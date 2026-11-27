import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronRight, Pause, Play, RefreshCw, Search, X } from 'lucide-react'
import {
  formatBytes,
  formatPercent,
  monitorApi,
  MonitorError,
  type ProcessDetail,
  type ProcessInfo,
  type ProcessList,
  type ProcessNode,
  type ProcessSignal,
  type ProcessSort,
  type SortOrder,
} from './monitor'

type ColumnSortKey = ProcessSort | 'user' | 'state'

type SelectedProcess = {
  pid: number
  startTicks: number
  name: string
  user: string
  revision: number
}

const POLL_INTERVAL_MS = 5000
const SEARCH_DEBOUNCE_MS = 200

const STATE_LABELS: Record<string, string> = {
  R: '运行中',
  S: '休眠',
  D: '不可中断等待',
  Z: '僵尸',
  T: '已停止',
  t: '追踪停止',
  I: '空闲',
  X: '已退出',
  W: '换页中',
}

const timeFormat = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

const dateTimeFormat = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

function isServerSort(key: ColumnSortKey): key is ProcessSort {
  return key === 'cpu' || key === 'memory' || key === 'pid' || key === 'name'
}

function defaultOrderFor(key: ColumnSortKey): SortOrder {
  return key === 'cpu' || key === 'memory' ? 'desc' : 'asc'
}

function stateLabel(state: string) {
  return STATE_LABELS[state] ?? state
}

function formatClock(iso: string | undefined) {
  if (!iso) return '—'
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '—' : timeFormat.format(date)
}

function formatTimestamp(iso: string | undefined) {
  if (!iso) return '—'
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '—' : dateTimeFormat.format(date)
}

function processKey(proc: Pick<ProcessInfo, 'pid' | 'startTicks'>) {
  return `${proc.pid}:${proc.startTicks}`
}

function sameProcess(left: Pick<ProcessInfo, 'pid' | 'startTicks'>, right?: Pick<ProcessInfo, 'pid' | 'startTicks'>) {
  return !!right && left.pid === right.pid && left.startTicks === right.startTicks
}

function errorMessage(failure: unknown, fallback: string) {
  if (failure instanceof MonitorError) {
    if (failure.status === 401) window.location.reload()
    if (failure.code === 'sudo_unavailable') {
      return '权限不足：终止其他用户的进程需要配置 GoDesk 免密 sudo 授权。'
    }
    if (failure.code === 'forbidden_pid') {
      return '系统核心进程（PID 1）禁止终止。'
    }
    if (failure.code === 'permission_denied') {
      return '权限不足，无法终止该进程。'
    }
    if (failure.code === 'process_not_found') {
      return '进程已退出或不存在。'
    }
    if (failure.code === 'process_changed') {
      return '目标进程已变化（PID 已被复用），请重新选择。'
    }
    if (failure.code === 'timeout') {
      return '发送信号超时，请刷新列表确认进程状态。'
    }
    if (failure.code && failure.message) return failure.message
  }
  return fallback
}

function SortButton({
  label,
  column,
  sortKey,
  order,
  onSort,
}: {
  label: string
  column: ColumnSortKey
  sortKey: ColumnSortKey
  order: SortOrder
  onSort: (key: ColumnSortKey) => void
}) {
  const Icon = order === 'asc' ? ArrowUp : ArrowDown
  return (
    <button className="monitor-sort" type="button" onClick={() => onSort(column)}>
      {label}
      {sortKey === column && <Icon size={12} aria-hidden="true" />}
    </button>
  )
}

function ProcessTreeBranch({
  node,
  target,
}: {
  node: ProcessNode
  target: Pick<ProcessInfo, 'pid' | 'startTicks'>
}) {
  const selected = sameProcess(node, target)
  return (
    <li>
      <div className="monitor-process-node" data-listener={selected}>
        <strong>{node.process}</strong>
        <span>PID {node.pid}</span>
        <span>{node.user || '—'}</span>
        {selected && <span className="monitor-process-listener">当前进程</span>}
      </div>
      {node.children && node.children.length > 0 && (
        <ul>
          {node.children.map(child => (
            <ProcessTreeBranch key={`${child.pid}-${child.startTicks}`} node={child} target={target} />
          ))}
        </ul>
      )}
    </li>
  )
}

