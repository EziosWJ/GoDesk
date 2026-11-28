const hostPath = '/api/v1/system/host'
const timezonesPath = '/api/v1/system/timezones'

export type HostCapabilities = {
  setHostname: boolean
  setTimezone: boolean
  hostnameReason: string
  timezoneReason: string
}

export type HostInfo = {
  hostname: string
  timezone: string
  os: string
  kernel: string
  arch: string
  cpuModel: string
  logicalCores: number
  memoryTotalBytes: number
  uptimeSeconds: number
  version: string
  commit: string
  buildDate: string
  user: string
  isRoot: boolean
  capabilities: HostCapabilities
}

export class HostError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'HostError'
    this.status = status
    this.code = code
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    cache: 'no-store',
    ...init,
    headers: { Accept: 'application/json', ...init?.headers },
  })
  const data = await response.json().catch(() => undefined) as { code?: string; message?: string } | undefined
  if (!response.ok) {
    const code = data?.code ?? 'request_failed'
    const message = response.status === 401
      ? '登录已过期，请重新登录'
      : data?.message ?? `请求失败（${response.status}）`
    throw new HostError(response.status, code, message)
  }
  return data as T
}

export const hostApi = {
  info(signal?: AbortSignal) {
    return request<HostInfo>(hostPath, { signal })
  },
  async timezones(signal?: AbortSignal) {
    const data = await request<{ timezones: string[] }>(timezonesPath, { signal })
    return Array.isArray(data.timezones) ? data.timezones : []
  },
  setHostname(hostname: string, signal?: AbortSignal) {
    return request<{ hostname: string }>(`${hostPath}/hostname`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostname }),
      signal,
    })
  },
  setTimezone(timezone: string, signal?: AbortSignal) {
    return request<{ timezone: string }>(`${hostPath}/timezone`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timezone }),
      signal,
    })
  },
}

export function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  const total = Math.floor(seconds)
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (days > 0) return `${days} 天 ${hours} 小时 ${minutes} 分钟`
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`
  if (minutes > 0) return `${minutes} 分钟`
  return `${total} 秒`
}

export function formatCpuSummary(cpuModel: string, logicalCores: number): string {
  const model = cpuModel.trim()
  const hasCores = Number.isFinite(logicalCores) && logicalCores > 0
  if (model && hasCores) return `${model}（${logicalCores} 核）`
  if (model) return model
  if (hasCores) return `${logicalCores} 核`
  return '—'
}

export function formatBuildMeta(commit: string, buildDate: string): string {
  const parts: string[] = []
  const trimmedCommit = commit.trim()
  if (trimmedCommit) parts.push(trimmedCommit.slice(0, 7))
  const trimmedDate = buildDate.trim()
  if (trimmedDate) parts.push(trimmedDate)
  return parts.join(' · ')
}

export function capabilityReasonMessage(kind: 'hostname' | 'timezone', reason: string): string {
  if (kind === 'hostname') {
    if (reason === 'systemd_unavailable') {
      return '当前环境未运行 systemd（如 WSL / 容器），主机名仅支持只读查看'
    }
    if (reason === 'unsupported') {
      return '当前主机未安装 hostnamectl，主机名仅支持只读查看'
    }
    return '当前环境不支持修改主机名，仅支持只读查看'
  }
  if (reason === 'systemd_unavailable') {
    return '当前环境未运行 systemd（如 WSL / 容器），时区仅支持只读查看'
  }
  if (reason === 'unsupported') {
    return '当前主机未安装 timedatectl，时区仅支持只读查看'
  }
  return '当前环境不支持修改时区，仅支持只读查看'
}

export function hostMutationErrorMessage(kind: 'hostname' | 'timezone', failure: unknown): string {
  if (failure instanceof HostError) {
    if (failure.status === 401) return '登录已过期，请重新登录'
    switch (failure.code) {
      case 'invalid_hostname':
        return '主机名格式无效：仅支持字母、数字、连字符和点，且不能以连字符开头或结尾'
      case 'invalid_timezone':
        return '所选时区无效或主机未安装对应时区数据'
      case 'permission_denied':
        return '权限不足：修改主机配置需要 root 权限或已配置免密 sudo（NOPASSWD）'
      case 'sudo_unavailable':
        return '当前账号权限不足且未检测到可用的 sudo，需要 root 权限或配置免密 sudo 后才能修改'
      case 'unsupported':
        return kind === 'hostname'
          ? '当前环境不支持修改主机名（缺少 hostnamectl 或未运行 systemd）'
          : '当前环境不支持修改时区（缺少 timedatectl 或未运行 systemd）'
      case 'timeout':
        return '操作超时，请确认主机服务响应正常后重试'
      case 'operation_failed':
        return failure.message ? `修改失败：${failure.message}` : '系统命令执行失败，请重试'
      default:
        return failure.message || (kind === 'hostname' ? '无法修改主机名，请重试' : '无法修改时区，请重试')
    }
  }
  return kind === 'hostname' ? '无法修改主机名，请检查连接后重试' : '无法修改时区，请检查连接后重试'
}
