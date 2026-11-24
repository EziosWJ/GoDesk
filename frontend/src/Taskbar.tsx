import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type Ref } from 'react'
import { Ellipsis, Grid2X2, Unplug } from 'lucide-react'
import { apps, type AppId } from './apps'
import { HealthPanel } from './HealthPanel'
import { StatusIcon } from './HealthStatusIcon'
import { effectiveStatus, healthStatusText, normalizeStatus } from './healthUi'
import { useHostHealth } from './useHostHealth'
import './styles/taskbar.css'

const timeFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
const dateFormat = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })

type NetworkDetails = {
  rxBytesPerSecond?: number
  txBytesPerSecond?: number
}

function percentText(value: number | null | undefined) {
  return value === null || value === undefined || !Number.isFinite(value) ? '—' : `${Math.round(value)}%`
}

function rateText(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return '—'
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s']
  let scaled = value
  let unit = 0
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024
    unit += 1
  }
  const rounded = unit === 0 || scaled >= 10 ? Math.round(scaled) : Math.round(scaled * 10) / 10
  return `${rounded} ${units[unit]}`
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

const popupLabels = { windows: '更多应用', health: '主机健康' }
type Popup = keyof typeof popupLabels
const compactTray = window.matchMedia('(max-width: 520px)')
const popupId = 'taskbar-popover'

type TaskbarProps = {
  running: { id: string; appId: AppId; title: string }[]
  focusedId: string | null | undefined
  startOpen: boolean
  startButton: Ref<HTMLButtonElement>
  onStart: () => void
  onFocusApp: (id: string) => void
  onOpenPopup: () => void
  onOpenMonitor: () => void
}

