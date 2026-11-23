import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { Play, RotateCw, Square } from 'lucide-react'
import {
  ServiceError, servicesApi,
  type ManagedService, type ServiceAction, type ServiceBootState, type ServiceDetail as ServiceDetailData,
} from './services'
import { ServiceBadge } from './ServiceBadge'
import {
  actionLabels, actionProgress, bootStateLabels, formatBytes, formatDuration,
} from './serviceLabels'

type Tab = 'detail' | 'logs'

type ServiceDetailProps = {
  service: ManagedService
  refreshToken: number
  pendingAction?: ServiceAction
  actionError: string
  excluded: boolean
  logsAvailable: boolean
  tab: Tab
  onTabChange: (tab: Tab) => void
  onAction: (action: ServiceAction) => void
  logsPanel?: ReactNode
  headingRef: RefObject<HTMLHeadingElement | null>
}

const detailTabId = 'service-tab-detail'
const logsTabId = 'service-tab-logs'
const detailPanelId = 'service-panel-detail'
const logsPanelId = 'service-panel-logs'

function startReason(service: ManagedService) {
  if (service.bootState === 'masked') return '单元已被屏蔽，无法启动'
  switch (service.state) {
    case 'running': return '服务正在运行'
    case 'completed': return '服务已完成运行'
    default: return '当前状态不允许启动'
  }
}

function stopReason(service: ManagedService) {
  if (service.bootState === 'masked') return '单元已被屏蔽'
  switch (service.state) {
    case 'stopped': return '服务未运行'
    case 'failed': return '服务未在运行'
    default: return '当前状态不允许停止'
  }
}

function restartReason(service: ManagedService) {
  if (service.bootState === 'masked') return '单元已被屏蔽'
  if (service.state === 'stopped') return '服务未运行'
  return '当前状态不允许重启'
}

function bootReason(bootState: ServiceBootState) {
  switch (bootState) {
    case 'static': return '该单元为静态单元，不支持开机自启'
    case 'masked': return '该单元已被屏蔽，不支持开机自启'
    case 'runtime': return '该单元仅在本次运行期间有效'
    case 'not_applicable': return '该单元不适用开机自启'
    default: return '当前状态不允许该操作'
  }
}

function detailErrorMessage(error: unknown) {
  if (error instanceof ServiceError) {
    switch (error.code) {
      case 'permission': return '权限不足：无法读取服务详情'
      case 'not_found': return '服务不存在，可能已被移除'
      case 'timeout': return '读取服务详情超时'
      default: return error.message
    }
  }
  return error instanceof Error ? error.message : '无法读取服务详情'
}

