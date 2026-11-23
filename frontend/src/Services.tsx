import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft, CircleCheck, CircleHelp, CircleMinus, CirclePlay, CircleX, Play, Power, PowerOff,
  RefreshCw, RotateCw, Search, Square, type LucideIcon,
} from 'lucide-react'
import { useSplitLayout } from './useSplitLayout'
import {
  servicesApi, ServiceError,
  type ManagedService, type ServiceAction, type ServiceBootState, type ServicesSnapshot, type ServiceState,
} from './services'

const LOG_LINES = 200

const statuses: Record<ServiceState, { label: string; Icon: LucideIcon }> = {
  running: { label: '运行中', Icon: CirclePlay },
  completed: { label: '已完成', Icon: CircleCheck },
  stopped: { label: '已停止', Icon: CircleMinus },
  failed: { label: '失败', Icon: CircleX },
  unknown: { label: '未知', Icon: CircleHelp },
}

const bootStateLabels: Record<ServiceBootState, string> = {
  enabled: '已启用',
  disabled: '已禁用',
  static: '静态',
  masked: '已屏蔽',
  runtime: '仅本次运行',
  not_applicable: '不适用',
}

const actionLabels: Record<ServiceAction, string> = {
  start: '启动',
  stop: '停止',
  restart: '重启',
  enable: '启用开机自启',
  disable: '禁用开机自启',
}

const actionIcons: Record<ServiceAction, LucideIcon> = {
  start: Play,
  stop: Square,
  restart: RotateCw,
  enable: Power,
  disable: PowerOff,
}

const actionProgress: Record<ServiceAction, string> = {
  start: '正在启动服务…',
  stop: '正在停止服务…',
  restart: '正在重启服务…',
  enable: '正在启用开机自启…',
  disable: '正在禁用开机自启…',
}

function ServiceStatus({ state }: { state: ServiceState }) {
  const { Icon, label } = statuses[state]
  return <span className="service-status" data-status={state}><Icon size={16} aria-hidden="true" />{label}</span>
}

function backendLabel(backend?: string) {
  switch (backend) {
    case 'systemd': return 'systemd 服务'
    case 'openrc': return 'OpenRC 服务'
    case 'busybox': return 'BusyBox 服务'
    default: return '服务管理'
  }
}

function unauthorized(error: unknown) {
  return error instanceof ServiceError && error.status === 401
}

function listErrorMessage(error: unknown) {
  if (error instanceof ServiceError) {
    switch (error.code) {
      case 'permission': return '权限不足：无法读取服务列表'
      case 'timeout': return '读取服务列表超时'
      default: return error.message
    }
  }
  return error instanceof Error ? error.message : '无法读取服务列表'
}

