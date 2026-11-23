import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Plus, RefreshCw, SquareTerminal } from 'lucide-react'
import type { WindowState } from '@surdeddd/wmkit'
import { terminalApi, terminalWindowId, type TerminalSession } from './terminal'

const formatTime = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' })
const statusLabels = { minimized: '已最小化', visible: '窗口已打开', remote: '在其他位置打开', background: '后台运行' }
type SessionAction = { type: 'rename' | 'end'; session: TerminalSession }

export function TerminalSessions({ active, windows, launchError, onOpen, onRename }: {
  active: boolean
  windows: Readonly<Record<string, WindowState>>
  launchError: string
  onOpen: (session: TerminalSession, takeover?: boolean) => void
  onRename: (session: TerminalSession) => void
}) {
  const [sessions, setSessions] = useState<TerminalSession[]>()
  const [action, setAction] = useState<SessionAction>()
  const [pending, setPending] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const dialog = useRef<HTMLDialogElement>(null)
  const revision = useRef(0)

  useEffect(() => {
    if (!active) {
      dialog.current?.close()
      return
    }
    const controller = new AbortController()
    let timer: number | undefined

    async function load() {
      const version = revision.current
      try {
        const result = await terminalApi.list(controller.signal)
        if (controller.signal.aborted || version !== revision.current) return
        setSessions(result)
        setLoadError('')
      } catch {
        if (!controller.signal.aborted) setLoadError('无法读取终端会话')
      } finally {
        if (!controller.signal.aborted) timer = window.setTimeout(load, 2500)
      }
    }

    void load()
    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [active, refresh])

  useEffect(() => {
    if (action) dialog.current?.showModal()
  }, [action])

  async function createSession() {
    setActionError('')
    setPending(true)
    try {
      const session = await terminalApi.create()
      revision.current++
      setSessions(current => [...(current ?? []), session])
      onOpen(session)
    } catch {
      setActionError('无法新建终端，请重试')
    } finally {
      setPending(false)
    }
  }

  function startAction(type: SessionAction['type'], session: TerminalSession) {
    setActionError('')
    setAction({ type, session })
  }

  async function confirmAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!action) return
    const name = String(new FormData(event.currentTarget).get('name') ?? '').trim()
    if (action.type === 'rename' && !name) {
      setActionError('请输入会话名称')
      return
    }
    setActionError('')
    setPending(true)
    try {
      if (action.type === 'rename') {
        const result = await terminalApi.rename(action.session.id, name)
        revision.current++
        setSessions(current => current?.map(session => session.id === result.id ? result : session))
        onRename(result)
      } else {
        await terminalApi.end(action.session.id)
        revision.current++
        setSessions(current => current?.filter(session => session.id !== action.session.id))
      }
      dialog.current?.close()
    } catch {
      setActionError(action.type === 'rename' ? '无法更改会话名称' : '无法结束会话')
    } finally {
      setPending(false)
      setRefresh(value => value + 1)
    }
  }

  return (
    <section className="terminal-page terminal-manager" aria-label="终端会话">
      <div className="terminal-toolbar">
        <button className="app-control primary-control" type="button" disabled={pending} onClick={createSession}>
          <Plus size={16} aria-hidden="true" />新建终端
        </button>
        <button className="app-control" type="button" onClick={() => setRefresh(value => value + 1)}>
          <RefreshCw size={15} aria-hidden="true" />刷新
        </button>
      </div>
      <div className="terminal-sessions system-scroll">
        {(loadError || !action && (actionError || launchError)) &&
          <p className="authentication-error" role="alert">{loadError || actionError || launchError}</p>}
        {!sessions && !loadError && <p className="system-caption" role="status">正在读取终端会话…</p>}
        {sessions?.length === 0 && (
          <div className="terminal-sessions-empty">
            <SquareTerminal size={24} aria-hidden="true" />
            <p>暂无运行中的会话</p>
          </div>
        )}
        {!!sessions?.length && <ul className="terminal-session-list" role="list">
          {sessions.map(session => {
            const local = windows[terminalWindowId(session.id)]
            const needsTakeover = !local && session.attached
            const status = local?.stage === 'minimized' ? 'minimized' : local ? 'visible'
              : session.attached ? 'remote' : 'background'
            return (
              <li key={session.id} className="terminal-session">
                <div className="terminal-session-info">
                  <span className="terminal-session-icon" aria-hidden="true"><SquareTerminal size={19} /></span>
                  <div>
                    <strong title={session.name}>{session.name}</strong>
                    <span className="terminal-session-status" data-status={status}>{statusLabels[status]}</span>
                  </div>
                </div>
                <div className="terminal-session-times">
                  <span>创建于</span><time dateTime={session.createdAt}>{formatTime.format(Date.parse(session.createdAt))}</time>
                  <span>最近接入</span>{session.lastAttachedAt
                    ? <time dateTime={session.lastAttachedAt}>{formatTime.format(Date.parse(session.lastAttachedAt))}</time>
                    : <span>尚未接入</span>}
                </div>
                <div className="terminal-session-actions">
                  <button className="app-control terminal-session-open" type="button" onClick={() => onOpen(session, needsTakeover)}>
                    {local ? '显示窗口' : needsTakeover ? '接管' : '接回'}
                  </button>
                  <button className="app-control" type="button" disabled={pending} onClick={() => startAction('rename', session)}>改名</button>
                  <button className="app-control danger-control" type="button" disabled={pending} onClick={() => startAction('end', session)}>结束会话</button>
                </div>
              </li>
            )
          })}
        </ul>}
      </div>

      <dialog ref={dialog} className="service-dialog" aria-labelledby="terminal-action-title" onClose={() => {
        setAction(undefined)
        setActionError('')
      }}>
        {action && (
          <form onSubmit={confirmAction}>
            <div className="service-dialog-body">
              <h2 id="terminal-action-title">{action.type === 'rename' ? '修改会话名称' : '结束会话？'}</h2>
              {action.type === 'rename'
                ? <label className="terminal-name-field">会话名称<input name="name" defaultValue={action.session.name} required autoFocus /></label>
                : <p>「{action.session.name}」的 Shell 和其中正在运行的命令将结束。</p>}
              {actionError && <p className="authentication-error" role="alert">{actionError}</p>}
            </div>
            <div className="service-dialog-actions">
              <button className="app-control" type="button" onClick={() => dialog.current?.close()} autoFocus={action.type === 'end'}>取消</button>
              <button className={`app-control ${action.type === 'end' ? 'danger-control' : 'primary-control'}`} type="submit" disabled={pending}>
                {action.type === 'end' ? '结束会话' : '保存'}
              </button>
            </div>
          </form>
        )}
      </dialog>
    </section>
  )
}