export function ServiceDetailPane({
  service, refreshToken, pendingAction, actionError,
  excluded, logsAvailable, tab, onTabChange, onAction, logsPanel, headingRef,
}: ServiceDetailProps) {
  const [detail, setDetail] = useState<ServiceDetailData>()
  const [detailError, setDetailError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const actions = new Set(service.actions)
  const busy = pendingAction !== undefined
  const canStart = actions.has('start')
  const canStop = actions.has('stop')
  const primaryAction: ServiceAction = canStop ? 'stop' : 'start'
  const restartEnabled = actions.has('restart')
  const bootOn = service.bootState === 'enabled'
  const bootAction: ServiceAction = bootOn ? 'disable' : 'enable'
  const bootAvailable = actions.has(bootAction)
  const tabs = useRef<{ detail: HTMLButtonElement | null; logs: HTMLButtonElement | null }>({ detail: null, logs: null })

  useEffect(() => {
    const controller = new AbortController()
    servicesApi.detail(service.name, controller.signal)
      .then(next => {
        if (controller.signal.aborted) return
        setDetail(next)
        setDetailError('')
      })
      .catch(error => {
        if (controller.signal.aborted) return
        if (error instanceof ServiceError && error.status === 401) {
          window.location.reload()
          return
        }
        setDetailError(detailErrorMessage(error))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoaded(true)
      })
    return () => controller.abort()
  }, [service.name, refreshToken])

  const state = detail?.state ?? service.state
  const stateDetail = (detail?.stateDetail || service.stateDetail) || '—'
  const bootState = detail?.bootState ?? service.bootState

  function tabKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const next: Tab = tab === 'detail' ? 'logs' : 'detail'
    onTabChange(next)
    tabs.current[next]?.focus()
  }

  return (
    <div className="service-detail-content">
      <header className="service-detail-header">
        <div className="service-detail-title">
          <h3 ref={headingRef} tabIndex={-1} className="service-detail-name">{service.name}</h3>
          <ServiceBadge state={state} />
        </div>
        <div className="service-detail-actions">
          <button type="button"
            className={`app-control service-action${primaryAction === 'start' ? ' primary-control' : ''}`}
            aria-disabled={busy || !canStart ? 'true' : undefined}
            title={canStart ? undefined : startReason(service)}
            onClick={() => { if (!busy && canStart) onAction('start') }}>
            <Play size={14} aria-hidden="true" />{actionLabels.start}
          </button>
          <button type="button"
            className={`app-control service-action${primaryAction === 'stop' ? ' primary-control' : ''}`}
            aria-disabled={busy || !canStop ? 'true' : undefined}
            title={canStop ? undefined : stopReason(service)}
            onClick={() => { if (!busy && canStop) onAction('stop') }}>
            <Square size={14} aria-hidden="true" />{actionLabels.stop}
          </button>
          <button type="button" className="app-control service-action"
            aria-disabled={busy || !restartEnabled ? 'true' : undefined}
            title={restartEnabled ? undefined : restartReason(service)}
            onClick={() => { if (!busy && restartEnabled) onAction('restart') }}>
            <RotateCw size={14} aria-hidden="true" />{actionLabels.restart}
          </button>
          <button type="button" role="switch" aria-checked={bootOn}
            className="app-control service-switch"
            aria-disabled={busy || !bootAvailable ? 'true' : undefined}
            title={!bootAvailable
              ? bootReason(bootState)
              : bootOn ? '点击禁用开机自启' : '点击启用开机自启'}
            onClick={() => { if (!busy && bootAvailable) onAction(bootAction) }}>
            <span className="service-switch-track" aria-hidden="true"><span className="service-switch-thumb" /></span>
            开机自启
          </button>
        </div>
        {(pendingAction || actionError) && (
          <div className="service-action-feedback">
            {pendingAction && <p className="system-caption service-pending" role="status">{actionProgress[pendingAction]}</p>}
            {actionError && <p className="service-alert" role="alert">{actionError}</p>}
          </div>
        )}
      </header>
      {logsAvailable && (
        <div className="service-tabs" role="tablist" aria-label="服务视图" onKeyDown={tabKeyDown}>
          <button ref={node => { tabs.current.detail = node }} type="button" role="tab"
            id={detailTabId} className="service-tab" aria-selected={tab === 'detail'}
            aria-controls={detailPanelId} tabIndex={tab === 'detail' ? 0 : -1}
            onClick={() => onTabChange('detail')}>详情</button>
          <button ref={node => { tabs.current.logs = node }} type="button" role="tab"
            id={logsTabId} className="service-tab" aria-selected={tab === 'logs'}
            aria-controls={logsPanelId} tabIndex={tab === 'logs' ? 0 : -1}
            onClick={() => onTabChange('logs')}>日志</button>
        </div>
      )}
      <div className="service-detail-panel" role={logsAvailable ? 'tabpanel' : undefined}
        id={logsAvailable ? detailPanelId : undefined}
        aria-labelledby={logsAvailable ? detailTabId : undefined}
        hidden={logsAvailable && tab !== 'detail'}>
        <div className="service-detail-body">
          {detailError && <p className="service-alert" role="alert">{detailError}</p>}
          {!loaded && !detailError && <p className="system-caption" role="status">正在读取详情…</p>}
          <section className="service-group" aria-labelledby="service-group-overview">
            <h4 id="service-group-overview">概述</h4>
            <dl className="service-field-grid">
              <div><dt>描述</dt><dd>{service.description || '—'}</dd></div>
              <div><dt>状态</dt><dd><ServiceBadge state={state} /></dd></div>
              <div><dt>原始状态</dt><dd className="service-mono">{stateDetail}</dd></div>
              <div><dt>开机自启</dt><dd>{bootStateLabels[bootState]}</dd></div>
            </dl>
          </section>
          <section className="service-group" aria-labelledby="service-group-runtime">
            <h4 id="service-group-runtime">运行</h4>
            <dl className="service-field-grid">
              <div><dt>主 PID</dt><dd className="service-numeric">{detail?.mainPid ?? '—'}</dd></div>
              <div><dt>内存</dt><dd className="service-numeric">{formatBytes(detail?.memoryBytes)}</dd></div>
              <div><dt>CPU 累计</dt><dd className="service-numeric">{formatDuration(detail?.cpuUsageNs)}</dd></div>
              <div><dt>启动时间</dt><dd>{detail?.activeEnterTimestamp || '—'}</dd></div>
            </dl>
          </section>
          <section className="service-group" aria-labelledby="service-group-files">
            <h4 id="service-group-files">文件</h4>
            <dl className="service-field-grid">
              <div><dt>单元文件</dt><dd className="service-mono">{detail?.fragmentPath || '—'}</dd></div>
            </dl>
          </section>
          {excluded && <p className="system-caption" role="status">此服务已移出当前筛选结果。</p>}
        </div>
      </div>
      {logsAvailable && (
        <div className="service-detail-panel service-logs-host" role="tabpanel"
          id={logsPanelId} aria-labelledby={logsTabId} hidden={tab !== 'logs'}>
          {logsPanel}
        </div>
      )}
    </div>
  )
}
