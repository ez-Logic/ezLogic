<script lang="ts">
	import { theme, toggleTheme } from '#lib/theme.svelte.js';

	const light = $derived(theme.current === 'light');
</script>

<button
	type="button"
	role="switch"
	aria-checked={light}
	aria-label="Light mode"
	title={light ? 'Switch to dark mode' : 'Switch to light mode'}
	onclick={toggleTheme}
	class="relative flex h-8 w-16 shrink-0 items-center justify-between rounded-full border border-line bg-sunken px-2 text-muted transition hover:border-line-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
>
	<span
		class="absolute left-0.5 top-0.5 size-6 rounded-full bg-surface shadow ring-1 ring-line transition-transform duration-200 {light
			? 'translate-x-0'
			: 'translate-x-8'}"
		aria-hidden="true"
	></span>
	<svg viewBox="0 0 20 20" class="relative size-4 {light ? 'text-ink' : ''}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
		<circle cx="10" cy="10" r="3.2" />
		<path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" />
	</svg>
	<svg viewBox="0 0 20 20" class="relative size-4 {light ? '' : 'text-ink'}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true">
		<path d="M16.5 11.8A6.8 6.8 0 0 1 8.2 3.5a6.8 6.8 0 1 0 8.3 8.3z" />
	</svg>
</button>
