export type CPUStat = {
  percent: number
  perCore: number[]
}

export type LoadStat = {
  load1: number
  load5: number
  load15: number
  logicalCores: number
}

export type MemoryStat = {
  total: number
  used: number
  percent: number
}

export type SwapStat = {
  totalBytes: number
  usedBytes: number
  usedPercent: number
  configured: boolean
  swapInPerSec: number
  swapOutPerSec: number
}

export type DiskStat = {
  mountpoint: string
  total: number
  used: number
  percent: number
}

export type DiskIODevice = {
  name: string
  readBytesPerSec: number
  writeBytesPerSec: number
}

export type DiskIOStat = {
  readBytesPerSec: number
  writeBytesPerSec: number
  devices: DiskIODevice[]
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
  load?: LoadStat | null
  memory: MemoryStat | null
  swap?: SwapStat | null
  disks: DiskStat[]
  diskIO?: DiskIOStat | null
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

export type ProcessSort = 'cpu' | 'memory' | 'pid' | 'name'
export type SortOrder = 'asc' | 'desc'
export type ProcessSignal = 'SIGTERM' | 'SIGKILL'

export type ProcessInfo = {
  pid: number
  ppid: number
  startTicks: number
  name: string
  state: string
  user: string
  cpuPercent: number
  rssBytes: number
}

export type ProcessList = {
  collectedAt: string
  selfPid: number
  protectedPids: number[]
  total: number
  processes: ProcessInfo[]
}

export type ProcessDetail = {
  pid: number
  ppid: number
  startTicks: number
  name: string
  state: string
  user: string
  rssBytes: number
  cmdline: string[]
  cwd: string
  startedAt: string
  threads: number
  tree?: ProcessNode | null
  isProtected: boolean
  isSelfOrAncestor: boolean
}

export type ProcessListParams = {
  q?: string
  sort?: ProcessSort
  order?: SortOrder
}

export type ProcessSignalRequest = {
  pid: number
  startTicks: number
  signal: ProcessSignal
}

const numberFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 })
const loadFormat = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function formatPercent(value: number | null | undefined) {
  return value === null || value === undefined || !Number.isFinite(value) ? '—' : `${numberFormat.format(value)}%`
}

export function formatBytes(value: number, suffix = '') {
  if (!Number.isFinite(value) || value < 0) return '—'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  let scaled = value
  let unit = 0
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024
    unit += 1
  }
  return `${numberFormat.format(scaled)} ${units[unit]}${suffix}`
}

export function formatRate(value: number) {
  return formatBytes(value, '/s')
}

export function formatLoad(value: number) {
  return Number.isFinite(value) ? loadFormat.format(value) : '—'
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

function processListQuery(params: ProcessListParams) {
  const query = new URLSearchParams()
  if (params.q && params.q.trim()) query.set('q', params.q.trim())
  if (params.sort) query.set('sort', params.sort)
  if (params.order) query.set('order', params.order)
  const serialized = query.toString()
  return serialized ? `?${serialized}` : ''
}

const portsPath = '/api/v1/system/ports'
const processesPath = '/api/v1/system/processes'

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
  processes: (params: ProcessListParams = {}, signal?: AbortSignal) =>
    request<ProcessList>(`${processesPath}${processListQuery(params)}`, { signal }),
  processDetail: (pid: number, startTicks?: number, signal?: AbortSignal) => {
    const query = startTicks !== undefined ? `?startTicks=${encodeURIComponent(String(startTicks))}` : ''
    return request<ProcessDetail>(`${processesPath}/${encodeURIComponent(String(pid))}${query}`, { signal })
  },
  signalProcess: (payload: ProcessSignalRequest, signal?: AbortSignal) => request<void>(`${processesPath}/signal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  }),
}
