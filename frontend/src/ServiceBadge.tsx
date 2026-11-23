import type { ServiceState } from './services'
import { statusLabels } from './serviceLabels'

export function ServiceBadge({ state }: { state: ServiceState }) {
  const { label, Icon } = statusLabels[state]
  return (
    <span className="service-badge" data-status={state}>
      <Icon size={14} aria-hidden="true" />
      {label}
    </span>
  )
}
