import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Activity, ArrowDown, ArrowUp, HardDrive, MemoryStick, Network, Search } from 'lucide-react'
import { monitorApi, MonitorError, type DiskStat, type Metrics, type NetworkSeries, type NetworkStat, type Port } from './monitor'

const numberFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 })

function formatPercent(value: number | null | undefined) {
  return value === null || value === undefined || !Number.isFinite(value) ? '—' : `${numberFormat.format(value)}%`
}

function formatBytes(value: number, suffix = '') {
  if (!Number.isFinite(value) || value < 0) return '—'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  let scaled = value
  let unit = 0
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024
    unit += 1
  }
  return `${numberFormat.format(scaled)} ${units[unit]}${suffix}`
}

function formatRate(value: number) {
  return formatBytes(value, '/s')
}

function TrendChart({ name, samples }: { name: string; samples: number[] }) {
  const values = samples.length > 0 ? samples : [0]
  const points = values.map((value, index) => {
    const x = (index / Math.max(1, values.length - 1)) * 240
    const y = 100 - Math.max(0, Math.min(100, value))
    return `${x},${y}`
  }).join(' ')
  const minimum = Math.min(...values)
  const maximum = Math.max(...values)

  return (
    <figure className="monitor-trend system-caption" aria-label={`${name}最近 60 秒，最低 ${formatPercent(minimum)}，最高 ${formatPercent(maximum)}`}>
      <div className="monitor-scale" aria-hidden="true"><span>100%</span><span>50%</span><span>0%</span></div>
      <svg viewBox="0 0 240 100" preserveAspectRatio="none" aria-hidden="true">
        <path className="monitor-gridlines" d="M0 0H240 M0 50H240 M0 100H240 M0 0V100 M120 0V100 M240 0V100" vectorEffect="non-scaling-stroke" />
        <polygon className="monitor-fill" points={`0,100 ${points} 240,100`} />
        <polyline className="monitor-line" points={points} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="monitor-time" aria-hidden="true"><span>60 秒前</span><span>现在</span></div>
    </figure>
  )
}

function CoreBars({ values }: { values: number[] }) {
  const label = `每核使用率：${values.map((value, index) => `核心 ${index + 1} ${formatPercent(value)}`).join('，')}`
  return (
    <div className="monitor-cores" role="img" aria-label={label}>
      {values.map((value, index) => (
        <span key={index} title={`核心 ${index + 1} ${formatPercent(value)}`}
          style={{ height: `${Math.max(2, Math.min(100, value))}%` }} />
      ))}
    </div>
  )
}

function TrendCard({ name, value, detail, samples, Icon, kind, footer }: {
  name: string
  value: number | null | undefined
  detail: ReactNode
  samples: number[]
  Icon: typeof Activity
  kind: 'cpu' | 'memory'
  footer?: ReactNode
}) {
  return (
    <section className="monitor-resource" data-resource={kind} aria-label={name}>
      <header className="monitor-resource-title"><Icon size={16} aria-hidden="true" /><h3>{name}</h3></header>
      <div className="monitor-reading">
        <strong>{value === null || value === undefined ? '—' : <>{numberFormat.format(value)}<span>%</span></>}</strong>
        <span className="system-caption">{detail}</span>
      </div>
      <TrendChart name={name} samples={samples} />
      {footer}
    </section>
  )
}

function DiskSection({ disks }: { disks: DiskStat[] }) {
  return (
    <section className="monitor-section" aria-labelledby="monitor-disks-title">
      <header className="monitor-resource-title">
        <HardDrive size={16} aria-hidden="true" /><h3 id="monitor-disks-title">磁盘</h3>
      </header>
      {disks.length === 0
        ? <p className="system-caption">暂无磁盘数据</p>
        : (
          <div className="monitor-disks">
            {disks.map(disk => (
              <div className="monitor-disk" key={disk.mountpoint}>
                <div className="monitor-disk-title"><strong>{disk.mountpoint}</strong><span>{formatPercent(disk.percent)}</span></div>
                <meter min={0} max={100} value={Math.max(0, Math.min(100, disk.percent))}
                  aria-label={`${disk.mountpoint} 使用率 ${formatPercent(disk.percent)}`} />
                <div className="monitor-disk-capacity system-caption">
                  <span>已用 {formatBytes(disk.used)}</span>
                  <span>可用 {formatBytes(Math.max(0, disk.total - disk.used))}</span>
                </div>
              </div>
            ))}
          </div>
        )}
    </section>
  )
}

function NetworkSparkline({ series }: { series: NetworkSeries }) {
  const peak = Math.max(1, ...series.rx, ...series.tx)
  const points = (values: number[]) => values.map((value, index) => {
    const x = (index / Math.max(1, values.length - 1)) * 240
    const y = 100 - Math.max(0, Math.min(1, value / peak)) * 100
    return `${x},${y}`
  }).join(' ')

  return (
    <figure className="monitor-network-trend system-caption" aria-label={`${series.name}最近 60 秒收发速率，峰值 ${formatRate(peak)}`}>
      <svg viewBox="0 0 240 100" preserveAspectRatio="none" aria-hidden="true">
        <path className="monitor-gridlines" d="M0 50H240" vectorEffect="non-scaling-stroke" />
        <polyline className="monitor-line" points={points(series.rx)} vectorEffect="non-scaling-stroke" />
        <polyline className="monitor-line monitor-line-secondary" points={points(series.tx)} vectorEffect="non-scaling-stroke" />
      </svg>
    </figure>
  )
}

