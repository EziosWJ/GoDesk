export const themeOptions = {
  system: '跟随系统',
  light: '浅色',
  dark: '深色',
} as const

export type ThemePreference = keyof typeof themeOptions

export const accentOptions = {
  blue: { label: '系统蓝', light: '#0067C0', dark: '#60CDFF' },
  iris: { label: '鸢尾紫', light: '#6246B5', dark: '#BBA7FA' },
  teal: { label: '青碧', light: '#007C7B', dark: '#4FD1C5' },
  amber: { label: '琥珀', light: '#B45309', dark: '#FBBF24' },
  rose: { label: '玫瑰', light: '#BE185D', dark: '#F472B6' },
} as const

export type AccentPreference = keyof typeof accentOptions

const themeKey = 'godesk-theme'
const accentKey = 'godesk-accent'
const root = document.documentElement
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)')
const listeners = new Set<() => void>()

let storedPreference = root.dataset.themePreference
let storedAccent = root.dataset.accent
try {
  storedPreference = localStorage.getItem(themeKey) ?? undefined
  storedAccent = localStorage.getItem(accentKey) ?? undefined
} catch {
  // Keep the preferences from the first-paint script when storage is unavailable.
}

let preference: ThemePreference =
  storedPreference === 'light' || storedPreference === 'dark' ? storedPreference : 'system'
let accent: AccentPreference = storedAccent && Object.hasOwn(accentOptions, storedAccent)
  ? storedAccent as AccentPreference
  : 'blue'

function applyTheme() {
  root.dataset.themePreference = preference
  root.dataset.theme = preference === 'system' ? (systemTheme.matches ? 'dark' : 'light') : preference
}

function notifyAppearance() {
  for (const listener of listeners) listener()
}

function savePreference(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // The preference still applies when storage is unavailable.
  }
}

export function getThemePreference() {
  return preference
}

export function setThemePreference(next: ThemePreference) {
  savePreference(themeKey, next)
  if (preference === next) return
  preference = next
  applyTheme()
  notifyAppearance()
}

export function getAccentPreference() {
  return accent
}

export function setAccentPreference(next: AccentPreference) {
  savePreference(accentKey, next)
  if (accent === next) return
  accent = next
  root.dataset.accent = next
  notifyAppearance()
}

export function subscribeAppearance(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

systemTheme.addEventListener('change', () => {
  if (preference !== 'system') return
  applyTheme()
  notifyAppearance()
})
applyTheme()
root.dataset.accent = accent
