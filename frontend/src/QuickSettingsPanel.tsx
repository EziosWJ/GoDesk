import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { CircleAlert, Info, Monitor, Moon, Settings2, Sun, X } from 'lucide-react'
import { getThemePreference, setThemePreference, subscribeAppearance, themeOptions, type ThemePreference } from './theme'

export type DesktopNotification = {
  id: number
  message: string
  kind: 'info' | 'error'
  createdAt: number
  read: boolean
}

type QuickSettingsProps = {
  notifications: DesktopNotification[]
  onDismiss: (id: number) => void
  onClear: () => void
  onOpenAppearance: () => void
  onOpenMonitor: () => void
}

const themeIcons = { system: Monitor, light: Sun, dark: Moon }
const themeModes = Object.keys(themeOptions) as ThemePreference[]
const toastDuration = 5000

function NotificationIcon({ kind }: Pick<DesktopNotification, 'kind'>) {
  const Icon = kind === 'error' ? CircleAlert : Info
  return <Icon className="taskbar-notification-icon" size={17} aria-hidden="true" />
}

export function QuickSettingsPanel({ notifications, onDismiss, onClear, onOpenAppearance, onOpenMonitor }: QuickSettingsProps) {
  const theme = useSyncExternalStore(subscribeAppearance, getThemePreference)
  const notificationHeading = useRef<HTMLHeadingElement>(null)

  return (
    <div className="quick-settings">
      <fieldset className="quick-settings-themes">
        <legend>主题模式</legend>
        <div className="quick-settings-theme-options">
          {themeModes.map(mode => {
            const Icon = themeIcons[mode]
            return (
              <label key={mode} className="quick-settings-theme">
                <input type="radio" name="quick-settings-theme" checked={theme === mode}
                  onChange={() => setThemePreference(mode)} />
                <span><Icon size={19} aria-hidden="true" />{themeOptions[mode]}</span>
              </label>
            )
          })}
        </div>
      </fieldset>
      <div className="quick-settings-links">
        <button type="button" className="app-control" onClick={onOpenAppearance}>
          <Settings2 size={16} aria-hidden="true" />系统设置（外观）
        </button>
        <button type="button" className="app-control" onClick={onOpenMonitor}>
          <Monitor size={16} aria-hidden="true" />系统监控
        </button>
      </div>
      <section className="quick-settings-notifications" aria-labelledby="quick-settings-notifications">
        <header>
          <h3 ref={notificationHeading} id="quick-settings-notifications" tabIndex={-1}>通知</h3>
          <button type="button" className="app-control" disabled={!notifications.length} onClick={() => {
            notificationHeading.current?.focus()
            onClear()
          }}>清空全部</button>
        </header>
        {notifications.length ? (
          <ul>
            {notifications.map(({ id, message, kind }) => (
              <li className="taskbar-notification" key={id} data-kind={kind}>
                <NotificationIcon kind={kind} />
                <span>{message}</span>
                <button className="app-control" type="button" aria-label={`关闭通知：${message}`}
                  onClick={event => {
                    const row = event.currentTarget.closest('li')
                    const adjacent = row?.nextElementSibling ?? row?.previousElementSibling
                    const nextButton = adjacent?.querySelector('button') ?? notificationHeading.current
                    nextButton?.focus()
                    onDismiss(id)
                  }}><X size={15} aria-hidden="true" /></button>
              </li>
            ))}
          </ul>
        ) : <p className="quick-settings-empty" role="status">暂无通知</p>}
      </section>
    </div>
  )
}

export function DesktopToasts({ notifications, hidden }: { notifications: DesktopNotification[]; hidden: boolean }) {
  const [now, setNow] = useState(Date.now)
  const recent = notifications.filter(item => !item.read && item.createdAt + toastDuration > now)
  const nextExpiry = recent.at(-1)?.createdAt

  useEffect(() => {
    if (nextExpiry === undefined) return
    const timer = window.setTimeout(() => setNow(Date.now()), nextExpiry + toastDuration - Date.now())
    return () => window.clearTimeout(timer)
  }, [nextExpiry])

  return (
    <div className="taskbar-toasts" role="status" aria-live="polite" aria-relevant="additions">
      {!hidden && recent.slice(0, 3).reverse().map(({ id, message, kind }) => (
        <div key={id} className="taskbar-notification taskbar-toast" data-kind={kind}>
          <NotificationIcon kind={kind} />
          <span>{message}</span>
        </div>
      ))}
    </div>
  )
}
