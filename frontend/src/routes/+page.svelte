<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { fade, fly } from 'svelte/transition';
	import {
		ApiError,
		applyEvent,
		emptyLiveMessage,
		endLive,
		ensureSession,
		finalizeLive,
		getHistory,
		getMe,
		isMockMode,
		logout,
		newChatId,
		streamChat
	} from '#lib/api.js';
	import { toolLabel } from '#lib/format.js';
	import { demoChats } from '#lib/mock.js';
	import { composePrompt, extractProofText, FileError } from '#lib/extract.js';
	import type { AssistantMessage, Chat, User, VerificationStatus } from '#lib/types.js';
	import Brace from '#lib/components/Brace.svelte';
	import Composer from '#lib/components/Composer.svelte';
	import FileDrop from '#lib/components/FileDrop.svelte';
	import LiveMessage from '#lib/components/LiveMessage.svelte';
	import ProofSteps from '#lib/components/ProofSteps.svelte';
	import Sidebar from '#lib/components/Sidebar.svelte';
	import StepDetail from '#lib/components/StepDetail.svelte';
	import ProofGraphPanel from '#lib/components/ProofGraphPanel.svelte';

	const STATUS_ANNOUNCE: Record<VerificationStatus, string> = {
		verified: 'Verified in Lean 4',
		unverified: 'Not yet verified',
		failed: 'Verification incomplete'
	};

	// ---- state ---------------------------------------------------------------
	let chats = $state<Chat[]>(isMockMode ? demoChats() : []);
	let activeId = $state<string | null>(chats[0]?.id ?? null);
	type DetailSelection = { kind: 'step'; messageId: string; stepId: string } | { kind: 'graph'; messageId: string } | null;
	let selection = $state<DetailSelection>(null);
	let graphTrigger: HTMLElement | null = null;
	let showLean = $state(false);
	let sidebarPinned = $state(true);
	let drawerOpen = $state(false);
	/** Set when loading a chat's stored history (GET /api/history) fails. Unrelated to a
	 * streaming run's own errors, which are shown inline on that message instead. */
	let historyError = $state<string | null>(null);
	/** Set when the guest session bootstrap (POST /api/session) fails. */
	let sessionError = $state<string | null>(null);
	/** Announced to screen readers as the agent works; not every token, just milestones. */
	let liveAnnouncement = $state('');

	/** The one run allowed at a time (backend/main.py uses a single shared workspace, so two
	 * concurrent runs could overwrite each other's .lean files -- see frontend/README.md B9). */
	let inFlight = $state<{ chatId: string; messageId: string; controller: AbortController } | null>(null);
	const running = $derived(inFlight !== null);

	type Attachment = { name: string; size: number };

	// Proof file chosen for a new chat; its text is extracted as soon as it is picked.
	let file = $state<File | null>(null);
	let fileError = $state('');
	let fileText = $state<string | null>(null);
	let reading = $state(false);

	/** The signed-in account, or null for a guest (auth is optional). */
	let user = $state<User | null>(null);

	async function signOut() {
		try {
			await logout();
		} catch (e) {
			sessionError = e instanceof Error ? e.message : String(e);
			return;
		}
		inFlight?.controller.abort();
		user = null;
		chats = [];
		newChat();
	}

	onMount(() => {
		getMe()
			.then((u) => (user = u))
			.catch(() => {});
		if (isMockMode) return;
		ensureSession().catch((e) => {
			sessionError = e instanceof Error ? e.message : String(e);
		});
	});

	function retrySession() {
		sessionError = null;
		ensureSession().catch((e) => {
			sessionError = e instanceof Error ? e.message : String(e);
		});
	}

	const active = $derived(chats.find((c) => c.id === activeId) ?? null);
	const selectedMessage = $derived(
		selection && active
			? (active.messages.find(
					(m): m is AssistantMessage => m.role === 'assistant' && m.id === selection!.messageId
				) ?? null)
			: null
	);
	const selectedStepId = $derived(selection?.kind === 'step' ? selection.stepId : null);
	const selectedIndex = $derived(
		selectedMessage && selectedStepId ? selectedMessage.steps.findIndex((s) => s.id === selectedStepId) : -1
	);
	const selectedStep = $derived(selectedMessage?.steps[selectedIndex] ?? null);
	const expanded = $derived(!!selectedStep || (selection?.kind === 'graph' && !!selectedMessage));
	/** The sidebar docks only when no step is expanded (sketch state 3 collapses it to ≡). */
	const sidebarDocked = $derived(sidebarPinned && !expanded);

	// ---- actions -------------------------------------------------------------
	function selectStep(messageId: string, stepId: string) {
		if (selection?.kind === 'step' && selection.messageId === messageId && selection.stepId === stepId) {
			selection = null;
			return;
		}
		selection = { kind: 'step', messageId, stepId };
		drawerOpen = false;
	}

	function closeDetail() {
		const returnFocus = selection?.kind === 'graph' ? graphTrigger : null;
		selection = null;
		tick().then(() => returnFocus?.focus());
	}

	function openGraph(messageId: string) {
		graphTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		selection = { kind: 'graph', messageId };
		drawerOpen = false;
	}

	async function openChat(id: string) {
		activeId = id;
		selection = null;
		drawerOpen = false;
		historyError = null;
		const chat = chats.find((c) => c.id === id);
		if (!chat || chat.messages.length > 0 || isMockMode) return;
		try {
			chat.messages = await getHistory(id);
		} catch (e) {
			historyError = e instanceof Error ? e.message : String(e);
		}
	}

	function newChat() {
		file = null;
		fileError = '';
		activeId = null;
		selection = null;
		drawerOpen = false;
		historyError = null;
	}

	/** Streams one turn into `chat`, replacing the `draftId` placeholder message as events arrive. */
	async function runTurn(chat: Chat, text: string, draftId: string) {
		let draft = emptyLiveMessage(draftId);
		chat.messages.push(draft);
		scrollToBottom();

		const controller = new AbortController();
		inFlight = { chatId: chat.id, messageId: draftId, controller };

		// Tokens can arrive many times a second; redrawing (and re-running KaTeX)
		// on every single one is wasteful, so batch updates to once per frame.
		// `done`/stop/error are applied immediately instead, below.
		let pendingFrame = 0;
		const flush = () => {
			const idx = chat.messages.findIndex((m) => m.id === draftId);
			if (idx !== -1) chat.messages[idx] = draft;
		};
		const scheduleFlush = () => {
			if (pendingFrame) return;
			pendingFrame = requestAnimationFrame(() => {
				pendingFrame = 0;
				flush();
				maybeAutoScroll();
			});
		};

		try {
			for await (const ev of streamChat(chat.id, text, { signal: controller.signal })) {
				if (ev.type === 'done') {
					draft = finalizeLive(draft, ev);
					flush();
					chat.updatedAt = Date.now();
					liveAnnouncement = STATUS_ANNOUNCE[draft.status];
					maybeAutoScroll();
				} else {
					draft = applyEvent(draft, ev);
					if (ev.type === 'tool_call_start') liveAnnouncement = toolLabel(ev.name);
					scheduleFlush();
				}
			}
		} catch (e) {
			if (e instanceof ApiError && e.kind === 'aborted') {
				draft = endLive(draft, 'stopped');
				liveAnnouncement = 'Stopped';
			} else {
				const detail = e instanceof Error ? e.message : String(e);
				draft = endLive(draft, 'error', detail);
				liveAnnouncement = `Error: ${detail}`;
			}
			flush();
			maybeAutoScroll();
		} finally {
			if (pendingFrame) cancelAnimationFrame(pendingFrame);
			if (inFlight?.messageId === draftId) inFlight = null;
		}
	}

	// Extracts the attached file's text as soon as it's picked, so it's ready by the
	// time the user hits send (submit() below checks fileText, not file, before
	// treating the pick as ready to attach).
	$effect(() => {
		const f = file;
		fileText = null;
		if (!f) {
			reading = false;
			return;
		}
		let stale = false;
		reading = true;
		extractProofText(f)
			.then((t) => {
				if (!stale) fileText = t;
			})
			.catch((e) => {
				if (stale) return;
				fileError = e instanceof FileError ? e.message : String(e);
				file = null;
			})
			.finally(() => {
				if (!stale) reading = false;
			});
		return () => {
			stale = true;
		};
	});

	/** Composer's onsend: folds in the attached file's extracted text (if any) before sending. */
	function submit(text: string) {
		if (file && fileText !== null) {
			const attachment = { name: file.name, size: file.size };
			const prompt = composePrompt(text, file.name, fileText);
			file = null;
			return send(text, prompt, attachment);
		}
		return send(text);
	}

	async function send(text: string, prompt = text, attachment?: Attachment) {
		if (running) return;
		let chat = active;
		if (!chat) {
			const title = text || attachment?.name || 'New proof';
			chat = {
				id: newChatId(),
				title: title.length > 48 ? title.slice(0, 47) + '…' : title,
				messages: [],
				updatedAt: Date.now()
			};
			chats.unshift(chat);
			activeId = chat.id;
			chat = chats[0];
		}
		// `prompt` (which may include an attachment's extracted text) is only kept on
		// the message when it differs from `text`, so retryMessage can resend it later
		// without silently dropping the attached file's content.
		chat.messages.push({
			id: `u-${Date.now().toString(36)}`,
			role: 'user',
			text,
			attachment,
			prompt: prompt !== text ? prompt : undefined
		});
		scrollToBottom();
		await runTurn(chat, prompt, `live-${Date.now().toString(36)}`);
	}

	/** Retries a failed/stopped message: drops it and re-runs the same turn (including
	 * any attached file's text), without duplicating the user bubble above it. */
	function retryMessage(messageId: string) {
		if (!active || running) return;
		const chat = active;
		const idx = chat.messages.findIndex((m) => m.id === messageId);
		if (idx <= 0) return;
		const prev = chat.messages[idx - 1];
		if (prev.role !== 'user') return;
		chat.messages.splice(idx, 1);
		runTurn(chat, prev.prompt ?? prev.text, `live-${Date.now().toString(36)}`);
	}

	function stop() {
		inFlight?.controller.abort();
	}

	// ---- scrolling & brace geometry -----------------------------------------
	let scroller: HTMLDivElement | undefined = $state();
	let braceEl: HTMLDivElement | undefined = $state();
	let brace = $state({ tipY: 0, height: 0 });
	/** Shown once new content arrives while the user has scrolled away from the bottom to read. */
	let showJumpToBottom = $state(false);

	function nearBottom(): boolean {
		if (!scroller) return true;
		return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
	}

	async function scrollToBottom() {
		await tick();
		scroller?.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
		showJumpToBottom = false;
	}

	/** Follows new streamed content only if the user hasn't scrolled away to read something. */
	function maybeAutoScroll() {
		if (nearBottom()) scrollToBottom();
		else showJumpToBottom = true;
	}

	function onscroll() {
		measureBrace();
		if (nearBottom()) showJumpToBottom = false;
	}

	function measureBrace() {
		if (!braceEl || !scroller || selection?.kind !== 'step') return;
		const card = scroller.querySelector<HTMLElement>(
			`[data-step-key="${selection.messageId}:${selection.stepId}"]`
		);
		const box = braceEl.getBoundingClientRect();
		if (!card) return;
		const r = card.getBoundingClientRect();
		brace = { tipY: r.top + r.height / 2 - box.top, height: box.height };
	}

	// Re-measure when the selection or layout changes; bring the card into view.
	$effect(() => {
		if (selection?.kind !== 'step' || !braceEl) return;
		const key = `${selection.messageId}:${selection.stepId}`;
		tick().then(() => {
			scroller
				?.querySelector<HTMLElement>(`[data-step-key="${key}"]`)
				?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
			measureBrace();
		});
		const ro = new ResizeObserver(measureBrace);
		ro.observe(braceEl);
		if (scroller) ro.observe(scroller);
		return () => ro.disconnect();
	});

	function onkeydown(e: KeyboardEvent) {
		const t = e.target as HTMLElement;
		if (t.closest('textarea, input, select')) return;
		if (e.key === 'Escape') {
			if (drawerOpen) drawerOpen = false;
			else if (selection) closeDetail();
			return;
		}
		if (t.closest('[data-proof-graph]') || selection?.kind === 'graph') return;
		if (!selectedMessage || selectedIndex < 0) return;
		const dir = e.key === 'ArrowDown' || e.key === 'j' ? 1 : e.key === 'ArrowUp' || e.key === 'k' ? -1 : 0;
		const target = selectedMessage.steps[selectedIndex + dir];
		if (dir && target) {
			e.preventDefault();
			selection = { kind: 'step', messageId: selectedMessage.id, stepId: target.id };
		}
	}

	const EXAMPLES = [
		'Prove that √2 is irrational',
		'Show there are infinitely many primes',
		'Prove 0 + 1 + ⋯ + n = n(n+1)/2'
	];
