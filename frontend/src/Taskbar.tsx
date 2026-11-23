import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type Ref } from 'react'
import { Battery, BatteryCharging, BatteryFull, BatteryLow, BatteryMedium, Ellipsis, Grid2X2, SlidersHorizontal, Volume2, VolumeX, Wifi, WifiOff } from 'lucide-react'
import { apps, type AppId } from './apps'
import './styles/taskbar.css'

const timeFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
const dateFormat = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })

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

type BatterySource = EventTarget & { level: number; charging: boolean; chargingTime: number; dischargingTime: number }
type BatteryStatus = { level: number; charging: boolean } | 'unavailable' | 'pending'

function useBatteryStatus() {
  const device = navigator as Navigator & { getBattery?: () => Promise<BatterySource> }
  const [battery, setBattery] = useState<BatteryStatus>(device.getBattery ? 'pending' : 'unavailable')

  useEffect(() => {
    let disposed = false
    let source: BatterySource | undefined

    function update() {
      if (!source) return
      // This tuple can also be a browser default, including on devices without batteries.
      const { level, charging, chargingTime, dischargingTime } = source
      setBattery(level === 1 && charging && chargingTime === 0 && dischargingTime === Infinity
        ? 'unavailable' : { level: Math.round(level * 100), charging })
    }

    device.getBattery?.().then(manager => {
      if (disposed) return
      source = manager
      for (const event of batteryEvents) source.addEventListener(event, update)
      update()
    }).catch(() => { if (!disposed) setBattery('unavailable') })

    return () => {
      disposed = true
      for (const event of batteryEvents) source?.removeEventListener(event, update)
    }
  }, [device])

  return battery
}

const batteryEvents = ['levelchange', 'chargingchange', 'chargingtimechange', 'dischargingtimechange']
const volumeKey = 'react-web-desktop-desktop-volume'

type AudioPreference = { volume: number; muted: boolean }

function readAudioPreference(): AudioPreference {
  try {
    const saved = JSON.parse(localStorage.getItem(volumeKey) ?? 'null')
    if (saved && Number.isFinite(saved.volume) && saved.volume >= 0 && saved.volume <= 100 && typeof saved.muted === 'boolean') {
      return { volume: saved.volume, muted: saved.muted }
    }
  } catch {
    // Use the default when storage is unavailable.
  }
  return { volume: 75, muted: false }
}

const popupLabels = { windows: '更多应用', status: '系统状态', network: '网络', audio: '音量', battery: '电池' }
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
}

