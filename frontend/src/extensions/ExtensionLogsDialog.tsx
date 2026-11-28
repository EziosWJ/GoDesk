import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Check, Copy, RefreshCw, Search, WrapText, X } from 'lucide-react'
import { Highlight } from '../Highlight'
import { ExtensionError, extensionErrorMessage, extensionsApi, localizedPluginName, type ExtensionPlugin } from './api'

const LOG_LINES = 200

export function ExtensionLogsDialog({ plugin, onClose }: {
  plugin: ExtensionPlugin
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const view = useRef<HTMLDivElement>(null)
  const copyTimer = useRef<number | undefined>(undefined)
  const titleId = useId()

  const [lines, setLines] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [wrap, setWrap] = useState(true)
  const [copied, setCopied] = useState(false)
  const [refreshCount, setRefreshCount] = useState(0)

  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => {
      window.clearTimeout(copyTimer.current)
      element?.close()
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    extensionsApi.logs(plugin.id, LOG_LINES, controller.signal)
      .then(next => {
        if (controller.signal.aborted) return
        setLines(next)
        setError('')
        setCopied(false)
      })
      .catch(cause => {
        if (controller.signal.aborted) return
        if (cause instanceof ExtensionError && cause.status === 401) {
          window.location.reload()
          return
        }
        setError(extensionErrorMessage(cause, '无法读取插件日志'))
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false)
          setLoaded(true)
        }
      })
    return () => controller.abort()
  }, [plugin.id, refreshCount])

  useLayoutEffect(() => {
    if (view.current && !query.trim()) {
      view.current.scrollTop = view.current.scrollHeight
    }
  }, [lines, query])

  function close() {
    dialog.current?.close()
    onClose()
  }

  function refresh() {
    setLoading(true)
    setError('')
    setRefreshCount(count => count + 1)
  }

  const needle = query.trim().toLowerCase()
  const visible = needle ? lines.filter(line => line.toLowerCase().includes(needle)) : lines

  async function copyLogs() {
    const text = visible.join('\n')
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.clearTimeout(copyTimer.current)
      copyTimer.current = window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setError('复制失败，请手动选择日志文本')
    }
  }

  return (
    <dialog
      ref={dialog}
      className="extension-dialog extension-logs-dialog"
      aria-labelledby={titleId}
      onCancel={event => { event.preventDefault(); close() }}
    >
      <div className="extension-logs-header">
        <div className="extension-logs-title">
          <h2 id={titleId}>{localizedPluginName(plugin)} 日志</h2>
          <span className="extension-id">{plugin.id} · {plugin.version}</span>
        </div>
        <button
          type="button"
          className="app-control extensions-icon-button"
          aria-label="关闭日志窗口"
          title="关闭"
          onClick={close}
        >
          <X size={15} aria-hidden="true" />
        </button>
      </div>

      <div className="extension-logs-body">
        <div className="extension-logs-toolbar">
          <label className="extension-log-search">
            <Search size={14} aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="搜索日志关键词"
              aria-label="搜索日志关键词"
            />
          </label>
          <button
            type="button"
            className="app-control extension-log-control"
            disabled={loading}
            title="手动刷新日志"
            onClick={refresh}
          >
            <RefreshCw size={14} className={loading ? 'extension-spin' : undefined} aria-hidden="true" />
            {loading ? '刷新中…' : '刷新'}
          </button>
          <button
            type="button"
            className="app-control extension-log-control"
            aria-pressed={wrap}
            title="切换自动换行"
            onClick={() => setWrap(value => !value)}
          >
            <WrapText size={14} aria-hidden="true" />自动换行
          </button>
          <button
            type="button"
            className="app-control extension-log-control"
            disabled={visible.length === 0}
            title={needle ? '复制当前匹配的日志行' : '复制全部已加载日志'}
            onClick={() => void copyLogs()}
          >
            {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
            {copied ? '已复制' : '复制'}
          </button>
        </div>

        <p className="extension-hint extension-log-meta">
          最近 {LOG_LINES} 行 · 共 {lines.length} 行{needle ? ` · 匹配 ${visible.length} 行` : ''}
        </p>

        {error && <p className="extensions-error" role="alert">{error}</p>}

        {!loaded && loading && !error && (
          <div className="extension-log-state" role="status">正在读取日志…</div>
        )}

        {loaded && !error && lines.length === 0 && (
          <div className="extension-log-state">暂无日志</div>
        )}

        {lines.length > 0 && (
          <div
            ref={view}
            className="extension-log-view"
            data-wrap={wrap ? 'true' : 'false'}
            role="log"
            aria-label={`${localizedPluginName(plugin)} 的日志`}
          >
            {visible.length === 0
              ? <p className="extension-hint">没有匹配的日志行</p>
              : visible.map((line, index) => (
                <div className="extension-log-line" key={index}>
                  <Highlight text={line} needle={query} />
                </div>
              ))}
          </div>
        )}
      </div>

      <div className="extension-dialog-actions">
        <button type="button" className="app-control" onClick={close}>关闭</button>
      </div>
    </dialog>
  )
}
