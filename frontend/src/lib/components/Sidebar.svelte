<script lang="ts">
	import type { Chat } from '#lib/types.js';
	import ThemeToggle from './ThemeToggle.svelte';

	let {
		chats,
		activeId,
		onselect,
		onnew,
		oncollapse
	}: {
		chats: Chat[];
		activeId: string | null;
		onselect: (id: string) => void;
		onnew: () => void;
		oncollapse: () => void;
	} = $props();
</script>

<aside class="flex h-full w-64 shrink-0 flex-col border-r border-line bg-surface">
	<div class="flex items-center gap-2 px-4 pb-2 pt-4">
		<div class="flex items-center gap-2 font-semibold tracking-tight">
			<span
				class="grid size-7 place-items-center rounded-lg bg-ink font-serif text-[15px] text-paper"
				aria-hidden="true">∴</span
			>
			ezLogic
		</div>
		<button
			type="button"
			onclick={oncollapse}
			class="ml-auto grid size-8 place-items-center rounded-lg text-muted transition hover:bg-sunken hover:text-ink"
			aria-label="Collapse sidebar"
			title="Collapse sidebar"
		>
			<svg viewBox="0 0 20 20" class="size-[18px]" fill="none" stroke="currentColor" stroke-width="1.6">
				<rect x="3" y="4" width="14" height="12" rx="2" />
				<path d="M8 4v12" />
			</svg>
		</button>
	</div>

	<div class="px-3 py-2">
		<button
			type="button"
			onclick={onnew}
			class="flex w-full items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm text-ink-2 transition hover:border-line-strong hover:bg-sunken hover:text-ink"
		>
			<svg viewBox="0 0 20 20" class="size-4" fill="none" stroke="currentColor" stroke-width="1.8">
				<path d="M10 4v12M4 10h12" />
			</svg>
			New proof
		</button>
	</div>

	<h2 class="px-5 pb-1 pt-3 text-xs font-medium uppercase tracking-wider text-muted">Chat history</h2>
	<nav class="flex-1 overflow-y-auto px-3 pb-4">
		{#if chats.length === 0}
			<p class="px-2 py-2 text-sm text-muted">No chats yet.</p>
		{/if}
		<ul class="space-y-0.5">
			{#each chats as chat (chat.id)}
				<li>
					<button
						type="button"
						onclick={() => onselect(chat.id)}
						class="w-full truncate rounded-lg px-3 py-2 text-left text-sm transition {chat.id ===
						activeId
							? 'bg-sunken font-medium text-ink'
							: 'text-ink-2 hover:bg-sunken/70 hover:text-ink'}"
						aria-current={chat.id === activeId ? 'page' : undefined}
					>
						{chat.title}
					</button>
				</li>
			{/each}
		</ul>
	</nav>

	<div class="flex items-center border-t border-line px-4 py-3">
		<ThemeToggle />
	</div>
</aside>
