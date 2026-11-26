import { useEffect, useRef, useState, type FormEvent } from 'react'
import { AppWindow, CircleStop, KeyRound, Pencil, Plus, RefreshCw, SquareTerminal, type LucideIcon } from 'lucide-react'
import type { WindowState } from '@surdeddd/wmkit'
import { terminalApi, terminalWindowId, type TerminalSession } from './terminal'

const formatTime = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' })
type SessionAction = { type: 'rename' | 'end'; session: TerminalSession }

function SessionActionButton({ label, icon: Icon, disabled, danger, onClick }: {
  label: string
  icon: LucideIcon
  disabled?: boolean
  danger?: boolean
  onClick: () => void
}) {
  return (
    <button className={`app-control terminal-action${danger ? ' danger-control' : ''}`} type="button"
      aria-label={label} disabled={disabled} onClick={onClick}>
      <Icon size={16} aria-hidden="true" />
      <span className="terminal-action-tooltip" aria-hidden="true">{label}</span>
    </button>
  )
}

export function TerminalSessions({ active, windows, onOpen, onRename }: {
  active: boolean
  windows: Readonly<Record<string, Pick<WindowState, 'stage' | 'meta'>>>
  onOpen: (session: TerminalSession, takeControl?: boolean) => void
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
        {(loadError || !action && actionError) &&
          <p className="authentication-error" role="alert">{loadError || actionError}</p>}
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
            const controlsHere = session.controllerClientId !== null && session.controllerClientId === local?.meta.clientId
            const controlLabel = session.controllerClientId ? '接管' : '取得控制权'
            const status = controlsHere ? '本桌面控制'
              : session.controllerClientId ? '其他位置控制'
              : session.attached ? '只读观看' : '后台运行'
            const windowStatus = local?.stage === 'minimized' ? ' · 已最小化' : ''
            return (
              <li key={session.id} className="terminal-session">
                <div className="terminal-session-info">
                  <span className="terminal-session-icon" aria-hidden="true"><SquareTerminal size={19} /></span>
                  <div>
                    <strong title={session.name}>{session.name}</strong>
                    <span className="terminal-session-status">{status}{windowStatus}</span>
                  </div>
                </div>
                <div className="terminal-session-times">
                  <span>创建于</span><time dateTime={session.createdAt}>{formatTime.format(Date.parse(session.createdAt))}</time>
                  <span>最近接入</span>{session.lastAttachedAt
                    ? <time dateTime={session.lastAttachedAt}>{formatTime.format(Date.parse(session.lastAttachedAt))}</time>
                    : <span>尚未接入</span>}
                </div>
                <div className="terminal-session-actions">
                  <SessionActionButton label={local ? '显示窗口' : '打开'} icon={AppWindow}
                    onClick={() => onOpen(session)} />
                  {session.attached && !controlsHere && (
                    <SessionActionButton label={controlLabel} icon={KeyRound} onClick={() => onOpen(session, true)} />
                  )}
                  <SessionActionButton label="改名" icon={Pencil} disabled={pending}
                    onClick={() => startAction('rename', session)} />
                  <SessionActionButton label="结束会话" icon={CircleStop} danger disabled={pending}
                    onClick={() => startAction('end', session)} />
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
