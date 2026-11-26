import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type Ref } from 'react'
import { Bell, ClockAlert, Ellipsis, Minus, Pin, PinOff, Plus, Search, SlidersHorizontal, Square, Unplug, X } from 'lucide-react'
import { AppIcon } from './AppIcon'
import { apps, type AppId } from './apps'
import { CommandMenu, type MenuAnchor, type MenuGroup } from './CommandMenu'
import { HealthPanel } from './HealthPanel'
import { StatusIcon } from './HealthStatusIcon'
import { effectiveStatus, healthStatusText, normalizeStatus } from './healthUi'
import { DesktopToasts, QuickSettingsPanel, type DesktopNotification } from './QuickSettingsPanel'
import type { HostHealthState } from './useHostHealth'
import './styles/taskbar.css'

const timeFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
const dateFormat = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
const popupLabels = { windows: '更多应用', health: '主机健康', quick: '快捷控制与通知' }
const popupId = 'taskbar-popover'
const commandMenuId = 'taskbar-command-menu'

type Popup = keyof typeof popupLabels
type RunningWindow = { id: string; appId: AppId; title: string; minimized: boolean }
type Task = { key: string; appId: AppId; title: string; win?: RunningWindow }

type TaskbarProps = {
  running: RunningWindow[]
  focusedId: string | null | undefined
  pinnedApps: AppId[]
  togglePinApp: (id: AppId) => void
  startOpen: boolean
  startButton: Ref<HTMLButtonElement>
  onStart: () => void
  onSearch: () => void
  onLaunchApp: (appId: AppId) => void
  onToggleApp: (id: string) => void
  onMinimize: (id: string) => void
  onRestore: (id: string) => void
  onCloseWindow: (id: string) => void
  onShowDesktop: () => void
  onOpenPopup: () => void
  onOpenMonitor: () => void
  onOpenAppearance: () => void
  notifications: DesktopNotification[]
  onReadNotifications: () => void
  onDismissNotification: (id: number) => void
  onClearNotifications: () => void
  health: HostHealthState
}

function percentText(value: number | null | undefined) {
  return value == null || !Number.isFinite(value) ? '—' : `${Math.round(value)}%`
}

function Clock() {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  return (
    <time dateTime={now.toISOString()} className="taskbar-clock">
      <span>{timeFormat.format(now)}</span>
      <span>{dateFormat.format(now)}</span>
    </time>
  )
}

function getTasks(pinnedApps: AppId[], running: RunningWindow[]): Task[] {
  const windowTask = (win: RunningWindow): Task => ({ key: win.id, appId: win.appId, title: win.title, win })
  return [
    ...pinnedApps.flatMap((appId): Task[] => {
      const matches = running.filter(win => win.appId === appId && !win.id.startsWith('extension-'))
      return matches.length ? matches.map(windowTask) : [{ key: `pin-${appId}`, appId, title: apps[appId].name }]
    }),
    ...running.filter(win => !pinnedApps.includes(win.appId) || win.id.startsWith('extension-')).map(windowTask),
  ]
}

function partitionTasks(tasks: Task[], slots: number, focusedId: TaskbarProps['focusedId']) {
  if (tasks.length <= slots) return { visible: tasks, hidden: [] }

  const active = tasks.find(task => task.win && task.win.id === focusedId)
  // Keep the active window first in the capacity budget, then prefer idle pins.
  const priority = [...(active ? [active] : []), ...tasks.filter(task => !task.win),
    ...tasks.filter(task => task.win && task !== active)]
  const direct = new Set(priority.slice(0, Math.max(active ? 1 : 0, slots - 1)))
  return { visible: tasks.filter(task => direct.has(task)), hidden: tasks.filter(task => !direct.has(task)) }
}

