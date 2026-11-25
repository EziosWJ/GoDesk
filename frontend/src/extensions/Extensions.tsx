import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import {
  ExternalLink, MonitorUp, MonitorX, PackagePlus, Play, Power, PowerOff, Puzzle, RefreshCw, Settings2, Square, Trash2,
} from 'lucide-react'
import {
  ExtensionError, extensionsApi,
  type ExtensionConfigField, type ExtensionPlugin, type ExtensionStatus,
} from './api'
import './styles.css'

const statusLabels: Record<ExtensionStatus, string> = {
  stopped: '已停止',
  starting: '启动中',
  running: '运行中',
  stopping: '停止中',
  failed: '启动失败',
}

function unauthorized(error: unknown) {
  return error instanceof ExtensionError && error.status === 401
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '操作失败'
}

function statusLabel(plugin: ExtensionPlugin) {
  if (!plugin.enabled) return '未启用'
  if (plugin.status === 'stopped') return '已启用，已停止'
  return statusLabels[plugin.status]
}

function ConfigDialog({ plugin, onClose, onSaved }: {
  plugin: ExtensionPlugin
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const fields = Object.entries(plugin.configSchema ?? {})
  const [values, setValues] = useState<Record<string, string | boolean>>(() => {
    const initial: Record<string, string | boolean> = {}
    for (const [name, field] of fields) {
      const value = plugin.config[name]
      initial[name] = field.type === 'boolean' ? value === true : value === undefined || value === null ? '' : String(value)
    }
    return initial
  })
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])

  function close() {
    dialog.current?.close()
    onClose()
  }

  function buildPayload(): Record<string, unknown> | string {
    const payload: Record<string, unknown> = {}
    for (const [name, field] of fields) {
      const value = values[name]
      if (field.type === 'boolean') {
        payload[name] = value === true
        continue
      }
      const text = String(value ?? '')
      if (field.secret) {
        // The host omits secret values from responses, so an empty input keeps
        // the stored value.
        if (text === '') continue
        payload[name] = text
        continue
      }
      if (text.trim() === '') {
        if (field.required) return `${name} 为必填项`
        payload[name] = null
        continue
      }
      if (field.type === 'number') {
        const parsed = Number(text)
        if (!Number.isFinite(parsed)) return `${name} 需要数字`
        payload[name] = parsed
        continue
      }
      payload[name] = text
    }
    return payload
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    const payload = buildPayload()
    if (typeof payload === 'string') {
      setError(payload)
      return
    }
    setPending(true)
    setError('')
    try {
      await extensionsApi.updateConfig(plugin.id, payload)
      await onSaved()
    } catch (cause) {
      if (unauthorized(cause)) {
        window.location.reload()
        return
      }
      setError(errorMessage(cause))
    } finally {
      setPending(false)
    }
  }

  function fieldInput(name: string, field: ExtensionConfigField) {
    if (field.type === 'boolean') {
      return (
        <label className="extension-check">
          <input type="checkbox" checked={values[name] === true}
            onChange={event => setValues(current => ({ ...current, [name]: event.target.checked }))} />
          启用
        </label>
      )
    }
    return (
      <input
        type={field.secret ? 'password' : field.type === 'number' ? 'number' : 'text'}
        step={field.type === 'number' ? 'any' : undefined}
        value={String(values[name] ?? '')}
        placeholder={field.secret ? '留空保持当前值' : undefined}
        onChange={event => setValues(current => ({ ...current, [name]: event.target.value }))}
      />
    )
  }

  return (
    <dialog ref={dialog} className="extension-dialog" aria-labelledby={titleId}
      onCancel={event => { event.preventDefault(); close() }}>
      <form onSubmit={save}>
        <div className="extension-dialog-body">
          <h2 id={titleId}>{plugin.name} 配置</h2>
          {fields.length === 0 && <p className="extension-hint">该插件没有可配置项。</p>}
          {fields.length > 0 && (
            <div className="extension-form">
              {fields.map(([name, field]) => (
                <div key={name} className="extension-field">
                  <label>{name}
                    <span className="extension-field-type">{field.type}{field.required ? ' · 必填' : ''}</span>
                  </label>
                  {fieldInput(name, field)}
                </div>
              ))}
            </div>
          )}
          {error && <p className="extensions-error" role="alert">{error}</p>}
        </div>
        <div className="extension-dialog-actions">
          <button type="button" className="app-control" onClick={close}>取消</button>
          <button type="submit" className="app-control primary-control" disabled={pending}>
            {pending ? '正在保存…' : '保存'}
          </button>
        </div>
      </form>
    </dialog>
  )
}

