import {
  useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent,
} from 'react'
import { ArrowLeft, ArrowUpDown, Check, CircleHelp, RefreshCw, Search } from 'lucide-react'
import { useSplitLayout } from './useSplitLayout'
import { ServiceList } from './ServiceList'
import { ServiceDetailPane } from './ServiceDetail'
import { ServiceLogs } from './ServiceLogs'
import {
  ServiceError, servicesApi,
  type ManagedService, type ServiceAction,
  type ServicesSnapshot, type ServiceState,
} from './services'
import { confirmationLabels, confirmationTitles, confirmationWarnings, formatClock } from './serviceLabels'
import './styles/services.css'

const SPLITTER_WIDTH = 6
const MIN_LIST_WIDTH = 320
const MIN_DETAIL_WIDTH = 420
const SPLIT_MIN_WIDTH = MIN_LIST_WIDTH + MIN_DETAIL_WIDTH + SPLITTER_WIDTH
const SPLIT_STEP = 24
const DEFAULT_SHARE = 0.4
const POLL_INTERVAL = 10_000
const SEARCH_DEBOUNCE = 100

type ServiceFilter = 'all' | 'running' | 'inactive' | 'abnormal'
type DetailTab = 'detail' | 'logs'
type ConfirmAction = 'stop' | 'restart' | 'disable'

const filterOrder: ServiceFilter[] = ['all', 'running', 'inactive', 'abnormal']
const filterLabels: Record<ServiceFilter, string> = {
  all: '全部',
  running: '运行中',
  inactive: '未运行',
  abnormal: '异常',
}

function matchesFilter(state: ServiceState, filter: ServiceFilter) {
  switch (filter) {
    case 'running': return state === 'running'
    case 'inactive': return state === 'stopped' || state === 'completed'
    case 'abnormal': return state === 'failed' || state === 'unknown'
    default: return true
  }
}

function isAnomaly(service: ManagedService) {
  return service.state === 'failed' || service.state === 'unknown'
}

