import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import type { WindowState } from '@surdeddd/wmkit'
import { useDesktop, useWindowManager, useWmState, useWmWindowRef } from '@surdeddd/wmkit/react'
import { glassTheme } from '@surdeddd/wmkit/themes'
import {
  ExternalLink, Globe, Image, LogOut, Minus, MonitorX, PanelTop, RefreshCw, Search, Square, SquaresSubtract, X,
} from 'lucide-react'
import { apps, type AppId } from './apps.ts'
import type { Session } from './auth'
import { CommandMenu, type MenuAnchor } from './CommandMenu'
import { FileManager } from './FileManager'
import { IconManager } from './IconManager'
import { TextEditorApp, type EditorOpenRequest, type EditorWindowHandle } from './TextEditorApp'
import { Taskbar } from './Taskbar'
import { TerminalSessions } from './TerminalSessions'
import { Extensions } from './extensions/Extensions'
import { ExtensionWindow } from './extensions/ExtensionWindow'
import { extensionWebPath, type ExtensionPlugin } from './extensions/api'
import { useExtensionCatalog } from './extensions/useExtensionCatalog'
import { terminalApi, terminalClientId, terminalWindowId, type TerminalSession } from './terminal'
import { openWebShortcut, useWebShortcuts } from './webShortcuts'
import { minimumWindowHeight, minimumWindowWidth, readWindowSize, saveWindowSize, windowSizeGroup } from './windowSize.ts'
import './App.css'

const workAreaOptions = {
  animation: false,
  snap: false,
  grouping: false,
  magnetism: false,
  keyboard: { snapShortcuts: false, historyShortcuts: false, tabShortcuts: false },
}

const TerminalPage = lazy(() => import('./TerminalPage'))
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
const appIds = Object.keys(apps) as AppId[]
const previewGlass = new URLSearchParams(window.location.search).get('window-theme') === 'glass'
const shortcutPreference = 'react-web-desktop-extension-shortcuts'

function readExtensionShortcuts(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(shortcutPreference) ?? '[]')
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

function windowMotionDuration(style: CSSStyleDeclaration, token: 'overlay' | 'feedback') {
  const duration = style.getPropertyValue(`--react-web-desktop-duration-${token}`).trim()
  return Number.parseFloat(duration) * (duration.endsWith('ms') ? 1 : 1000)
}

function LauncherIcon({ id }: { id: AppId | 'web-shortcut' }) {
  const { icon: Icon, launcherIcon } = id === 'web-shortcut' ? { icon: Globe, launcherIcon: undefined } : apps[id]
  return (
    <span className="shortcut-tile" data-glyph={launcherIcon ? undefined : id} aria-hidden="true">
      {launcherIcon && <img src={launcherIcon} alt="" width={42} height={42} />}
      <Icon className={launcherIcon ? 'shortcut-tile-fallback' : undefined} size={24} strokeWidth={1.75} />
    </span>
  )
}

