const prefix = '/api/v1/services'

export type ServiceState = 'running' | 'completed' | 'stopped' | 'failed' | 'unknown'
export type ServiceBootState = 'enabled' | 'disabled' | 'static' | 'masked' | 'runtime' | 'not_applicable'
export type ServiceAction = 'start' | 'stop' | 'restart' | 'enable' | 'disable'

export type ServiceCapabilities = {
  start: boolean
  stop: boolean
  restart: boolean
  enable: boolean
  disable: boolean
  logs: boolean
  stateReliable: boolean
}

export type ManagedService = {
  name: string
  description: string
  state: ServiceState
  stateDetail: string
  bootState: ServiceBootState
  actions: ServiceAction[]
}

export type ServicesSnapshot = {
  backend: string
  capabilities: ServiceCapabilities
  services: ManagedService[]
}

export type ServiceDetail = {
  name: string
  state: ServiceState
  stateDetail: string
  bootState: ServiceBootState
  mainPid: number | null
  memoryBytes: number | null
  cpuUsageNs: number | null
  activeEnterTimestamp: string
  fragmentPath: string
}

export class ServiceError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'ServiceError'
    this.code = code
    this.status = status
  }
}

function responseError(data: { code?: string; message?: string } | undefined, status: number) {
  return new ServiceError(data?.code ?? 'request_failed',
    status === 401 ? '登录已过期，请重新登录' : data?.message ?? `服务请求失败（${status}）`, status)
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(prefix + path, init)
  if (response.status === 204) return undefined as T
  const data = await response.json().catch(() => undefined)
  if (!response.ok) throw responseError(data, response.status)
  return data as T
}

export const servicesApi = {
  list(signal?: AbortSignal) {
    return request<ServicesSnapshot>('', { signal })
  },
  detail(unit: string, signal?: AbortSignal) {
    return request<ServiceDetail>(`/${encodeURIComponent(unit)}`, { signal })
  },
  action(unit: string, action: ServiceAction) {
    return request<void>(`/${encodeURIComponent(unit)}/${action}`, { method: 'POST' })
  },
  async logs(unit: string, lines: number, signal?: AbortSignal) {
    const query = new URLSearchParams({ lines: String(lines) })
    const data = await request<{ lines: string[] }>(`/${encodeURIComponent(unit)}/logs?${query}`, { signal })
    return data.lines
  },
}