function actionErrorMessage(error: unknown) {
  if (error instanceof ServiceError) {
    switch (error.code) {
      case 'permission': return '权限不足：goDesk 运行账号不能执行该操作'
      case 'not_found': return '服务不存在，可能已被移除'
      case 'action_not_allowed': return '当前状态不允许该动作'
      case 'timeout': return '操作超时，systemd 任务可能仍在运行'
      case 'operation_failed': return error.message || '操作失败'
      default: return error.message
    }
  }
  return error instanceof Error ? error.message : '操作失败'
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

export function Services({ active = true }: { active?: boolean }) {
  const [snapshot, setSnapshot] = useState<ServicesSnapshot>()
  const [listError, setListError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ServiceState | 'all'>('all')
  const [selectedName, setSelectedName] = useState<string>()
  const [showDetail, setShowDetail] = useState(false)
  const [tab, setTab] = useState<'detail' | 'logs'>('detail')
  const [confirmation, setConfirmation] = useState<ServiceAction>()
  const [pending, setPending] = useState<{ unit: string; action: ServiceAction }>()
  const [actionError, setActionError] = useState<{ unit: string; message: string }>()
  const [logs, setLogs] = useState<string[]>([])
  const [logsLoading, setLogsLoading] = useState(false)
  const [logsError, setLogsError] = useState('')

  const dialog = useRef<HTMLDialogElement>(null)
  const cancelButton = useRef<HTMLButtonElement>(null)
  const confirmButton = useRef<HTMLButtonElement>(null)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const back = useRef<HTMLButtonElement>(null)
  const filterControl = useRef<HTMLSelectElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const detail = useRef<HTMLElement>(null)
  const rowButtons = useRef(new Map<string, HTMLButtonElement>())
  const listScrollTop = useRef(0)
  const nextFocus = useRef<'detail' | 'list' | null>(null)
  const logsUnit = useRef<string | undefined>(undefined)
  const logsAbort = useRef<AbortController | null>(null)
  const selectedNameRef = useRef<string | undefined>(undefined)
  const activeTabRef = useRef<'detail' | 'logs'>('detail')
  const titleId = useId()
  const descriptionId = useId()
  const detailId = useId()
  const detailTabId = useId()
  const detailPanelId = useId()
  const logsTabId = useId()
  const logsPanelId = useId()

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await servicesApi.list(signal)
      if (signal?.aborted) return
      setSnapshot(next)
      setListError('')
    } catch (error) {
      if (signal?.aborted) return
      if (unauthorized(error)) {
        window.location.reload()
        return
      }
      setListError(listErrorMessage(error))
    }
  }, [])

  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    let timer: number | undefined
    let stopped = false

    function schedule() {
      window.clearTimeout(timer)
      if (document.visibilityState === 'visible') timer = window.setTimeout(tick, 10_000)
    }

    async function tick() {
      await load(controller.signal)
      if (stopped || controller.signal.aborted) return
      schedule()
    }

    function onVisibility() {
      if (document.visibilityState === 'visible') {
        window.clearTimeout(timer)
        void tick()
      } else {
        window.clearTimeout(timer)
      }
    }

    void tick()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stopped = true
      controller.abort()
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [active, load])

  const selected = snapshot?.services.find(service => service.name === selectedName)
  const logsAvailable = snapshot?.capabilities.logs === true
  const activeTab = logsAvailable ? tab : 'detail'
  const visibleServices = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return (snapshot?.services ?? [])
      .filter(service => (filter === 'all' || service.state === filter)
        && (!needle || service.name.toLowerCase().includes(needle) || service.description.toLowerCase().includes(needle)))
      .sort((left, right) => left.name.localeCompare(right.name))
  }, [snapshot, query, filter])
  const excluded = selected !== undefined && !visibleServices.includes(selected)
  const selectedActions = selected?.actions ?? []
  const lifecycleActions = selectedActions.filter(action => action !== 'enable' && action !== 'disable')
  const bootActions = selectedActions.filter(action => action === 'enable' || action === 'disable')
  const selectedPending = pending?.unit === selected?.name ? pending : undefined
  const selectedError = actionError && actionError.unit === selected?.name ? actionError.message : ''

  useEffect(() => {
    selectedNameRef.current = selectedName
    activeTabRef.current = activeTab
  }, [selectedName, activeTab])

  const { root, split } = useSplitLayout(617, wide => {
    const activeElement = document.activeElement
    if (wide) {
      if (activeElement === back.current) nextFocus.current = 'detail'
    } else if (list.current?.contains(activeElement)) {
      setShowDetail(false)
    } else if (selected && (detail.current?.contains(activeElement) || dialog.current?.open)) {
      setShowDetail(true)
    }
  })

  const listVisible = split || !showDetail

  useEffect(() => () => {
    logsAbort.current?.abort()
  }, [])

  async function loadLogs(unit: string, force = false) {
    if (!force && logsUnit.current === unit && !logsError) return
    logsAbort.current?.abort()
    const controller = new AbortController()
    logsAbort.current = controller
    const changed = logsUnit.current !== unit
    logsUnit.current = unit
    setLogsLoading(true)
    setLogsError('')
    if (changed) setLogs([])
    try {
      const lines = await servicesApi.logs(unit, LOG_LINES, controller.signal)
      if (!controller.signal.aborted) setLogs(lines)
    } catch (error) {
      if (controller.signal.aborted) return
      if (unauthorized(error)) {
        window.location.reload()
        return
      }
      setLogs([])
      setLogsError(logsErrorMessage(error))
    } finally {
      if (!controller.signal.aborted) setLogsLoading(false)
    }
  }

  useLayoutEffect(() => {
    if (listVisible && list.current) list.current.scrollTop = listScrollTop.current
  }, [listVisible])

  useLayoutEffect(() => {
    if (nextFocus.current === 'detail') heading.current?.focus()
    if (nextFocus.current === 'list') {
      const row = selectedName ? rowButtons.current.get(selectedName) : undefined
      const target = row ?? filterControl.current
      target?.focus()
    }
    nextFocus.current = null
  }, [selectedName, showDetail, split])

  useLayoutEffect(() => {
    if (confirmation && !dialog.current?.open) {
      dialog.current?.showModal()
      cancelButton.current?.focus()
    }
  }, [confirmation])

  async function refreshNow() {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  async function runAction(service: ManagedService, action: ServiceAction) {
    setPending({ unit: service.name, action })
    setActionError(undefined)
    try {
      await servicesApi.action(service.name, action)
      await load()
      logsUnit.current = undefined
      if (activeTabRef.current === 'logs' && selectedNameRef.current === service.name) {
        void loadLogs(service.name, true)
      }
    } catch (error) {
      if (unauthorized(error)) {
        window.location.reload()
        return
      }
      setActionError({ unit: service.name, message: actionErrorMessage(error) })
    } finally {
      setPending(undefined)
    }
  }

  function requestAction(service: ManagedService, action: ServiceAction, button: HTMLButtonElement) {
    if (action === 'stop' || action === 'restart') {
      trigger.current = button
      setConfirmation(action)
      return
    }
    heading.current?.focus()
    void runAction(service, action)
  }

  function closeConfirmation(confirmed: boolean) {
    const action = confirmation
    dialog.current?.close()
    setConfirmation(undefined)
    if (confirmed && selected && action) {
      heading.current?.focus()
      void runAction(selected, action)
    } else {
      trigger.current?.focus()
    }
  }

  return (
    <div className="services-page system-page" ref={root} data-split={split}>
      <header className="services-toolbar">
        <div>
          <h2 className="system-subtitle">{backendLabel(snapshot?.backend)}</h2>
          <p className="system-caption">
            {snapshot ? `${snapshot.services.length} 个服务` : listError ? '服务列表不可用' : '载入中'}
          </p>
        </div>
        {snapshot?.backend !== 'none' && (
          <div className="services-toolbar-controls">
            <label className="services-search">
              <Search size={15} aria-hidden="true" />
              <input type="search" value={query} onChange={event => setQuery(event.target.value)}
                placeholder="搜索服务名或描述" aria-label="搜索服务" />
            </label>
            <label className="services-filter">状态
              <select ref={filterControl} value={filter} onChange={event => setFilter(event.target.value as typeof filter)}>
                <option value="all">全部</option>
                {Object.entries(statuses).map(([state, { label }]) => <option key={state} value={state}>{label}</option>)}
              </select>
            </label>
            <button type="button" className="app-control services-refresh" onClick={() => { void refreshNow() }}
              disabled={refreshing} aria-label="刷新服务列表" title="刷新">
              <RefreshCw size={15} aria-hidden="true" />
            </button>
          </div>
        )}
      </header>
      <div className="services-body">
        {snapshot && !snapshot.capabilities.stateReliable && (
          <p className="system-caption service-warning" role="status">该后端无法可靠判断服务状态。</p>
        )}
        {snapshot?.backend === 'none' ? (
          <div className="services-empty-state system-scroll">
            <CircleHelp size={32} aria-hidden="true" />
            <p className="system-subtitle">未检测到受支持的初始化系统</p>
            <p className="system-caption">需要 systemd、OpenRC 或 BusyBox init。可以用 <code>-service-backend</code> 指定后端。</p>
          </div>
        ) : (
          <div className="services-panes">
            <div ref={list} className="services-list system-scroll" role="region" aria-label="服务列表" hidden={!listVisible}
              onScroll={event => { if (listVisible) listScrollTop.current = event.currentTarget.scrollTop }}>
              {listError && <p className="service-alert service-list-error" role="alert">{listError}</p>}
              {!snapshot && !listError && <p className="services-empty system-caption" role="status">正在读取服务…</p>}
              {snapshot && visibleServices.length === 0 && (
                <p className="services-empty system-caption">
                  {query.trim() || filter !== 'all' ? '没有符合当前筛选的服务' : '没有可管理的服务'}
                </p>
              )}
              {visibleServices.length > 0 && (
                <table className="data-table services-table" aria-label="服务列表">
                  <thead><tr><th scope="col">服务</th><th scope="col">状态</th></tr></thead>
                  <tbody>
                    {visibleServices.map(service => (
                      <tr key={service.name} data-selected={selectedName === service.name}>
                        <td>
                          <button className="app-control service-name"
                            ref={node => {
                              if (node) rowButtons.current.set(service.name, node)
                              else rowButtons.current.delete(service.name)
                            }}
                            aria-current={selectedName === service.name ? 'true' : undefined}
                            aria-controls={detailId}
                            onClick={() => {
                              setActionError(undefined)
                              if (!split) {
                                listScrollTop.current = list.current?.scrollTop ?? 0
                                nextFocus.current = 'detail'
                              }
                              setSelectedName(service.name)
                              setShowDetail(true)
                              if (activeTab === 'logs') void loadLogs(service.name)
                            }}>{service.name}</button>
                        </td>
                        <td><ServiceStatus state={service.state} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <section ref={detail} id={detailId} className="service-detail system-scroll" aria-label="服务详情" hidden={!split && !showDetail}>
              {!split && <button ref={back} className="app-control system-back" onClick={() => {
                nextFocus.current = 'list'
                setShowDetail(false)
              }}><ArrowLeft size={16} aria-hidden="true" />返回列表</button>}
              {selected ? (
                <>
                  <h3 ref={heading} tabIndex={-1} className="system-subtitle service-detail-name">{selected.name}</h3>
                  {logsAvailable && (
                    <div className="service-tabs" role="tablist" aria-label="服务详情">
                      <button type="button" role="tab" id={detailTabId} className="service-tab"
                        aria-selected={activeTab === 'detail'} aria-controls={detailPanelId}
                        tabIndex={activeTab === 'detail' ? 0 : -1} onClick={() => setTab('detail')}>详情</button>
                      <button type="button" role="tab" id={logsTabId} className="service-tab"
                        aria-selected={activeTab === 'logs'} aria-controls={logsPanelId}
                        tabIndex={activeTab === 'logs' ? 0 : -1}
                        onClick={() => { setTab('logs'); if (selected) void loadLogs(selected.name) }}>日志</button>
                    </div>
                  )}
                  <div role={logsAvailable ? 'tabpanel' : undefined} id={logsAvailable ? detailPanelId : undefined}
                    aria-labelledby={logsAvailable ? detailTabId : undefined} hidden={activeTab !== 'detail'}>
                      <dl className="service-fields">
                        <div><dt>当前状态</dt><dd><span role="status"><ServiceStatus state={selected.state} /></span></dd></div>
                        {selected.stateDetail && <div><dt>原始状态</dt><dd className="service-mono">{selected.stateDetail}</dd></div>}
                        <div><dt>开机自启</dt><dd>{bootStateLabels[selected.bootState]}</dd></div>
                        <div><dt>描述</dt><dd>{selected.description || '—'}</dd></div>
                      </dl>
                      {selectedError && <p className="service-alert" role="alert">{selectedError}</p>}
                      {selectedPending && <p className="system-caption service-pending" role="status">{actionProgress[selectedPending.action]}</p>}
                      {lifecycleActions.length === 0 && bootActions.length === 0 && !selectedPending && (
                        <p className="system-caption">当前状态没有可执行的操作。</p>
                      )}
                      <div className="service-actions">
                        {lifecycleActions.length > 0 && (
                          <div className="service-action-group" aria-label="生命周期操作">
                            {lifecycleActions.map(action => {
                              const Icon = actionIcons[action]
                              return (
                                <button key={action} type="button" className="app-control service-action"
                                  disabled={pending !== undefined}
                                  onClick={event => requestAction(selected, action, event.currentTarget)}>
                                  <Icon size={15} aria-hidden="true" />{actionLabels[action]}
                                </button>
                              )
                            })}
                          </div>
                        )}
                        {bootActions.length > 0 && (
                          <div className="service-action-group" aria-label="开机自启操作">
                            {bootActions.map(action => {
                              const Icon = actionIcons[action]
                              return (
                                <button key={action} type="button" className="app-control service-action"
                                  disabled={pending !== undefined}
                                  onClick={event => requestAction(selected, action, event.currentTarget)}>
                                  <Icon size={15} aria-hidden="true" />{actionLabels[action]}
                                </button>
                              )
                            })}
                          </div>
                        )}
                      </div>
                      {excluded && <p className="system-caption service-excluded" role="status">此服务已移出当前筛选结果。</p>}
                    </div>
                  {logsAvailable && (
                    <div role="tabpanel" id={logsPanelId} aria-labelledby={logsTabId} className="service-logs-panel" hidden={activeTab !== 'logs'}>
                      <div className="service-logs-toolbar">
                        <span className="system-caption">最近 {LOG_LINES} 行</span>
                        <button type="button" className="app-control" disabled={logsLoading}
                          onClick={() => { if (selected) void loadLogs(selected.name, true) }}>
                          <RefreshCw size={15} aria-hidden="true" />刷新
                        </button>
                      </div>
                      {logsError && <p className="service-alert" role="alert">{logsError}</p>}
                      {logsLoading && logs.length === 0 && <p className="system-caption" role="status">正在读取日志…</p>}
                      {!logsLoading && !logsError && logs.length === 0 && <p className="system-caption">暂无日志。</p>}
                      {logs.length > 0 && <pre className="service-logs" aria-label={`${selected.name} 的日志`}>{logs.join('\n')}</pre>}
                    </div>
                  )}
                </>
              ) : (
                <p className="system-caption">选择服务以查看详情</p>
              )}
            </section>
          </div>
        )}
      </div>
      <dialog ref={dialog} className="service-dialog" aria-labelledby={titleId} aria-describedby={descriptionId}
        onKeyDown={event => {
          if (event.key !== 'Tab') return
          const [first, last] = [cancelButton.current, confirmButton.current]
          if (event.shiftKey ? document.activeElement === first : document.activeElement === last) {
            event.preventDefault()
            const next = event.shiftKey ? last : first
            next?.focus()
          }
        }}
        onCancel={event => {
          event.preventDefault()
          closeConfirmation(false)
        }}>
        <div className="service-dialog-body">
          <h2 id={titleId}>{confirmation === 'restart' ? '重启服务？' : '停止服务？'}</h2>
          <div id={descriptionId}>
            <p className="service-target">{selected?.name}</p>
            {selected?.description && <p>{selected.description}</p>}
            <p>{confirmation === 'restart' ? '重启会短暂中断依赖它的功能。' : '停止后依赖它的功能可能中断。'}</p>
          </div>
        </div>
        <div className="service-dialog-actions">
          <button ref={cancelButton} className="app-control" onClick={() => closeConfirmation(false)}>取消</button>
          <button ref={confirmButton} className="app-control danger-control" onClick={() => closeConfirmation(true)}>
            {confirmation === 'restart' ? '重启服务' : '停止服务'}
          </button>
        </div>
      </dialog>
    </div>
  )
}