function AppWindow({ binder, win, appId, closing, children, onRequestClose, onExited }: {
  binder: ReturnType<typeof useDesktop>['binder']
  win: WindowState
  appId: AppId
  closing: boolean
  children: ReactNode
  onRequestClose?: () => void
  onExited: (openedSeq: number) => void
}) {
  const bindWindow = useWmWindowRef(binder, win.id)
  const element = useRef<HTMLElement>(null)
  const entrance = useRef<Animation>(null)
  const ref = useCallback((node: HTMLElement | null) => {
    element.current = node
    if (!closing) bindWindow(node)
  }, [bindWindow, closing])
  const { icon: Icon } = apps[appId]
  const maximized = win.stage === 'maximized'
  const MaximizeIcon = maximized ? SquaresSubtract : Square

  useLayoutEffect(() => {
    const node = element.current
    if (!node || reducedMotion.matches) return

    // WMKit owns transform. The individual translate property adds the entry offset.
    const animation = node.animate([
      { opacity: 0, translate: '0 8px' },
      { opacity: 1, translate: '0 0' },
    ], { duration: windowMotionDuration(getComputedStyle(node), 'overlay'), easing: 'ease-out', fill: 'backwards' })
    entrance.current = animation

    function reduceMotion(event: MediaQueryListEvent) {
      if (event.matches) animation.cancel()
    }

    reducedMotion.addEventListener('change', reduceMotion)
    return () => {
      reducedMotion.removeEventListener('change', reduceMotion)
      animation.cancel()
    }
  }, [])

  useLayoutEffect(() => {
    if (!closing && win.stage !== 'normal') entrance.current?.cancel()
  }, [closing, win.stage])

  useLayoutEffect(() => {
    const node = element.current
    if (!closing || !node) return
    if (reducedMotion.matches) {
      onExited(win.openedSeq)
      return
    }

    const style = getComputedStyle(node)
    const { opacity, translate } = style
    entrance.current?.cancel()
    const animation = node.animate([
      { opacity, translate },
      { opacity: 0, translate },
    ], { duration: windowMotionDuration(style, 'feedback'), easing: 'ease-out', fill: 'forwards' })
    let active = true
    function finish() {
      if (active) onExited(win.openedSeq)
    }
    function reduceMotion(event: MediaQueryListEvent) {
      if (event.matches) finish()
    }

    void animation.finished.then(finish, finish)
    reducedMotion.addEventListener('change', reduceMotion)
    return () => {
      active = false
      reducedMotion.removeEventListener('change', reduceMotion)
      animation.cancel()
    }
  }, [closing, onExited, win.openedSeq])

  return (
    <section ref={ref} className="app-window" tabIndex={-1} aria-label={win.title} data-app-window={appId}
      inert={closing} data-wm-window={closing && previewGlass ? '' : undefined}>
      <header className="titlebar" data-wm-drag>
        <span className="flex min-w-0 items-center gap-2">
          <Icon className={`app-icon ${appId}`} size={16} />
          <span data-wm-title className="truncate">{win.title}</span>
        </span>
        <span className="window-controls" data-wm-controls>
          <button data-wm-minimize aria-label="最小化" title="最小化"><Minus size={16} /></button>
          <button data-wm-maximize aria-label={maximized ? '还原' : '最大化'} title={maximized ? '还原' : '最大化'}>
            <MaximizeIcon size={14} />
          </button>
          <button data-wm-close aria-label="关闭" title="关闭" onClickCapture={onRequestClose && (event => {
            event.stopPropagation()
            onRequestClose()
          })}><X size={17} /></button>
        </span>
      </header>
      <div className="window-content" data-wm-content>
        {children}
      </div>
    </section>
  )
}

