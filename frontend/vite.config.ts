import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// Backend the dev server proxies `/api` to. Override with API_PROXY_TARGET if
// the FastAPI app isn't running on the default host/port.
const API_PROXY_TARGET = process.env.API_PROXY_TARGET ?? 'http://localhost:8000';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			// SPA fallback: Caddy serves this shell for every route and proxies /api.
			adapter: adapter({ fallback: 'index.html' })
		})
	],
	// Tauri (`npm run desktop:dev`) loads the dev server at a fixed URL and prints
	// its own output, so keep the port fixed and the terminal uncleared.
	clearScreen: false,
	server: {
		strictPort: true,
		proxy: {
			// Same-origin `/api` calls so the guest session cookie works without
			// CORS/SameSite issues, and SSE streaming passes straight through.
			'/api': {
				target: API_PROXY_TARGET,
				changeOrigin: true
			}
		}
	}
});
