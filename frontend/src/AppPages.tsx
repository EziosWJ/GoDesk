import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import {
  ArrowLeft, Check, ChevronRight, Languages, LockKeyhole, Monitor, Moon, Palette, Settings2, Sun, Terminal, Timer, Wallpaper,
} from 'lucide-react'
import { AuthError, authSession, type Session } from './auth'
import {
  accentOptions, getAccentPreference, getThemePreference, setAccentPreference, setThemePreference,
  subscribeAppearance, themeOptions, type AccentPreference, type ThemePreference,
} from './theme'
import {
  getWallpaperPreference, setWallpaperPreference, subscribeWallpaper, wallpaperIds, wallpapers, type WallpaperId,
} from './wallpapers'
import { useSplitLayout } from './useSplitLayout'
import { TerminalSettings } from './TerminalSettings'
import { HostSettings } from './HostSettings'

const categories = {
  appearance: { label: '外观', Icon: Monitor },
  general: { label: '主机与常规', Icon: Settings2 },
  terminal: { label: '终端', Icon: Terminal },
  account: { label: '账户', Icon: LockKeyhole },
}

type Category = keyof typeof categories
type EffectiveTheme = 'light' | 'dark'

const themeIcons = { system: Monitor, light: Sun, dark: Moon } as const

function effectiveTheme(): EffectiveTheme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

