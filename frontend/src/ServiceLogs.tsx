import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowDownToLine, Copy, Search, WrapText } from 'lucide-react'
import { ServiceError, servicesApi } from './services'
import { Highlight } from './Highlight'

const LOG_LINES = 500

type ServiceLogsProps = {
  unit: string
  active: boolean
  version: number
}

function logsErrorMessage(error: unknown) {
  if (error instanceof ServiceError) {
    switch (error.code) {
      case 'permission': return '权限不足：无法读取系统日志'
      case 'logs_unavailable': return '当前系统没有可用的 journalctl'
      case 'timeout': return '读取日志超时'
      default: return error.message
    }
  }
  return error instanceof Error ? error.message : '无法读取日志'
}

export function ServiceLogs({ unit, active, version }: ServiceLogsProps) {
  const [lines, setLines] = useState<string[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [follow, setFollow] = useState(true)
  const [wrap, setWrap] = useState(true)
  const [query, setQuery] = useState('')
  const [copied, setCopied] = useState(false)
  const view = useRef<HTMLDivElement>(null)
  const copyTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (!active || !unit) return
    const controller = new AbortController()
    servicesApi.logs(unit, LOG_LINES, controller.signal)
      .then(next => {
        if (controller.signal.aborted) return
        setLines(next)
        setError('')
        setCopied(false)
      })
      .catch(caught => {
        if (controller.signal.aborted) return
        if (caught instanceof ServiceError && caught.status === 401) {
          window.location.reload()
          return
        }
        setLines([])
        setError(logsErrorMessage(caught))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoaded(true)
      })
    return () => controller.abort()
  }, [active, unit, version])

  useEffect(() => () => window.clearTimeout(copyTimer.current), [])

  useLayoutEffect(() => {
    if (follow && view.current) view.current.scrollTop = view.current.scrollHeight
  }, [lines, follow])

  const needle = query.trim().toLowerCase()
  const visible = needle ? lines.filter(line => line.toLowerCase().includes(needle)) : lines

  async function copyLines() {
    try {
      await navigator.clipboard.writeText(lines.join('\n'))
      setCopied(true)
      window.clearTimeout(copyTimer.current)
      copyTimer.current = window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setError('复制失败，请手动选择日志文本')
    }
  }

  return (
    <div className="service-logs-panel">
      <div className="service-logs-toolbar">
        <label className="service-log-search">
          <Search size={14} aria-hidden="true" />
          <input type="search" value={query} onChange={event => setQuery(event.target.value)}
            placeholder="搜索日志" aria-label="搜索日志" />
        </label>
        <button type="button" className="app-control service-log-toggle" aria-pressed={follow}
          title="加载后自动滚动到底部" onClick={() => setFollow(value => !value)}>
          <ArrowDownToLine size={14} aria-hidden="true" />跟随尾部
        </button>
        <button type="button" className="app-control service-log-toggle" aria-pressed={wrap}
          title="自动换行" onClick={() => setWrap(value => !value)}>
          <WrapText size={14} aria-hidden="true" />自动换行
        </button>
        <button type="button" className="app-control service-log-toggle" disabled={lines.length === 0}
          title="复制全部已加载行" onClick={() => { void copyLines() }}>
          <Copy size={14} aria-hidden="true" />{copied ? '已复制' : '复制'}
        </button>
      </div>
      <p className="system-caption service-log-meta">
        最近 {LOG_LINES} 行{needle ? ` · 匹配 ${visible.length} 行` : ''}
      </p>
      {error && <p className="service-alert" role="alert">{error}</p>}
      {!loaded && !error && <p className="system-caption" role="status">正在读取日志…</p>}
      {loaded && !error && lines.length === 0 && <p className="system-caption">暂无日志</p>}
      {lines.length > 0 && (
        <div ref={view} className="service-log-view" data-wrap={wrap ? 'true' : 'false'}
          role="log" aria-label={`${unit} 的日志`}>
          {visible.length === 0
            ? <p className="system-caption">没有匹配的日志行</p>
            : visible.map((line, index) => (
              <div className="service-log-line" key={index}><Highlight text={line} needle={query} /></div>
            ))}
        </div>
      )}
    </div>
  )
}
