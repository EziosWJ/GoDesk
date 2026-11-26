import { useState, type RefObject } from 'react'
import { ExternalLink, Globe, LogOut, Pin, PinOff, Puzzle, Search, Server, Settings2, X } from 'lucide-react'
import { AppIcon, type AppIconId } from './AppIcon'
import { apps, type AppId } from './apps'
import { CommandMenu, type MenuAnchor } from './CommandMenu'
import type { ExtensionPlugin } from './extensions/api'
import type { HealthHost } from './health'
import type { WebShortcut } from './webShortcuts'

const appIds = Object.keys(apps) as AppId[]

type SearchResultItem = {
  key: string
  name: string
  kind: '应用' | '扩展' | '网页'
  appId: AppIconId
  external?: boolean
  open: () => void
  pinAppId?: AppId
}

export function StartMenu({
  open,
  query,
  onQueryChange,
  searchRef,
  pinnedApps,
  togglePinApp,
  plugins,
  webShortcuts,
  host,
  onOpenApp,
  onOpenExtension,
  onOpenWebShortcut,
  onOpenSettings,
  onRequestLogout,
}: {
  open: boolean
  query: string
  onQueryChange: (next: string) => void
  searchRef: RefObject<HTMLInputElement | null>
  pinnedApps: AppId[]
  togglePinApp: (id: AppId) => void
  plugins: ExtensionPlugin[] | undefined
  webShortcuts: WebShortcut[] | undefined
  host: HealthHost | undefined
  onOpenApp: (id: AppId) => void
  onOpenExtension: (plugin: ExtensionPlugin, target?: 'desktop' | 'tab') => void
  onOpenWebShortcut: (id: number) => void
  onOpenSettings: () => void
  onRequestLogout: () => void
}) {
  const [context, setContext] = useState<(MenuAnchor & { appId: AppId; layer: HTMLElement }) | null>(null)
  const search = query.trim().toLowerCase()

  const webPlugins = (plugins ?? []).filter(plugin => plugin.hasWeb)
  const shortcuts = webShortcuts ?? []

  const allItems: SearchResultItem[] = [
    ...appIds.map(id => ({
      key: `app-${id}`,
      name: apps[id].name,
      kind: '应用' as const,
      appId: id,
      open: () => onOpenApp(id),
      pinAppId: id,
    })),
    ...webPlugins.map(plugin => ({
      key: `ext-${plugin.id}`,
      name: plugin.name,
      kind: '扩展' as const,
      appId: 'extensions' as const,
      open: () => onOpenExtension(plugin),
    })),
    ...shortcuts.map(item => ({
      key: `web-${item.id}`,
      name: item.name,
      kind: '网页' as const,
      appId: 'web-shortcut' as const,
      external: true,
      open: () => onOpenWebShortcut(item.id),
    })),
  ]

  const matched = search
    ? allItems.filter(item => {
        if (item.name.toLowerCase().includes(search)) return true
        if (item.pinAppId && item.pinAppId.toLowerCase().includes(search)) return true
        if (item.key.toLowerCase().includes(search)) return true
        if (item.kind === '网页') {
          const entry = shortcuts.find(shortcut => `web-${shortcut.id}` === item.key)
          if (entry?.url.toLowerCase().includes(search)) return true
        }
        return false
      })
    : []

  const hostTitle = host?.hostname || 'goDesk 主机'
  const hostMeta = host
    ? [host.platform, host.architecture].filter(Boolean).join(' · ')
    : 'Linux Web 桌面'

  function openAppContext(anchor: MenuAnchor, appId: AppId) {
    const layer = anchor.source.closest<HTMLElement>('.desktop-shell')
    if (!layer) return
    setContext({ ...anchor, appId, layer })
  }

  return (
    <>
      <section
        id="start-menu"
        className="start-menu"
        data-start-ui
        aria-label="开始菜单"
        data-open={open}
        inert={!open}
      >
        <div className="start-menu-main">
          <form
            className="start-search"
            role="search"
            onKeyDown={event => {
              if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault()
            }}
            onSubmit={event => {
              event.preventDefault()
              if (search && matched.length === 1) matched[0].open()
            }}
          >
            <Search size={17} aria-hidden="true" />
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={event => onQueryChange(event.target.value)}
              placeholder="搜索应用、扩展与网页快捷方式"
              aria-label="搜索应用、扩展与网页快捷方式"
            />
            {query && (
              <button
                type="button"
                className="start-search-clear"
                aria-label="清除搜索"
                onClick={() => {
                  onQueryChange('')
                  searchRef.current?.focus()
                }}
              >
                <X size={14} aria-hidden="true" />
              </button>
            )}
          </form>

          {search ? (
            <div className="start-section">
              <div className="start-section-header">
                <h2>搜索结果</h2>
                <span className="start-section-count">{matched.length} 项</span>
              </div>
              {matched.length > 0 ? (
                <div className="start-results">
                  {matched.map(item => (
                    <button
                      key={item.key}
                      type="button"
                      className="start-result-item"
                      onClick={item.open}
                      onContextMenu={item.pinAppId ? event => {
                        event.preventDefault()
                        event.stopPropagation()
                        openAppContext({ source: event.currentTarget, point: { x: event.clientX, y: event.clientY } }, item.pinAppId!)
                      } : undefined}
                    >
                      <AppIcon id={item.appId} size={32} />
                      <span className="start-result-text">
                        <span className="start-result-name">{item.name}</span>
                        <span className="start-result-kind">{item.kind}</span>
                      </span>
                      {item.external && <ExternalLink size={14} className="start-result-trailing" aria-hidden="true" />}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="start-empty">未找到匹配的应用、扩展或网页快捷方式</p>
              )}
            </div>
          ) : (
            <>
              <div className="start-section">
                <div className="start-section-header">
                  <h2>系统应用</h2>
                  <span className="start-section-hint">右键可固定到任务栏</span>
                </div>
                <div className="start-apps">
                  {appIds.map(id => {
                    const pinned = pinnedApps.includes(id)
                    return (
                      <button
                        key={id}
                        type="button"
                        className="start-app-tile"
                        onClick={() => onOpenApp(id)}
                        onContextMenu={event => {
                          event.preventDefault()
                          event.stopPropagation()
                          openAppContext({ source: event.currentTarget, point: { x: event.clientX, y: event.clientY } }, id)
                        }}
                        onKeyDown={event => {
                          if (event.nativeEvent.isComposing || !(event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10')) return
                          event.preventDefault()
                          openAppContext({ source: event.currentTarget }, id)
                        }}
                      >
                        <AppIcon id={id} size={36} />
                        <span className="start-app-name">{apps[id].name}</span>
                        {pinned && <span className="start-pin-dot" title="已固定到任务栏" aria-hidden="true" />}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div className="start-section">
                <div className="start-section-header">
                  <h2>扩展与快捷方式</h2>
                  {(webPlugins.length > 0 || shortcuts.length > 0) && (
                    <span className="start-section-count">{webPlugins.length + shortcuts.length} 项</span>
                  )}
                </div>
                {webPlugins.length > 0 || shortcuts.length > 0 ? (
                  <div className="start-shortcuts-grid">
                    {webPlugins.map(plugin => (
                      <button
                        key={`ext-${plugin.id}`}
                        type="button"
                        className="start-shortcut-row"
                        onClick={() => onOpenExtension(plugin)}
                      >
                        <AppIcon id="extensions" size={28} />
                        <span className="start-result-text">
                          <span className="start-result-name">{plugin.name}</span>
                          <span className="start-result-kind">
                            {plugin.enabled && plugin.status === 'running' ? '扩展 · 运行中' : '扩展 · 未运行'}
                          </span>
                        </span>
                      </button>
                    ))}
                    {shortcuts.map(item => (
                      <button
                        key={`web-${item.id}`}
                        type="button"
                        className="start-shortcut-row"
                        onClick={() => onOpenWebShortcut(item.id)}
                      >
                        <AppIcon id="web-shortcut" size={28} />
                        <span className="start-result-text">
                          <span className="start-result-name">{item.name}</span>
                          <span className="start-result-kind">网页快捷方式</span>
                        </span>
                        <ExternalLink size={14} className="start-result-trailing" aria-hidden="true" />
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="start-empty-inline">
                    <span>暂无扩展应用或网页快捷方式</span>
                    <div className="start-empty-actions">
                      <button type="button" className="app-control" onClick={() => onOpenApp('extensions')}>
                        <Puzzle size={14} aria-hidden="true" />管理扩展
                      </button>
                      <button type="button" className="app-control" onClick={() => onOpenApp('icons')}>
                        <Globe size={14} aria-hidden="true" />图标管理
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        <footer className="start-menu-footer">
          <div className="start-host-info">
            <span className="start-host-avatar" aria-hidden="true">
              <Server size={16} />
            </span>
            <span className="start-host-text">
              <strong>{hostTitle}</strong>
              <span>{hostMeta}</span>
            </span>
          </div>
          <div className="start-footer-actions">
            <button
              type="button"
              className="app-control start-footer-icon"
              aria-label="系统设置"
              title="系统设置"
              onClick={onOpenSettings}
            >
              <Settings2 size={16} aria-hidden="true" />
            </button>
            <button
              className="app-control start-logout-button"
              type="button"
              aria-haspopup="dialog"
              onClick={onRequestLogout}
            >
              <LogOut size={15} aria-hidden="true" />
              退出登录
            </button>
          </div>
        </footer>
      </section>

      {context && (
        <CommandMenu
          key={`start-app-${context.appId}`}
          label={`${apps[context.appId].name}操作`}
          anchor={context}
          layer={context.layer}
          boundary={context.layer}
          zIndex={4}
          groups={[[
            {
              label: pinnedApps.includes(context.appId) ? '从任务栏取消固定' : '固定到任务栏',
              icon: pinnedApps.includes(context.appId) ? PinOff : Pin,
              run: () => togglePinApp(context.appId),
            },
          ]]}
          onClose={() => setContext(null)}
          restoreFocus={() => (context.source.isConnected ? context.source : searchRef.current)?.focus({ preventScroll: true })}
        />
      )}
    </>
  )
}
