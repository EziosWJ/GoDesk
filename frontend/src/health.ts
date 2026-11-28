export type HealthStatus = 'healthy' | 'warning' | 'critical' | 'unknown'

export type HealthCategory = 'cpu' | 'load' | 'memory' | 'swap' | 'storage' | 'network' | 'temperature'

export type HealthThresholds = {
  warning: number | null
  critical: number | null
}

export type CPUHealthDetails = {
  logicalCores?: number
}

export type LoadHealthDetails = {
  load1?: number
  load5?: number
  load15?: number
  logicalCores?: number
  load5PerCore?: number
}

export type MemoryHealthDetails = {
  totalBytes?: number
  usedBytes?: number
  availableBytes?: number
  availablePercent?: number
}

export type SwapHealthDetails = {
  totalBytes?: number
  usedBytes?: number
  usedPercent?: number
  swapInPerSec?: number
  swapOutPerSec?: number
}

export type NetworkHealthDetails = {
  interface?: string
  linkUp?: boolean
  isDefaultRoute?: boolean
  ipv4?: string[]
  ipv6?: string[]
  rxBytesPerSecond?: number
  txBytesPerSecond?: number
}

export type TemperatureHealthDetails = {
  sensor?: string
  chip?: string
  celsius?: number
  warning?: number | null
  critical?: number | null
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
  details: Record<string, unknown> | null
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