export function Settings({ onSession }: { onSession: (session: Session) => void }) {
  const [theme, setTheme] = useState<ThemePreference>(getThemePreference)
  const [accent, setAccent] = useState<AccentPreference>(getAccentPreference)
  const [wallpaper, setWallpaper] = useState<WallpaperId>(getWallpaperPreference)
  const [effective, setEffective] = useState<EffectiveTheme>(effectiveTheme)
  const [category, setCategory] = useState<Category>('appearance')
  const [showPage, setShowPage] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const navigation = useRef<HTMLElement>(null)
  const back = useRef<HTMLButtonElement>(null)
  const buttons = useRef<Partial<Record<Category, HTMLButtonElement | null>>>({})
  const nextFocus = useRef<'heading' | 'category' | null>(null)
  const { root, split } = useSplitLayout(600, wide => {
    if (wide) {
      if (document.activeElement === back.current) nextFocus.current = 'heading'
    } else {
      setShowPage(true)
      if (navigation.current?.contains(document.activeElement)) nextFocus.current = 'heading'
    }
  })

  // Keep the gallery in sync when appearance or wallpaper changes elsewhere (desktop menu, quick settings).
  useEffect(() => {
    const syncAppearance = () => {
      setTheme(getThemePreference())
      setAccent(getAccentPreference())
      setEffective(effectiveTheme())
    }
    const unsubscribeAppearance = subscribeAppearance(syncAppearance)
    const unsubscribeWallpaper = subscribeWallpaper(() => setWallpaper(getWallpaperPreference()))
    return () => {
      unsubscribeAppearance()
      unsubscribeWallpaper()
    }
  }, [])

  useLayoutEffect(() => {
    if (nextFocus.current === 'heading') heading.current?.focus()
    if (nextFocus.current === 'category') buttons.current[category]?.focus()
    nextFocus.current = null
  }, [category, showPage, split])

  function chooseTheme(value: ThemePreference) {
    setThemePreference(value)
    setTheme(value)
    setEffective(value === 'system' ? effectiveTheme() : value)
  }

  function chooseAccent(value: AccentPreference) {
    setAccentPreference(value)
    setAccent(value)
  }

  function chooseWallpaper(value: WallpaperId) {
    setWallpaperPreference(value)
    setWallpaper(value)
  }

  function openAppearance() {
    nextFocus.current = 'heading'
    setCategory('appearance')
    setShowPage(true)
  }

  return (
    <div className="settings-page system-page" ref={root} data-split={split}>
      <nav ref={navigation} className="settings-navigation system-scroll" aria-label="设置分类" hidden={!split && showPage}>
        {(Object.keys(categories) as Category[]).map(key => {
          const { label, Icon } = categories[key]
          return (
            <button key={key} ref={node => { buttons.current[key] = node }} className="app-control settings-category"
              aria-current={split && category === key ? 'page' : undefined}
              onClick={() => {
                if (!split) nextFocus.current = 'heading'
                setCategory(key)
                setShowPage(true)
              }}>
              <Icon size={16} aria-hidden="true" />
              {label}
              {!split && <ChevronRight className="settings-chevron" size={16} aria-hidden="true" />}
            </button>
          )
        })}
      </nav>
      <section className="settings-content system-scroll" aria-label={categories[category].label} hidden={!split && !showPage}>
        {!split && <button ref={back} className="app-control system-back" onClick={() => {
          nextFocus.current = 'category'
          setShowPage(false)
        }}><ArrowLeft size={16} aria-hidden="true" />返回分类</button>}
        <h2 ref={heading} tabIndex={-1} className="system-title">{categories[category].label}</h2>
        {category === 'appearance' ? (
          <>
            <p className="system-caption settings-note" id="appearance-note">更改立即应用到整个桌面，并与桌面右键菜单保持同步</p>
            <section className="settings-section" aria-labelledby="settings-theme-title">
              <div className="settings-section-head">
                <h3 id="settings-theme-title">主题模式</h3>
                <p className="system-caption">
                  {theme === 'system' ? `跟随系统 · 当前${effective === 'dark' ? '深色' : '浅色'}` : '手动选择固定外观'}
                </p>
              </div>
              <fieldset className="theme-cards" aria-labelledby="settings-theme-title" aria-describedby="appearance-note">
                {(Object.keys(themeOptions) as ThemePreference[]).map(value => {
                  const preview = value === 'system' ? effective : value
                  const ThemeIcon = themeIcons[value]
                  return (
                    <label key={value} className="theme-card">
                      <input type="radio" name="desktop-theme" value={value} checked={theme === value}
                        onChange={() => chooseTheme(value)} />
                      <span className="theme-card-preview" data-preview={preview} aria-hidden="true">
                        <span className="theme-card-wallpaper"
                          style={{ backgroundImage: `url(${wallpapers[wallpaper][preview]})` }} />
                        <span className="theme-card-window">
                          <span className="theme-card-window-bar"><i /><i /><i /></span>
                          <span className="theme-card-window-lines"><i /><i /><i /></span>
                        </span>
                        <span className="theme-card-taskbar"><i /><i /><i /><i /></span>
                      </span>
                      <span className="theme-card-footer">
                        <ThemeIcon size={15} aria-hidden="true" />
                        <span>{themeOptions[value]}</span>
                        <span className="theme-card-check"><Check size={12} aria-hidden="true" /></span>
                      </span>
                    </label>
                  )
                })}
              </fieldset>
            </section>
            <section className="settings-section" aria-labelledby="settings-accent-title">
              <div className="settings-section-head">
                <h3 id="settings-accent-title">强调色</h3>
                <p className="system-caption">开始菜单、任务栏和控件会立即使用所选颜色</p>
              </div>
              <fieldset className="accent-options" aria-labelledby="settings-accent-title">
                {(Object.keys(accentOptions) as AccentPreference[]).map(value => {
                  const option = accentOptions[value]
                  const color = effective === 'dark' ? option.dark : option.light
                  return (
                    <label key={value} className="accent-option">
                      <input type="radio" name="desktop-accent" value={value} checked={accent === value}
                        onChange={() => chooseAccent(value)} />
                      <span className="accent-swatch" aria-hidden="true"
                        style={{ background: color, color: effective === 'dark' ? '#1C1C1C' : '#FFFFFF' }}>
                        <Check size={13} aria-hidden="true" />
                      </span>
                      <span className="accent-name">{option.label}</span>
                      <span className="accent-value" aria-hidden="true">{color}</span>
                    </label>
                  )
                })}
              </fieldset>
            </section>
            <section className="settings-section" aria-labelledby="settings-wallpaper-title">
              <div className="settings-section-head">
                <h3 id="settings-wallpaper-title">桌面壁纸</h3>
                <p className="system-caption">点击缩略图立即更换，悬停可预览名称</p>
              </div>
              <fieldset className="wallpaper-options" aria-labelledby="settings-wallpaper-title">
                {wallpaperIds.map(id => (
                  <label key={id} className="wallpaper-option" title={wallpapers[id].description}>
                    <input type="radio" name="desktop-wallpaper" value={id} checked={wallpaper === id}
                      onChange={() => chooseWallpaper(id)} />
                    <span className="wallpaper-thumb" aria-hidden="true"
                      style={{ backgroundImage: `url(${wallpapers[id][effective]})` }}>
                      <span className="wallpaper-check"><Check size={12} aria-hidden="true" /></span>
                    </span>
                    <span className="wallpaper-name">{wallpapers[id].name}</span>
                  </label>
                ))}
              </fieldset>
            </section>
          </>
        ) : category === 'account' ? <ChangePassword onSession={onSession} /> : category === 'terminal' ? <TerminalSettings /> : (
          <GeneralSettings theme={theme} accent={accent} wallpaper={wallpaper} effective={effective}
            onOpenAppearance={openAppearance} onSession={onSession} />
        )}
      </section>
    </div>
  )
}