function NetworkSection({ network, series }: { network: NetworkStat[]; series: NetworkSeries[] }) {
  return (
    <section className="monitor-section" aria-labelledby="monitor-network-title">
      <header className="monitor-resource-title">
        <Network size={16} aria-hidden="true" /><h3 id="monitor-network-title">网络</h3>
      </header>
      {network.length === 0
        ? <p className="system-caption">暂无网卡数据</p>
        : (
          <div className="monitor-networks">
            {network.map(nic => {
              const nicSeries = series.find(item => item.name === nic.name)
              return (
                <div className="monitor-network" key={nic.name}>
                  <header className="monitor-network-title">
                    <strong>{nic.name}</strong>
                    <span className="system-caption">{nic.mac || '无 MAC'}</span>
                  </header>
                  <div className="monitor-network-addresses system-caption">
                    {nic.ipv4.map(address => <span key={`v4-${address}`}>IPv4 {address}</span>)}
                    {nic.ipv6.map(address => <span key={`v6-${address}`}>IPv6 {address}</span>)}
                  </div>
                  <div className="monitor-network-rates" aria-label={`接收 ${formatRate(nic.rxRate)}，发送 ${formatRate(nic.txRate)}`}>
                    <span><ArrowDown size={14} aria-hidden="true" />{formatRate(nic.rxRate)}</span>
                    <span><ArrowUp size={14} aria-hidden="true" />{formatRate(nic.txRate)}</span>
                  </div>
                  {nicSeries && nicSeries.rx.length > 1 && <NetworkSparkline series={nicSeries} />}
                </div>
              )
            })}
          </div>
        )}
    </section>
  )
}

function Overview({ metrics, error }: { metrics?: Metrics; error: string }) {
  return (
    <div className="monitor-overview" role="tabpanel" id="monitor-overview-panel" aria-labelledby="monitor-overview-tab">
      <header className="monitor-heading">
        <h2 className="system-subtitle">资源使用</h2>
        <span className="system-caption">{metrics ? `${metrics.platform} · 每秒更新` : '正在采集…'}</span>
      </header>
      {error && <p className="authentication-error" role="alert">{error}</p>}
      {!metrics && !error && <p className="system-caption" role="status">正在采集系统指标…</p>}
      {metrics && (
        <>
          <div className="monitor-trends">
            <TrendCard name="CPU" value={metrics.cpu?.percent} samples={metrics.series.cpu} Icon={Activity} kind="cpu"
              detail={metrics.cpu ? `${metrics.cpu.perCore.length} 核` : '—'}
              footer={metrics.cpu && metrics.cpu.perCore.length > 1 ? <CoreBars values={metrics.cpu.perCore} /> : undefined} />
            <TrendCard name="内存" value={metrics.memory?.percent} samples={metrics.series.memory} Icon={MemoryStick} kind="memory"
              detail={metrics.memory ? `${formatBytes(metrics.memory.used)} / ${formatBytes(metrics.memory.total)}` : '—'} />
          </div>
          <DiskSection disks={metrics.disks ?? []} />
          <NetworkSection network={metrics.network ?? []} series={metrics.series.network ?? []} />
        </>
      )}
    </div>
  )
}

type SortKey = 'port' | 'process'