function UninstallDialog({ plugin, onClose, onDone }: {
  plugin: ExtensionPlugin
  onClose: () => void
  onDone: () => Promise<void>
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const [purge, setPurge] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])

  function close() {
    dialog.current?.close()
    onClose()
  }

  async function confirm() {
    setPending(true)
    setError('')
    try {
      await extensionsApi.uninstall(plugin.id, purge)
      await onDone()
    } catch (cause) {
      if (unauthorized(cause)) {
        window.location.reload()
        return
      }
      setError(errorMessage(cause))
    } finally {
      setPending(false)
    }
  }

  return (
    <dialog ref={dialog} className="extension-dialog" aria-labelledby={titleId}
      onCancel={event => { event.preventDefault(); close() }}>
      <div className="extension-dialog-body">
        <h2 id={titleId}>卸载 {plugin.name}？</h2>
        <p className="extension-hint">插件包和配置会被移除。业务数据默认保留。</p>
        <label className="extension-check">
          <input type="checkbox" checked={purge}
            onChange={event => setPurge(event.target.checked)} />
          同时删除插件业务数据
        </label>
        {error && <p className="extensions-error" role="alert">{error}</p>}
      </div>
      <div className="extension-dialog-actions">
        <button type="button" className="app-control" onClick={close} autoFocus>取消</button>
        <button type="button" className="app-control danger-control" disabled={pending} onClick={() => void confirm()}>
          {pending ? '正在卸载…' : '卸载'}
        </button>
      </div>
    </dialog>
  )
}

