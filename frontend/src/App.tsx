import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { prefersReducedMotion } from '@surdeddd/wmkit'
import type { DesktopOptions, WindowState } from '@surdeddd/wmkit'
import { useDesktop, useWindowManager } from '@surdeddd/wmkit/react'
import { AppWindow } from './AppWindow'
import { apps, type AppId } from './apps.ts'
import type { Session } from './auth'
import { DesktopSurface, type DesktopShortcutItem } from './DesktopSurface'
import { FileManager } from './FileManager'
import { IconManager } from './IconManager'
import type { DesktopNotification } from './QuickSettingsPanel'
import { StartMenu } from './StartMenu'
import { Taskbar } from './Taskbar'
import { TerminalSessions } from './TerminalSessions'
import { TextEditorApp, type EditorOpenRequest, type EditorWindowHandle } from './TextEditorApp'
import { Extensions } from './extensions/Extensions'
import { ExtensionWindow } from './extensions/ExtensionWindow'
import { extensionWebPath, type ExtensionPlugin } from './extensions/api'
import { useExtensionCatalog } from './extensions/useExtensionCatalog'
import { terminalApi, terminalClientId, terminalWindowId, type TerminalSession } from './terminal'
import { useDesktopWindows, type DesktopWindow } from './useDesktopWindows'
import { useHostHealth } from './useHostHealth'
import { getWallpaperPreference, subscribeWallpaper } from './wallpapers'
import { openWebShortcut, useWebShortcuts } from './webShortcuts'
import { minimumWindowHeight, minimumWindowWidth, readWindowSize, saveWindowSize, windowSizeGroup } from './windowSize.ts'
import './App.css'

const workAreaOptions: DesktopOptions = {
  // WMKit checks prefers-reduced-motion when starting each minimize or restore animation.
  animation: true,
  snap: { preview: true, topEdge: 'maximize' },
  grouping: false,
  magnetism: { threshold: 10 },
  minimizeTarget: win => document.querySelector(`.taskbar-center [data-task-app="${CSS.escape(win.id)}"]`) ??
    document.querySelector('[data-task-popup="windows"]'),
  keyboard: { snapShortcuts: false, historyShortcuts: false, tabShortcuts: false },
}

const TerminalPage = lazy(() => import('./TerminalPage'))
const appIds = Object.keys(apps) as AppId[]
const shortcutPreference = 'godesk-extension-shortcuts'
const legacyShortcutPreference = 'react-web-desktop-extension-shortcuts'
const pinnedAppsKey = 'godesk-pinned-apps'
const defaultPinnedApps: AppId[] = ['files', 'editor', 'terminal', 'monitor', 'services']

function readPinnedApps(): AppId[] {
  try {
    const stored = localStorage.getItem(pinnedAppsKey)
    if (stored !== null) {
      const value: unknown = JSON.parse(stored)
      if (Array.isArray(value)) {
        return [...new Set(value.filter((id): id is AppId => typeof id === 'string' && Object.hasOwn(apps, id)))]
      }
    }
  } catch {
    // Start with the default pins when storage is unavailable or invalid.
  }
  return defaultPinnedApps
}

function savePinnedApps(pinnedApps: AppId[]) {
  try {
    localStorage.setItem(pinnedAppsKey, JSON.stringify(pinnedApps))
  } catch {
    // Pins still work for the current page without storage.
  }
}

function readExtensionShortcuts(): string[] {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(shortcutPreference) ?? localStorage.getItem(legacyShortcutPreference) ?? '[]',
    )
    return Array.isArray(value) ? [...new Set(value.filter(id => typeof id === 'string'))] : []
  } catch {
    return []
  }
}

function windowApp(id: string): AppId {
  if (id.startsWith('terminal-')) return 'terminal'
  if (id.startsWith('extension-')) return 'extensions'
  return id as AppId
}

function isEditableContext(target: EventTarget | null) {
  if (!(target instanceof Element)) return false
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"], .xterm, .monaco-editor'))
}

