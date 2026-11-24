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

const categories = [
  { category: 'cpu', label: 'CPU', Icon: Cpu },
  { category: 'memory', label: '内存', Icon: MemoryStick },
  { category: 'storage', label: '存储', Icon: HardDrive },
  { category: 'network', label: '网络', Icon: Network },
]

const reasonLabels: Record<string, string> = {
  initializing: '尚未取得首份有效数据',
  collect_failed: '本次采集失败',
  stale: '数据已过期',
  not_supported: '当前平台或文件系统不支持',
  no_threshold: '没有可信阈值，仅供参考',
  no_default_route: '未发现默认路由',
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

function categorySummary(checks: HealthCheck[], category: string) {
  const applicable = checks.filter(check => check.category === category && check.applicable)
  if (applicable.length === 0) return { status: null, text: '不可用' }
  let worst: DisplayStatus = 'healthy'
  for (const check of applicable) {
    const status = normalizeStatus(check.status)
    if (statusRank(status) > statusRank(worst)) worst = status
  }
  const count = applicable.filter(check => normalizeStatus(check.status) === worst).length
  const text = worst === 'healthy' ? '正常'
    : worst === 'warning' ? `${count} 项警告`
      : worst === 'critical' ? `${count} 项严重` : `${count} 项未知`
  return { status: worst, text }
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
  const unknowns = (snapshot?.checks ?? []).filter(check => check.applicable && normalizeStatus(check.status) === 'unknown')
  const unavailable = (snapshot?.checks ?? []).filter(check => !check.applicable)
  const issueCount = snapshot?.summary.issueCount ?? 0

  const hostRows: { label: string; value: string }[] = []
  if (snapshot) {
    if (snapshot.host.hostname) hostRows.push({ label: '主机名', value: snapshot.host.hostname })
    if (snapshot.host.platform) {
      const platform = snapshot.host.architecture
        ? `${snapshot.host.platform} · ${snapshot.host.architecture}`
        : snapshot.host.platform
      hostRows.push({ label: '平台', value: platform })
    }
    const uptime = formatUptime(snapshot.host.uptimeSeconds)
    if (uptime) hostRows.push({ label: '运行时间', value: uptime })
  }

  let caption = '正在连接 GoDesk…'
  if (disconnected) caption = 'GoDesk 连接中断，无法取得主机状态'
  else if (snapshot?.stale) caption = `数据未更新（最近检查 ${formatTime(snapshot.generatedAt)}）`
  else if (snapshot) {
    const checked = `最近检查 ${formatTime(snapshot.generatedAt)}`
    if (status === 'warning' || status === 'critical') caption = `${issueCount} 项异常 · ${checked}`
    else if (status === 'unknown') caption = `无法确认主机状态 · ${checked}`
    else caption = `所有检查正常 · ${checked}`
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

          {unknowns.length > 0 && (
            <section className="health-section" aria-labelledby="health-unknown-title">
              <h3 id="health-unknown-title" className="health-section-title">状态未知</h3>
              <ul className="health-plain-list">
                {unknowns.map(check => (
                  <li key={check.id}>
                    <span>{check.label}</span>
                    <span className="health-plain-detail">{check.message || reasonLabels[check.reason] || '状态未知'}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {issues.length === 0 && unknowns.length === 0 && status === 'healthy' && (
            <p className="health-ok">所有适用检查均正常。</p>
          )}

          <section className="health-section" aria-labelledby="health-dimensions-title">
            <h3 id="health-dimensions-title" className="health-section-title">检查维度</h3>
            <div className="health-dimensions">
              {categories.map(({ category, label, Icon }) => {
                const summary = categorySummary(snapshot.checks, category)
                return (
                  <div className="health-dimension" key={category} data-health={summary.status ?? 'unknown'}>
                    <Icon size={15} aria-hidden="true" />
                    <span className="health-dimension-label">{label}</span>
                    <span className="health-dimension-state">{summary.text}</span>
                  </div>
                )
              })}
            </div>
          </section>

          {unavailable.length > 0 && (
            <section className="health-section" aria-labelledby="health-unavailable-title">
              <h3 id="health-unavailable-title" className="health-section-title">不可用</h3>
              <ul className="health-plain-list">
                {unavailable.map(check => (
                  <li key={check.id}>
                    <span>{check.label}</span>
                    <span className="health-plain-detail">{reasonLabels[check.reason] ?? '不适用于当前环境'}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {hostRows.length > 0 && (
            <section className="health-section" aria-labelledby="health-host-title">
              <h3 id="health-host-title" className="health-section-title">主机信息</h3>
              <dl className="health-host">
                {hostRows.map(row => (
                  <div key={row.label}>
                    <dt>{row.label}</dt>
                    <dd>{row.value}</dd>
                  </div>
                ))}
              </dl>
            </section>
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
