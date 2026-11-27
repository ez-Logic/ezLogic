<!--
	Desktop app only: choose which ezLogic backend the app talks to. The URL is
	saved in localStorage (see setServerUrl in api.ts) and the app reloads so every
	piece of state (session, chats, graphs) comes from the new server.
-->
<script lang="ts">
	import { checkServer, defaultServerUrl, getSavedServerUrl, setServerUrl } from '#lib/api.js';
	import { serverSettings } from '#lib/server-settings.svelte.js';

	let dialog = $state<HTMLDialogElement>();
	let url = $state('');
	let status = $state<{ ok: boolean; text: string } | null>(null);
	let testing = $state(false);

	const fallback = defaultServerUrl();

	$effect(() => {
		if (!dialog) return;
		if (serverSettings.open && !dialog.open) {
			url = getSavedServerUrl() ?? fallback;
			status = null;
			dialog.showModal();
		} else if (!serverSettings.open && dialog.open) {
			dialog.close();
		}
	});

	function valid(value: string): boolean {
		try {
			const u = new URL(value.trim());
			return u.protocol === 'http:' || u.protocol === 'https:';
		} catch {
			return false;
		}
	}

	async function test() {
		if (!valid(url)) {
			status = { ok: false, text: 'Enter a full http:// or https:// URL.' };
			return;
		}
		testing = true;
		status = null;
		try {
			await checkServer(url);
			status = { ok: true, text: 'Connected.' };
		} catch (e) {
			status = { ok: false, text: e instanceof Error ? e.message : String(e) };
		} finally {
			testing = false;
		}
	}

	function save(event: SubmitEvent) {
		event.preventDefault();
		if (!valid(url)) {
			status = { ok: false, text: 'Enter a full http:// or https:// URL.' };
			return;
		}
		setServerUrl(url.trim() === fallback ? null : url);
		location.reload();
	}

	function reset() {
		setServerUrl(null);
		location.reload();
	}
</script>

<dialog
	bind:this={dialog}
	onclose={() => (serverSettings.open = false)}
	class="m-auto w-full max-w-md rounded-xl border border-line bg-surface p-6 text-ink shadow-lg backdrop:bg-black/40"
>
	<form onsubmit={save} class="space-y-4">
		<h2 class="text-lg font-semibold">Server</h2>
		<label class="block text-sm text-ink-2">
			Backend URL
			<input
				type="url"
				required
				spellcheck="false"
				bind:value={url}
				placeholder={fallback}
				class="mt-1 w-full rounded-lg border border-line bg-paper px-3 py-2 font-mono text-sm text-ink"
			/>
		</label>
		<p class="text-xs text-muted">Default: <span class="font-mono">{fallback}</span></p>
		{#if status}
			<p role="status" class="text-sm {status.ok ? 'text-ink-2' : 'text-warn'}">{status.text}</p>
		{/if}
		<div class="flex flex-wrap items-center gap-2">
			<button type="submit" class="rounded-lg bg-ink px-3 py-2 text-sm text-paper">Save and reload</button>
			<button
				type="button"
				onclick={test}
				disabled={testing}
				class="rounded-lg border border-line px-3 py-2 text-sm text-ink-2 hover:bg-sunken disabled:opacity-60"
			>
				{testing ? 'Testing…' : 'Test'}
			</button>
			<button type="button" onclick={reset} class="text-sm text-muted underline underline-offset-2 hover:text-ink">
				Reset to default
			</button>
			<button
				type="button"
				onclick={() => (serverSettings.open = false)}
				class="ml-auto text-sm text-muted hover:text-ink"
			>
				Cancel
			</button>
		</div>
	</form>
</dialog>