export default function App({ onLogout, onSession }: {
  onLogout: () => Promise<void>
  onSession: (session: Session) => void
}) {
  const wm = useWindowManager({ keepInViewport: true, minVisible: 164, historyLimit: 0 })
  const { ref, binder } = useDesktop(wm, workAreaOptions)
  const { windows, focusedId } = useDesktopWindows(wm)
  const hostHealth = useHostHealth()
  const running = Object.values(windows).map(win => ({
    id: win.id, appId: windowApp(win.id), title: win.title, minimized: win.stage === 'minimized',
  }))
  const [pinnedApps, setPinnedApps] = useState(readPinnedApps)
  const desktopWindows = useRef<Pick<WindowState, 'id' | 'openedSeq'>[]>([])
  const [appearanceRequest, requestAppearance] = useState(0)
  const [closingWindows, setClosingWindows] = useState<DesktopWindow[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [extensionShortcuts, setExtensionShortcuts] = useState(readExtensionShortcuts)
  const [startOpen, setStartOpen] = useState(false)
  const [query, setQuery] = useState('')
  const { plugins, loadError, load: loadExtensions } = useExtensionCatalog(
    extensionShortcuts.length > 0 || Boolean(windows.extensions) || startOpen,
  )
  const webShortcuts = useWebShortcuts()
  const startButton = useRef<HTMLButtonElement>(null)
  const startSearch = useRef<HTMLInputElement>(null)
  const logoutDialog = useRef<HTMLDialogElement>(null)
  const [logoutPending, setLogoutPending] = useState(false)
  const [logoutError, setLogoutError] = useState('')
  const pendingWindowFocus = useRef<string | null>(null)
  const [notifications, setNotifications] = useState<DesktopNotification[]>([])
  const nextNotificationId = useRef(0)
  const editor = useRef<EditorWindowHandle>(null)
  const [editorRequest, setEditorRequest] = useState<EditorOpenRequest>()
  const [wallpaper, setWallpaper] = useState(getWallpaperPreference)

  useEffect(() => savePinnedApps(pinnedApps), [pinnedApps])
  useEffect(() => subscribeWallpaper(() => setWallpaper(getWallpaperPreference())), [])

  const togglePinApp = useCallback((id: AppId) => {
    setPinnedApps(current => current.includes(id) ? current.filter(appId => appId !== id) : [...current, id])
  }, [])

  const readNotifications = useCallback(() => {
    setNotifications(current => current.map(item => item.read ? item : { ...item, read: true }))
  }, [])

  function notify(message: string, kind: DesktopNotification['kind'] = 'error') {
    const notification = { id: ++nextNotificationId.current, message, kind, createdAt: Date.now(), read: false }
    setNotifications(current => [notification, ...current])
  }

  function showDesktop() {
    const state = wm.getState()
    const visible = state.order.map(id => state.windows[id]).filter(win => win.stage !== 'minimized')
    if (visible.length) {
      desktopWindows.current = visible.map(({ id, openedSeq }) => ({ id, openedSeq }))
      for (const { id } of visible) wm.minimize(id)
      return
    }
    const restore = desktopWindows.current
    desktopWindows.current = []
    for (const { id, openedSeq } of restore) {
      if (state.windows[id]?.openedSeq === openedSeq) wm.restore(id)
    }
  }

  function closeTaskWindow(id: string) {
    if (id === 'editor') {
      if (wm.getState().windows[id]?.stage === 'minimized') wm.restore(id)
      editor.current?.requestClose()
    } else {
      wm.close(id)
    }
  }

  function openAppearance() {
    openWindow('settings')
    requestAppearance(current => current + 1)
  }

  useLayoutEffect(() => {
    if (!appearanceRequest) return
    const settings = document.querySelector<HTMLElement>('[data-wm-window="settings"]:not([inert])')
    settings?.focus({ preventScroll: true })
    // Use the settings page's existing category action in both split and narrow layouts.
    const categories = settings?.querySelectorAll<HTMLButtonElement>('.settings-category')
    Array.from(categories ?? []).find(button => button.textContent?.trim() === '外观')?.click()
  }, [appearanceRequest])

  useEffect(() => {
    try {
      localStorage.setItem(shortcutPreference, JSON.stringify(extensionShortcuts))
    } catch {
      // Shortcuts still work for the current page without storage.
    }
  }, [extensionShortcuts])

  const removeClosingWindow = useCallback((openedSeq: number) => {
    setClosingWindows(current => current.filter(win => win.openedSeq !== openedSeq))
  }, [])

  // WMKit removes the live window immediately. React keeps its inert DOM for the fade.
  useLayoutEffect(() => wm.on('close', ({ window: win }) => {
    const node = document.querySelector<HTMLElement>(`[data-wm-window="${win.id}"]`)
    if (!node) return
    if (!wm.getState().focusedId && node.contains(document.activeElement)) startButton.current?.focus()
    if (!node.hidden && !prefersReducedMotion(window)) setClosingWindows(current => [...current, win])
  }), [wm])

  useEffect(() => {
    let resize: {
      pointer: number; element: HTMLElement; id: string; group: string; bounds: WindowState['bounds']
    } | undefined

    function startResize(event: PointerEvent) {
      if (event.button !== 0 || !(event.target instanceof Element)) return
      const element = event.target.closest('[data-wm-resize]')?.closest<HTMLElement>('[data-app-window]')
      const id = element?.dataset.wmWindow
      if (!element || !id) return
      const win = wm.getState().windows[id]
      if (win?.stage !== 'normal') return
      resize = {
        pointer: event.pointerId, element, id, bounds: win.bounds,
        group: windowSizeGroup(windowApp(id)),
      }
    }

    function finishResize(event: PointerEvent) {
      if (resize?.pointer !== event.pointerId) return
      const { element, id, group, bounds } = resize
      resize = undefined
      if (event.type !== 'pointerup' || !element.hasAttribute('data-wm-resizing')) return
      // WMKit applies the final pointer position in its pointerup handler.
      window.setTimeout(() => {
        const win = wm.getState().windows[id]
        if (!element.isConnected || win?.stage !== 'normal') return
        const { width, height } = win.bounds
        if (width === bounds.width && height === bounds.height) return
        saveWindowSize(group, { width, height })
      }, 0)
    }

    window.addEventListener('pointerdown', startResize, true)
    window.addEventListener('pointerup', finishResize, true)
    window.addEventListener('pointercancel', finishResize, true)
    return () => {
      window.removeEventListener('pointerdown', startResize, true)
      window.removeEventListener('pointerup', finishResize, true)
      window.removeEventListener('pointercancel', finishResize, true)
    }
  }, [wm])

  useLayoutEffect(() => {
    if (startOpen) {
      startSearch.current?.focus()
    } else if (pendingWindowFocus.current) {
      const id = pendingWindowFocus.current
      pendingWindowFocus.current = null
      document.querySelector<HTMLElement>(`[data-wm-window="${id}"]`)?.focus()
    }
  }, [startOpen])

  useEffect(() => {
    function handleLauncherShortcut(event: KeyboardEvent) {
      if (event.isComposing || event.defaultPrevented) return
      const isCtrlK = (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k'
      const isAltSpace = event.altKey && !event.ctrlKey && !event.metaKey && event.code === 'Space'
      if (!isCtrlK && !isAltSpace) return
      if (isCtrlK && isEditableContext(event.target) && !startOpen) return
      event.preventDefault()
      setStartOpen(current => {
        if (current) {
          startButton.current?.focus()
          return false
        }
        setQuery('')
        return true
      })
    }

    document.addEventListener('keydown', handleLauncherShortcut)
    return () => document.removeEventListener('keydown', handleLauncherShortcut)
  }, [startOpen])

  useEffect(() => {
    if (!startOpen) return

    function dismissOutside(event: PointerEvent) {
      if (!(event.target instanceof Element)) return
      if (!event.target.closest('[data-start-ui], [role="menu"]')) setStartOpen(false)
    }

    function dismissWithEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return
      startButton.current?.focus()
      setStartOpen(false)
    }

    document.addEventListener('pointerdown', dismissOutside)
    document.addEventListener('keydown', dismissWithEscape)
    return () => {
      document.removeEventListener('pointerdown', dismissOutside)
      document.removeEventListener('keydown', dismissWithEscape)
    }
  }, [startOpen])

  function openApp(id: AppId) {
    if (id === 'terminal') {
      setStartOpen(false)
      void launchTerminal()
      return
    }
    if (id === 'extensions' && extensionShortcuts.length > 0) void loadExtensions()
    openWindow(id)
  }

  function openWindow(appId: AppId, id: string = appId, title = apps[appId].name, meta?: WindowState['meta']) {
    const { windows: openWindows, viewport } = wm.getState()
    if (openWindows[id]) {
      wm.focus(id)
    } else {
      setClosingWindows(current => current.some(win => win.id === id) ? current.filter(win => win.id !== id) : current)
      const app = apps[appId]
      const size = readWindowSize(windowSizeGroup(appId)) ?? app
      const width = Math.max(minimumWindowWidth, Math.min(size.width, viewport.width - 24))
      const height = Math.max(minimumWindowHeight, Math.min(size.height, viewport.height - 24))
      const offset = (Object.keys(openWindows).length % 5) * 25
      wm.open({
        id, title, width, height, meta,
        x: Math.min(Math.max(0, viewport.width - width), Math.max(12, (viewport.width - width) / 2 - 42 + offset)),
        y: Math.min(Math.max(0, viewport.height - height), Math.max(12, (viewport.height - height) / 2 - 38 + offset)),
        minWidth: minimumWindowWidth, minHeight: minimumWindowHeight,
      })
    }
    if (startOpen) pendingWindowFocus.current = id
    setStartOpen(false)
  }

  function openExtension(plugin: ExtensionPlugin, target: 'desktop' | 'tab' = 'desktop') {
    if (!plugin.enabled || plugin.status !== 'running') {
      notify(`「${plugin.name}」未运行，请在「扩展」中启用或启动。`)
      setStartOpen(false)
      return
    }
    if (target === 'tab') {
      setStartOpen(false)
      window.open(extensionWebPath(plugin.id), '_blank', 'noopener')
      return
    }
    openWindow('extensions', `extension-${plugin.id}`, plugin.name, { extensionId: plugin.id })
  }

  function setExtensionShortcut(id: string, pinned: boolean) {
    setExtensionShortcuts(current => {
      if (pinned) return current.includes(id) ? current : [id, ...current]
      return current.includes(id) ? current.filter(shortcut => shortcut !== id) : current
    })
    if (!pinned) setSelected(current => current === `extension-${id}` ? null : current)
  }

  function openSession(session: TerminalSession, takeControl = false) {
    const id = terminalWindowId(session.id)
    const existing = wm.getState().windows[id]
    if (existing) {
      if (takeControl) {
        wm.update(id, { meta: {
          ...existing.meta, controlRequest: Number(existing.meta.controlRequest) + 1,
        } })
      }
      openWindow('terminal', id)
      return
    }
    openWindow('terminal', id, session.name, { session, clientId: terminalClientId(), controlRequest: Number(takeControl) })
  }

  async function launchTerminal() {
    try {
      openSession(await terminalApi.create())
    } catch {
      notify('无法新建终端，请重试')
    }
  }

  function openTextFile(path: string, elevated: boolean, readOnly: boolean) {
    setEditorRequest({ path, elevated, readOnly })
    openApp('editor')
  }

  function closeEditor() {
    setEditorRequest(undefined)
    wm.close('editor')
  }

  function renderApp(id: AppId, win: DesktopWindow, closing: boolean) {
    if (id === 'files') return <FileManager onOpenText={openTextFile} />
    if (id === 'editor') return (
      <TextEditorApp ref={closing ? null : editor}
        openRequest={editorRequest} onClose={closeEditor} />
    )
    if (id === 'sessions') return (
      <TerminalSessions active={!closing && win.stage !== 'minimized'} windows={windows}
        onOpen={openSession}
        onRename={session => wm.update(terminalWindowId(session.id), { title: session.name })} />
    )
    if (id === 'terminal') return (
      <Suspense fallback={<p className="app-body" role="status">正在打开终端…</p>}>
        <TerminalPage session={win.meta.session as TerminalSession} clientId={win.meta.clientId as string}
          controlRequest={Number(win.meta.controlRequest)}
          active={!closing && focusedId === win.id && win.stage !== 'minimized'} closing={closing} />
      </Suspense>
    )
    if (id === 'services') return (
      <apps.services.Content active={!closing && win.stage !== 'minimized'} />
    )
    if (id === 'settings') return <apps.settings.Content onSession={onSession} />
    if (id === 'icons') return <IconManager {...webShortcuts} />
    if (id === 'extensions') {
      const extensionId = win.meta.extensionId
      if (typeof extensionId === 'string') {
        // Unmounting the iframe on close ends only this window's subscription.
        return closing ? null : <ExtensionWindow plugin={{ id: extensionId, name: win.title }} />
      }
      return <Extensions plugins={plugins} loadError={loadError} load={loadExtensions}
        shortcuts={extensionShortcuts} onSetShortcut={setExtensionShortcut} onOpen={openExtension} />
    }
    const { Content } = apps[id]
    return <Content />
  }

  async function confirmLogout() {
    setLogoutPending(true)
    setLogoutError('')
    try {
      await onLogout()
    } catch {
      setLogoutError('无法退出登录，请重试')
    } finally {
      setLogoutPending(false)
    }
  }

  const pluginShortcuts = extensionShortcuts.flatMap(id => {
    const plugin = plugins?.find(plugin => plugin.id === id && plugin.hasWeb)
    return plugin ? [plugin] : []
  })
  const shortcuts: DesktopShortcutItem[] = [
    ...(webShortcuts.items ?? []).map(item => ({
      id: `web-shortcut-${item.id}`, name: item.name, appId: 'web-shortcut' as const,
      open: () => openWebShortcut(item.id),
    })),
    ...pluginShortcuts.map(plugin => ({
      id: `extension-${plugin.id}`, name: plugin.name, appId: 'extensions' as const,
      open: () => openExtension(plugin), plugin,
    })),
    ...appIds.map(id => ({ id, name: apps[id].name, appId: id, open: () => openApp(id) })),
  ]

  return (
    <main className="desktop-shell text-godesk-body" data-wallpaper={wallpaper} aria-label="goDesk 桌面">
      <DesktopSurface
        workAreaRef={ref}
        shortcuts={shortcuts}
        wallpaper={wallpaper}
        selected={selected}
        onSelect={setSelected}
        onClearStartMenu={() => setStartOpen(false)}
        onOpenTerminal={() => openApp('terminal')}
        onOpenAppearance={openAppearance}
        onOpenExtension={openExtension}
        onRemoveExtensionShortcut={id => setExtensionShortcut(id, false)}
      >
        {[...Object.values(windows), ...closingWindows].map(win => {
          const id = windowApp(win.id)
          const closing = windows[win.id]?.openedSeq !== win.openedSeq
          return (
            <AppWindow key={win.openedSeq} binder={binder} win={win} appId={id} closing={closing}
              onRequestClose={id === 'editor' ? () => editor.current?.requestClose() : undefined}
              onExited={removeClosingWindow}>
              {renderApp(id, win, closing)}
            </AppWindow>
          )
        })}
      </DesktopSurface>

      <StartMenu
        open={startOpen}
        query={query}
        onQueryChange={setQuery}
        searchRef={startSearch}
        pinnedApps={pinnedApps}
        togglePinApp={togglePinApp}
        plugins={plugins}
        webShortcuts={webShortcuts.items}
        host={hostHealth.snapshot?.host}
        onOpenApp={openApp}
        onOpenExtension={openExtension}
        onOpenWebShortcut={id => {
          setStartOpen(false)
          openWebShortcut(id)
        }}
        onOpenSettings={() => openWindow('settings')}
        onRequestLogout={() => {
          logoutDialog.current?.showModal()
          setStartOpen(false)
        }}
      />

      <Taskbar running={running} focusedId={focusedId} pinnedApps={pinnedApps} togglePinApp={togglePinApp}
        startOpen={startOpen} startButton={startButton}
        health={hostHealth}
        onStart={() => {
          if (!startOpen) setQuery('')
          setStartOpen(value => !value)
        }}
        onSearch={() => {
          if (startOpen) startSearch.current?.focus({ preventScroll: true })
          else {
            setQuery('')
            setStartOpen(true)
          }
        }}
        onLaunchApp={openApp}
        onToggleApp={id => {
          if (wm.getState().focusedId === id) wm.minimize(id)
          else wm.focus(id)
        }}
        onMinimize={id => wm.minimize(id)}
        onRestore={id => wm.restore(id)}
        onCloseWindow={closeTaskWindow}
        onShowDesktop={showDesktop}
        onOpenPopup={() => setStartOpen(false)}
        onOpenMonitor={() => openWindow('monitor')}
        onOpenAppearance={openAppearance}
        notifications={notifications} onReadNotifications={readNotifications}
        onDismissNotification={id => setNotifications(current => current.filter(item => item.id !== id))}
        onClearNotifications={() => setNotifications([])} />

      <dialog ref={logoutDialog} className="service-dialog" aria-labelledby="logout-dialog-title"
        aria-describedby="logout-dialog-message" onClose={() => {
          setLogoutError('')
          startButton.current?.focus()
        }}>
        <div className="service-dialog-body">
          <h2 id="logout-dialog-title">退出登录？</h2>
          <p id="logout-dialog-message">退出后将关闭所有窗口并清除草稿。终端会话会继续运行。</p>
          {logoutError && <p className="authentication-error" role="alert">{logoutError}</p>}
        </div>
        <div className="service-dialog-actions">
          <button className="app-control" type="button" onClick={() => logoutDialog.current?.close()}>取消</button>
          <button className="app-control danger-control" type="button" disabled={logoutPending} onClick={confirmLogout}>退出登录</button>
        </div>
      </dialog>
    </main>
  )
}
