export const themeOptions = {
  system: '跟随系统',
  light: '浅色',
  dark: '深色',
} as const

export type ThemePreference = keyof typeof themeOptions

const root = document.documentElement
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)')
const storedPreference = root.dataset.themePreference

let preference: ThemePreference =
  storedPreference === 'light' || storedPreference === 'dark' ? storedPreference : 'system'

function applyTheme() {
  root.dataset.theme = preference === 'system' ? (systemTheme.matches ? 'dark' : 'light') : preference
}

export function getThemePreference() {
  return preference
}

export function setThemePreference(next: ThemePreference) {
  preference = next
  root.dataset.themePreference = next
  applyTheme()

  try {
    window.localStorage.setItem('react-web-desktop-theme', next)
  } catch {
    // The preference still applies when storage is unavailable.
  }
}

systemTheme.addEventListener('change', applyTheme)
applyTheme()