export function Taskbar({ running, focusedId, startOpen, startButton, onStart, onFocusApp, onOpenPopup, onOpenMonitor }: TaskbarProps) {
  const footer = useRef<HTMLElement>(null)
  const appGroup = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLElement>(null)
  const [slots, setSlots] = useState(running.length)
  const [compact, setCompact] = useState(compactTray.matches)
  const [popup, setPopup] = useState<Popup | null>(null)
  const [anchorX, setAnchorX] = useState(0)
  const pendingAppFocus = useRef<string | null>(null)
  const { snapshot, connection } = useHostHealth()

  useLayoutEffect(() => {
    const group = appGroup.current!
    function measure() {
      const buttonWidth = group.firstElementChild!.getBoundingClientRect().width
      const gap = parseFloat(getComputedStyle(group).columnGap)
      setSlots(Math.max(0, Math.floor((group.clientWidth + gap) / (buttonWidth + gap)) - 1))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(group)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    function syncLayout() {
      setCompact(compactTray.matches)
      setPopup(null)
    }
    compactTray.addEventListener('change', syncLayout)
    return () => compactTray.removeEventListener('change', syncLayout)
  }, [])

  const hasOverflow = running.length > slots
  const directApps = hasOverflow ? running.slice(0, Math.max(0, slots - 1)) : running
  const activeApp = running.find(win => win.id === focusedId)
  const visibleApps = hasOverflow && directApps.length && activeApp && !directApps.includes(activeApp)
    ? [...directApps.slice(0, -1), activeApp] : directApps
  const hiddenApps = hasOverflow ? running.filter(win => !visibleApps.includes(win)) : []

  const disconnected = connection === 'disconnected'
  const healthStatus = effectiveStatus(snapshot, connection)
  const stale = Boolean(snapshot?.stale) && !disconnected
  const issueCount = snapshot?.summary.issueCount ?? 0
  const showCount = !stale && (healthStatus === 'warning' || healthStatus === 'critical') && issueCount > 0
  const live = Boolean(snapshot) && !stale && !disconnected
  const cpuCheck = snapshot?.checks.find(check => check.category === 'cpu' && check.applicable)
  const memoryCheck = snapshot?.checks.find(check => check.category === 'memory' && check.applicable)
  const networkCheck = snapshot?.checks.find(check => check.category === 'network' && check.applicable)
  const networkDetails = (networkCheck?.details ?? {}) as NetworkDetails
  const cpuText = percentText(cpuCheck?.value)
  const memoryText = percentText(memoryCheck?.value)
  const rxText = rateText(networkDetails.rxBytesPerSecond)
  const txText = rateText(networkDetails.txBytesPerSecond)
  const metricsName = live
    ? `，CPU ${cpuText}，内存 ${memoryText}${networkCheck ? `，下行 ${rxText}，上行 ${txText}` : ''}`
    : ''
  const healthName = disconnected
    ? 'GoDesk 连接中断'
    : `主机健康：${healthStatusText[healthStatus]}${showCount ? `，${issueCount} 项异常` : ''}${metricsName}`

  // Announce only when the overall status or the issue count changes. The
  // first result initializes the baseline without speaking.
  const announced = useRef<string | null>(null)
  const [announcement, setAnnouncement] = useState('')
  useEffect(() => {
    if (disconnected) return
    const key = `${healthStatus}:${showCount ? issueCount : 0}`
    if (announced.current === null) {
      announced.current = key
      return
    }
    if (announced.current === key) return
    announced.current = key
    setAnnouncement(showCount
      ? `主机健康：${healthStatusText[healthStatus]}，${issueCount} 项异常`
      : `主机健康：${healthStatusText[healthStatus]}`)
  }, [disconnected, healthStatus, showCount, issueCount])

  function triggerFor(kind: Popup) {
    return footer.current?.querySelector<HTMLButtonElement>(`[data-task-popup="${kind}"]`)
  }

  useLayoutEffect(() => {
    if (!popup) return
    const bar = footer.current!
    const trigger = triggerFor(popup)
    function place() {
      if (!trigger) {
        setPopup(null)
        return
      }
      const bounds = trigger.getBoundingClientRect()
      setAnchorX(bounds.left - bar.getBoundingClientRect().left + bounds.width / 2)
    }
    if (trigger) place()
    const observer = new ResizeObserver(place)
    observer.observe(bar)
    return () => observer.disconnect()
  }, [popup, compact, visibleApps.length, hasOverflow])

  useLayoutEffect(() => {
    if (popup) panel.current?.focus({ preventScroll: true })
  }, [popup])

  useLayoutEffect(() => {
    if (!popup && pendingAppFocus.current) {
      const button = footer.current?.querySelector<HTMLButtonElement>(`[data-task-app="${pendingAppFocus.current}"]`)
      const target = button ?? triggerFor('windows')
      target?.focus({ preventScroll: true })
      pendingAppFocus.current = null
    }
  }, [popup, focusedId])

  useLayoutEffect(() => {
    if (!popup) return
    function dismissOutside(event: Event) {
      if (!(event.target instanceof Node)) return
      if (!panel.current?.contains(event.target) && !triggerFor(popup!)?.contains(event.target)) setPopup(null)
    }
    function dismissOnEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return
      event.preventDefault()
      triggerFor(popup!)?.focus({ preventScroll: true })
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
  }, [popup])

  function popupButton(kind: Popup, Icon: typeof Grid2X2, label = popupLabels[kind]) {
    return (
      <button className="taskbar-button" type="button" data-task-popup={kind} aria-label={label}
        title={kind === 'windows' ? undefined : label}
        aria-expanded={popup === kind} aria-controls={popup === kind ? popupId : undefined}
        onClick={() => {
          onOpenPopup()
          setPopup(current => current === kind ? null : kind)
        }}>
        <Icon size={kind === 'windows' ? 20 : 18} aria-hidden="true" />
        {kind === 'windows' && <span className="taskbar-tooltip" aria-hidden="true">{label}</span>}
      </button>
    )
  }

  return (
    <>
      <div className="taskbar-live" role="status" aria-live="polite">{announcement}</div>
      <footer ref={footer} className="taskbar" aria-label="任务栏"
        style={{ '--popover-anchor': `${anchorX}px` } as CSSProperties}>
        <div ref={appGroup} className="taskbar-apps" aria-label="应用切换" role="group">
          <button ref={startButton} type="button" className="taskbar-button taskbar-start" data-start-ui aria-label="开始"
            aria-controls={startOpen ? 'start-menu' : undefined} aria-expanded={startOpen} onClick={() => {
              setPopup(null)
              onStart()
            }}>
            <Grid2X2 size={22} strokeWidth={2.4} aria-hidden="true" />
            <span className="taskbar-tooltip" aria-hidden="true">开始</span>
          </button>
          {visibleApps.map(({ id, appId, title }) => {
            const { icon: Icon } = apps[appId]
            return (
              <button key={id} type="button" className="taskbar-button taskbar-running" data-task-app={id} aria-pressed={focusedId === id}
                aria-label={title} onClick={() => onFocusApp(id)}>
                <Icon className={`app-icon ${appId}`} size={20} aria-hidden="true" />
                <span className="taskbar-tooltip" aria-hidden="true">{title}</span>
              </button>
            )
          })}
          {hasOverflow && popupButton('windows', Ellipsis)}
        </div>
        <div className="taskbar-tray">
          <button type="button" className="taskbar-button taskbar-health" data-task-popup="health"
            data-health={disconnected ? 'disconnected' : healthStatus}
            aria-label={healthName} aria-expanded={popup === 'health'} aria-controls={popup === 'health' ? popupId : undefined}
            title={compact ? healthName : undefined}
            onClick={() => {
              onOpenPopup()
              setPopup(current => current === 'health' ? null : 'health')
            }}>
            {disconnected ? <Unplug size={18} aria-hidden="true" /> : <StatusIcon status={healthStatus} size={18} />}
            {!compact && (
              <span className="taskbar-health-text">
                {disconnected ? '连接中断' : stale ? '数据未更新' : snapshot ? (
                  <>
                    <span className="taskbar-health-item" data-health={normalizeStatus(cpuCheck?.status)}>
                      <span className="taskbar-health-label">CPU</span>
                      <span className="taskbar-health-value">{cpuText}</span>
                    </span>
                    <span className="taskbar-health-item" data-health={normalizeStatus(memoryCheck?.status)}>
                      <span className="taskbar-health-label">内存</span>
                      <span className="taskbar-health-value">{memoryText}</span>
                    </span>
                    {networkCheck && (
                      <span className="taskbar-health-item taskbar-health-net" data-health={normalizeStatus(networkCheck.status)}>
                        <span className="taskbar-health-label" aria-hidden="true">↓</span>
                        <span className="taskbar-health-value">{rxText}</span>
                        <span className="taskbar-health-label" aria-hidden="true">↑</span>
                        <span className="taskbar-health-value">{txText}</span>
                      </span>
                    )}
                  </>
                ) : '正在连接…'}
              </span>
            )}
            {showCount && <span className="taskbar-health-count" aria-hidden="true">{issueCount}</span>}
          </button>
          <Clock />
        </div>
        {popup && (
          <section ref={panel} id={popupId} className="taskbar-popover" data-popup={popup} tabIndex={-1} aria-labelledby={`${popupId}-title`}>
            <div className="taskbar-popover-body">
              <h2 id={`${popupId}-title`}>{popupLabels[popup]}</h2>
              {popup === 'windows' ? (
                <ul className="taskbar-window-list">
                  {hiddenApps.map(({ id, appId, title }) => {
                    const { icon: Icon } = apps[appId]
                    return <li key={id}><button type="button" onClick={() => {
                      pendingAppFocus.current = id
                      setPopup(null)
                      onFocusApp(id)
                    }}><Icon size={18} aria-hidden="true" />{title}</button></li>
                  })}
                </ul>
              ) : (
                <HealthPanel snapshot={snapshot} connection={connection} onOpenMonitor={() => {
                  setPopup(null)
                  onOpenMonitor()
                }} />
              )}
            </div>
          </section>
        )}
        {popup && <span className="taskbar-popover-arrow" aria-hidden="true" />}
      </footer>
    </>
  )
}
