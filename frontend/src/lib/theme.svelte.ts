export type Theme = 'dark' | 'light';

/** Shared by every ThemeToggle (docked sidebar and drawer). Always starts dark and is not persisted. */
export const theme = $state<{ current: Theme }>({ current: 'dark' });

export function setTheme(next: Theme) {
	theme.current = next;
	if (typeof document !== 'undefined') document.documentElement.dataset.theme = next;
}

export const toggleTheme = () => setTheme(theme.current === 'dark' ? 'light' : 'dark');