export function Taskbar({ running, focusedId, startOpen, startButton, onStart, onFocusApp, onOpenPopup }: TaskbarProps) {
  const footer = useRef<HTMLElement>(null)
  const appGroup = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLElement>(null)
  const [slots, setSlots] = useState(running.length)
  const [compact, setCompact] = useState(compactTray.matches)
  const [popup, setPopup] = useState<Popup | null>(null)
  const [anchorX, setAnchorX] = useState(0)
  const pendingAppFocus = useRef<string | null>(null)
  const [online, setOnline] = useState(navigator.onLine)
  const [networkNotice, setNetworkNotice] = useState('')
  const battery = useBatteryStatus()
  const [audio, setAudio] = useState(readAudioPreference)
  const [audioError, setAudioError] = useState('')
  const audioContext = useRef<AudioContext | null>(null)
  const audioOutput = useRef<GainNode | null>(null)
  const previewing = useRef(false)
  const quiet = audio.muted || audio.volume === 0

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

  useEffect(() => {
    let timer: number | undefined
    function update() {
      setOnline(navigator.onLine)
      setNetworkNotice(navigator.onLine ? '网络连接已恢复' : '网络连接已断开')
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setNetworkNotice(''), 4000)
    }
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
      window.clearTimeout(timer)
    }
  }, [])

  useEffect(() => () => {
    void audioContext.current?.close().catch(() => {})
    audioContext.current = null
    audioOutput.current = null
  }, [])

  const hasOverflow = running.length > slots
  const directApps = hasOverflow ? running.slice(0, Math.max(0, slots - 1)) : running
  const activeApp = running.find(win => win.id === focusedId)
  const visibleApps = hasOverflow && directApps.length && activeApp && !directApps.includes(activeApp)
    ? [...directApps.slice(0, -1), activeApp] : directApps
  const hiddenApps = hasOverflow ? running.filter(win => !visibleApps.includes(win)) : []

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

  function updateAudio(next: AudioPreference) {
    setAudio(next)
    const output = audioOutput.current
    if (output) output.gain.value = next.muted ? 0 : next.volume / 100
    try {
      localStorage.setItem(volumeKey, JSON.stringify(next))
    } catch {
      // Audio controls still work without storage.
    }
  }

  async function testAudio() {
    if (quiet || previewing.current) return
    previewing.current = true
    setAudioError('')
    try {
      const context = audioContext.current ??= new AudioContext()
      if (!audioOutput.current) {
        audioOutput.current = context.createGain()
        audioOutput.current.connect(context.destination)
        audioOutput.current.gain.value = audio.volume / 100
      }
      await context.resume()
      const tone = context.createOscillator()
      const envelope = context.createGain()
      const now = context.currentTime
      tone.frequency.value = 660
      envelope.gain.setValueAtTime(0, now)
      envelope.gain.linearRampToValueAtTime(0.16, now + 0.025)
      envelope.gain.exponentialRampToValueAtTime(0.001, now + 0.3)
      tone.connect(envelope).connect(audioOutput.current)
      tone.onended = () => {
        tone.disconnect()
        envelope.disconnect()
        previewing.current = false
      }
      tone.start(now)
      tone.stop(now + 0.31)
    } catch {
      previewing.current = false
      setAudioError('无法播放试听音')
    }
  }

  function popupButton(kind: Popup, Icon: typeof Wifi, label = popupLabels[kind]) {
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

  const NetworkIcon = online ? Wifi : WifiOff
  const AudioIcon = quiet ? VolumeX : Volume2
  let BatteryIcon = Battery
  if (typeof battery === 'object') {
    if (battery.charging) BatteryIcon = BatteryCharging
    else if (battery.level <= 25) BatteryIcon = BatteryLow
    else if (battery.level <= 75) BatteryIcon = BatteryMedium
    else BatteryIcon = BatteryFull
  }
  const networkLabel = online ? '在线' : '离线'
  const sections: Record<'network' | 'audio' | 'battery', ReactNode> = {
    network: <>
      <p className="taskbar-reading" data-offline={!online}>{networkLabel}</p>
      <p className="taskbar-caption">当前浏览器报告的连接状态</p>
    </>,
    audio: <>
      <div className="taskbar-volume">
        <button type="button" className="taskbar-button" aria-label="静音" aria-pressed={audio.muted}
          title={audio.muted ? '取消静音' : '静音'} onClick={() => updateAudio({ ...audio, muted: !audio.muted })}>
          <AudioIcon size={18} aria-hidden="true" />
        </button>
        <input type="range" aria-label="桌面音量" aria-valuetext={`${audio.volume}%`} min={0} max={100} value={audio.volume}
          onChange={event => updateAudio({ volume: Number(event.target.value), muted: false })} />
        <span>{audio.volume}%</span>
      </div>
      <div className="taskbar-audio-actions">
        <span className="taskbar-caption">仅作用于桌面内的声音</span>
        <button type="button" className="taskbar-preview" disabled={quiet} onClick={() => void testAudio()}>试听</button>
      </div>
      {audioError && <p role="status" className="taskbar-caption">{audioError}</p>}
    </>,
    battery: typeof battery === 'object' ? <>
      <p className="taskbar-reading">{battery.level}% <span className="taskbar-caption">{battery.charging ? '充电中' : '使用电池'}</span></p>
      <meter className="taskbar-charge" aria-label="电池电量" min={0} max={100} value={battery.level} />
    </> : <p className="taskbar-caption">{battery === 'pending' ? '正在读取电池状态…' : '浏览器未提供可用的电量数据。'}</p>,
  }

  return (
    <>
      <div className="taskbar-notice" role="status">
        {networkNotice && <div><NetworkIcon size={18} aria-hidden="true" />{networkNotice}</div>}
      </div>
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
          <div className="taskbar-status" aria-label="系统状态" role="group">
            {compact ? popupButton('status', SlidersHorizontal) : <>
              {popupButton('network', NetworkIcon, `网络：${networkLabel}`)}
              {popupButton('audio', AudioIcon, `音量：${quiet ? '静音' : `${audio.volume}%`}`)}
              {popupButton('battery', BatteryIcon, `电池：${typeof battery === 'object' ? `${battery.level}%` : '查看状态'}`)}
            </>}
          </div>
          <Clock />
        </div>
        {popup && (
          <section ref={panel} id={popupId} className="taskbar-popover" tabIndex={-1} aria-labelledby={`${popupId}-title`}>
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
              ) : popup === 'status' ? (
                <div className="taskbar-quick-status">
                  <div><h3><NetworkIcon size={16} aria-hidden="true" />网络</h3>{sections.network}</div>
                  <div><h3><AudioIcon size={16} aria-hidden="true" />音量</h3>{sections.audio}</div>
                  <div><h3><BatteryIcon size={16} aria-hidden="true" />电池</h3>{sections.battery}</div>
                </div>
              ) : sections[popup]}
            </div>
          </section>
        )}
        {popup && <span className="taskbar-popover-arrow" aria-hidden="true" />}
      </footer>
    </>
  )
}
