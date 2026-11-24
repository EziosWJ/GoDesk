import { CircleCheck, CircleHelp, OctagonAlert, TriangleAlert } from 'lucide-react'
import type { DisplayStatus } from './healthUi'

export function StatusIcon({ status, size = 18 }: { status: DisplayStatus; size?: number }) {
  const Icon = status === 'healthy' ? CircleCheck
    : status === 'warning' ? TriangleAlert
      : status === 'critical' ? OctagonAlert : CircleHelp
  return <Icon size={size} aria-hidden="true" />
}
