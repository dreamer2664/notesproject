import { getSettings, setSettings } from '../core/db'

export type ThemeMode = 'light' | 'dark' | 'system'

const media = window.matchMedia('(prefers-color-scheme: dark)')

export function applyTheme(mode: ThemeMode) {
  const dark = mode === 'dark' || (mode === 'system' && media.matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#161618' : '#f6f6f7')
}

export async function initTheme() {
  const { theme = 'system' } = await getSettings()
  applyTheme(theme)
  media.addEventListener('change', async () => {
    const s = await getSettings()
    if ((s.theme ?? 'system') === 'system') applyTheme('system')
  })
}

export async function toggleTheme(): Promise<ThemeMode> {
  const { theme = 'system' } = await getSettings()
  const isDark = theme === 'dark' || (theme === 'system' && media.matches)
  const next: ThemeMode = isDark ? 'light' : 'dark'
  await setSettings({ theme: next })
  applyTheme(next)
  document.dispatchEvent(new CustomEvent('theme-change', { detail: next }))
  return next
}
