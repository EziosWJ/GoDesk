import { useLayoutEffect, useRef, useState } from 'react'
import { ArrowLeft, AudioLines, ChevronRight, Monitor, Settings2, Timer } from 'lucide-react'
import { getThemePreference, setThemePreference, themeOptions, type ThemePreference } from './theme'
import { useSplitLayout } from './useSplitLayout'

const categories = {
  appearance: { label: '外观', Icon: Monitor },
  general: { label: '常规', Icon: Settings2 },
}

type Category = keyof typeof categories

const generalSettings = [
  { name: '显示语言', value: '简体中文', Icon: Settings2 },
  { name: '时间格式', value: '24 小时制', Icon: Timer },
  { name: '系统音量', value: '75%', Icon: AudioLines },
]

export function Settings() {
  const [theme, setTheme] = useState(getThemePreference)
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

  useLayoutEffect(() => {
    if (nextFocus.current === 'heading') heading.current?.focus()
    if (nextFocus.current === 'category') buttons.current[category]?.focus()
    nextFocus.current = null
  }, [category, showPage, split])

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
            <p className="system-caption settings-note" id="appearance-note">更改立即应用到整个桌面</p>
            <fieldset className="theme-options" aria-label="桌面外观" aria-describedby="appearance-note">
              {(Object.entries(themeOptions) as [ThemePreference, string][]).map(([value, label]) => (
                <label key={value} className="theme-option">
                  <input type="radio" name="desktop-theme" value={value} checked={theme === value} onChange={() => {
                    setThemePreference(value)
                    setTheme(value)
                  }} />
                  {label}
                </label>
              ))}
            </fieldset>
          </>
        ) : (
          <>
            <p className="system-caption settings-note">示例设置</p>
            <dl className="settings-list">
              {generalSettings.map(({ name, value, Icon }) => (
                <div key={name}><dt><Icon size={16} aria-hidden="true" />{name}</dt><dd>{value}</dd></div>
              ))}
            </dl>
          </>
        )}
      </section>
    </div>
  )
}
