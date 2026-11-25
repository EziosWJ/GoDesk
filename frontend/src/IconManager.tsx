import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { ExternalLink, Globe, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { openWebShortcut, webShortcutsApi, type WebShortcut } from './webShortcuts'
import './styles/icon-manager.css'

type DialogAction =
  | { kind: 'create' }
  | { kind: 'edit' | 'delete'; item: WebShortcut }

function ShortcutDialog({ action, onClose, onChange }: {
  action: DialogAction
  onClose: () => void
  onChange: () => Promise<void>
}) {
  const item = action.kind === 'create' ? undefined : action.item
  const removing = action.kind === 'delete'
  const title = action.kind === 'create' ? '新建网页快捷方式' : removing ? '删除网页快捷方式' : '编辑网页快捷方式'
  const titleId = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const fields = new FormData(event.currentTarget)
    setPending(true)
    setError('')
    try {
      if (removing) {
        await webShortcutsApi.remove(action.item.id)
      } else {
        await webShortcutsApi.save({
          name: String(fields.get('name')),
          url: String(fields.get('url')),
          parameterName: String(fields.get('parameterName')),
          secret: String(fields.get('secret')),
        }, item?.id)
      }
      await onChange()
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败，请重试')
    } finally {
      setPending(false)
    }
  }

  return (
    <dialog ref={dialog} className="service-dialog" aria-labelledby={titleId}
      onCancel={event => { event.preventDefault(); if (!pending) onClose() }}>
      <form className="icon-manager-form" onSubmit={event => void submit(event)}>
        <div className="service-dialog-body">
          <h2 id={titleId}>{title}</h2>
          {removing ? <p>删除桌面上的「{item?.name}」快捷方式？</p> : (
            <fieldset disabled={pending} className="icon-manager-fields">
              <label>名称
                <input name="name" defaultValue={item?.name} required autoFocus />
              </label>
              <label>网页地址
                <input type="url" name="url" defaultValue={item?.url} placeholder="https://"
                  spellCheck={false} required />
              </label>
              <label>登录参数名（可选）
                <input name="parameterName" defaultValue={item?.parameterName} placeholder="例如 k" spellCheck={false} />
              </label>
              <label>密钥值
                <input type="password" name="secret" autoComplete="new-password"
                  placeholder={item?.parameterName ? '留空保留当前密钥' : undefined} />
              </label>
              {item?.parameterName && <p className="system-caption">清空登录参数名可移除已保存的密钥。</p>}
            </fieldset>
          )}
          {error && <p className="authentication-error" role="alert">{error}</p>}
        </div>
        <div className="service-dialog-actions">
          <button type="button" className="app-control" disabled={pending} autoFocus={removing}
            onClick={onClose}>取消</button>
          <button type="submit" className={`app-control ${removing ? 'danger-control' : 'primary-control'}`}
            disabled={pending}>{pending ? '正在处理…' : removing ? '删除' : '保存'}</button>
        </div>
      </form>
    </dialog>
  )
}

export function IconManager({ items, error, load }: {
  items: WebShortcut[] | undefined
  error: string
  load: () => Promise<void>
}) {
  const [action, setAction] = useState<DialogAction>()

  return (
    <div className="icon-manager">
      <header className="icon-manager-toolbar">
        <h2>网页快捷方式</h2>
        <button type="button" className="app-control primary-control" onClick={() => setAction({ kind: 'create' })}>
          <Plus size={16} aria-hidden="true" />新建网页快捷方式
        </button>
      </header>
      <div className="icon-manager-list">
        {error && (
          <div className="icon-manager-error">
            <p className="authentication-error" role="alert">{error}</p>
            <button type="button" className="app-control" onClick={() => void load()}>
              <RefreshCw size={14} aria-hidden="true" />重试
            </button>
          </div>
        )}
        {!items && !error && <p className="system-caption" role="status">正在加载…</p>}
        {items?.length === 0 && !error && <p className="system-caption">还没有网页快捷方式。</p>}
        {items?.map(item => (
          <article key={item.id} className="icon-manager-row" aria-label={item.name}>
            <Globe size={20} className="app-icon" aria-hidden="true" />
            <div className="icon-manager-address">
              <h3 className="truncate">{item.name}</h3>
              <p className="system-caption truncate" title={item.url}>{item.url}</p>
            </div>
            <div className="icon-manager-actions">
              <button type="button" className="app-control" onClick={() => openWebShortcut(item.id)}>
                <ExternalLink size={14} aria-hidden="true" />打开
              </button>
              <button type="button" className="app-control" onClick={() => setAction({ kind: 'edit', item })}>
                <Pencil size={14} aria-hidden="true" />编辑
              </button>
              <button type="button" className="app-control" onClick={() => setAction({ kind: 'delete', item })}>
                <Trash2 size={14} aria-hidden="true" />删除
              </button>
            </div>
          </article>
        ))}
      </div>
      {action && <ShortcutDialog action={action} onChange={load} onClose={() => setAction(undefined)} />}
    </div>
  )
}