function GeneralSettings({ theme, accent, wallpaper, effective, onOpenAppearance, onSession }: {
  theme: ThemePreference
  accent: AccentPreference
  wallpaper: WallpaperId
  effective: EffectiveTheme
  onOpenAppearance: () => void
  onSession: (session: Session) => void
}) {
  const appearanceLabel = theme === 'system'
    ? `${themeOptions.system}（当前${effective === 'dark' ? '深色' : '浅色'}）`
    : themeOptions[theme]
  const accentColor = effective === 'dark' ? accentOptions[accent].dark : accentOptions[accent].light

  return (
    <>
      <HostSettings onSession={onSession} />
      <section className="settings-section" aria-labelledby="settings-desktop-env-title">
        <div className="settings-section-head">
          <h3 id="settings-desktop-env-title">桌面环境</h3>
          <p className="system-caption">随外观更改即时更新</p>
        </div>
        <dl className="settings-list settings-summary">
          <div><dt><Languages size={16} aria-hidden="true" />显示语言</dt><dd>简体中文</dd></div>
          <div><dt><Timer size={16} aria-hidden="true" />时间格式</dt><dd>24 小时制</dd></div>
          <div><dt><Monitor size={16} aria-hidden="true" />外观模式</dt><dd>{appearanceLabel}</dd></div>
          <div>
            <dt><Palette size={16} aria-hidden="true" />强调色</dt>
            <dd>
              <span className="settings-accent-chip" style={{ background: accentColor }} aria-hidden="true" />
              {accentOptions[accent].label}
            </dd>
          </div>
          <div><dt><Wallpaper size={16} aria-hidden="true" />桌面壁纸</dt><dd>{wallpapers[wallpaper].name}</dd></div>
        </dl>
        <button type="button" className="app-control settings-jump" onClick={onOpenAppearance}>
          <Palette size={16} aria-hidden="true" />
          调整外观
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      </section>
    </>
  )
}

function ChangePassword({ onSession }: { onSession: (session: Session) => void }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const fields = new FormData(form)
    const currentPassword = String(fields.get('currentPassword'))
    const password = String(fields.get('password'))
    setSuccess(false)
    if (password !== fields.get('confirmation')) {
      setError('两次输入的新密码不一致')
      return
    }
    setError('')
    setPending(true)
    try {
      onSession(await authSession('password', { currentPassword, password }))
      form.reset()
      setSuccess(true)
    } catch (failure) {
      if (failure instanceof AuthError && failure.status === 401) {
        onSession({ status: 'login' })
      } else if (failure instanceof AuthError && failure.status === 403) {
        setError('当前密码错误')
      } else {
        setError('无法修改密码，请重试')
      }
    } finally {
      setPending(false)
    }
  }

  return (
    <form className="settings-password-form" onSubmit={submit} onChange={() => {
      setError('')
      setSuccess(false)
    }}>
      <label>当前密码<input name="currentPassword" type="password" autoComplete="current-password" required /></label>
      <label>新密码<input name="password" type="password" autoComplete="new-password" required /></label>
      <label>确认新密码<input name="confirmation" type="password" autoComplete="new-password" required /></label>
      {error && <p className="authentication-error" role="alert">{error}</p>}
      {success && <p role="status">密码已修改，其他设备需要重新登录。</p>}
      <button className="app-control primary-control" type="submit" disabled={pending}>修改密码</button>
    </form>
  )
}
