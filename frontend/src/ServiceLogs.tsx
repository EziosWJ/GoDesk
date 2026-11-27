import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react'
import { ArrowDownToLine, Copy, Search, WrapText } from 'lucide-react'
import { ServiceError, servicesApi } from './services'
import { Highlight } from './Highlight'

const LOG_LINES = 500
const STREAM_INITIAL_LINES = 200
const MAX_LIVE_LINES = 2000

type StreamStatus = 'idle' | 'connecting' | 'live' | 'error'

type ServiceLogsProps = {
  unit: string
  active: boolean
  version: number
  logsAvailable?: boolean
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

function streamErrorMessage(raw: string) {
  try {
    const parsed = JSON.parse(raw) as { code?: string; message?: string }
    switch (parsed.code) {
      case 'permission': return '权限不足：无法读取系统日志'
      case 'logs_unavailable': return '当前系统没有可用的 journalctl'
      case 'timeout': return '读取日志超时'
      default: return parsed.message || '实时日志发生错误'
    }
  } catch {
    return '实时日志发生错误'
  }
}

export function ServiceLogs({ unit, active, version, logsAvailable = true }: ServiceLogsProps) {
  const [lines, setLines] = useState<string[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [follow, setFollow] = useState(true)
  const [wrap, setWrap] = useState(true)
  const [query, setQuery] = useState('')
  const [copied, setCopied] = useState(false)
  const [live, setLive] = useState(false)
  const [streamStatus, setStreamStatus] = useState<StreamStatus>('idle')
  const [prevActive, setPrevActive] = useState(active)
  const [prevUnit, setPrevUnit] = useState(unit)
  const view = useRef<HTMLDivElement>(null)
  const copyTimer = useRef<number | undefined>(undefined)
  const staticController = useRef<AbortController | undefined>(undefined)

  if (unit !== prevUnit) {
    setPrevUnit(unit)
    setLive(false)
    setStreamStatus('idle')
    setLines([])
    setLoaded(false)
    setError('')
    setCopied(false)
  }

  if (active !== prevActive) {
    setPrevActive(active)
    if (!active) {
      setLive(false)
      setStreamStatus('idle')
    }
  }

  const isLive = useEffectEvent(() => live)

  useEffect(() => {
    if (!active || !unit || isLive()) return
    staticController.current?.abort()
    const controller = new AbortController()
    staticController.current = controller
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
    return () => {
      controller.abort()
      if (staticController.current === controller) staticController.current = undefined
    }
  }, [active, unit, version])

  useEffect(() => {
    if (!active || !live || !logsAvailable || !unit) return
    staticController.current?.abort()
    const source = new EventSource(servicesApi.logsStreamUrl(unit, STREAM_INITIAL_LINES))
    let closed = false
    let resetDone = false
    let pending: string[] = []
    let rafId: number | undefined

    function flush() {
      rafId = undefined
      if (closed || pending.length === 0) return
      const batch = pending
      pending = []
      const shouldReset = !resetDone
      resetDone = true
      setLines(current => {
        const next = shouldReset ? batch : [...current, ...batch]
        return next.length > MAX_LIVE_LINES ? next.slice(-MAX_LIVE_LINES) : next
      })
    }

    function onOpen() {
      if (closed) return
      if (!resetDone) {
        resetDone = true
        setLines([])
      }
      setLoaded(true)
      setStreamStatus('live')
      setError('')
      setCopied(false)
    }

    function onMessage(event: MessageEvent<string>) {
      if (closed) return
      try {
        const parsed = JSON.parse(event.data) as { line?: unknown }
        if (typeof parsed?.line !== 'string') return
        pending.push(parsed.line)
        setStreamStatus('live')
        setLoaded(true)
        if (rafId === undefined) rafId = window.requestAnimationFrame(flush)
      } catch {
        // Ignore malformed event payloads.
      }
    }

    function onError(event: Event) {
      if (closed) return
      closed = true
      if (rafId !== undefined) {
        window.cancelAnimationFrame(rafId)
        rafId = undefined
      }
      source.close()
      setLive(false)
      setStreamStatus('error')
      setLoaded(true)
      if (event instanceof MessageEvent && typeof event.data === 'string') {
        setError(streamErrorMessage(event.data))
      } else {
        setError('实时日志连接已中断，请重试')
      }
    }

    source.addEventListener('open', onOpen)
    source.addEventListener('message', onMessage)
    source.addEventListener('error', onError)

    return () => {
      closed = true
      if (rafId !== undefined) window.cancelAnimationFrame(rafId)
      source.removeEventListener('open', onOpen)
      source.removeEventListener('message', onMessage)
      source.removeEventListener('error', onError)
      source.close()
    }
  }, [active, live, logsAvailable, unit])

  useEffect(() => () => window.clearTimeout(copyTimer.current), [])

  useLayoutEffect(() => {
    if (follow && view.current) view.current.scrollTop = view.current.scrollHeight
  }, [lines, follow])

  const needle = query.trim().toLowerCase()
  const visible = needle ? lines.filter(line => line.toLowerCase().includes(needle)) : lines

  function toggleLive() {
    if (!logsAvailable) return
    if (live) {
      setLive(false)
      setStreamStatus('idle')
    } else {
      setError('')
      setStreamStatus('connecting')
      setLive(true)
    }
  }

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

  const metaText = live
    ? streamStatus === 'connecting'
      ? '正在连接实时日志…'
      : `实时日志 · ${lines.length}/${MAX_LIVE_LINES} 行${needle ? ` · 匹配 ${visible.length} 行` : ''}`
    : lines.length > LOG_LINES
      ? `已加载 ${lines.length} 行${needle ? ` · 匹配 ${visible.length} 行` : ''}`
      : `最近 ${LOG_LINES} 行${needle ? ` · 匹配 ${visible.length} 行` : ''}`

  return (
    <div className="service-logs-panel">
      <div className="service-logs-toolbar">
        <label className="service-log-search">
          <Search size={14} aria-hidden="true" />
          <input type="search" value={query} onChange={event => setQuery(event.target.value)}
            placeholder="搜索日志" aria-label="搜索日志" />
        </label>
        {logsAvailable && (
          <button type="button" className="app-control service-log-toggle service-log-live"
            aria-pressed={live} data-stream={streamStatus}
            title={live ? '停止实时日志' : '开启实时日志（SSE）'}
            onClick={toggleLive}>
            <span className="service-live-dot" aria-hidden="true" />
            实时
          </button>
        )}
        <button type="button" className="app-control service-log-toggle" aria-pressed={follow}
          title="加载或收到新日志时自动滚动到底部" onClick={() => setFollow(value => !value)}>
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
      <p className="system-caption service-log-meta" role={live ? 'status' : undefined}>
        {metaText}
      </p>
      {error && <p className="service-alert" role="alert">{error}</p>}
      {!live && !loaded && !error && <p className="system-caption" role="status">正在读取日志…</p>}
      {live && streamStatus === 'connecting' && !error && lines.length === 0 && (
        <p className="system-caption" role="status">正在连接实时日志…</p>
      )}
      {live && streamStatus === 'live' && !error && lines.length === 0 && (
        <p className="system-caption" role="status">已连接，等待新日志…</p>
      )}
      {!live && loaded && !error && lines.length === 0 && <p className="system-caption">暂无日志</p>}
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
