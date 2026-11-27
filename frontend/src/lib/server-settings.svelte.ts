// Open/closed state of the desktop app's Server URL dialog (ServerSettings.svelte,
// mounted once in +layout.svelte), so any page can open it.

export const serverSettings = $state({ open: false });

export function openServerSettings(): void {
	serverSettings.open = true;
}
