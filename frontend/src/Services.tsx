import { useId, useLayoutEffect, useRef, useState } from 'react'
import { ArrowLeft, CircleCheck, CircleHelp, CircleMinus, CircleX } from 'lucide-react'
import { useSplitLayout } from './useSplitLayout'

const statuses = {
  running: { label: '运行中', Icon: CircleCheck },
  stopped: { label: '已停止', Icon: CircleMinus },
  failed: { label: '失败', Icon: CircleX },
  unknown: { label: '未知', Icon: CircleHelp },
}

type Service = { name: string; status: keyof typeof statuses; impact?: string }
const initialServices: Service[] = [
  { name: 'NetworkManager.service', status: 'running', impact: '网络连接可能会中断。' },
  { name: 'systemd-journald.service', status: 'running', impact: '系统日志将暂停收集。' },
  { name: 'cron.service', status: 'running', impact: '计划任务将暂停，直到服务重新启动。' },
  { name: 'sshd.service', status: 'stopped' },
  { name: 'cups.service', status: 'failed' },
  { name: 'backup.service', status: 'unknown' },
]

function ServiceStatus({ status }: { status: Service['status'] }) {
  const { Icon, label } = statuses[status]
  return <span className="service-status" data-status={status}><Icon size={16} aria-hidden="true" />{label}</span>
}

export function Services() {
  const [services, setServices] = useState(initialServices)
  const [filter, setFilter] = useState<Service['status'] | 'all'>('all')
  const [selectedName, setSelectedName] = useState<string>()
  const [showDetail, setShowDetail] = useState(false)
  const [pending, setPending] = useState<Service>()
  const dialog = useRef<HTMLDialogElement>(null)
  const cancelButton = useRef<HTMLButtonElement>(null)
  const confirmButton = useRef<HTMLButtonElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const back = useRef<HTMLButtonElement>(null)
  const filterControl = useRef<HTMLSelectElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const detail = useRef<HTMLElement>(null)
  const rowButtons = useRef(new Map<string, HTMLButtonElement>())
  const listScrollTop = useRef(0)
  const nextFocus = useRef<'detail' | 'list' | null>(null)
  const titleId = useId()
  const descriptionId = useId()
  const detailId = useId()
  const selected = services.find(service => service.name === selectedName)
  const visibleServices = services.filter(service => filter === 'all' || service.status === filter)
  const excluded = selected !== undefined && !visibleServices.includes(selected)

  const { root, split } = useSplitLayout(617, wide => {
    const active = document.activeElement
    if (wide) {
      if (active === back.current) nextFocus.current = 'detail'
    } else if (list.current?.contains(active)) {
      setShowDetail(false)
    } else if (selected && (detail.current?.contains(active) || dialog.current?.open)) {
      setShowDetail(true)
    }
  })

  const listVisible = split || !showDetail

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
    if (pending && !dialog.current?.open) {
      dialog.current?.showModal()
      cancelButton.current?.focus()
    }
  }, [pending])

  function close(confirmed: boolean) {
    if (confirmed && pending) {
      setServices(current => current.map(service => service === pending ? { ...service, status: 'stopped' } : service))
    }
    dialog.current?.close()
    if (confirmed) heading.current?.focus()
    else trigger.current?.focus()
    setPending(undefined)
  }

  return (
    <div className="services-page system-page" ref={root} data-split={split}>
      <header className="services-toolbar">
        <div>
          <h2 className="system-subtitle">systemd 服务</h2>
          <p className="system-caption">模拟数据</p>
        </div>
        <label className="services-filter">状态
          <select ref={filterControl} value={filter} onChange={event => setFilter(event.target.value as typeof filter)}>
            <option value="all">全部</option>
            {Object.entries(statuses).map(([status, { label }]) => <option key={status} value={status}>{label}</option>)}
          </select>
        </label>
      </header>
      <div className="services-panes">
        <div ref={list} className="services-list system-scroll" role="region" aria-label="服务列表" hidden={!listVisible}
          onScroll={event => { if (listVisible) listScrollTop.current = event.currentTarget.scrollTop }}>
          <table className="data-table services-table" aria-label="systemd 服务">
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
                        if (!split) {
                          listScrollTop.current = list.current?.scrollTop ?? 0
                          nextFocus.current = 'detail'
                        }
                        setSelectedName(service.name)
                        setShowDetail(true)
                      }}>{service.name}</button>
                  </td>
                  <td><ServiceStatus status={service.status} /></td>
                </tr>
              ))}
              {visibleServices.length === 0 && <tr><td colSpan={2} className="services-empty">没有符合当前状态筛选的服务</td></tr>}
            </tbody>
          </table>
        </div>
        <section ref={detail} id={detailId} className="service-detail system-scroll" aria-label="服务详情" hidden={!split && !showDetail}>
          {!split && <button ref={back} className="app-control system-back" onClick={() => {
            nextFocus.current = 'list'
            setShowDetail(false)
          }}><ArrowLeft size={16} aria-hidden="true" />返回列表</button>}
          {selected ? (
            <>
              <h3 ref={heading} tabIndex={-1} className="system-subtitle service-detail-name">{selected.name}</h3>
              <dl className="service-fields">
                <div><dt>当前状态</dt><dd><span role="status"><ServiceStatus status={selected.status} /></span></dd></div>
                {selected.impact && <div><dt>停止影响</dt><dd>{selected.impact}</dd></div>}
              </dl>
              {selected.impact && selected.status === 'running' && (
                <button ref={trigger} className="app-control service-stop" onClick={() => setPending(selected)}>停止服务</button>
              )}
              {excluded && <p className="system-caption service-excluded" role="status">此服务已移出当前筛选结果。</p>}
            </>
          ) : (
            <p className="system-caption">选择服务以查看详情</p>
          )}
        </section>
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
          close(false)
        }}>
        <div className="service-dialog-body">
          <h2 id={titleId}>停止服务？</h2>
          <div id={descriptionId}>
            <p className="service-target">{pending?.name}</p>
            <p>{pending?.impact}此操作只更新演示中的服务状态。</p>
          </div>
        </div>
        <div className="service-dialog-actions">
          <button ref={cancelButton} className="app-control" onClick={() => close(false)}>取消</button>
          <button ref={confirmButton} className="app-control danger-control" onClick={() => close(true)}>停止服务</button>
        </div>
      </dialog>
    </div>
  )
}
