export type CPUStat = {
  percent: number
  perCore: number[]
}

export type MemoryStat = {
  total: number
  used: number
  percent: number
}

export type DiskStat = {
  mountpoint: string
  total: number
  used: number
  percent: number
}

export type NetworkStat = {
  name: string
  mac: string
  ipv4: string[]
  ipv6: string[]
  rxRate: number
  txRate: number
}

export type NetworkSeries = {
  name: string
  rx: number[]
  tx: number[]
}

export type Metrics = {
  sampledAt: string
  platform: string
  cpu: CPUStat | null
  memory: MemoryStat | null
  disks: DiskStat[]
  network: NetworkStat[]
  series: {
    cpu: number[]
    memory: number[]
    network: NetworkSeries[]
  }
}

export type Port = {
  protocol: 'tcp' | 'udp'
  address: string
  port: number
  pid?: number
  process?: string
}

export class MonitorError extends Error {
  status: number

  constructor(status: number) {
    super(`Monitor request failed (${status})`)
    this.name = 'MonitorError'
    this.status = status
  }
}

async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    headers: { Accept: 'application/json' },
    signal,
  })
  if (!response.ok) throw new MonitorError(response.status)
  return response.json()
}

export const monitorApi = {
  metrics: (signal?: AbortSignal) => request<Metrics>('/api/v1/system/metrics', signal),
  ports: (signal?: AbortSignal) => request<Port[]>('/api/v1/system/ports', signal),
}
