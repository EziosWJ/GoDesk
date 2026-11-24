import { ArrowRight, Cpu, HardDrive, MemoryStick, Network, Unplug } from 'lucide-react'
import type { HealthCheck, HealthSnapshot } from './health'
import type { ConnectionState } from './useHostHealth'
import { StatusIcon } from './HealthStatusIcon'
import { effectiveStatus, healthStatusText, normalizeStatus, type DisplayStatus } from './healthUi'
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

type Metric = {
  category: string
  label: string
  Icon: typeof Cpu
  status: DisplayStatus | null
  value: string
  title?: string
}

type NetworkDetails = {
  interface?: string
  linkUp?: boolean
  ipv4?: string[]
  ipv6?: string[]
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

function readingText(check: HealthCheck) {
  if (check.value === null || !Number.isFinite(check.value)) return null
  return `当前 ${numberFormat.format(check.value)}${unitSuffix(check.unit)}`
}

function thresholdText(check: HealthCheck) {
  if (!check.thresholds) return null
  const suffix = unitSuffix(check.unit)
  const parts: string[] = []
  if (check.thresholds.warning !== null) parts.push(`警告 ${numberFormat.format(check.thresholds.warning)}${suffix}`)
  if (check.thresholds.critical !== null) parts.push(`严重 ${numberFormat.format(check.thresholds.critical)}${suffix}`)
  return parts.length > 0 ? parts.join(' · ') : null
}

function unavailableMetric(category: string, label: string, Icon: typeof Cpu, title?: string): Metric {
  return { category, label, Icon, status: null, value: '不可用', title }
}

function unavailableTitle(checks: HealthCheck[], category: string) {
  return checks.find(check => check.category === category && !check.applicable)?.message || undefined
}

function percentMetric(checks: HealthCheck[], category: string, label: string, Icon: typeof Cpu): Metric {
  const check = checks.find(item => item.category === category && item.applicable)
  if (!check) return unavailableMetric(category, label, Icon, unavailableTitle(checks, category))
  const status = normalizeStatus(check.status)
  return {
    category,
    label,
    Icon,
    status,
    value: percentText(check.value),
    title: status === 'healthy' ? undefined : check.message || undefined,
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
  return {
    category: 'storage',
    label: '存储',
    Icon,
    status: normalizeStatus(worst.status),
    value: percentText(worst.value),
    title: applicable.map(check => `${check.label} ${percentText(check.value)}`).join(' · '),
  }
}

function networkMetric(checks: HealthCheck[]): Metric {
  const Icon = Network
  const check = checks.find(item => item.category === 'network' && item.applicable)
  if (!check) return unavailableMetric('network', '网络', Icon, unavailableTitle(checks, 'network'))
  const status = normalizeStatus(check.status)
  const details = (check.details ?? {}) as NetworkDetails
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
    title: [details.interface, addresses].filter(Boolean).join(' · ') || check.message || undefined,
  }
}

function metricsFor(checks: HealthCheck[]): Metric[] {
  return [
    percentMetric(checks, 'cpu', 'CPU', Cpu),
    percentMetric(checks, 'memory', '内存', MemoryStick),
    storageMetric(checks),
    networkMetric(checks),
  ]
}

function IssueItem({ check }: { check: HealthCheck }) {
  const status = normalizeStatus(check.status)
  const reading = readingText(check)
  const thresholds = thresholdText(check)
  const duration = check.since ? formatSpan(check.since) : null
  return (
    <li className="health-issue" data-health={status}>
      <div className="health-issue-head">
        <strong>{check.label}</strong>
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
      {duration && <p className="health-issue-since">已持续 {duration}</p>}
    </li>
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
          <div className="health-metrics">
            {metrics.map(metric => {
              const Icon = metric.Icon
              const stateText = metric.status ? checkStatusText[metric.status] : '不可用'
              return (
                <div key={metric.category} className="health-metric"
                  data-health={metric.status ?? 'unavailable'} title={metric.title}>
                  <span className="health-metric-head">
                    <Icon size={15} aria-hidden="true" />
                    <span>{metric.label}</span>
                  </span>
                  <strong className="health-metric-value">
                    {metric.value}
                    <span className="health-sr">，{stateText}</span>
                  </strong>
                </div>
              )
            })}
          </div>

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