export function ProcessesPanel() {
  const [list, setList] = useState<ProcessList>()
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [sortKey, setSortKey] = useState<ColumnSortKey>('cpu')
  const [order, setOrder] = useState<SortOrder>('desc')
  const [paused, setPaused] = useState(false)
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible')
  const [refreshTick, setRefreshTick] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [selection, setSelection] = useState<SelectedProcess>()
  const [notice, setNotice] = useState('')
  const detailId = useId()
  const prevPausedRef = useRef(paused)
  const prevVisibleRef = useRef(visible)

  // Track document visibility so we NEVER poll when hidden.
  useEffect(() => {
    function handleVisibility() {
      setVisible(document.visibilityState === 'visible')
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [])

  // Debounce non-empty search queries so typing does not flood /proc scans.
  useEffect(() => {
    const trimmed = query.trim()
    if (!trimmed) return
    const timer = window.setTimeout(() => setDebouncedQuery(trimmed), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [query])

  const serverSort: ProcessSort = isServerSort(sortKey) ? sortKey : 'cpu'
  const serverOrder: SortOrder = isServerSort(sortKey) ? order : 'desc'

  // On-demand polling: ONLY fetches while this tab is mounted AND document is visible.
  useEffect(() => {
    const justPaused = !prevPausedRef.current && paused
    const resumedVisibilityWhilePaused = !prevVisibleRef.current && visible && paused
    prevPausedRef.current = paused
    prevVisibleRef.current = visible

    if (!visible || justPaused || resumedVisibilityWhilePaused) return

    const controller = new AbortController()
    let timer: number | undefined
    let stopped = false

    async function load() {
      if (document.visibilityState !== 'visible') return
      setRefreshing(true)
      try {
        const next = await monitorApi.processes(
          { q: debouncedQuery, sort: serverSort, order: serverOrder },
          controller.signal,
        )
        if (controller.signal.aborted) return
        setList(next)
        setError('')
      } catch (failure) {
        if (controller.signal.aborted) return
        if (failure instanceof MonitorError && failure.status === 401) {
          stopped = true
          window.location.reload()
          return
        }
        setError(errorMessage(failure, '无法读取进程列表，正在重试…'))
      } finally {
        if (!controller.signal.aborted) setRefreshing(false)
        if (!stopped && !paused && !controller.signal.aborted && document.visibilityState === 'visible') {
          timer = window.setTimeout(load, POLL_INTERVAL_MS)
        }
      }
    }

    void load()
    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [debouncedQuery, serverSort, serverOrder, paused, visible, refreshTick])

  const protectedSet = useMemo(() => new Set(list?.protectedPids ?? []), [list?.protectedPids])

  const rows = useMemo(() => {
    const items = list?.processes ?? []
    if (isServerSort(sortKey)) return items
    const dir = order === 'asc' ? 1 : -1
    return [...items].sort((left, right) => {
      const cmp = sortKey === 'user'
        ? left.user.localeCompare(right.user, 'zh-CN')
        : left.state.localeCompare(right.state)
      return cmp !== 0 ? cmp * dir : left.pid - right.pid
    })
  }, [list?.processes, sortKey, order])

  function toggleSort(column: ColumnSortKey) {
    if (sortKey === column) {
      setOrder(previous => (previous === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(column)
      setOrder(defaultOrderFor(column))
    }
  }

  function selectProcess(proc: ProcessInfo) {
    setNotice('')
    setSelection(previous => ({
      pid: proc.pid,
      startTicks: proc.startTicks,
      name: proc.name,
      user: proc.user,
      revision: (previous?.revision ?? 0) + 1,
    }))
  }

  const currentMatch = selection && list?.processes.find(item => sameProcess(item, selection))
  const sortDirection = order === 'asc' ? 'ascending' : 'descending'

  return (
    <div className="monitor-ports monitor-processes" role="tabpanel" id="monitor-processes-panel" aria-labelledby="monitor-processes-tab">
      <div className="monitor-ports-toolbar monitor-processes-toolbar">
        <label className="monitor-filter">
          <Search size={15} aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={event => {
              const next = event.target.value
              setQuery(next)
              if (!next.trim()) setDebouncedQuery('')
            }}
            placeholder="搜索进程名、PID 或用户"
            aria-label="筛选进程"
          />
        </label>
        <div className="monitor-processes-controls">
          <button
            type="button"
            className="app-control"
            aria-pressed={paused}
            onClick={() => setPaused(value => !value)}
          >
            {paused ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}
            <span>{paused ? '继续' : '暂停'}</span>
          </button>
          <button
            type="button"
            className="app-control"
            disabled={refreshing}
            onClick={() => setRefreshTick(value => value + 1)}
          >
            <RefreshCw size={14} className={refreshing ? 'monitor-spin' : undefined} aria-hidden="true" />
            <span>手动刷新</span>
          </button>
        </div>
        <span className="system-caption monitor-processes-meta" role="status">
          {list ? `${list.total} 个进程 · 更新于 ${formatClock(list.collectedAt)}` : error ? '读取失败' : '载入中…'}
        </span>
      </div>

      {error && <p className="authentication-error monitor-ports-error" role="alert">{error}</p>}

      <div className="monitor-ports-scroll">
        {!list && !error && <p className="monitor-ports-status system-caption" role="status">正在读取进程列表…</p>}
        {list && rows.length === 0 && <p className="monitor-ports-status system-caption">没有找到匹配的进程</p>}
        {rows.length > 0 && (
          <table className="data-table monitor-ports-table monitor-processes-table">
            <thead>
              <tr>
                <th scope="col" aria-sort={sortKey === 'pid' ? sortDirection : 'none'}>
                  <SortButton label="PID" column="pid" sortKey={sortKey} order={order} onSort={toggleSort} />
                </th>
                <th scope="col" aria-sort={sortKey === 'name' ? sortDirection : 'none'}>
                  <SortButton label="进程名" column="name" sortKey={sortKey} order={order} onSort={toggleSort} />
                </th>
                <th scope="col" aria-sort={sortKey === 'user' ? sortDirection : 'none'}>
                  <SortButton label="用户" column="user" sortKey={sortKey} order={order} onSort={toggleSort} />
                </th>
                <th scope="col" aria-sort={sortKey === 'state' ? sortDirection : 'none'}>
                  <SortButton label="状态" column="state" sortKey={sortKey} order={order} onSort={toggleSort} />
                </th>
                <th scope="col" className="monitor-col-numeric" aria-sort={sortKey === 'cpu' ? sortDirection : 'none'}>
                  <SortButton label="CPU%" column="cpu" sortKey={sortKey} order={order} onSort={toggleSort} />
                </th>
                <th scope="col" className="monitor-col-numeric" aria-sort={sortKey === 'memory' ? sortDirection : 'none'}>
                  <SortButton label="内存 (RSS)" column="memory" sortKey={sortKey} order={order} onSort={toggleSort} />
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(proc => {
                const key = processKey(proc)
                const expanded = sameProcess(proc, selection)
                const isSelf = list?.selfPid === proc.pid
                const isProtected = protectedSet.has(proc.pid)
                return (
                  <tr key={key} data-selected={expanded} onClick={() => selectProcess(proc)}>
                    <td>
                      <button
                        className="monitor-port-open"
                        type="button"
                        aria-label={`${proc.name} PID ${proc.pid}`}
                        aria-expanded={expanded}
                        aria-controls={expanded ? detailId : undefined}
                      >
                        <ChevronRight size={14} aria-hidden="true" />
                        {proc.pid}
                      </button>
                    </td>
                    <td className="monitor-process-name-cell" title={proc.name}>
                      <span>{proc.name}</span>
                      {proc.pid === 1 && <span className="monitor-process-tag">PID 1</span>}
                      {proc.pid !== 1 && isSelf && <span className="monitor-process-tag">GoDesk</span>}
                      {proc.pid !== 1 && !isSelf && isProtected && <span className="monitor-process-tag">父进程</span>}
                    </td>
                    <td>{proc.user || '—'}</td>
                    <td>
                      <span className="monitor-process-state" data-state={proc.state} title={stateLabel(proc.state)}>
                        {proc.state}
                      </span>
                    </td>
                    <td className="monitor-col-numeric">{formatPercent(proc.cpuPercent)}</td>
                    <td className="monitor-col-numeric">{formatBytes(proc.rssBytes)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {selection && (
        <section className="monitor-port-detail monitor-process-detail" id={detailId} aria-label={`${selection.name} 详情`}>
          <header className="monitor-port-detail-heading">
            <strong>{selection.name}（PID {selection.pid}）</strong>
            <span className="system-caption">用户 {selection.user || '—'}</span>
            {selection.pid === 1 && <span className="monitor-process-tag">系统核心进程</span>}
            {selection.pid !== 1 && protectedSet.has(selection.pid) && (
              <span className="monitor-process-tag monitor-process-tag-danger">GoDesk 自身/父进程</span>
            )}
            <button
              className="app-control monitor-port-close"
              type="button"
              aria-label="关闭进程详情"
              onClick={() => setSelection(undefined)}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </header>
          <ProcessDetailPanel
            key={selection.revision}
            selection={selection}
            inList={!!currentMatch}
            listedProtected={protectedSet.has(selection.pid)}
            onRefresh={message => {
              if (message) setNotice(message)
              setRefreshTick(value => value + 1)
            }}
          />
        </section>
      )}

      <footer className="monitor-ports-footer system-caption">
        <span>{paused ? '自动刷新已暂停 · 按需采集' : '按需采集 · 每 5 秒刷新'}</span>
        {notice && <span role="status">{notice}</span>}
      </footer>
    </div>
  )
}

function ProcessDetailPanel({
  selection,
  inList,
  listedProtected,
  onRefresh,
}: {
  selection: SelectedProcess
  inList: boolean
  listedProtected: boolean
  onRefresh: (notice?: string) => void
}) {
  const [detail, setDetail] = useState<ProcessDetail>()
  const [detailError, setDetailError] = useState('')
  const [loading, setLoading] = useState(true)
  const [stale, setStale] = useState(false)
  const [pendingSignal, setPendingSignal] = useState<ProcessSignal | null>(null)
  const [sending, setSending] = useState(false)
  const [signalError, setSignalError] = useState('')
  const dialogRef = useRef<HTMLDialogElement>(null)
  const signalController = useRef<AbortController | null>(null)
  const dialogTitleId = useId()

  useEffect(() => () => {
    signalController.current?.abort()
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void monitorApi.processDetail(selection.pid, selection.startTicks, controller.signal)
      .then(next => {
        if (controller.signal.aborted) return
        setDetail(next)
        setDetailError('')
      })
      .catch(failure => {
        if (controller.signal.aborted) return
        if (failure instanceof MonitorError && (failure.code === 'process_not_found' || failure.code === 'process_changed')) {
          setStale(true)
        }
        setDetailError(errorMessage(failure, '无法读取进程详情'))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [selection.pid, selection.startTicks])

  const isPid1 = selection.pid <= 1 || detail?.isProtected === true
  const isSelfOrAncestor = !isPid1 && (detail?.isSelfOrAncestor === true || listedProtected)
  const actionsDisabled = isPid1 || stale || sending

  function openConfirm(signal: ProcessSignal) {
    if (actionsDisabled) return
    setSignalError('')
    setPendingSignal(signal)
    dialogRef.current?.showModal()
  }

  function closeConfirm() {
    if (sending) return
    dialogRef.current?.close()
    setPendingSignal(null)
    setSignalError('')
  }

  async function confirmSignal() {
    if (!pendingSignal || isPid1) return
    const controller = new AbortController()
    signalController.current = controller
    setSending(true)
    setSignalError('')
    try {
      await monitorApi.signalProcess(
        { pid: selection.pid, startTicks: selection.startTicks, signal: pendingSignal },
        controller.signal,
      )
      if (controller.signal.aborted) return
      dialogRef.current?.close()
      setPendingSignal(null)
      onRefresh(`已向 ${selection.name}（PID ${selection.pid}）发送 ${pendingSignal}`)
    } catch (failure) {
      if (controller.signal.aborted) return
      if (failure instanceof MonitorError && (failure.code === 'process_not_found' || failure.code === 'process_changed')) {
        setStale(true)
        onRefresh()
      }
      setSignalError(errorMessage(failure, '无法向进程发送信号'))
    } finally {
      if (!controller.signal.aborted) setSending(false)
    }
  }

  const displayName = detail?.name ?? selection.name
  const displayUser = detail?.user ?? selection.user
  const cmdlineText = detail && detail.cmdline.length > 0 ? detail.cmdline.join(' ') : '(无命令行)'

  return (
    <>
      <div className="monitor-port-detail-toolbar monitor-process-detail-toolbar">
        <span className="system-caption">
          {!inList || stale
            ? '进程可能已退出或不在当前筛选结果中'
            : detail
              ? `PPID ${detail.ppid} · ${detail.threads} 线程 · ${formatBytes(detail.rssBytes)}`
              : '正在加载进程信息…'}
        </span>
        <div className="monitor-port-detail-actions">
          {isPid1 && <span className="system-caption">系统核心进程（PID 1）禁止终止</span>}
          <button
            type="button"
            className="app-control danger-control"
            disabled={actionsDisabled}
            title={isPid1 ? '系统核心进程（PID 1）禁止终止' : '发送 SIGTERM 请求优雅退出'}
            onClick={() => openConfirm('SIGTERM')}
          >
            结束 (SIGTERM)
          </button>
          <button
            type="button"
            className="app-control danger-control"
            disabled={actionsDisabled}
            title={isPid1 ? '系统核心进程（PID 1）禁止终止' : '发送 SIGKILL 强制立即终止'}
            onClick={() => openConfirm('SIGKILL')}
          >
            强制结束 (SIGKILL)
          </button>
        </div>
      </div>

      <div className="monitor-port-detail-content monitor-process-detail-body" tabIndex={0}>
        {loading && !detail && <p className="monitor-ports-status system-caption" role="status">正在读取进程详情…</p>}
        {detailError && <p className="authentication-error monitor-ports-error" role="alert">{detailError}</p>}
        {detail && (
          <>
            <dl className="monitor-process-facts">
              <div><dt>PPID</dt><dd>{detail.ppid}</dd></div>
              <div><dt>用户</dt><dd>{detail.user || '—'}</dd></div>
              <div><dt>状态</dt><dd>{detail.state}（{stateLabel(detail.state)}）</dd></div>
              <div><dt>线程数</dt><dd>{detail.threads}</dd></div>
              <div><dt>常驻内存</dt><dd>{formatBytes(detail.rssBytes)}</dd></div>
              <div><dt>启动时间</dt><dd>{formatTimestamp(detail.startedAt)}</dd></div>
              <div className="monitor-process-fact-wide">
                <dt>工作目录</dt>
                <dd><code>{detail.cwd || '—'}</code></dd>
              </div>
              <div className="monitor-process-fact-wide">
                <dt>命令行</dt>
                <dd><code>{cmdlineText}</code></dd>
              </div>
            </dl>

            <div className="monitor-process-tree-section">
              <h4 className="system-caption">进程树</h4>
              {detail.tree ? (
                <ul className="monitor-process-tree">
                  <ProcessTreeBranch node={detail.tree} target={detail} />
                </ul>
              ) : (
                <p className="monitor-ports-status system-caption">暂无进程树信息</p>
              )}
            </div>
          </>
        )}
      </div>

      <dialog
        ref={dialogRef}
        className="service-dialog"
        aria-labelledby={dialogTitleId}
        onCancel={event => {
          if (sending) {
            event.preventDefault()
          } else {
            setPendingSignal(null)
            setSignalError('')
          }
        }}
      >
        <div className="service-dialog-body">
          <h2 id={dialogTitleId}>
            {pendingSignal === 'SIGKILL' ? '强制结束进程（SIGKILL）？' : '结束进程（SIGTERM）？'}
          </h2>
          <p className="service-target">
            {displayName}（PID {selection.pid} · 用户 {displayUser || '—'}）
          </p>
          <p>
            {pendingSignal === 'SIGKILL'
              ? '将发送 SIGKILL 信号，由内核强制立即终止该进程，进程无法保存状态或清理资源。'
              : '将发送 SIGTERM 信号，通知该进程优雅退出并释放资源。'}
          </p>
          {isSelfOrAncestor && (
            <p className="monitor-danger-banner" role="alert">
              ⚠️ 警告：该进程为 GoDesk 自身或其父进程，终止后将导致当前 Web 桌面断连或服务退出！
            </p>
          )}
          {signalError && <p className="authentication-error monitor-dialog-error" role="alert">{signalError}</p>}
        </div>
        <div className="service-dialog-actions">
          <button type="button" className="app-control" autoFocus disabled={sending} onClick={closeConfirm}>
            取消
          </button>
          <button
            type="button"
            className="app-control danger-control"
            disabled={sending || isPid1 || !pendingSignal}
            onClick={() => void confirmSignal()}
          >
            {sending
              ? '正在发送…'
              : pendingSignal === 'SIGKILL'
                ? '确认强制结束 (SIGKILL)'
                : '确认结束 (SIGTERM)'}
          </button>
        </div>
      </dialog>
    </>
  )
}