</script>

<svelte:window {onkeydown} />

<div aria-live="polite" class="sr-only">{liveAnnouncement}</div>

<div class="flex h-dvh overflow-hidden">
	{#if sidebarDocked}
		<div class="hidden md:block" transition:fly={{ x: -24, duration: 160 }}>
			<Sidebar
				{chats}
				{activeId}
				{user}
				onlogout={signOut}
				onselect={openChat}
				onnew={newChat}
				oncollapse={() => (sidebarPinned = false)}
			/>
		</div>
	{/if}

	<main class="relative flex min-w-0 flex-1 flex-col">
		<!-- Top bar -->
		<header class="flex h-14 shrink-0 items-center gap-2 px-3">
			<button
				type="button"
				onclick={() => (drawerOpen = true)}
				class="grid size-9 place-items-center rounded-lg text-ink-2 transition hover:bg-sunken hover:text-ink
				{sidebarDocked ? 'md:hidden' : ''}"
				aria-label="Open chat history"
				title="Chat history"
			>
				<svg viewBox="0 0 20 20" class="size-5" fill="none" stroke="currentColor" stroke-width="1.7">
					<path d="M3.5 5.5h13M3.5 10h13M3.5 14.5h13" stroke-linecap="round" />
				</svg>
			</button>
			<h1 class="truncate text-sm font-medium text-ink-2">
				{active?.title ?? 'New proof'}
			</h1>
			{#if isMockMode}
				<span
					class="ml-auto rounded-full border border-line px-2.5 py-0.5 text-xs text-muted"
					title="Unset VITE_MOCK to connect to the backend agent">Demo data</span
				>
			{/if}
		</header>

		{#if sessionError}
			<div
				class="mx-3 mb-2 flex items-center gap-3 rounded-xl border border-warn/30 bg-warn-soft px-4 py-2.5 text-sm text-warn"
				role="alert"
				transition:fade={{ duration: 120 }}
			>
				<span class="flex-1">Can't reach the server: {sessionError}</span>
				<button type="button" onclick={retrySession} class="font-medium underline underline-offset-2">
					Retry
				</button>
			</div>
		{/if}

		{#if historyError}
			<div
				class="mx-3 mb-2 flex items-center gap-3 rounded-xl border border-warn/30 bg-warn-soft px-4 py-2.5 text-sm text-warn"
				role="alert"
				transition:fade={{ duration: 120 }}
			>
				<span class="flex-1">Couldn't load this chat: {historyError}</span>
				<button
					type="button"
					onclick={() => activeId && openChat(activeId)}
					class="font-medium underline underline-offset-2"
				>
					Retry
				</button>
			</div>
		{/if}

		<!-- Conversation + detail split -->
		<div class="flex min-h-0 flex-1 gap-0 px-3 lg:px-4">
			<section
				class="relative flex min-h-0 min-w-0 flex-col transition-[width] duration-200
				{expanded ? 'w-full lg:w-[400px] lg:shrink-0 xl:w-[440px]' : 'w-full'}"
			>
				<div
					bind:this={scroller}
					{onscroll}
					class="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
				>
					{#if !active || active.messages.length === 0}
						<!-- Sketch state 1: empty chat -->
						<div class="mx-auto flex h-full max-w-2xl flex-col items-center justify-center px-4 pb-10 text-center">
							<p class="font-serif text-4xl text-ink" aria-hidden="true">∀ ∃ ⊢</p>
							<h2 class="mt-4 text-2xl font-semibold tracking-tight">What would you like to prove?</h2>
							<p class="mt-2 max-w-md text-sm text-ink-2">
								Describe a theorem, paste a proof sketch, or upload a .tex or .pdf proof. ezLogic formalises it in Lean, checks it,
								and explains each step.
							</p>
							<div class="mt-6 flex flex-wrap justify-center gap-2">
								{#each EXAMPLES as ex (ex)}
									<button
										type="button"
										disabled={running}
										onclick={() => send(ex)}
										class="rounded-full border border-line bg-surface px-3.5 py-1.5 text-sm text-ink-2 transition hover:border-line-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
									>
										{ex}
									</button>
								{/each}
							</div>
						</div>
					{:else}
						<!-- Sketch state 2: chat with proof blocks -->
						<div class="mx-auto space-y-8 py-4 {expanded ? 'max-w-none pr-1' : 'max-w-3xl px-1'}">
							{#each active.messages as msg (msg.id)}
								{#if msg.role === 'user'}
									<div class="flex justify-end">
										<p
											class="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-sunken px-4 py-2.5 text-[15px] leading-6 text-ink"
										>
											{#if msg.attachment}
												<span class="mb-1.5 flex items-center gap-1.5 rounded-lg bg-surface px-2.5 py-1 text-xs text-ink-2">
													<svg viewBox="0 0 20 20" class="size-3.5 shrink-0" fill="none" stroke="currentColor" stroke-width="1.6">
														<path d="M5 2.5h6.5L15 6v11.5H5z M11.5 2.5V6H15" stroke-linejoin="round" />
													</svg>
													<span class="truncate">{msg.attachment.name}</span>
												</span>
											{/if}
											{msg.text}
										</p>
									</div>
								{:else if msg.live}
									<div in:fade={{ duration: 120 }}>
										<LiveMessage message={msg} onretry={() => retryMessage(msg.id)} />
									</div>
								{:else}
									<ProofSteps
										message={msg}
										compact={expanded}
										selectedStepId={selection?.kind === 'step' && selection.messageId === msg.id ? selection.stepId : null}
										onselect={(stepId) => selectStep(msg.id, stepId)}
										onopengraph={() => openGraph(msg.id)}
									/>
								{/if}
							{/each}
						</div>
					{/if}
				</div>

				{#if showJumpToBottom}
					<button
						type="button"
						onclick={scrollToBottom}
						transition:fade={{ duration: 120 }}
						class="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-paper shadow-lg transition hover:opacity-90"
					>
						↓ New activity
					</button>
				{/if}
			</section>

			{#if expanded && selectedMessage && selectedStep}
				<!-- Sketch state 3: brace + thorough explanation -->
				<div bind:this={braceEl} class="relative hidden w-10 shrink-0 justify-center pt-4 pb-2 lg:flex">
					<Brace tipY={brace.tipY - 16} height={Math.max(0, brace.height - 24)} />
				</div>
				<div
					class="fixed inset-0 z-30 bg-paper p-3 lg:static lg:z-auto lg:min-w-0 lg:flex-1 lg:bg-transparent lg:p-0 lg:pb-2 lg:pt-1"
					in:fly={{ x: 24, duration: 200 }}
				>
					<StepDetail
						message={selectedMessage}
						step={selectedStep}
						index={selectedIndex}
						bind:showLean
						onclose={closeDetail}
						onstep={(stepId) => selectStep(selectedMessage.id, stepId)}
					/>
				</div>
			{/if}
			{#if selection?.kind === 'graph' && selectedMessage}
				<div class="fixed inset-0 z-30 bg-paper p-3 lg:static lg:z-auto lg:ml-4 lg:min-w-0 lg:flex-1 lg:bg-transparent lg:p-0 lg:pb-2 lg:pt-1">
					<ProofGraphPanel queryId={selectedMessage.queryId} onclose={closeDetail} />
				</div>
			{/if}
		</div>

		<!-- Composer: present in every state -->
		<div class="shrink-0 px-4 pb-4 pt-2">
			<div class="mx-auto max-w-3xl">
				{#if !active || active.messages.length === 0}
					<div class="mb-2">
						<FileDrop bind:file bind:error={fileError} disabled={running} />
						{#if reading}
							<p class="mt-1.5 px-2 text-xs text-muted">Reading file…</p>
						{/if}
					</div>
				{/if}
				<Composer
					{running}
					allowEmpty={!!file && fileText !== null}
					onsend={submit}
					onstop={stop}
				/>
				<p class="mt-2 text-center text-[11px] text-muted">
					{running
						? 'A proof is currently running — use Stop to cancel.'
						: 'Proofs are checked by Lean 4. Explanations are AI-generated.'}
				</p>
			</div>
		</div>
	</main>

	<!-- Chat history drawer (used when the sidebar is collapsed) -->
	{#if drawerOpen}
		<div class="fixed inset-0 z-40 flex">
			<button
				type="button"
				class="absolute inset-0 bg-black/25"
				aria-label="Close chat history"
				onclick={() => (drawerOpen = false)}
				transition:fade={{ duration: 120 }}
			></button>
			<div class="relative h-full shadow-xl" transition:fly={{ x: -260, duration: 180 }}>
				<Sidebar
					{chats}
					{activeId}
					{user}
					onlogout={signOut}
					onselect={openChat}
					onnew={newChat}
					oncollapse={() => {
						drawerOpen = false;
					}}
				/>
			</div>
			{#if !sidebarPinned && !expanded}
				<button
					type="button"
					onclick={() => {
						sidebarPinned = true;
						drawerOpen = false;
					}}
					class="relative ml-2 mt-3 h-fit rounded-lg bg-surface px-3 py-1.5 text-xs text-ink-2 shadow"
				>
					Keep open
				</button>
			{/if}
		</div>
	{/if}
</div>
