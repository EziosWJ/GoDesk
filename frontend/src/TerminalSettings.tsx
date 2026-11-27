import { useEffect, useState, useSyncExternalStore, type FormEvent } from 'react'
import { Minus, Plus } from 'lucide-react'
import { terminalApi } from './terminal'
import {
  adjustTerminalFontSize,
  defaultTerminalFontSize,
  getTerminalFontSize,
  maxTerminalFontSize,
  minTerminalFontSize,
  resetTerminalFontSize,
  setTerminalFontSize,
  subscribeTerminalFontSize,
} from './terminalPreferences'

export function TerminalSettings() {
  const fontSize = useSyncExternalStore(subscribeTerminalFontSize, getTerminalFontSize)
  const [lines, setLines] = useState<string>()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    terminalApi.settings(controller.signal).then(settings => {
      if (!controller.signal.aborted) setLines(String(settings.scrollbackLines))
    }, () => {
      if (!controller.signal.aborted) setError('无法读取终端设置')
    })
    return () => controller.abort()
  }, [attempt])

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setError('')
    setSaved(false)
    try {
      const result = await terminalApi.saveSettings({ scrollbackLines: Number(lines) })
      setLines(String(result.scrollbackLines))
      setSaved(true)
    } catch {
      setError('无法保存终端设置，请重试')
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <section className="settings-section" aria-labelledby="terminal-font-heading">
        <div className="settings-section-head">
          <h3 id="terminal-font-heading">终端字号</h3>
          <span className="system-caption">当前浏览器生效</span>
        </div>
        <div className="terminal-settings-font">
          <input
            type="range"
            min={minTerminalFontSize}
            max={maxTerminalFontSize}
            step={1}
            value={fontSize}
            aria-label="终端字号"
            aria-describedby="terminal-font-note"
            onChange={event => setTerminalFontSize(Number(event.target.value))}
          />
          <div className="terminal-settings-stepper" role="group" aria-label="微调终端字号">
            <button
              type="button"
              className="app-control"
              aria-label="减小字号"
              disabled={fontSize <= minTerminalFontSize}
              onClick={() => adjustTerminalFontSize(-1)}
            >
              <Minus size={14} aria-hidden="true" />
            </button>
            <span className="terminal-settings-font-value" aria-live="polite">{fontSize}px</span>
            <button
              type="button"
              className="app-control"
              aria-label="增大字号"
              disabled={fontSize >= maxTerminalFontSize}
              onClick={() => adjustTerminalFontSize(1)}
            >
              <Plus size={14} aria-hidden="true" />
            </button>
          </div>
          <button
            type="button"
            className="app-control"
            disabled={fontSize === defaultTerminalFontSize}
            onClick={resetTerminalFontSize}
          >
            恢复默认
          </button>
        </div>
        <p className="system-caption" id="terminal-font-note">
          仅保存在当前浏览器，调整后立即应用到所有已打开的终端窗口（{minTerminalFontSize}–{maxTerminalFontSize}px，默认 {defaultTerminalFontSize}px）。
        </p>
      </section>

      <section className="settings-section" aria-labelledby="terminal-scrollback-heading">
        <div className="settings-section-head">
          <h3 id="terminal-scrollback-heading">会话回看</h3>
          <span className="system-caption">主机全局配置</span>
        </div>
        {lines === undefined ? (
          error ? (
            <>
              <p className="authentication-error" role="alert">{error}</p>
              <button type="button" className="app-control" onClick={() => {
                setError('')
                setAttempt(value => value + 1)
              }}>重试</button>
            </>
          ) : (
            <p className="system-caption" role="status">正在读取终端设置…</p>
          )
        ) : (
          <form className="settings-password-form" onSubmit={save}>
            <label>
              回看行数
              <input type="number" value={lines} min={0} max={2147483647} step={1} required disabled={pending}
                aria-describedby="terminal-scrollback-note" onChange={event => {
                  setLines(event.target.value)
                  setSaved(false)
                  setError('')
                }} />
            </label>
            <p className="system-caption" id="terminal-scrollback-note">保存后对新建会话生效。设为 0 时只保留当前画面。</p>
            {error && <p className="authentication-error" role="alert">{error}</p>}
            {saved && <p role="status">终端设置已保存</p>}
            <button type="submit" className="app-control primary-control" disabled={pending}>保存</button>
          </form>
        )}
      </section>
    </>
  )
}