function backendName(backend?: string) {
  switch (backend) {
    case 'systemd': return 'systemd'
    case 'openrc': return 'OpenRC'
    case 'busybox': return 'BusyBox'
    case 'none': return '未检测到服务后端'
    default: return backend || '—'
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

function isConfirmAction(action: ServiceAction): action is ConfirmAction {
  return action === 'stop' || action === 'restart' || action === 'disable'
}

function SortMenu({ anomaliesFirst, onChange }: {
  anomaliesFirst: boolean
  onChange: (value: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const container = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function dismiss(event: PointerEvent) {
      if (event.target instanceof Node && container.current?.contains(event.target)) return
      setOpen(false)
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  return (
    <div className="service-sort" ref={container}>
      <button type="button" className="app-control services-icon-button"
        aria-haspopup="menu" aria-expanded={open} aria-label="排序" title="排序"
        onClick={() => setOpen(value => !value)}>
        <ArrowUpDown size={15} aria-hidden="true" />
      </button>
      {open && (
        <div className="service-sort-menu" role="menu" aria-label="排序">
          <button type="button" role="menuitemcheckbox" aria-checked={anomaliesFirst}
            onClick={() => { onChange(!anomaliesFirst); setOpen(false) }}>
            <span className="service-menu-check" aria-hidden="true">
              {anomaliesFirst && <Check size={14} />}
            </span>
            异常置顶
          </button>
          <p className="system-caption service-sort-hint">其余按名称升序</p>
        </div>
      )}
    </div>
  )
}

export function Services({ active = true }: { active?: boolean }) {
  const [snapshot, setSnapshot] = useState<ServicesSnapshot>()
  const [listError, setListError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<Date>()
  const [query, setQuery] = useState('')
  const [needle, setNeedle] = useState('')
  const [filter, setFilter] = useState<ServiceFilter>('all')
  const [anomaliesFirst, setAnomaliesFirst] = useState(false)
  const [selectedName, setSelectedName] = useState<string>()
  const [showDetail, setShowDetail] = useState(false)
  const [tab, setTab] = useState<DetailTab>('detail')
  const [pending, setPending] = useState<{ unit: string; action: ServiceAction }>()
  const [actionError, setActionError] = useState<{ unit: string; message: string }>()
  const [confirmation, setConfirmation] = useState<ConfirmAction>()
  const [logsVersion, setLogsVersion] = useState(0)
  const [listVersion, setListVersion] = useState(0)
  const [listShare, setListShare] = useState(DEFAULT_SHARE)
  const [resizing, setResizing] = useState(false)

  const dialog = useRef<HTMLDialogElement>(null)
  const cancelButton = useRef<HTMLButtonElement>(null)
  const confirmButton = useRef<HTMLButtonElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const back = useRef<HTMLButtonElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const panes = useRef<HTMLDivElement>(null)
  const detailPane = useRef<HTMLElement>(null)
  const dragState = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null)
  const listScrollTop = useRef(0)
  const nextFocus = useRef<'detail' | 'list' | null>(null)
  const titleId = useId()
  const descriptionId = useId()

  useEffect(() => {
    const timer = window.setTimeout(() => setNeedle(query), SEARCH_DEBOUNCE)
    return () => window.clearTimeout(timer)
  }, [query])

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await servicesApi.list(signal)
      if (signal?.aborted) return
      setSnapshot(next)
      setListError('')
      setLastUpdated(new Date())
      setListVersion(value => value + 1)
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
      if (document.visibilityState === 'visible') timer = window.setTimeout(tick, POLL_INTERVAL)
    }

    async function tick() {
      await load(controller.signal)
      if (stopped || controller.signal.aborted) return
      schedule()
    }

    function onVisibility() {
      window.clearTimeout(timer)
      if (document.visibilityState === 'visible') void tick()
    }

    function onFocus() {
      if (document.visibilityState !== 'visible') return
      window.clearTimeout(timer)
      void tick()
    }

    void tick()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onFocus)
    return () => {
      stopped = true
      controller.abort()
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onFocus)
    }
  }, [active, load])

  const services = useMemo(() => snapshot?.services ?? [], [snapshot])
  const searchMatched = useMemo(() => {
    const value = needle.trim().toLowerCase()
    if (!value) return services
    return services.filter(service =>
      service.name.toLowerCase().includes(value) ||
      service.description.toLowerCase().includes(value))
  }, [services, needle])
  const counts = useMemo(() => ({
    all: searchMatched.length,
    running: searchMatched.filter(service => matchesFilter(service.state, 'running')).length,
    inactive: searchMatched.filter(service => matchesFilter(service.state, 'inactive')).length,
    abnormal: searchMatched.filter(service => matchesFilter(service.state, 'abnormal')).length,
  }), [searchMatched])
  const visible = useMemo(() => {
    const filtered = searchMatched.filter(service => matchesFilter(service.state, filter))
    return filtered.sort((left, right) => {
      if (anomaliesFirst) {
        const leftRank = isAnomaly(left) ? 0 : 1
        const rightRank = isAnomaly(right) ? 0 : 1
        if (leftRank !== rightRank) return leftRank - rightRank
      }
      return left.name.localeCompare(right.name)
    })
  }, [searchMatched, filter, anomaliesFirst])

  const selected = services.find(service => service.name === selectedName)
  const logsAvailable = snapshot?.capabilities.logs === true
  const activeTab: DetailTab = logsAvailable ? tab : 'detail'
  const excluded = selected !== undefined && !visible.includes(selected)
  const selectedPending = pending?.unit === selected?.name ? pending : undefined
  const selectedActionError = actionError && actionError.unit === selected?.name ? actionError.message : ''

  const { root, split } = useSplitLayout(SPLIT_MIN_WIDTH, wide => {
    const activeElement = document.activeElement
    if (wide) {
      if (activeElement === back.current) nextFocus.current = 'detail'
    } else if (list.current?.contains(activeElement)) {
      setShowDetail(false)
    } else if (selected && (detailPane.current?.contains(activeElement) || dialog.current?.open)) {
      setShowDetail(true)
    }
  })

  const listVisible = split || !showDetail
  const detailVisible = split || showDetail

  useLayoutEffect(() => {
    if (listVisible && list.current) list.current.scrollTop = listScrollTop.current
  }, [listVisible])

  useLayoutEffect(() => {
    if (nextFocus.current === 'detail') heading.current?.focus()
    if (nextFocus.current === 'list') {
      const row = list.current?.querySelector<HTMLButtonElement>('.service-row[aria-current="true"]')
      ;(row ?? searchInput.current)?.focus()
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
    setLogsVersion(value => value + 1)
    setRefreshing(false)
  }

  async function runAction(service: ManagedService, action: ServiceAction) {
    setPending({ unit: service.name, action })
    setActionError(undefined)
    try {
      await servicesApi.action(service.name, action)
      await load()
      setLogsVersion(value => value + 1)
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

  function requestAction(action: ServiceAction) {
    if (!selected) return
    if (isConfirmAction(action)) {
      setConfirmation(action)
      return
    }
    heading.current?.focus()
    void runAction(selected, action)
  }

  function closeConfirmation(confirmed: boolean) {
    const action = confirmation
    dialog.current?.close()
    setConfirmation(undefined)
    if (confirmed && selected && action) {
      heading.current?.focus()
      void runAction(selected, action)
    }
  }

  function selectService(name: string) {
    setActionError(undefined)
    setSelectedName(name)
  }

  function openService(name: string) {
    setActionError(undefined)
    if (!split) {
      listScrollTop.current = list.current?.scrollTop ?? 0
      nextFocus.current = 'detail'
    }
    setSelectedName(name)
    setShowDetail(true)
  }

  function backToList() {
    nextFocus.current = 'list'
    setShowDetail(false)
  }

  function clearFilters() {
    setQuery('')
    setNeedle('')
    setFilter('all')
  }

  function resizeTo(width: number) {
    const container = panes.current
    if (!container) return
    const available = container.getBoundingClientRect().width - SPLITTER_WIDTH
    if (available <= 0) return
    const maximum = Math.max(MIN_LIST_WIDTH, available - MIN_DETAIL_WIDTH)
    const next = Math.min(Math.max(width, MIN_LIST_WIDTH), maximum)
    setListShare(next / available)
  }

  function beginResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    const width = list.current?.getBoundingClientRect().width
    if (!width) return
    dragState.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.currentTarget.focus()
    setResizing(true)
    event.preventDefault()
  }

  function moveResize(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragState.current
    if (!drag || drag.pointerId !== event.pointerId) return
    resizeTo(drag.startWidth + event.clientX - drag.startX)
  }

  function endResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragState.current?.pointerId !== event.pointerId) return
    dragState.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setResizing(false)
  }

  function resizeKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const container = panes.current
    const width = list.current?.getBoundingClientRect().width
    if (!container || width === undefined) return
    const available = container.getBoundingClientRect().width - SPLITTER_WIDTH
    const maximum = Math.max(MIN_LIST_WIDTH, available - MIN_DETAIL_WIDTH)
    let next: number
    switch (event.key) {
      case 'ArrowLeft': next = width - SPLIT_STEP; break
      case 'ArrowRight': next = width + SPLIT_STEP; break
      case 'Home': next = MIN_LIST_WIDTH; break
      case 'End': next = maximum; break
      case 'Enter':
        event.preventDefault()
        setListShare(DEFAULT_SHARE)
        return
      default: return
    }
    event.preventDefault()
    resizeTo(next)
  }

  const filtersActive = needle.trim() !== '' || filter !== 'all'
  const confirmClass = confirmation === 'stop' || confirmation === 'restart'
    ? 'app-control danger-control'
    : 'app-control primary-control'

  return (
    <div className="services-page" ref={root} data-split={split}
      data-resizing={resizing ? 'true' : undefined}>
      <div className="services-body">
        {snapshot && !snapshot.capabilities.stateReliable && (
          <p className="system-caption services-warning" role="status">该后端无法可靠判断服务状态。</p>
        )}
        {snapshot?.backend === 'none' ? (
          <div className="services-empty-state">
            <CircleHelp size={32} aria-hidden="true" />
            <p className="system-subtitle">未检测到受支持的初始化系统</p>
            <p className="system-caption">
              需要 systemd、OpenRC 或 BusyBox init。可以用 <code>-service-backend</code> 指定后端。
            </p>
          </div>
        ) : (
          <div ref={panes} className="services-panes"
            style={split ? {
              gridTemplateColumns: `minmax(${MIN_LIST_WIDTH}px, ${listShare}fr) ${SPLITTER_WIDTH}px minmax(${MIN_DETAIL_WIDTH}px, ${1 - listShare}fr)`,
            } : undefined}>
            <div className="services-list-pane" hidden={!listVisible}>
              <div className="services-toolbar">
                <div className="services-toolbar-row">
                  <label className="services-search">
                    <Search size={14} aria-hidden="true" />
                    <input ref={searchInput} type="search" value={query}
                      onChange={event => setQuery(event.target.value)}
                      placeholder="搜索服务名或描述" aria-label="搜索服务" />
                  </label>
                  <SortMenu anomaliesFirst={anomaliesFirst} onChange={setAnomaliesFirst} />
                  <button type="button" className="app-control services-icon-button"
                    onClick={() => { void refreshNow() }} disabled={refreshing}
                    aria-label="刷新服务列表" title="刷新">
                    <RefreshCw size={15} aria-hidden="true" />
                  </button>
                </div>
                <div className="services-toolbar-row">
                  <div className="service-chips" role="group" aria-label="状态筛选">
                    {filterOrder.map(value => (
                      <button key={value} type="button" className="service-chip"
                        aria-pressed={filter === value} onClick={() => setFilter(value)}>
                        {filterLabels[value]}
                        <span className="service-chip-count">{counts[value]}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <ServiceList
                services={visible}
                selectedName={selectedName}
                needle={needle}
                listRef={list}
                onSelect={selectService}
                onOpen={openService}
                onScroll={top => { listScrollTop.current = top }}
                loading={!snapshot && !listError}
                error={listError}
                emptyMessage={filtersActive ? '没有符合当前筛选的服务' : '没有可管理的服务'}
                onClearFilters={filtersActive ? clearFilters : undefined} />
            </div>
            {split && (
              <div className="services-splitter" role="separator" aria-orientation="vertical"
                aria-label="调整服务列表宽度" aria-valuemin={0} aria-valuemax={100}
                aria-valuenow={Math.round(listShare * 100)}
                aria-valuetext={`列表宽度 ${Math.round(listShare * 100)}%`}
                tabIndex={0} title="拖动调整宽度；双击或按 Enter 恢复默认"
                onPointerDown={beginResize} onPointerMove={moveResize}
                onPointerUp={endResize} onPointerCancel={endResize}
                onDoubleClick={() => setListShare(DEFAULT_SHARE)} onKeyDown={resizeKeyDown} />
            )}
            <section ref={detailPane} className="service-detail" aria-label="服务详情"
              hidden={!split && !showDetail}>
              {!split && (
                <div className="service-detail-backrow">
                  <button ref={back} type="button" className="app-control service-back" onClick={backToList}>
                    <ArrowLeft size={16} aria-hidden="true" />返回列表
                  </button>
                </div>
              )}
              {selected ? (
                detailVisible ? (
                  <ServiceDetailPane
                    key={selected.name}
                    service={selected}
                    refreshToken={listVersion}
                    pendingAction={selectedPending?.action}
                    actionError={selectedActionError}
                    excluded={excluded}
                    logsAvailable={logsAvailable}
                    tab={activeTab}
                    onTabChange={setTab}
                    onAction={requestAction}
                    logsPanel={logsAvailable
                      ? <ServiceLogs key={selected.name} unit={selected.name}
                          active={activeTab === 'logs'} version={logsVersion} />
                      : undefined}
                    headingRef={heading} />
                ) : null
              ) : (
                <div className="service-detail-body">
                  <p className="system-caption">选择服务以查看详情</p>
                </div>
              )}
            </section>
          </div>
        )}
      </div>
      <footer className="app-statusbar services-statusbar">
        <span>{backendName(snapshot?.backend)}</span>
        <span aria-live="polite">
          {lastUpdated ? `更新于 ${formatClock(lastUpdated)}` : refreshing ? '正在刷新…' : '等待首次刷新'}
        </span>
      </footer>
      <dialog ref={dialog} className="service-dialog" aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={event => {
          if (event.key !== 'Tab') return
          const [first, last] = [cancelButton.current, confirmButton.current]
          if (event.shiftKey ? document.activeElement === first : document.activeElement === last) {
            event.preventDefault()
            const nextTarget = event.shiftKey ? last : first
            nextTarget?.focus()
          }
        }}
        onCancel={event => {
          event.preventDefault()
          closeConfirmation(false)
        }}>
        <div className="service-dialog-body">
          <h2 id={titleId}>{confirmation ? confirmationTitles[confirmation] : ''}</h2>
          <div id={descriptionId}>
            <p className="service-target">{selected?.name}</p>
            {selected?.description && <p>{selected.description}</p>}
            <p>{confirmation ? confirmationWarnings[confirmation] : ''}</p>
          </div>
        </div>
        <div className="service-dialog-actions">
          <button ref={cancelButton} type="button" className="app-control"
            onClick={() => closeConfirmation(false)}>取消</button>
          <button ref={confirmButton} type="button" className={confirmClass}
            onClick={() => closeConfirmation(true)}>
            {confirmation ? confirmationLabels[confirmation] : '确认'}
          </button>
        </div>
      </dialog>
    </div>
  )
}
