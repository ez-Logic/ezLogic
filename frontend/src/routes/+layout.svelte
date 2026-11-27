<script lang="ts">
	import 'katex/dist/katex.min.css';
	import './layout.css';
	import favicon from '#lib/assets/favicon.svg';
	import { isDesktop } from '#lib/api.js';
	import ServerSettings from '#lib/components/ServerSettings.svelte';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>ezLogic</title>
</svelte:head>

{@render children()}

{#if isDesktop()}
	<ServerSettings />
{/if}