export default function App({ onLogout, onSession }: {
  onLogout: () => Promise<void>
  onSession: (session: Session) => void
}) {
  const wm = useWindowManager({ keepInViewport: true, minVisible: 164, historyLimit: 0 })
  const { ref, binder } = useDesktop(wm, workAreaOptions)
  const { windows, focusedId } = useWmState(wm)
  const running = Object.values(windows).map(win => ({ id: win.id, appId: windowApp(win.id), title: win.title }))
  const [closingWindows, setClosingWindows] = useState<WindowState[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [extensionShortcuts, setExtensionShortcuts] = useState(readExtensionShortcuts)
  const { plugins, loadError, load: loadExtensions } = useExtensionCatalog(
    extensionShortcuts.length > 0 || Boolean(windows.extensions),
  )
  const webShortcuts = useWebShortcuts()
  const [startOpen, setStartOpen] = useState(false)
  const [query, setQuery] = useState('')
  const startButton = useRef<HTMLButtonElement>(null)
  const startSearch = useRef<HTMLInputElement>(null)
  const logoutDialog = useRef<HTMLDialogElement>(null)
  const [logoutPending, setLogoutPending] = useState(false)
  const [logoutError, setLogoutError] = useState('')
  const pendingWindowFocus = useRef<string | null>(null)
  const [launchError, setLaunchError] = useState('')
  const editor = useRef<EditorWindowHandle>(null)
  const [editorRequest, setEditorRequest] = useState<EditorOpenRequest>()

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
    if (!node.hidden && !reducedMotion.matches) setClosingWindows(current => [...current, win])
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
  const [context, setContext] = useState<(MenuAnchor & { pluginId?: string }) | null>(null)
  const [wallpaper, setWallpaper] = useState<'iris' | 'graphite' | 'lavender'>('iris')

  useEffect(() => {
    if (!startOpen) return

    function dismissOutside(event: PointerEvent) {
      if (!(event.target instanceof Element)) return
      if (!event.target.closest('[data-start-ui]')) setStartOpen(false)
    }

    function dismissWithEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.isComposing) return
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
        minWidth: minimumWindowWidth, minHeight: minimumWindowHeight, snappable: false,
      })
    }
    if (startOpen) pendingWindowFocus.current = id
    setStartOpen(false)
  }

  function openExtension(plugin: ExtensionPlugin, target: 'desktop' | 'tab' = 'desktop') {
    setLaunchError('')
    if (!plugin.enabled || plugin.status !== 'running') {
      setLaunchError(`「${plugin.name}」未运行，请在「扩展」中启用或启动。`)
      return
    }
    if (target === 'tab') {
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
    setLaunchError('')
    try {
      openSession(await terminalApi.create())
    } catch {
      setLaunchError('无法新建终端，请重试')
    }
  }

  function openDesktopMenu(anchor: MenuAnchor) {
    setSelected(null)
    setStartOpen(false)
    setContext(anchor)
  }

  function openShortcutMenu(anchor: MenuAnchor, pluginId: string) {
    setSelected(`extension-${pluginId}`)
    setStartOpen(false)
    setContext({ ...anchor, pluginId })
  }

  function openTextFile(path: string, elevated: boolean, readOnly: boolean) {
    setEditorRequest({ path, elevated, readOnly })
    openApp('editor')
  }

  function closeEditor() {
    setEditorRequest(undefined)
    wm.close('editor')
  }

  function renderApp(id: AppId, win: WindowState, closing: boolean) {
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

  function showContextMenu(event: MouseEvent<HTMLElement>) {
    if (!(event.target instanceof Element) || event.target.closest('.shortcut, .app-window')) return
    event.preventDefault()
    openDesktopMenu({ source: event.currentTarget, point: { x: event.clientX, y: event.clientY } })
  }

  const search = query.trim().toLowerCase()
  const results = appIds.filter(id => apps[id].name.includes(search) || id.includes(search))
  const pluginShortcuts = extensionShortcuts.flatMap(id => {
    const plugin = plugins?.find(plugin => plugin.id === id && plugin.hasWeb)
    return plugin ? [plugin] : []
  })
  const shortcuts = [
    ...(webShortcuts.items ?? []).map(item => ({
      id: `web-shortcut-${item.id}`, name: item.name, appId: 'web-shortcut' as const,
      open: () => openWebShortcut(item.id), plugin: undefined,
    })),
    ...pluginShortcuts.map(plugin => ({
      id: `extension-${plugin.id}`, name: plugin.name, appId: 'extensions' as const,
      open: () => openExtension(plugin), plugin,
    })),
    ...appIds.map(id => ({ id, name: apps[id].name, appId: id, open: () => openApp(id), plugin: undefined })),
  ]
  const contextPlugin = context?.pluginId ? pluginShortcuts.find(plugin => plugin.id === context.pluginId) : undefined
  const contextBoundary = context?.pluginId ? context.source.closest<HTMLElement>('.work-area') : context?.source

  return (
    <main className="desktop-shell text-react-web-desktop-body" data-wallpaper={wallpaper} aria-label="React Web Desktop 桌面">
      {previewGlass && <style>{glassTheme}</style>}
      <div className="wallpaper" aria-hidden="true">{wallpaper !== 'lavender' && <><i /><i /><i /></>}</div>
      <div
        ref={ref}
        className="work-area"
        tabIndex={0}
        role="group"
        aria-label="桌面工作区"
        data-window-theme={previewGlass ? 'glass' : undefined}
        onContextMenu={showContextMenu}
        onKeyDown={event => {
          if (event.target !== event.currentTarget || event.nativeEvent.isComposing ||
            !(event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10')) return
          event.preventDefault()
          const bounds = event.currentTarget.getBoundingClientRect()
          openDesktopMenu({ source: event.currentTarget, point: { x: bounds.left + 12, y: bounds.top + 12 } })
        }}
        onClick={event => { if (event.target instanceof Element && !event.target.closest('.shortcut, .app-window')) setSelected(null) }}
      >
        <nav className="shortcut-list" aria-label="桌面快捷方式">
          {shortcuts.map(({ id, name, appId, open, plugin }) => (
            <button
              key={id}
              className="shortcut"
              aria-pressed={selected === id}
              onClick={event => {
                setSelected(id)
                const nativeEvent = event.nativeEvent
                const touch = nativeEvent instanceof PointerEvent && nativeEvent.pointerType === 'touch'
                if (event.detail === 0 || touch && (plugin || appId === 'web-shortcut')) open()
              }}
              onDoubleClick={open}
              onContextMenu={plugin && (event => {
                event.preventDefault()
                event.stopPropagation()
                openShortcutMenu({ source: event.currentTarget, point: { x: event.clientX, y: event.clientY } }, plugin.id)
              })}
              onKeyDown={plugin && (event => {
                if (event.nativeEvent.isComposing || !(event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10')) return
                event.preventDefault()
                openShortcutMenu({ source: event.currentTarget }, plugin.id)
              })}
            >
              <LauncherIcon id={appId} />
              <span>{name}</span>
            </button>
          ))}
        </nav>
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
      </div>

      {launchError && (
        <div className="desktop-alert">
          <span role="alert">{launchError}</span>
          <button className="app-control" type="button" aria-label="关闭提示" onClick={() => setLaunchError('')}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      )}

      {context && contextBoundary && (!context.pluginId || contextPlugin) && (
        <CommandMenu key={contextPlugin ? `extension-${contextPlugin.id}` : 'desktop'}
          label={contextPlugin ? `${contextPlugin.name}快捷方式操作` : '桌面操作'}
          anchor={context} layer={contextBoundary.parentElement!} boundary={contextBoundary} zIndex={2}
          groups={contextPlugin ? [[
            { label: '打开', icon: PanelTop, run: () => openExtension(contextPlugin) },
            { label: '在新标签页打开', icon: ExternalLink, run: () => openExtension(contextPlugin, 'tab') },
            { label: '移除桌面快捷方式', icon: MonitorX, run: () => setExtensionShortcut(contextPlugin.id, false) },
          ]] : [
            [{ label: '刷新', icon: RefreshCw, run: () => window.location.reload() }],
            [
              { label: '使用暮紫壁纸', icon: Image, checked: wallpaper === 'lavender',
                run: () => setWallpaper(current => current === 'lavender' ? 'iris' : 'lavender') },
              { label: '使用灰阶壁纸', icon: Image, checked: wallpaper === 'graphite',
                run: () => setWallpaper(current => current === 'graphite' ? 'iris' : 'graphite') },
            ],
          ]}
          onClose={() => setContext(null)}
          restoreFocus={() => (context.source.isConnected ? context.source : contextBoundary).focus({ preventScroll: true })} />
      )}

      <section id="start-menu" className="start-menu" data-start-ui aria-label="开始菜单"
        data-open={startOpen} inert={!startOpen}>
        <form className="start-search" role="search" onKeyDown={event => {
          if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault()
        }} onSubmit={event => {
          event.preventDefault()
          if (results.length === 1) openApp(results[0])
        }}>
          <Search size={17} aria-hidden="true" />
          <input ref={startSearch} type="search" value={query} onChange={event => setQuery(event.target.value)}
            placeholder="搜索应用" aria-label="搜索应用" />
        </form>
        <h2>应用</h2>
        <div className="start-apps">
          {results.map(id => {
            const { name } = apps[id]
            return (
              <button key={id} onClick={() => openApp(id)}>
                <LauncherIcon id={id} />
                {name}
              </button>
            )
          })}
          {results.length === 0 && <p className="muted">未找到应用</p>}
        </div>
        <footer className="start-menu-footer">
          <button className="app-control" type="button" aria-haspopup="dialog" onClick={() => {
            logoutDialog.current?.showModal()
            setStartOpen(false)
          }}>
            <LogOut size={16} aria-hidden="true" />
            退出登录
          </button>
        </footer>
      </section>

      <Taskbar running={running} focusedId={focusedId} startOpen={startOpen} startButton={startButton}
        onStart={() => {
          if (!startOpen) setQuery('')
          setStartOpen(value => !value)
        }}
        onToggleApp={id => {
          if (wm.getState().focusedId === id) wm.minimize(id)
          else wm.focus(id)
        }}
        onOpenPopup={() => setStartOpen(false)}
        onOpenMonitor={() => openWindow('monitor')} />

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