export function Taskbar({
  running, focusedId, pinnedApps, togglePinApp, startOpen, startButton, onStart, onSearch,
  onLaunchApp, onToggleApp, onMinimize, onRestore, onCloseWindow, onShowDesktop, onOpenPopup, onOpenMonitor,
  onOpenAppearance, notifications, onReadNotifications, onDismissNotification, onClearNotifications, health,
}: TaskbarProps) {
  const footer = useRef<HTMLElement>(null)
  const left = useRef<HTMLDivElement>(null)
  const tray = useRef<HTMLDivElement>(null)
  const center = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLElement>(null)
  const [slots, setSlots] = useState(Infinity)
  const [popup, setPopup] = useState<Popup | null>(null)
  const [anchorX, setAnchorX] = useState(0)
  const [context, setContext] = useState<(MenuAnchor & { taskKey: string; layer: HTMLElement }) | null>(null)
  const pendingTaskFocus = useRef<string | null>(null)
  const { snapshot, connection } = health
  const tasks = getTasks(pinnedApps, running)
  const { visible, hidden } = partitionTasks(tasks, slots, focusedId)
  const contextTask = tasks.find(task => task.key === context?.taskKey)
  const contextOpen = Boolean(context && contextTask)
  const unread = notifications.some(notification => !notification.read)
  const unreadError = notifications.some(notification => !notification.read && notification.kind === 'error')

  useLayoutEffect(() => {
    const bar = footer.current!
    const leftGroup = left.current!
    const rightGroup = tray.current!
    const centerGroup = center.current!
    const button = centerGroup.firstElementChild!
    function measure() {
      const { paddingLeft, paddingRight, columnGap } = getComputedStyle(bar)
      const gap = parseFloat(getComputedStyle(centerGroup).columnGap)
      const spacing = parseFloat(paddingLeft) + parseFloat(paddingRight) + 2 * parseFloat(columnGap)
      const side = Math.max(leftGroup.getBoundingClientRect().width, rightGroup.getBoundingClientRect().width)
      const available = bar.clientWidth - spacing - 2 * side
      const buttonWidth = button.getBoundingClientRect().width
      setSlots(Math.max(0, Math.floor((available + gap) / (buttonWidth + gap)) - 2))
    }
    measure()
    const observer = new ResizeObserver(measure)
    for (const element of [bar, leftGroup, rightGroup, button]) observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const disconnected = connection === 'disconnected'
  const stale = Boolean(snapshot?.stale) && !disconnected
  const healthStatus = effectiveStatus(snapshot, connection)
  const issueCount = snapshot?.summary.issueCount ?? 0
  const showCount = !stale && (healthStatus === 'warning' || healthStatus === 'critical') && issueCount > 0
  const live = Boolean(snapshot) && !stale && !disconnected
  const cpuCheck = snapshot?.checks.find(check => check.category === 'cpu' && check.applicable)
  const memoryCheck = snapshot?.checks.find(check => check.category === 'memory' && check.applicable)
  const cpuText = percentText(cpuCheck?.value)
  const memoryText = percentText(memoryCheck?.value)
  const statusText = disconnected ? '连接中断' : stale ? '数据已过期' : snapshot ? healthStatusText[healthStatus] : '正在连接'
  const healthSummary = `主机健康：${statusText}${showCount ? `，${issueCount} 项异常` : ''}`
  const healthName = live ? `${healthSummary}，CPU ${cpuText}，内存 ${memoryText}` : healthSummary
  const previousHealth = useRef(healthSummary)
  const [announcement, setAnnouncement] = useState('')

  useEffect(() => {
    if (previousHealth.current === healthSummary) return
    previousHealth.current = healthSummary
    setAnnouncement(healthSummary)
  }, [healthSummary])

  useEffect(() => {
    if (popup === 'quick' && unread) onReadNotifications()
  }, [popup, unread, onReadNotifications])

  function triggerFor(kind: Popup) {
    return footer.current?.querySelector<HTMLButtonElement>(`[data-task-popup="${kind}"]`)
  }

  const hasOverflow = hidden.length > 0
  useLayoutEffect(() => {
    if (!popup) return
    const bar = footer.current!
    const trigger = triggerFor(popup)
    if (!trigger) {
      const frame = window.requestAnimationFrame(() => {
        center.current?.querySelector<HTMLButtonElement>('.taskbar-start')?.focus({ preventScroll: true })
        setPopup(null)
      })
      return () => window.cancelAnimationFrame(frame)
    }
    function place() {
      const bounds = trigger!.getBoundingClientRect()
      setAnchorX(bounds.left - bar.getBoundingClientRect().left + bounds.width / 2)
    }
    place()
    const observer = new ResizeObserver(place)
    for (const element of [bar, center.current!, left.current!, tray.current!]) observer.observe(element)
    return () => observer.disconnect()
  }, [popup, hasOverflow])

  useLayoutEffect(() => {
    if (popup) panel.current?.focus({ preventScroll: true })
  }, [popup])

  useLayoutEffect(() => {
    if (popup || !pendingTaskFocus.current) return
    const button = center.current?.querySelector<HTMLButtonElement>(`[data-task-key="${CSS.escape(pendingTaskFocus.current)}"]`)
    const target = button ?? triggerFor('windows')
    target?.focus({ preventScroll: true })
    pendingTaskFocus.current = null
  }, [popup])

  useLayoutEffect(() => {
    if (!popup) return
    const trigger = triggerFor(popup)
    function dismissOutside(event: Event) {
      if (!(event.target instanceof Element)) return
      if (panel.current?.contains(event.target) || trigger?.contains(event.target) ||
        event.target.closest(`#${commandMenuId}`)) return
      setPopup(null)
    }
    function dismissOnEscape(event: KeyboardEvent) {
      if (contextOpen || event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return
      event.preventDefault()
      trigger?.focus({ preventScroll: true })
      setPopup(null)
    }
    document.addEventListener('pointerdown', dismissOutside)
    document.addEventListener('focusin', dismissOutside)
    document.addEventListener('keydown', dismissOnEscape)
    return () => {
      document.removeEventListener('pointerdown', dismissOutside)
      document.removeEventListener('focusin', dismissOutside)
      document.removeEventListener('keydown', dismissOnEscape)
    }
  }, [popup, contextOpen])

  function togglePopup(kind: Popup) {
    onOpenPopup()
    setPopup(current => current === kind ? null : kind)
  }

  function popupAttributes(kind: Popup) {
    return {
      'data-task-popup': kind,
      'aria-expanded': popup === kind,
      'aria-controls': popup === kind ? popupId : undefined,
    }
  }

  function openTaskMenu(task: Task, anchor: MenuAnchor) {
    const layer = footer.current?.parentElement
    if (!layer) return
    onOpenPopup()
    setContext({ ...anchor, taskKey: task.key, layer })
  }

  function menuGroups({ appId, win }: Task): MenuGroup[] {
    const pinned = pinnedApps.includes(appId)
    return [
      appId === 'terminal' ? [{ label: '新建终端', icon: Plus, run: () => onLaunchApp('terminal') }] : [],
      !win?.id.startsWith('extension-') ? [
        { label: pinned ? '从任务栏取消固定' : '固定到任务栏', icon: pinned ? PinOff : Pin, run: () => togglePinApp(appId) },
      ] : [],
      win ? [
        { label: win.minimized ? '还原' : '最小化', icon: win.minimized ? Square : Minus,
          run: () => win.minimized ? onRestore(win.id) : onMinimize(win.id) },
        { label: '关闭窗口', icon: X, danger: true, run: () => onCloseWindow(win.id) },
      ] : [],
    ]
  }

  function renderTask(task: Task, overflow = false) {
    const { key, appId, title, win } = task
    return (
      <button key={key} type="button" className={overflow ? 'taskbar-window-button' : `taskbar-button${win ? ' taskbar-running' : ''}`}
        data-task-key={key} data-task-app={win?.id} aria-pressed={win ? focusedId === win.id : undefined}
        aria-label={title} title={title} aria-haspopup="menu"
        onClick={() => {
          if (overflow) {
            pendingTaskFocus.current = key
            setPopup(null)
          }
          if (win) onToggleApp(win.id)
          else onLaunchApp(appId)
        }}
        onContextMenu={event => {
          event.preventDefault()
          openTaskMenu(task, { source: event.currentTarget, point: { x: event.clientX, y: event.clientY } })
        }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || !(event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10')) return
          event.preventDefault()
          openTaskMenu(task, { source: event.currentTarget })
        }}>
        <AppIcon id={appId} size={24} className="taskbar-app-icon" />
        {overflow && <span>{title}</span>}
      </button>
    )
  }

  function openFromPopup(action: () => void) {
    setPopup(null)
    action()
  }

  return (
    <>
      <div className="taskbar-live" role="status" aria-live="polite">{announcement}</div>
      <footer ref={footer} className="taskbar" aria-label="任务栏"
        style={{ '--popover-anchor': `${anchorX}px` } as CSSProperties}>
        <div className="taskbar-left" ref={left}>
          <button type="button" className="taskbar-button taskbar-health" {...popupAttributes('health')}
            data-health={disconnected ? 'disconnected' : stale ? 'stale' : healthStatus}
            aria-label={healthName} title={healthName} onClick={() => togglePopup('health')}>
            {disconnected ? <Unplug size={18} aria-hidden="true" /> : stale ?
              <ClockAlert size={18} aria-hidden="true" /> : <StatusIcon status={healthStatus} size={18} />}
            <span className="taskbar-health-text" aria-hidden="true">
              {live ? (
                <>
                  <span className="taskbar-health-item" data-health={normalizeStatus(cpuCheck?.status)}>
                    <span>CPU</span><strong>{cpuText}</strong>
                  </span>
                  <span className="taskbar-health-item taskbar-health-memory" data-health={normalizeStatus(memoryCheck?.status)}>
                    <span>内存</span><strong>{memoryText}</strong>
                  </span>
                </>
              ) : statusText}
            </span>
            {showCount && <span className="taskbar-health-count" aria-hidden="true">{issueCount}</span>}
          </button>
        </div>
        <div ref={center} className="taskbar-center" aria-label="应用切换" role="group">
          <button ref={startButton} type="button" className="taskbar-button taskbar-start" data-start-ui aria-label="开始"
            title="开始" aria-controls="start-menu" aria-expanded={startOpen} onClick={() => openFromPopup(onStart)}>
            <span className="taskbar-start-mark" aria-hidden="true"><i /><i /><i /><i /></span>
          </button>
          <button type="button" className="taskbar-button" data-start-ui aria-label="搜索" title="搜索"
            aria-controls="start-menu" onClick={() => openFromPopup(onSearch)}>
            <Search size={22} aria-hidden="true" />
          </button>
          {visible.map(task => renderTask(task))}
          {hasOverflow && (
            <button type="button" className="taskbar-button" {...popupAttributes('windows')}
              aria-label="更多应用" title="更多应用" onClick={() => togglePopup('windows')}>
              <Ellipsis size={22} aria-hidden="true" />
            </button>
          )}
        </div>
        <div className="taskbar-tray" ref={tray}>
          <button type="button" className="taskbar-button taskbar-quick" {...popupAttributes('quick')}
            aria-label={unread ? '快捷控制与通知，有未读通知' : popupLabels.quick} title={popupLabels.quick}
            onClick={() => togglePopup('quick')}>
            <SlidersHorizontal size={17} aria-hidden="true" />
            <Bell size={16} className="taskbar-quick-bell" aria-hidden="true" />
            {unread && <span className="taskbar-unread" data-error={unreadError} aria-hidden="true" />}
          </button>
          <Clock />
          <button type="button" className="taskbar-show-desktop" aria-label="显示桌面" title="显示桌面" onClick={onShowDesktop} />
        </div>
        <DesktopToasts notifications={notifications} hidden={popup === 'quick'} />
        {popup && (
          <section ref={panel} id={popupId} className="taskbar-popover" data-popup={popup} tabIndex={-1}
            aria-labelledby={`${popupId}-title`}>
            <div className="taskbar-popover-body">
              <h2 id={`${popupId}-title`}>{popupLabels[popup]}</h2>
              {popup === 'windows' && (
                <ul className="taskbar-window-list">{hidden.map(task => <li key={task.key}>{renderTask(task, true)}</li>)}</ul>
              )}
              {popup === 'health' && <HealthPanel snapshot={snapshot} connection={connection}
                onOpenMonitor={() => openFromPopup(onOpenMonitor)} />}
              {popup === 'quick' && <QuickSettingsPanel notifications={notifications} onDismiss={onDismissNotification}
                onClear={onClearNotifications} onOpenAppearance={() => openFromPopup(onOpenAppearance)}
                onOpenMonitor={() => openFromPopup(onOpenMonitor)} />}
            </div>
          </section>
        )}
      </footer>
      {context && contextTask && (
        <CommandMenu key={context.taskKey} id={commandMenuId} label={`${contextTask.title}任务栏操作`}
          anchor={context} groups={menuGroups(contextTask)} layer={context.layer}
          boundary={context.layer} zIndex={5} onClose={() => setContext(null)}
          restoreFocus={() => {
            const target = context.source.isConnected ? context.source : triggerFor('windows') ??
              center.current?.querySelector<HTMLButtonElement>('.taskbar-start')
            target?.focus({ preventScroll: true })
          }} />
      )}
    </>
  )
}
