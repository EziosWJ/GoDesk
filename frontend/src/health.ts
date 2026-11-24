export type HealthStatus = 'healthy' | 'warning' | 'critical' | 'unknown'

export type HealthThresholds = {
  warning: number | null
  critical: number | null
}

export type HealthCheck = {
  id: string
  category: string
  label: string
  status: string
  applicable: boolean
  reason: string
  message: string
  observedAt: string
  since: string | null
  stale: boolean
  value: number | null
  unit: string | null
  thresholds: HealthThresholds | null
  details: Record<string, unknown>
}

export type HealthSummary = {
  total: number
  healthy: number
  warning: number
  critical: number
  unknown: number
  notApplicable: number
  issueCount: number
}

export type HealthHost = {
  hostname: string
  platform: string
  architecture: string
  uptimeSeconds: number | null
}

export type HealthSnapshot = {
  schemaVersion: number
  generatedAt: string
  stale: boolean
  overall: string
  host: HealthHost
  summary: HealthSummary
  checks: HealthCheck[]
}

export class HealthError extends Error {
  status: number

  constructor(status: number) {
    super(`Health request failed (${status})`)
    this.name = 'HealthError'
    this.status = status
  }
}

async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    headers: { Accept: 'application/json' },
    signal,
  })
  if (!response.ok) throw new HealthError(response.status)
  return response.json()
}

export const healthApi = {
  status: (signal?: AbortSignal) => request<HealthSnapshot>('/api/v1/system/status', signal),
}
