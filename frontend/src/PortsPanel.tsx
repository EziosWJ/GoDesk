import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowDown, ArrowUp, ChevronRight, Search, X } from 'lucide-react'
import { monitorApi, MonitorError, type Endpoint, type Port, type PortDetail, type PortOwner, type ProcessNode } from './monitor'

type SortKey = 'port' | 'process'
type Selection = { endpoint: Endpoint; owner?: PortOwner; revision: number }

function endpointKey(port: Endpoint) {
  return `${port.protocol}/${port.address}/${port.port}`
}

function endpointLabel(port: Endpoint) {
  const address = port.address.includes(':') ? `[${port.address}]` : port.address
  return `${port.protocol.toUpperCase()} ${address}:${port.port}`
}

function sameOwner(left: PortOwner, right?: PortOwner) {
  return left.pid === right?.pid && left.startTicks === right.startTicks
}

function ownerNames(port: Port) {
  return [...new Set(port.owners.map(owner => owner.process))].join('、')
}

function errorMessage(failure: unknown, fallback: string) {
  if (failure instanceof MonitorError) {
    if (failure.status === 401) window.location.reload()
    if (failure.code) return failure.message
  }
  return fallback
}

function SortButton({ label, column, sortKey, ascending, onSort }: {
  label: string; column: SortKey; sortKey: SortKey; ascending: boolean; onSort: (key: SortKey) => void
}) {
  const Icon = ascending ? ArrowUp : ArrowDown
  return (
    <button className="monitor-sort" type="button" onClick={() => onSort(column)}>
      {label}{sortKey === column && <Icon size={12} aria-hidden="true" />}
    </button>
  )
}

