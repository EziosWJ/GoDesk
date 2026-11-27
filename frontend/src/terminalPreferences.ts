export const minTerminalFontSize = 11
export const maxTerminalFontSize = 24
export const defaultTerminalFontSize = 13

const fontSizeKey = 'godesk-terminal-font-size'
const listeners = new Set<() => void>()

export function clampTerminalFontSize(value: number) {
  if (!Number.isFinite(value)) return defaultTerminalFontSize
  return Math.min(maxTerminalFontSize, Math.max(minTerminalFontSize, Math.round(value)))
}

function readStoredFontSize() {
  try {
    const raw = localStorage.getItem(fontSizeKey)
    if (raw === null) return defaultTerminalFontSize
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? clampTerminalFontSize(parsed) : defaultTerminalFontSize
  } catch {
    return defaultTerminalFontSize
  }
}

let fontSize = readStoredFontSize()

function notifyFontSize() {
  for (const listener of listeners) listener()
}

export function getTerminalFontSize() {
  return fontSize
}

export function setTerminalFontSize(next: number) {
  const clamped = clampTerminalFontSize(next)
  try {
    localStorage.setItem(fontSizeKey, String(clamped))
  } catch {
    // Keep applying the font size in memory when storage is unavailable.
  }
  if (fontSize === clamped) return
  fontSize = clamped
  notifyFontSize()
}

export function adjustTerminalFontSize(delta: number) {
  setTerminalFontSize(fontSize + delta)
}

export function resetTerminalFontSize() {
  setTerminalFontSize(defaultTerminalFontSize)
}

export function subscribeTerminalFontSize(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    if (event.key !== null && event.key !== fontSizeKey) return
    const next = readStoredFontSize()
    if (fontSize === next) return
    fontSize = next
    notifyFontSize()
  })
}