function PortsPanel() {
  const [ports, setPorts] = useState<Port[]>()
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('port')
  const [ascending, setAscending] = useState(true)
  const reloading = useRef(false)

  useEffect(() => {
    const controller = new AbortController()
    let timer: number | undefined
    let stopped = false

    async function load() {
      try {
        const next = await monitorApi.ports(controller.signal)
        if (controller.signal.aborted) return
        setPorts(next)
        setError('')
      } catch (failure) {
        if (controller.signal.aborted) return
        if (failure instanceof MonitorError && failure.status === 401) {
          stopped = true
          if (!reloading.current) {
            reloading.current = true
            window.location.reload()
          }
          return
        }
        setError('无法读取端口信息，正在重试…')
      } finally {
        if (!stopped && !controller.signal.aborted) timer = window.setTimeout(load, 5000)
      }
    }

    void load()
    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [])

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const visible = (ports ?? []).filter(port => !needle
      || [port.port, port.protocol, port.address, port.process ?? '', port.pid ?? ''].join(' ').toLowerCase().includes(needle))
    return [...visible].sort((left, right) => {
      if (sortKey === 'process') {
        const byProcess = (left.process ?? '').localeCompare(right.process ?? '', 'zh-CN')
        if (byProcess !== 0) return ascending ? byProcess : -byProcess
      }
      if (left.port !== right.port) return ascending ? left.port - right.port : right.port - left.port
      const byProtocol = left.protocol.localeCompare(right.protocol)
      if (byProtocol !== 0) return ascending ? byProtocol : -byProtocol
      const byAddress = left.address.localeCompare(right.address)
      return ascending ? byAddress : -byAddress
    })
  }, [ports, query, sortKey, ascending])

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setAscending(value => !value)
      return
    }
    setSortKey(key)
    setAscending(true)
  }

  const sortIndicator = (key: SortKey) => sortKey === key
    ? (ascending ? <ArrowUp size={12} aria-hidden="true" /> : <ArrowDown size={12} aria-hidden="true" />)
    : null

  return (
    <div className="monitor-ports" role="tabpanel" id="monitor-ports-panel" aria-labelledby="monitor-ports-tab">
      <div className="monitor-ports-toolbar">
        <label className="monitor-filter">
          <Search size={15} aria-hidden="true" />
          <input type="search" value={query} onChange={event => setQuery(event.target.value)}
            placeholder="筛选端口、协议、地址或进程" aria-label="筛选端口" />
        </label>
        <span className="system-caption" role="status">{ports ? `共 ${rows.length} 个端口` : '载入中'}</span>
      </div>
      {error && <p className="authentication-error monitor-ports-error" role="alert">{error}</p>}
      <div className="monitor-ports-scroll">
        {!ports && !error && <p className="monitor-ports-status system-caption" role="status">正在读取端口…</p>}
        {ports && rows.length === 0 && <p className="monitor-ports-status system-caption">没有找到匹配的端口</p>}
        {rows.length > 0 && (
          <table className="data-table monitor-ports-table">
            <thead>
              <tr>
                <th scope="col" aria-sort={sortKey === 'port' ? (ascending ? 'ascending' : 'descending') : 'none'}>
                  <button className="monitor-sort" type="button" onClick={() => toggleSort('port')}>
                    端口{sortIndicator('port')}
                  </button>
                </th>
                <th scope="col">协议</th>
                <th scope="col">监听地址</th>
                <th scope="col" aria-sort={sortKey === 'process' ? (ascending ? 'ascending' : 'descending') : 'none'}>
                  <button className="monitor-sort" type="button" onClick={() => toggleSort('process')}>
                    进程{sortIndicator('process')}
                  </button>
                </th>
                <th scope="col">PID</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(port => (
                <tr key={`${port.protocol}-${port.address}-${port.port}-${port.pid ?? 'unknown'}`}>
                  <td className="monitor-port-number">{port.port}</td>
                  <td>{port.protocol.toUpperCase()}</td>
                  <td className="monitor-port-address">{port.address}</td>
                  <td className="monitor-port-process" title={port.process}>{port.process || '—'}</td>
                  <td className="monitor-port-pid">{port.pid ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="monitor-ports-footer system-caption">
        <span>每 5 秒刷新</span>
        <span>「—」表示运行账号无权查看归属进程</span>
      </div>
    </div>
  )
}

type Tab = 'overview' | 'ports'

export function SystemMonitor() {
  const [tab, setTab] = useState<Tab>('overview')
  const [metrics, setMetrics] = useState<Metrics>()
  const [error, setError] = useState('')
  const reloading = useRef(false)

  useEffect(() => {
    const controller = new AbortController()
    let timer: number | undefined
    let stopped = false

    async function load() {
      try {
        const next = await monitorApi.metrics(controller.signal)
        if (controller.signal.aborted) return
        setMetrics(next)
        setError('')
      } catch (failure) {
        if (controller.signal.aborted) return
        if (failure instanceof MonitorError && failure.status === 401) {
          stopped = true
          if (!reloading.current) {
            reloading.current = true
            window.location.reload()
          }
          return
        }
        setError(failure instanceof MonitorError && failure.status === 503
          ? '系统指标尚未就绪，正在重试…'
          : '无法读取系统指标，正在重试…')
      } finally {
        if (!stopped && !controller.signal.aborted) timer = window.setTimeout(load, 1000)
      }
    }

    void load()
    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [])

  function handleTabKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    const next: Tab = event.key === 'ArrowLeft' || event.key === 'Home' ? 'overview' : 'ports'
    setTab(next)
    document.getElementById(`monitor-${next}-tab`)?.focus()
  }

  return (
    <div className="monitor-page">
      <div className="monitor-tabs" role="tablist" aria-label="系统监控视图" onKeyDown={handleTabKey}>
        <button id="monitor-overview-tab" type="button" role="tab" aria-selected={tab === 'overview'}
          aria-controls="monitor-overview-panel" tabIndex={tab === 'overview' ? 0 : -1}
          onClick={() => setTab('overview')}>概览</button>
        <button id="monitor-ports-tab" type="button" role="tab" aria-selected={tab === 'ports'}
          aria-controls="monitor-ports-panel" tabIndex={tab === 'ports' ? 0 : -1}
          onClick={() => setTab('ports')}>端口</button>
      </div>
      {tab === 'overview' ? <Overview metrics={metrics} error={error} /> : <PortsPanel />}
    </div>
  )
}