export function PortsPanel() {
  const [ports, setPorts] = useState<Port[]>()
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('port')
  const [ascending, setAscending] = useState(true)
  const [selection, setSelection] = useState<Selection>()
  const [refresh, setRefresh] = useState(0)
  const [notice, setNotice] = useState('')
  const detailId = useId()

  useEffect(() => {
    const controller = new AbortController()
    let timer: number | undefined

    async function load() {
      try {
        const next = await monitorApi.ports(controller.signal)
        if (controller.signal.aborted) return
        setPorts(next)
        setError('')
      } catch (failure) {
        if (controller.signal.aborted) return
        setError(errorMessage(failure, '无法读取端口信息，正在重试…'))
        if (failure instanceof MonitorError && failure.status === 401) return
      }
      if (!controller.signal.aborted) timer = window.setTimeout(load, 5000)
    }

    void load()
    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [refresh])

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return (ports ?? []).filter(port => !needle || [
      port.port, port.protocol, port.address, ...port.owners.flatMap(owner => [owner.process, owner.pid]),
    ].join(' ').toLowerCase().includes(needle)).sort((left, right) => {
      const byProcess = sortKey === 'process' ? ownerNames(left).localeCompare(ownerNames(right), 'zh-CN') : 0
      const byEndpoint = left.port - right.port || left.protocol.localeCompare(right.protocol) || left.address.localeCompare(right.address)
      return (ascending ? 1 : -1) * (byProcess || byEndpoint)
    })
  }, [ports, query, sortKey, ascending])

  function toggleSort(key: SortKey) {
    setAscending(sortKey === key ? !ascending : true)
    setSortKey(key)
  }

  function select(endpoint: Endpoint, owner?: PortOwner) {
    setNotice('')
    setSelection(previous => ({ endpoint, owner, revision: (previous?.revision ?? 0) + 1 }))
  }

  const current = selection && ports?.find(port => endpointKey(port) === endpointKey(selection.endpoint))
  const currentOwners = current?.owners ?? []
  const selectedOwner = selection?.owner
  const active = !!selectedOwner && currentOwners.some(owner => sameOwner(owner, selectedOwner))
  const sortDirection = ascending ? 'ascending' : 'descending'

  return (
    <div className="monitor-ports" role="tabpanel" id="monitor-ports-panel" aria-labelledby="monitor-ports-tab">
      <div className="monitor-ports-toolbar">
        <label className="monitor-filter">
          <Search size={15} aria-hidden="true" />
          <input type="search" value={query} onChange={event => setQuery(event.target.value)}
            placeholder="筛选端口、协议、地址或进程" aria-label="筛选端口" />
        </label>
        <span className="system-caption" role="status">{ports ? `${rows.length} 项监听` : error ? '读取失败' : '载入中'}</span>
      </div>
      {error && <p className="authentication-error monitor-ports-error" role="alert">{error}</p>}
      <div className="monitor-ports-scroll">
        {!ports && !error && <p className="monitor-ports-status system-caption" role="status">正在读取端口…</p>}
        {ports && rows.length === 0 && <p className="monitor-ports-status system-caption">没有找到匹配的端口</p>}
        {rows.length > 0 && (
          <table className="data-table monitor-ports-table">
            <thead>
              <tr>
                <th scope="col" aria-sort={sortKey === 'port' ? sortDirection : 'none'}>
                  <SortButton label="端口" column="port" sortKey={sortKey} ascending={ascending} onSort={toggleSort} />
                </th>
                <th scope="col">协议</th>
                <th scope="col">监听地址</th>
                <th scope="col" aria-sort={sortKey === 'process' ? sortDirection : 'none'}>
                  <SortButton label="进程" column="process" sortKey={sortKey} ascending={ascending} onSort={toggleSort} />
                </th>
                <th scope="col">PID</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(port => {
                const key = endpointKey(port)
                const expanded = !!selection && key === endpointKey(selection.endpoint)
                const names = ownerNames(port)
                return (
                  <tr key={key} data-selected={expanded}
                    onClick={() => select(port, port.owners.length === 1 ? port.owners[0] : undefined)}>
                    <td>
                      <button className="monitor-port-open" type="button" aria-label={endpointLabel(port)}
                        aria-expanded={expanded} aria-controls={expanded ? detailId : undefined}>
                        <ChevronRight size={14} aria-hidden="true" />{port.port}
                      </button>
                    </td>
                    <td>{port.protocol.toUpperCase()}</td>
                    <td className="monitor-port-address">{port.address}</td>
                    <td className="monitor-port-process" title={names}>{names || '归属未知'}</td>
                    <td className="monitor-port-pid">{port.owners.length > 1 ? `${port.owners.length} 个进程` : port.owners[0]?.pid ?? '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
      {selection && (
        <section className="monitor-port-detail" id={detailId} aria-label={endpointLabel(selection.endpoint)}>
          <header className="monitor-port-detail-heading">
            <strong>{endpointLabel(selection.endpoint)}</strong>
            {currentOwners.length > 0 && (currentOwners.length > 1 || !active) && (
              <select className="app-control monitor-port-owner-select" aria-label="选择监听进程"
                value={active && selectedOwner ? String(selectedOwner.pid) : ''} onChange={event => {
                  const owner = currentOwners.find(item => String(item.pid) === event.target.value)
                  if (owner) select(selection.endpoint, owner)
                }}>
                <option value="" disabled>选择监听进程</option>
                {currentOwners.map(owner => <option key={owner.pid} value={owner.pid}>{owner.process}（PID {owner.pid}）</option>)}
              </select>
            )}
            {current?.unknownOwner && <span className="system-caption">有监听归属未知</span>}
            <button className="app-control monitor-port-close" type="button" aria-label="关闭端口详情"
              onClick={() => setSelection(undefined)}><X size={16} aria-hidden="true" /></button>
          </header>
          {selectedOwner ? (
            <PortProcessDetail key={selection.revision} selection={{ ...selection, owner: selectedOwner }}
              active={active} actionsAvailable={!error}
              onRefresh={message => {
                if (message) setNotice(message)
                setRefresh(value => value + 1)
              }} />
          ) : (
            <p className="monitor-ports-status system-caption">
              {!current ? '监听已结束' : currentOwners.length > 0 ? '选择一个进程查看详情' : '未找到持有此监听的进程'}
            </p>
          )}
        </section>
      )}
      <footer className="monitor-ports-footer system-caption">
        <span>管理员读取 · 每 5 秒刷新</span>
        {notice && <span role="status">{notice}</span>}
      </footer>
    </div>
  )
}

function ProcessBranch({ node, owner }: { node: ProcessNode; owner: PortOwner }) {
  const selected = sameOwner(node, owner)
  return (
    <li>
      <div className="monitor-process-node" data-listener={selected}>
        <strong>{node.process}</strong>
        <span>PID {node.pid}</span>
        <span>{node.user || '—'}</span>
        {selected && <span className="monitor-process-listener">监听进程</span>}
      </div>
      {node.children && node.children.length > 0 && (
        <ul>{node.children.map(child => <ProcessBranch key={child.pid} node={child} owner={owner} />)}</ul>
      )}
    </li>
  )
}

function PortProcessDetail({ selection, active, actionsAvailable, onRefresh }: {
  selection: Selection & { owner: PortOwner }; active: boolean; actionsAvailable: boolean; onRefresh: (notice?: string) => void
}) {
  const [detail, setDetail] = useState<PortDetail>()
  const [tab, setTab] = useState<'tree' | 'logs'>('tree')
  const [logs, setLogs] = useState<string[]>()
  const [logError, setLogError] = useState('')
  const [detailError, setDetailError] = useState('')
  const [stopError, setStopError] = useState('')
  const [loadingLogs, setLoadingLogs] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [changed, setChanged] = useState(false)
  const detailController = useRef<AbortController | null>(null)
  const logController = useRef<AbortController | null>(null)
  const stopController = useRef<AbortController | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const tabId = useId()
  const { endpoint, owner } = selection
  const target = { protocol: endpoint.protocol, address: endpoint.address, port: endpoint.port, pid: owner.pid, startTicks: owner.startTicks }
  const ended = !active || changed
  const atSelectedEndpoint = active && !changed && actionsAvailable
  const stopLabel = detail?.unit ? '停止服务' : '停止进程'

  useEffect(() => () => {
    detailController.current?.abort()
    logController.current?.abort()
    stopController.current?.abort()
  }, [])

  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    detailController.current = controller
    const { protocol, address, port } = endpoint
    void monitorApi.portDetail({ protocol, address, port, pid: owner.pid, startTicks: owner.startTicks }, controller.signal)
      .then(next => {
        if (controller.signal.aborted) return
        setDetail(next)
        setDetailError('')
      })
      .catch(failure => {
        if (controller.signal.aborted) return
        if (failure instanceof MonitorError && failure.code === 'target_changed') setChanged(true)
        setDetailError(errorMessage(failure, '无法读取进程详情'))
      })
    return () => controller.abort()
  }, [active, endpoint, owner])

  async function loadLogs() {
    if (!detail || !atSelectedEndpoint) return
    logController.current?.abort()
    const controller = new AbortController()
    logController.current = controller
    setLoadingLogs(true)
    setLogError('')
    try {
      const next = await monitorApi.portLogs({ ...target, unit: detail.unit }, controller.signal)
      if (!controller.signal.aborted) setLogs(next.lines)
    } catch (failure) {
      if (controller.signal.aborted) return
      if (failure instanceof MonitorError && failure.code === 'target_changed') {
        setChanged(true)
        onRefresh()
      }
      setLogError(errorMessage(failure, '日志不可用'))
    } finally {
      if (!controller.signal.aborted) setLoadingLogs(false)
    }
  }

  function switchTab(next: typeof tab) {
    if (tab === next) return
    setTab(next)
    if (next === 'logs' && !logs) void loadLogs()
  }

  function moveTabFocus(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    const next = event.key === 'Home' ? 'tree' : event.key === 'End' ? 'logs' : tab === 'tree' ? 'logs' : 'tree'
    switchTab(next)
    document.getElementById(`${tabId}-${next}`)?.focus()
  }

  async function stop() {
    dialog.current?.close()
    if (!detail || !atSelectedEndpoint) return
    const controller = new AbortController()
    stopController.current = controller
    setStopping(true)
    setStopError('')
    try {
      await monitorApi.stopPort({ ...target, unit: detail.unit }, controller.signal)
      if (!controller.signal.aborted) onRefresh(detail.unit ? `已停止 ${detail.unit}` : `已向 PID ${owner.pid} 发送停止信号`)
    } catch (failure) {
      if (controller.signal.aborted) return
      if (failure instanceof MonitorError && failure.code === 'target_changed') setChanged(true)
      setStopError(errorMessage(failure, '无法停止所选目标'))
      onRefresh()
    } finally {
      if (!controller.signal.aborted) setStopping(false)
    }
  }

  return (
    <>
      <div className="monitor-port-detail-toolbar">
        <div className="monitor-tabs monitor-port-detail-tabs" role="tablist" aria-label="进程详情">
          {(['tree', 'logs'] as const).map(view => (
            <button key={view} type="button" role="tab" id={`${tabId}-${view}`} aria-selected={tab === view}
              aria-controls={`${tabId}-panel`} tabIndex={tab === view ? 0 : -1}
              disabled={view === 'logs' && !detail} onKeyDown={moveTabFocus} onClick={() => switchTab(view)}>
              {view === 'tree' ? '进程树' : '日志'}
            </button>
          ))}
        </div>
        <div className="monitor-port-detail-actions">
          <span className="system-caption" title={detail?.unit}>{detail?.unit ?? `${owner.process} · PID ${owner.pid}`}</span>
          {ended && <span className="system-caption" role="status">监听已结束</span>}
          {owner.pid === 1 ? <span className="system-caption">系统管理器仅支持查看</span> : (
            <button className="app-control danger-control" type="button" disabled={!detail || !atSelectedEndpoint || stopping}
              onClick={() => dialog.current?.showModal()}>{stopping ? '正在停止…' : stopLabel}</button>
          )}
        </div>
      </div>
      {stopError && <p className="authentication-error monitor-ports-error" role="alert">{stopError}</p>}
      <div className="monitor-port-detail-content" role="tabpanel" id={`${tabId}-panel`} aria-labelledby={`${tabId}-${tab}`} tabIndex={0}>
        {tab === 'tree' ? (
          detail ? <ul className="monitor-process-tree"><ProcessBranch node={detail.tree} owner={owner} /></ul> :
          detailError ? <p className="authentication-error monitor-ports-error" role="alert">{detailError}</p> :
          active && <p className="monitor-ports-status system-caption" role="status">正在读取进程树…</p>
        ) : (
          <>
            <div className="monitor-port-log-toolbar">
              <span className="system-caption">{detail?.unit ? `服务日志 · ${detail.unit}` : `本次运行日志 · PID ${owner.pid}`}</span>
              <button type="button" className="app-control" onClick={() => void loadLogs()} disabled={!atSelectedEndpoint || loadingLogs}>刷新日志</button>
            </div>
            {logError && <p className="authentication-error monitor-ports-error" role="alert">{logError}</p>}
            {loadingLogs && <p className="monitor-ports-status system-caption" role="status">正在读取日志…</p>}
            {!!logs?.length && <pre className="monitor-port-log">{logs.join('\n')}</pre>}
            {logs?.length === 0 && !loadingLogs && !logError && <p className="monitor-ports-status system-caption">没有 journal 记录</p>}
          </>
        )}
      </div>
      <dialog ref={dialog} className="service-dialog" aria-labelledby={titleId}>
        <div className="service-dialog-body">
          <h2 id={titleId}>{stopLabel}？</h2>
          <p className="service-target">{detail?.unit ?? `${owner.process}（PID ${owner.pid}）`}</p>
          <p>{endpointLabel(endpoint)}</p>
          {detail?.otherPorts && detail.otherPorts.length > 0 && (
            <div className="monitor-port-dialog-impact">
              <p>此服务还持有以下监听</p>
              <ul>{detail.otherPorts.map(port => <li key={endpointKey(port)}>{endpointLabel(port)}</li>)}</ul>
            </div>
          )}
          {detail?.stopsDesk && <p>停止 GoDesk 可能中断桌面连接。</p>}
          {!atSelectedEndpoint && <p>当前无法停止此监听的目标。</p>}
        </div>
        <div className="service-dialog-actions">
          <button type="button" className="app-control" autoFocus onClick={() => dialog.current?.close()}>取消</button>
          <button type="button" className="app-control danger-control" disabled={!atSelectedEndpoint}
            onClick={() => void stop()}>{stopLabel}</button>
        </div>
      </dialog>
    </>
  )
}
