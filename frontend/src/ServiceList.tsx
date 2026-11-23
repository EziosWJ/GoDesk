import { useRef, type KeyboardEvent, type RefObject } from 'react'
import type { ManagedService } from './services'
import { Highlight } from './Highlight'
import { ServiceBadge } from './ServiceBadge'

type ServiceListProps = {
  services: ManagedService[]
  selectedName?: string
  needle: string
  listRef: RefObject<HTMLDivElement | null>
  onSelect: (name: string) => void
  onOpen: (name: string) => void
  onScroll: (top: number) => void
  loading: boolean
  error: string
  emptyMessage: string
  onClearFilters?: () => void
}

export function ServiceList({
  services, selectedName, needle, listRef, onSelect, onOpen, onScroll,
  loading, error, emptyMessage, onClearFilters,
}: ServiceListProps) {
  const rows = useRef(new Map<string, HTMLButtonElement>())

  function move(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const nextIndex = event.key === 'ArrowDown'
      ? Math.min(index + 1, services.length - 1)
      : Math.max(index - 1, 0)
    if (nextIndex === index) return
    const next = services[nextIndex]
    onSelect(next.name)
    rows.current.get(next.name)?.focus()
  }

  return (
    <div className="services-list" ref={listRef} role="region" aria-label="服务列表"
      onScroll={event => onScroll(event.currentTarget.scrollTop)}>
      {error && <p className="service-alert service-list-error" role="alert">{error}</p>}
      {loading && !error && <p className="services-empty system-caption" role="status">正在读取服务…</p>}
      {!loading && !error && services.length === 0 && (
        <div className="services-empty system-caption">
          <p>{emptyMessage}</p>
          {onClearFilters && (
            <button type="button" className="app-control services-empty-action" onClick={onClearFilters}>
              清除筛选
            </button>
          )}
        </div>
      )}
      {services.length > 0 && (
        <ul className="service-rows">
          {services.map((service, index) => (
            <li key={service.name}>
              <button
                ref={node => {
                  if (node) rows.current.set(service.name, node)
                  else rows.current.delete(service.name)
                }}
                type="button"
                className="service-row"
                data-selected={selectedName === service.name ? 'true' : undefined}
                aria-current={selectedName === service.name ? 'true' : undefined}
                onClick={() => onOpen(service.name)}
                onKeyDown={event => move(event, index)}>
                <span className="service-row-top">
                  <span className="service-row-name"><Highlight text={service.name} needle={needle} /></span>
                  {service.bootState === 'enabled' && (
                    <span className="service-autostart" role="img" aria-label="开机自启" title="开机自启" />
                  )}
                  <ServiceBadge state={service.state} />
                </span>
                <span className="service-row-description">
                  {service.description
                    ? <Highlight text={service.description} needle={needle} />
                    : <span className="service-row-placeholder">—</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