export function Extensions({ plugins, loadError, load, shortcuts, onSetShortcut, onOpen }: {
  plugins: ExtensionPlugin[] | undefined
  loadError: string
  load: () => Promise<void>
  shortcuts: string[]
  onSetShortcut: (id: string, pinned: boolean) => void
  onOpen: (plugin: ExtensionPlugin) => void
}) {
  const [error, setError] = useState('')
  const [pending, setPending] = useState('')
  const [configPlugin, setConfigPlugin] = useState<ExtensionPlugin>()
  const [uninstallPlugin, setUninstallPlugin] = useState<ExtensionPlugin>()
  const fileInput = useRef<HTMLInputElement>(null)

  async function run(plugin: ExtensionPlugin, name: string, task: () => Promise<unknown>) {
    setPending(`${plugin.id}:${name}`)
    setError('')
    try {
      await task()
      await load()
    } catch (cause) {
      if (unauthorized(cause)) {
        window.location.reload()
        return
      }
      setError(errorMessage(cause))
    } finally {
      setPending('')
    }
  }

  async function install(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setPending('install')
    setError('')
    try {
      await extensionsApi.install(file)
      await load()
    } catch (cause) {
      if (unauthorized(cause)) {
        window.location.reload()
        return
      }
      setError(errorMessage(cause))
    } finally {
      setPending('')
    }
  }

  return (
    <div className="extensions-page">
      <header className="extensions-toolbar">
        <div>
          <h2>扩展</h2>
          <p className="system-caption">安装 ZIP 后启用；插件在 GoDesk 进程内运行。</p>
        </div>
        <div className="extensions-toolbar-actions">
          <button type="button" className="app-control" disabled={pending === 'install'}
            onClick={() => fileInput.current?.click()}>
            <PackagePlus size={15} aria-hidden="true" />
            {pending === 'install' ? '正在安装…' : '安装 ZIP'}
          </button>
          <button type="button" className="app-control extensions-icon-button"
            aria-label="刷新扩展列表" title="刷新" onClick={() => { setError(''); void load() }}>
            <RefreshCw size={15} aria-hidden="true" />
          </button>
          <input ref={fileInput} type="file" accept=".zip,application/zip" hidden onChange={event => void install(event)} />
        </div>
      </header>

      {(error || loadError) && <p className="extensions-error extensions-banner" role="alert">{error || loadError}</p>}

      <div className="extensions-list">
        {plugins === undefined && !loadError && <p className="extension-hint" role="status">正在加载扩展…</p>}
        {plugins?.length === 0 && (
          <div className="extensions-empty">
            <Puzzle size={34} aria-hidden="true" />
            <h3>还没有安装扩展</h3>
            <p>选择 Extension-Host 构建出的插件 ZIP 进行安装。</p>
            <button type="button" className="app-control" onClick={() => fileInput.current?.click()}>
              <PackagePlus size={15} aria-hidden="true" />安装 ZIP
            </button>
          </div>
        )}
        {plugins?.map(plugin => {
          const busy = pending.startsWith(`${plugin.id}:`)
          const starting = plugin.status === 'starting' || plugin.status === 'stopping'
          const pinned = shortcuts.includes(plugin.id)
          return (
            <article key={plugin.id} className="extension-row" data-status={plugin.status}>
              <div className="extension-row-main">
                <div className="extension-title">
                  <Puzzle size={17} className="extension-icon" aria-hidden="true" />
                  <h3>{plugin.name}</h3>
                  <span className="extension-version">{plugin.version}</span>
                  <span className="extension-status" data-status={plugin.status}>{statusLabel(plugin)}</span>
                  {plugin.hasWeb && <span className="extension-capability">Web</span>}
                  {plugin.hasLua && <span className="extension-capability">Lua</span>}
                </div>
                <p className="extension-id">{plugin.id}</p>
                {plugin.error && <p className="extensions-error" role="alert">{plugin.error}</p>}
              </div>
              <div className="extension-actions">
                {plugin.enabled ? (
                  <button type="button" className="app-control" disabled={busy || starting}
                    onClick={() => void run(plugin, 'disable', () => extensionsApi.disable(plugin.id))}>
                    <PowerOff size={14} aria-hidden="true" />禁用
                  </button>
                ) : (
                  <button type="button" className="app-control primary-control" disabled={busy}
                    onClick={() => void run(plugin, 'enable', () => extensionsApi.enable(plugin.id))}>
                    <Power size={14} aria-hidden="true" />启用
                  </button>
                )}
                {plugin.enabled && plugin.status === 'running' && (
                  <button type="button" className="app-control" disabled={busy}
                    onClick={() => void run(plugin, 'stop', () => extensionsApi.stop(plugin.id))}>
                    <Square size={14} aria-hidden="true" />停止
                  </button>
                )}
                {plugin.enabled && (plugin.status === 'stopped' || plugin.status === 'failed') && (
                  <button type="button" className="app-control" disabled={busy}
                    onClick={() => void run(plugin, 'start', () => extensionsApi.start(plugin.id))}>
                    <Play size={14} aria-hidden="true" />{plugin.status === 'failed' ? '重试' : '启动'}
                  </button>
                )}
                <button type="button" className="app-control" disabled={busy}
                  onClick={() => setConfigPlugin(plugin)}>
                  <Settings2 size={14} aria-hidden="true" />配置
                </button>
                <button type="button" className="app-control" disabled={busy || plugin.status !== 'running' || !plugin.hasWeb}
                  title={plugin.hasWeb ? undefined : '该插件没有 Web 入口'}
                  onClick={() => onOpen(plugin)}>
                  <ExternalLink size={14} aria-hidden="true" />打开
                </button>
                {plugin.hasWeb && (
                  <button type="button" className="app-control" disabled={busy}
                    onClick={() => onSetShortcut(plugin.id, !pinned)}>
                    {pinned ? <MonitorX size={14} aria-hidden="true" /> : <MonitorUp size={14} aria-hidden="true" />}
                    {pinned ? '移除桌面快捷方式' : '添加到桌面'}
                  </button>
                )}
                <button type="button" className="app-control" disabled={busy}
                  onClick={() => setUninstallPlugin(plugin)}>
                  <Trash2 size={14} aria-hidden="true" />卸载
                </button>
              </div>
            </article>
          )
        })}
      </div>

      {configPlugin && (
        <ConfigDialog key={configPlugin.id} plugin={configPlugin}
          onClose={() => setConfigPlugin(undefined)}
          onSaved={async () => { setConfigPlugin(undefined); await load() }} />
      )}
      {uninstallPlugin && (
        <UninstallDialog key={uninstallPlugin.id} plugin={uninstallPlugin}
          onClose={() => setUninstallPlugin(undefined)}
          onDone={async () => {
            onSetShortcut(uninstallPlugin.id, false)
            setUninstallPlugin(undefined)
            await load()
          }} />
      )}
    </div>
  )
}
