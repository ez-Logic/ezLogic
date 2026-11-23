<script lang="ts">
	import { page } from '$app/state';

	const notFound = $derived(page.status === 404);
</script>

<svelte:head>
	<title>{notFound ? 'Page not found' : 'Something went wrong'} · ezLogic</title>
</svelte:head>

<main class="flex min-h-full flex-col bg-paper text-ink">
	<header class="flex items-center gap-2 px-4 pt-4 font-semibold tracking-tight sm:px-6">
		<a href="/" class="flex items-center gap-2 rounded-lg focus-visible:outline-2 focus-visible:outline-accent">
			<span class="grid size-7 place-items-center rounded-lg bg-ink font-serif text-[15px] text-paper" aria-hidden="true"
				>∴</span
			>
			ezLogic
		</a>
	</header>

	<div class="mx-auto flex max-w-xl flex-1 flex-col items-center justify-center px-4 pb-16 text-center">
		<p class="font-serif text-5xl text-ink" aria-hidden="true">{notFound ? '∄' : '⊥'}</p>
		<p class="mt-5 font-mono text-sm text-muted">{page.status}</p>
		<h1 class="mt-1 text-2xl font-semibold tracking-tight">
			{notFound ? 'No such page exists' : 'Something went wrong'}
		</h1>
		<p class="mt-2 max-w-md text-sm text-ink-2">
			{#if notFound}
				We searched for a witness to <code class="rounded bg-sunken px-1.5 break-all py-0.5 font-mono text-[0.85em] text-ink"
					>{page.url.pathname}</code
				> and couldn't find one. The link may be broken, or the page may have moved.
			{:else}
				{page.error?.message ?? 'An unexpected error occurred.'}
			{/if}
		</p>

		<div class="mt-8 flex flex-wrap justify-center gap-2">
			<a
				href="/"
				class="rounded-full bg-ink px-4 py-2 text-sm font-medium text-paper transition hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
			>
				Back to ezLogic
			</a>
			{#if !notFound}
				<button
					type="button"
					onclick={() => location.reload()}
					class="rounded-full border border-line bg-surface px-4 py-2 text-sm text-ink-2 transition hover:border-line-strong hover:text-ink"
				>
					Try again
				</button>
			{/if}
		</div>
	</div>
</main>
