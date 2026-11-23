<!--
	TEMPORARY sign-in / sign-up page. It only exists to exercise the email + password
	pipeline (/api/auth/*) and will be replaced by the real /login design.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { getMe, login, logout, signup } from '#lib/api.js';
	import type { User } from '#lib/types.js';

	let mode = $state<'login' | 'signup'>('login');
	let email = $state('');
	let password = $state('');
	let pending = $state(false);
	let error = $state<string | null>(null);
	let user = $state<User | null>(null);

	onMount(() => {
		getMe()
			.then((u) => (user = u))
			.catch(() => {});
	});

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		pending = true;
		error = null;
		try {
			await (mode === 'login' ? login : signup)(email.trim(), password);
			await goto('/');
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			pending = false;
		}
	}

	async function signOut() {
		try {
			await logout();
			user = null;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}
</script>

<svelte:head>
	<title>Sign in · ezLogic</title>
</svelte:head>

<main class="grid min-h-dvh place-items-center bg-paper px-4">
	<div class="w-full max-w-sm rounded-xl border border-line bg-surface p-6 shadow-sm">
		<h1 class="mb-4 text-lg font-semibold text-ink">
			{user ? 'Signed in' : mode === 'login' ? 'Sign in' : 'Create account'}
		</h1>

		{#if user}
			<p class="mb-4 text-sm text-ink-2">Signed in as <strong>{user.email}</strong>.</p>
			<div class="flex gap-2">
				<a href="/" class="rounded-lg bg-ink px-3 py-2 text-sm text-paper">Go to app</a>
				<button type="button" onclick={signOut} class="rounded-lg border border-line px-3 py-2 text-sm text-ink-2 hover:bg-sunken">
					Sign out
				</button>
			</div>
		{:else}
			<form onsubmit={submit} class="space-y-3">
				<label class="block text-sm text-ink-2">
					Email
					<input
						type="email"
						required
						autocomplete="email"
						bind:value={email}
						class="mt-1 w-full rounded-lg border border-line bg-paper px-3 py-2 text-ink"
					/>
				</label>
				<label class="block text-sm text-ink-2">
					Password
					<input
						type="password"
						required
						minlength={mode === 'signup' ? 8 : undefined}
						autocomplete={mode === 'login' ? 'current-password' : 'new-password'}
						bind:value={password}
						class="mt-1 w-full rounded-lg border border-line bg-paper px-3 py-2 text-ink"
					/>
				</label>
				{#if error}
					<p role="alert" class="text-sm text-warn">{error}</p>
				{/if}
				<button
					type="submit"
					disabled={pending}
					class="w-full rounded-lg bg-ink px-3 py-2 text-sm text-paper disabled:opacity-60"
				>
					{pending ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
				</button>
			</form>
			<p class="mt-4 text-sm text-muted">
				{mode === 'login' ? 'No account yet?' : 'Already have an account?'}
				<button
					type="button"
					class="text-ink underline"
					onclick={() => {
						mode = mode === 'login' ? 'signup' : 'login';
						error = null;
					}}
				>
					{mode === 'login' ? 'Create one' : 'Sign in'}
				</button>
			</p>
			<p class="mt-2 text-sm"><a href="/" class="text-muted underline">Continue as guest</a></p>
		{/if}
	</div>
</main>
