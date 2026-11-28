import { Activity, ArrowLeftRight, ArrowRight, Cpu, HardDrive, MemoryStick, Network, Thermometer, Unplug } from 'lucide-react'
import type {
  CPUHealthDetails,
  HealthCheck,
  HealthSnapshot,
  LoadHealthDetails,
  MemoryHealthDetails,
  NetworkHealthDetails,
  SwapHealthDetails,
  TemperatureHealthDetails,
} from './health'
import { StatusIcon } from './HealthStatusIcon'
import { effectiveStatus, healthStatusText, normalizeStatus, type DisplayStatus } from './healthUi'
import { formatBytes, formatLoad, formatRate } from './monitor'
import type { ConnectionState } from './useHostHealth'
import './styles/health-panel.css'

const numberFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 })
const timeFormat = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
})

const checkStatusText: Record<DisplayStatus, string> = {
  healthy: '正常',
  warning: '警告',
  critical: '异常',
  unknown: '未知',
}

type MetricHealth = DisplayStatus | 'not-applicable' | 'unavailable'
type TemperatureHealth = DisplayStatus | 'info' | 'not-applicable'

type Metric = {
  category: string
  label: string
  Icon: typeof Cpu
  status: MetricHealth
  value: string
  stateText: string
  detail?: string
  meta?: string
  title?: string
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function detailsOf<T extends Record<string, unknown>>(check: HealthCheck): Partial<T> {
  return (check.details && typeof check.details === 'object' ? check.details : {}) as Partial<T>
}

function statusRank(status: DisplayStatus) {
  return status === 'critical' ? 3 : status === 'warning' ? 2 : status === 'unknown' ? 1 : 0
}

function formatTime(value: string) {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? timeFormat.format(date) : '—'
}

function formatSpan(since: string) {
  const start = new Date(since).getTime()
  if (!Number.isFinite(start)) return null
  const seconds = Math.max(0, Math.round((Date.now() - start) / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const rest = minutes % 60
    return rest > 0 ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`
  }
  const days = Math.floor(hours / 24)
  return `${days} 天 ${hours % 24} 小时`
}

function formatUptime(seconds: number | null) {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return null
  const minutes = Math.floor(seconds / 60)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days > 0) return `${days} 天 ${hours} 小时`
  if (hours > 0) return `${hours} 小时 ${minutes % 60} 分钟`
  return `${minutes} 分钟`
}

function unitSuffix(unit: string | null) {
  if (unit === 'percent') return '%'
  if (unit === 'celsius') return ' °C'
  return unit ? ` ${unit}` : ''
}

function percentText(value: number | null) {
  return value === null || !Number.isFinite(value) ? '—' : `${numberFormat.format(value)}%`
}

function celsiusText(value: number | null) {
  return value === null || !Number.isFinite(value) ? '—' : `${numberFormat.format(value)} °C`
}

function readingText(check: HealthCheck) {
  if (!isFiniteNumber(check.value)) return null
  if (check.category === 'load') return `当前每核 ${formatLoad(check.value)}`
  return `当前 ${numberFormat.format(check.value)}${unitSuffix(check.unit)}`
}

function thresholdText(check: HealthCheck, suffixOverride?: string) {
  if (!check.thresholds) return null
  const suffix = suffixOverride ?? unitSuffix(check.unit)
  const parts: string[] = []
  if (isFiniteNumber(check.thresholds.warning)) {
    parts.push(`警告 ${numberFormat.format(check.thresholds.warning)}${suffix}`)
  }
  if (isFiniteNumber(check.thresholds.critical)) {
    parts.push(`严重 ${numberFormat.format(check.thresholds.critical)}${suffix}`)
  }
  return parts.length > 0 ? parts.join(' · ') : null
}

function unavailableMetric(category: string, label: string, Icon: typeof Cpu, title?: string): Metric {
  return { category, label, Icon, status: 'unavailable', value: '不可用', stateText: '不可用', title }
}

function unavailableTitle(checks: HealthCheck[], category: string) {
  return checks.find(check => check.category === category && !check.applicable)?.message || undefined
}

function cpuMetric(checks: HealthCheck[]): Metric {
  const Icon = Cpu
  const check = checks.find(item => item.category === 'cpu' && item.applicable)
  if (!check) return unavailableMetric('cpu', 'CPU', Icon, unavailableTitle(checks, 'cpu'))
  const status = normalizeStatus(check.status)
  const details = detailsOf<CPUHealthDetails>(check)
  const cores = isFiniteNumber(details.logicalCores) && details.logicalCores > 0 ? `${details.logicalCores} 核` : undefined
  const thresholds = thresholdText(check)
  return {
    category: 'cpu',
    label: 'CPU',
    Icon,
    status,
    value: percentText(check.value),
    stateText: checkStatusText[status],
    detail: status === 'unknown' ? (check.message || undefined) : cores,
    title: [status === 'healthy' ? undefined : check.message, cores, thresholds].filter(Boolean).join(' · ') || undefined,
  }
}

function memoryMetric(checks: HealthCheck[]): Metric {
  const Icon = MemoryStick
  const check = checks.find(item => item.category === 'memory' && item.applicable)
  if (!check) return unavailableMetric('memory', '内存', Icon, unavailableTitle(checks, 'memory'))
  const status = normalizeStatus(check.status)
  const details = detailsOf<MemoryHealthDetails>(check)
  const usage = isFiniteNumber(details.totalBytes) && details.totalBytes > 0 && isFiniteNumber(details.usedBytes)
    ? `${formatBytes(details.usedBytes)} / ${formatBytes(details.totalBytes)}`
    : undefined
  const thresholds = thresholdText(check)
  return {
    category: 'memory',
    label: '内存',
    Icon,
    status,
    value: percentText(check.value),
    stateText: checkStatusText[status],
    detail: status === 'unknown' ? (check.message || undefined) : usage,
    title: [status === 'healthy' ? undefined : check.message, usage, thresholds].filter(Boolean).join(' · ') || undefined,
  }
}

function loadMetric(checks: HealthCheck[]): Metric {
  const Icon = Activity
  const check = checks.find(item => item.category === 'load')
  if (!check) return unavailableMetric('load', '系统负载', Icon)
  if (!check.applicable) {
    return {
      category: 'load',
      label: '系统负载',
      Icon,
      status: 'not-applicable',
      value: '不可用',
      stateText: '不适用',
      detail: check.message || undefined,
      title: check.message || undefined,
    }
  }
  const status = normalizeStatus(check.status)
  const details = detailsOf<LoadHealthDetails>(check)
  const perCore = isFiniteNumber(check.value)
    ? check.value
    : (isFiniteNumber(details.load5PerCore) ? details.load5PerCore : null)
  const hasTriple = isFiniteNumber(details.load1) && isFiniteNumber(details.load5) && isFiniteNumber(details.load15)
  const triple = hasTriple
    ? `${formatLoad(details.load1!)} / ${formatLoad(details.load5!)} / ${formatLoad(details.load15!)}`
    : null
  const cores = isFiniteNumber(details.logicalCores) && details.logicalCores > 0 ? `${details.logicalCores} 核` : null
  const thresholds = thresholdText(check)
  const detail = status === 'unknown'
    ? (check.message || undefined)
    : ([triple, cores].filter(Boolean).join(' · ') || undefined)
  return {
    category: 'load',
    label: '系统负载',
    Icon,
    status,
    value: perCore !== null ? `${formatLoad(perCore)} / 核` : '—',
    stateText: checkStatusText[status],
    detail,
    meta: thresholds ?? undefined,
    title: [
      status === 'healthy' ? undefined : check.message,
      triple ? `1/5/15 分钟 ${triple}` : undefined,
      cores,
      thresholds ? `每核阈值 ${thresholds}` : undefined,
    ].filter(Boolean).join(' · ') || undefined,
  }
}

function swapMetric(checks: HealthCheck[]): Metric {
  const Icon = ArrowLeftRight
  const check = checks.find(item => item.category === 'swap')
  if (!check) return unavailableMetric('swap', 'Swap', Icon)
  if (!check.applicable) {
    const unconfigured = check.reason === 'not_supported'
    return {
      category: 'swap',
      label: 'Swap',
      Icon,
      status: 'not-applicable',
      value: unconfigured ? '未配置' : '不适用',
      stateText: unconfigured ? '未配置' : '不适用',
      detail: unconfigured ? '未启用交换空间' : (check.message || undefined),
      title: check.message || (unconfigured ? '未配置 Swap' : undefined),
    }
  }
  const status = normalizeStatus(check.status)
  const details = detailsOf<SwapHealthDetails>(check)
  const usage = isFiniteNumber(details.totalBytes) && details.totalBytes > 0 && isFiniteNumber(details.usedBytes)
    ? `${formatBytes(details.usedBytes)} / ${formatBytes(details.totalBytes)}`
    : undefined
  const swapIn = isFiniteNumber(details.swapInPerSec) ? details.swapInPerSec : 0
  const swapOut = isFiniteNumber(details.swapOutPerSec) ? details.swapOutPerSec : 0
  const paging = swapIn > 0 || swapOut > 0
    ? `换入 ${formatRate(swapIn)} · 换出 ${formatRate(swapOut)}`
    : undefined
  const thresholds = thresholdText(check)
  return {
    category: 'swap',
    label: 'Swap',
    Icon,
    status,
    value: percentText(check.value),
    stateText: checkStatusText[status],
    detail: status === 'unknown' ? (check.message || undefined) : usage,
    meta: status === 'unknown' ? undefined : (paging ?? thresholds ?? undefined),
    title: [status === 'healthy' ? undefined : check.message, usage, paging, thresholds].filter(Boolean).join(' · ') || undefined,
  }
}

function storageMetric(checks: HealthCheck[]): Metric {
  const Icon = HardDrive
  const applicable = checks.filter(check => check.category === 'storage' && check.applicable)
  if (applicable.length === 0) return unavailableMetric('storage', '存储', Icon, unavailableTitle(checks, 'storage'))
  // 摘要取状态最严重的检查项；同状态时取使用率最高的一项。
  const worst = applicable.reduce((current, check) => {
    const rank = statusRank(normalizeStatus(check.status))
    const currentRank = statusRank(normalizeStatus(current.status))
    if (rank !== currentRank) return rank > currentRank ? check : current
    return (check.value ?? -1) > (current.value ?? -1) ? check : current
  })
  const status = normalizeStatus(worst.status)
  const detail = status === 'unknown'
    ? (worst.message || undefined)
    : (applicable.length > 1 ? `${worst.label} 等 ${applicable.length} 项` : worst.label)
  return {
    category: 'storage',
    label: '存储',
    Icon,
    status,
    value: percentText(worst.value),
    stateText: checkStatusText[status],
    detail,
    title: applicable.map(check => `${check.label} ${percentText(check.value)}`).join(' · '),
  }
}

function networkMetric(checks: HealthCheck[]): Metric {
  const Icon = Network
  const check = checks.find(item => item.category === 'network')
  if (!check) return unavailableMetric('network', '网络', Icon)
  if (!check.applicable) {
    const noRoute = check.reason === 'no_default_route'
    return {
      category: 'network',
      label: '网络',
      Icon,
      status: 'not-applicable',
      value: noRoute ? '无默认路由' : '不可用',
      stateText: noRoute ? '无默认路由' : '不适用',
      detail: check.message || undefined,
      title: check.message || undefined,
    }
  }
  const status = normalizeStatus(check.status)
  const details = detailsOf<NetworkHealthDetails>(check)
  let value = '—'
  if (status === 'critical') value = '已断链'
  else if (status === 'warning') value = '无可用地址'
  else if (status === 'healthy') value = details.ipv4?.[0] ?? (details.ipv6?.length ? 'IPv6' : '已连接')
  const addresses = [...(details.ipv4 ?? []), ...(details.ipv6 ?? [])].join(' · ')
  return {
    category: 'network',
    label: '网络',
    Icon,
    status,
    value,
    stateText: checkStatusText[status],
    detail: status === 'unknown' ? (check.message || undefined) : (details.interface || undefined),
    title: [details.interface, addresses].filter(Boolean).join(' · ') || check.message || undefined,
  }
}

function metricsFor(checks: HealthCheck[]): Metric[] {
  return [
    cpuMetric(checks),
    memoryMetric(checks),
    loadMetric(checks),
    swapMetric(checks),
    storageMetric(checks),
    networkMetric(checks),
  ]
}

function issueLabel(check: HealthCheck) {
  if (check.category !== 'temperature') return check.label
  const details = detailsOf<TemperatureHealthDetails>(check)
  const sensor = check.label || details.sensor || '温度'
  const chip = typeof details.chip === 'string' && details.chip && details.chip !== sensor ? details.chip : null
  const prefix = sensor.includes('温度') ? sensor : `温度 · ${sensor}`
  return chip ? `${prefix}（${chip}）` : prefix
}

function issueDetailsText(check: HealthCheck) {
  if (check.category === 'load') {
    const details = detailsOf<LoadHealthDetails>(check)
    if (isFiniteNumber(details.load1) && isFiniteNumber(details.load5) && isFiniteNumber(details.load15)) {
      const triple = `${formatLoad(details.load1)} / ${formatLoad(details.load5)} / ${formatLoad(details.load15)}`
      const cores = isFiniteNumber(details.logicalCores) && details.logicalCores > 0 ? ` · ${details.logicalCores} 核` : ''
      return `1/5/15 分钟：${triple}${cores}`
    }
  }
  if (check.category === 'swap') {
    const details = detailsOf<SwapHealthDetails>(check)
    const parts: string[] = []
    if (isFiniteNumber(details.totalBytes) && details.totalBytes > 0 && isFiniteNumber(details.usedBytes)) {
      parts.push(`${formatBytes(details.usedBytes)} / ${formatBytes(details.totalBytes)}`)
    }
    const swapIn = isFiniteNumber(details.swapInPerSec) ? details.swapInPerSec : 0
    const swapOut = isFiniteNumber(details.swapOutPerSec) ? details.swapOutPerSec : 0
    if (swapIn > 0 || swapOut > 0) {
      parts.push(`换入 ${formatRate(swapIn)} · 换出 ${formatRate(swapOut)}`)
    }
    return parts.length > 0 ? parts.join(' · ') : null
  }
  return null
}

function IssueItem({ check }: { check: HealthCheck }) {
  const status = normalizeStatus(check.status)
  const reading = readingText(check)
  const thresholds = thresholdText(check, check.category === 'load' ? ' / 核' : undefined)
  const extra = issueDetailsText(check)
  const duration = check.since ? formatSpan(check.since) : null
  return (
    <li className="health-issue" data-health={status}>
      <div className="health-issue-head">
        <strong>{issueLabel(check)}</strong>
        <span className="health-issue-state">{status === 'critical' ? '严重' : '警告'}</span>
      </div>
      <p className="health-issue-message">{check.message}</p>
      {(reading || thresholds) && (
        <p className="health-issue-reading">
          {reading}
          {reading && thresholds ? ' · ' : ''}
          {thresholds}
        </p>
      )}
      {extra && <p className="health-issue-reading">{extra}</p>}
      {duration && <p className="health-issue-since">已持续 {duration}</p>}
    </li>
  )
}

function TemperatureItem({ check, multiple }: { check: HealthCheck; multiple: boolean }) {
  const details = detailsOf<TemperatureHealthDetails>(check)
  const sensorName = check.label || (typeof details.sensor === 'string' && details.sensor) || '温度'
  const chip = typeof details.chip === 'string' && details.chip && details.chip !== sensorName ? details.chip : null
  const celsius = isFiniteNumber(check.value)
    ? check.value
    : (isFiniteNumber(details.celsius) ? details.celsius : null)
  const reading = celsiusText(celsius)

  let dataHealth: TemperatureHealth
  let stateText: string
  let note: string | null = null

  if (!check.applicable) {
    if (check.reason === 'no_threshold') {
      dataHealth = 'info'
      stateText = '仅展示读数'
      note = '无硬件阈值，仅展示读数'
    } else if (check.reason === 'not_supported') {
      dataHealth = 'not-applicable'
      stateText = '不可用'
      note = '当前主机无可用温度传感器'
    } else {
      dataHealth = 'not-applicable'
      stateText = '不适用'
      note = check.message || '不适用'
    }
  } else {
    const status = normalizeStatus(check.status)
    dataHealth = status
    stateText = checkStatusText[status]
    const thresholds = thresholdText(check)
    if (status === 'unknown') {
      note = [check.message, thresholds].filter(Boolean).join(' · ') || '状态未知'
    } else {
      note = thresholds ?? (check.message || null)
    }
  }

  const showAlertBadge = dataHealth === 'warning' || dataHealth === 'critical'
  return (
    <li className="health-temp-item" data-health={dataHealth}>
      <div className="health-temp-main">
        <div className="health-temp-name">
          <strong>{sensorName}</strong>
          {chip && (multiple || chip !== 'thermal') && <span className="health-temp-chip">{chip}</span>}
        </div>
        <div className="health-temp-reading">
          {showAlertBadge && (
            <span className="health-temp-badge">{dataHealth === 'critical' ? '严重' : '警告'}</span>
          )}
          <strong>
            {reading}
            <span className="health-sr">，{stateText}</span>
          </strong>
        </div>
      </div>
      {note && <p className="health-temp-meta">{note}</p>}
    </li>
  )
}

function TemperatureSection({ checks }: { checks: HealthCheck[] }) {
  const tempChecks = checks.filter(check => check.category === 'temperature')
  if (tempChecks.length === 0) return null

  const unsupportedOnly = tempChecks.length === 1
    && !tempChecks[0].applicable
    && tempChecks[0].reason === 'not_supported'
  const multiple = tempChecks.length > 1

  return (
    <section className="health-section" aria-labelledby="health-temperature-title">
      <h3 id="health-temperature-title" className="health-section-title">
        <Thermometer size={14} aria-hidden="true" />
        <span>温度</span>
        {multiple && <span className="health-section-count">{tempChecks.length}</span>}
      </h3>
      {unsupportedOnly ? (
        <p className="health-temp-empty">当前主机无可用温度传感器</p>
      ) : (
        <ul className="health-temp-list">
          {tempChecks.map(check => <TemperatureItem key={check.id} check={check} multiple={multiple} />)}
        </ul>
      )}
    </section>
  )
}

type HealthPanelProps = {
  snapshot: HealthSnapshot | null
  connection: ConnectionState
  onOpenMonitor: () => void
}

export function HealthPanel({ snapshot, connection, onOpenMonitor }: HealthPanelProps) {
  const disconnected = connection === 'disconnected'
  const status = effectiveStatus(snapshot, connection)
  const stale = Boolean(snapshot?.stale) && !disconnected
  const issues = (snapshot?.checks ?? [])
    .filter(check => check.applicable && ['warning', 'critical'].includes(normalizeStatus(check.status)))
    .sort((left, right) => statusRank(normalizeStatus(right.status)) - statusRank(normalizeStatus(left.status)))
  const issueCount = snapshot?.summary.issueCount ?? 0
  const metrics = snapshot ? metricsFor(snapshot.checks) : []

  let caption = '正在连接 GoDesk…'
  if (disconnected) caption = 'GoDesk 连接中断，无法取得主机状态'
  else if (snapshot?.stale) caption = `数据未更新（最近检查 ${formatTime(snapshot.generatedAt)}）`
  else if (snapshot) {
    const checked = `最近检查 ${formatTime(snapshot.generatedAt)}`
    if (status === 'warning' || status === 'critical') caption = `${issueCount} 项异常 · ${checked}`
    else if (status === 'unknown') caption = `无法确认主机状态 · ${checked}`
    else caption = checked
  }

  const hostParts: string[] = []
  if (snapshot) {
    if (snapshot.host.hostname) hostParts.push(snapshot.host.hostname)
    if (snapshot.host.platform) {
      hostParts.push(snapshot.host.architecture
        ? `${snapshot.host.platform} · ${snapshot.host.architecture}`
        : snapshot.host.platform)
    }
    const uptime = formatUptime(snapshot.host.uptimeSeconds)
    if (uptime) hostParts.push(`已运行 ${uptime}`)
  }

  return (
    <div className="health-panel">
      <section className="health-overview" data-health={disconnected ? 'disconnected' : status}>
        <span className="health-overview-icon">
          {disconnected ? <Unplug size={22} aria-hidden="true" /> : <StatusIcon status={status} size={22} />}
        </span>
        <div>
          <p className="health-overview-title">{healthStatusText[status]}</p>
          <p className="health-overview-caption">{caption}</p>
        </div>
      </section>

      {disconnected && snapshot && (
        <p className="health-note">以下为最近一次成功获取的数据（{formatTime(snapshot.generatedAt)}）。</p>
      )}
      {stale && snapshot && (
        <p className="health-note">以下状态来自过期数据，仅供参考，不代表当前主机状态。</p>
      )}

      {snapshot && (
        <>
          {issues.length > 0 && (
            <section className="health-section" aria-labelledby="health-issues-title">
              <h3 id="health-issues-title" className="health-section-title">
                异常检查项 <span className="health-section-count">{issueCount}</span>
              </h3>
              <ul className="health-issues">
                {issues.map(check => <IssueItem key={check.id} check={check} />)}
              </ul>
            </section>
          )}

          <div className="health-metrics">
            {metrics.map(metric => {
              const Icon = metric.Icon
              return (
                <div key={metric.category} className="health-metric"
                  data-health={metric.status} title={metric.title}>
                  <span className="health-metric-head">
                    <Icon size={15} aria-hidden="true" />
                    <span>{metric.label}</span>
                  </span>
                  <strong className="health-metric-value">
                    {metric.value}
                    <span className="health-sr">，{metric.stateText}</span>
                  </strong>
                  {metric.detail && <span className="health-metric-detail">{metric.detail}</span>}
                  {metric.meta && <span className="health-metric-meta">{metric.meta}</span>}
                </div>
              )
            })}
          </div>

          <TemperatureSection checks={snapshot.checks} />

          {hostParts.length > 0 && (
            <p className="health-host-line">{hostParts.join(' · ')}</p>
          )}
        </>
      )}

      <button type="button" className="app-control health-open-monitor" onClick={onOpenMonitor}>
        查看系统监控
        <ArrowRight size={16} aria-hidden="true" />
      </button>
    </div>
  )
}
