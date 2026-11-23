import type { AppId } from './apps.ts'

export const minimumWindowWidth = 320
export const minimumWindowHeight = 240

export type WindowSize = { width: number; height: number }

const sizeKeyPrefix = 'react-web-desktop-window-size:'
const legacyFileSizeKey = 'react-web-desktop-file-window-size'

export function windowSizeGroup(appId: AppId, windowId: string): string {
  if (appId !== 'terminal') return appId
  return windowId === 'terminal' ? 'terminal' : 'terminal-session'
}

function parseSize(raw: string | null): WindowSize | undefined {
  if (raw === null) return undefined
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) return undefined
    const { width, height } = value as { width?: unknown; height?: unknown }
    if (typeof width === 'number' && Number.isFinite(width) && width >= minimumWindowWidth
      && typeof height === 'number' && Number.isFinite(height) && height >= minimumWindowHeight) {
      return { width, height }
    }
  } catch {
    // Ignore corrupt storage and fall back to the app default.
  }
}

export function readWindowSize(group: string): WindowSize | undefined {
  try {
    const size = parseSize(localStorage.getItem(sizeKeyPrefix + group))
    if (size) return size
    return group === 'files' ? parseSize(localStorage.getItem(legacyFileSizeKey)) : undefined
  } catch {
    // Storage may be unavailable; the app default still works.
  }
}

export function saveWindowSize(group: string, size: WindowSize) {
  try {
    localStorage.setItem(sizeKeyPrefix + group, JSON.stringify(size))
  } catch {
    // Resizing still works without storage.
  }
}
