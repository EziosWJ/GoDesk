import { useMemo, useSyncExternalStore } from 'react'
import type { ManagerState, WindowManager, WindowState } from '@surdeddd/wmkit'

export type DesktopWindow = Pick<WindowState, 'id' | 'openedSeq' | 'title' | 'stage' | 'meta'>

type DesktopSnapshot = {
  focusedId: ManagerState['focusedId']
  windows: Readonly<Record<string, DesktopWindow>>
}

function createSnapshotReader(wm: WindowManager) {
  let sourceWindows: ManagerState['windows'] | undefined
  let renderedWindows: DesktopWindow[] = []
  let snapshot: DesktopSnapshot = { focusedId: null, windows: {} }

  return () => {
    const { focusedId, windows } = wm.getState()
    let renderedById = snapshot.windows
    if (windows !== sourceWindows) {
      sourceWindows = windows
      // Keep window mount order independent of WMKit's focus and stacking order.
      const next = Object.values(windows)
      const unchanged = next.length === renderedWindows.length && next.every((win, index) => {
        const previous = renderedWindows[index]
        return win.id === previous.id && win.openedSeq === previous.openedSeq && win.title === previous.title
          && win.stage === previous.stage && win.meta === previous.meta
      })
      if (!unchanged) {
        renderedWindows = next.map(({ id, openedSeq, title, stage, meta }) => ({ id, openedSeq, title, stage, meta }))
        renderedById = Object.fromEntries(renderedWindows.map(win => [win.id, win]))
      }
    }
    // WMKit's DOM binder handles geometry. Reuse the React snapshot during moves and resizes.
    if (focusedId !== snapshot.focusedId || renderedById !== snapshot.windows) {
      snapshot = { focusedId, windows: renderedById }
    }
    return snapshot
  }
}

export function useDesktopWindows(wm: WindowManager): DesktopSnapshot {
  const getSnapshot = useMemo(() => createSnapshotReader(wm), [wm])
  return useSyncExternalStore(wm.subscribe, getSnapshot, getSnapshot)
}
