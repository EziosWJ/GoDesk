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

export type Endpoint = {
  protocol: 'tcp' | 'udp'
  address: string
  port: number
}

export type PortOwner = {
  pid: number
  process: string
  startTicks: number
}

export type Port = Endpoint & {
  owners: PortOwner[]
  unknownOwner?: boolean
}

export type ProcessNode = PortOwner & {
  user: string
  children?: ProcessNode[]
}

export type PortTarget = Endpoint & Pick<PortOwner, 'pid' | 'startTicks'> & { unit?: string }

export type PortDetail = {
  tree: ProcessNode
  unit?: string
  otherPorts?: Endpoint[]
  stopsDesk?: boolean
}

export class MonitorError extends Error {
  status: number
  code?: string

  constructor(status: number, message?: string, code?: string) {
    super(message ?? `Monitor request failed (${status})`)
    this.name = 'MonitorError'
    this.status = status
    this.code = code
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: { Accept: 'application/json', ...options?.headers },
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new MonitorError(response.status, body?.message, body?.code)
  }
  if (response.status === 204) return undefined as T
  return response.json()
}

function portQuery(target: PortTarget) {
  const query = new URLSearchParams({
    protocol: target.protocol,
    address: target.address,
    port: String(target.port),
    pid: String(target.pid),
    startTicks: String(target.startTicks),
  })
  if (target.unit) query.set('unit', target.unit)
  return query
}

const portsPath = '/api/v1/system/ports'

export const monitorApi = {
  metrics: (signal?: AbortSignal) => request<Metrics>('/api/v1/system/metrics', { signal }),
  ports: (signal?: AbortSignal) => request<Port[]>(portsPath, { signal }),
  portDetail: (target: PortTarget, signal?: AbortSignal) =>
    request<PortDetail>(`${portsPath}/detail?${portQuery(target)}`, { signal }),
  portLogs: (target: PortTarget, signal?: AbortSignal) =>
    request<{ lines: string[] }>(`${portsPath}/logs?${portQuery(target)}`, { signal }),
  stopPort: (target: PortTarget, signal?: AbortSignal) => request<void>(`${portsPath}/stop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(target),
    signal,
  }),
}
