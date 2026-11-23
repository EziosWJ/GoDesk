import { useEffect, useState, type FormEvent } from 'react'
import { terminalApi } from './terminal'

export function TerminalSettings() {
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

  if (lines === undefined) {
    return error ? <>
      <p className="authentication-error" role="alert">{error}</p>
      <button type="button" className="app-control" onClick={() => {
        setError('')
        setAttempt(value => value + 1)
      }}>重试</button>
    </> : <p className="system-caption" role="status">正在读取终端设置…</p>
  }

  return (
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
  )
}
