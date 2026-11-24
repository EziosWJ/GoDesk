import type { HealthSnapshot } from './health'
import type { ConnectionState } from './useHostHealth'

export type DisplayStatus = 'healthy' | 'warning' | 'critical' | 'unknown'

export const healthStatusText: Record<DisplayStatus, string> = {
  healthy: '主机正常',
  warning: '需要关注',
  critical: '严重异常',
  unknown: '状态未知',
}

export function normalizeStatus(value: string | null | undefined): DisplayStatus {
  return value === 'healthy' || value === 'warning' || value === 'critical' || value === 'unknown'
    ? value
    : 'unknown'
}

export function effectiveStatus(snapshot: HealthSnapshot | null, connection: ConnectionState): DisplayStatus {
  if (connection === 'disconnected' || !snapshot || snapshot.stale) return 'unknown'
  return normalizeStatus(snapshot.overall)
}
