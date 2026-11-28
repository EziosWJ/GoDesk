import { useState, type MouseEvent, type ReactNode } from 'react'
import { ExternalLink, Image, MonitorX, Palette, PanelTop, RefreshCw, Terminal } from 'lucide-react'
import { AppIcon, type AppIconId } from './AppIcon'
import { CommandMenu, type MenuAnchor } from './CommandMenu'
import { localizedPluginName, type ExtensionPlugin } from './extensions/api'
import { setWallpaperPreference, wallpaperIds, wallpapers, type WallpaperId } from './wallpapers'

export type DesktopShortcutItem = {
  id: string
  name: string
  appId: AppIconId
  open: () => void
  plugin?: ExtensionPlugin
}

export function DesktopSurface({
  workAreaRef,
  shortcuts,
  wallpaper,
  selected,
  onSelect,
  onClearStartMenu,
  onOpenTerminal,
  onOpenAppearance,
  onOpenExtension,
  onRemoveExtensionShortcut,
  children,
}: {
  workAreaRef: (node: HTMLElement | null) => void
  shortcuts: DesktopShortcutItem[]
  wallpaper: WallpaperId
  selected: string | null
  onSelect: (id: string | null) => void
  onClearStartMenu: () => void
  onOpenTerminal: () => void
  onOpenAppearance: () => void
  onOpenExtension: (plugin: ExtensionPlugin, target?: 'desktop' | 'tab') => void
  onRemoveExtensionShortcut: (id: string) => void
  children: ReactNode
}) {
  const [context, setContext] = useState<(MenuAnchor & { pluginId?: string }) | null>(null)

  function openDesktopMenu(anchor: MenuAnchor) {
    onSelect(null)
    onClearStartMenu()
    setContext(anchor)
  }

  function openShortcutMenu(anchor: MenuAnchor, pluginId: string) {
    onSelect(`extension-${pluginId}`)
    onClearStartMenu()
    setContext({ ...anchor, pluginId })
  }

  function handleContextMenu(event: MouseEvent<HTMLElement>) {
    if (!(event.target instanceof Element) || event.target.closest('.shortcut, .app-window')) return
    event.preventDefault()
    openDesktopMenu({ source: event.currentTarget, point: { x: event.clientX, y: event.clientY } })
  }

  const contextPlugin = context?.pluginId
    ? shortcuts.find(item => item.plugin?.id === context.pluginId)?.plugin
    : undefined
  const contextBoundary = context?.pluginId
    ? context.source.closest<HTMLElement>('.work-area')
    : context?.source

  return (
    <>
      <div className="wallpaper" aria-hidden="true" />
      <div
        ref={workAreaRef}
        className="work-area"
        tabIndex={0}
        role="group"
        aria-label="桌面工作区"
        onContextMenu={handleContextMenu}
        onKeyDown={event => {
          if (event.target !== event.currentTarget || event.nativeEvent.isComposing ||
            !(event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10')) return
          event.preventDefault()
          const bounds = event.currentTarget.getBoundingClientRect()
          openDesktopMenu({ source: event.currentTarget, point: { x: bounds.left + 12, y: bounds.top + 12 } })
        }}
        onClick={event => {
          if (event.target instanceof Element && !event.target.closest('.shortcut, .app-window')) onSelect(null)
        }}
      >
        <nav className="shortcut-list" aria-label="桌面快捷方式">
          {shortcuts.map(({ id, name, appId, open, plugin }) => (
            <button
              key={id}
              type="button"
              className="shortcut"
              aria-pressed={selected === id}
              onClick={event => {
                onSelect(id)
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
              <AppIcon id={appId} size={42} />
              <span className="shortcut-label">{name}</span>
            </button>
          ))}
        </nav>
        {children}
      </div>

      {context && contextBoundary && (!context.pluginId || contextPlugin) && (
        <CommandMenu
          key={contextPlugin ? `extension-${contextPlugin.id}` : 'desktop'}
          label={contextPlugin ? `${localizedPluginName(contextPlugin)}快捷方式操作` : '桌面操作'}
          anchor={context}
          layer={contextBoundary.parentElement!}
          boundary={contextBoundary}
          zIndex={2}
          groups={contextPlugin ? [[
            { label: '打开', icon: PanelTop, run: () => onOpenExtension(contextPlugin) },
            { label: '在新标签页打开', icon: ExternalLink, run: () => onOpenExtension(contextPlugin, 'tab') },
            { label: '移除桌面快捷方式', icon: MonitorX, run: () => onRemoveExtensionShortcut(contextPlugin.id) },
          ]] : [
            [
              { label: '打开终端', icon: Terminal, run: onOpenTerminal },
              { label: '刷新', icon: RefreshCw, run: () => window.location.reload() },
            ],
            wallpaperIds.map(id => ({
              label: `壁纸：${wallpapers[id].name}`,
              icon: Image,
              checked: wallpaper === id,
              run: () => setWallpaperPreference(id),
            })),
            [
              { label: '个性化设置', icon: Palette, run: onOpenAppearance },
            ],
          ]}
          onClose={() => setContext(null)}
          restoreFocus={() => (context.source.isConnected ? context.source : contextBoundary).focus({ preventScroll: true })}
        />
      )}
    </>
  )
}
