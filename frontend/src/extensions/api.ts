export type ExtensionStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed'

export type ExtensionConfigField = {
  type: 'string' | 'number' | 'boolean'
  required?: boolean
  secret?: boolean
  default?: unknown
}

export type ExtensionPlugin = {
  id: string
  name: string
  version: string
  enabled: boolean
  status: ExtensionStatus
  error?: string
  hasWeb: boolean
  hasLua: boolean
  webPath?: string
  apiPath?: string
  eventsPath?: string
  config: Record<string, unknown>
  configSchema?: Record<string, ExtensionConfigField>
  installedAt: string
  startedAt?: string
  logPath: string
}

export class ExtensionError extends Error {
  readonly status: number
  readonly code?: string
  readonly pluginId?: string

  constructor(status: number, message: string, code?: string, pluginId?: string) {
    super(message)
    this.name = 'ExtensionError'
    this.status = status
    this.code = code
    this.pluginId = pluginId
  }
}

export function extensionErrorMessage(error: unknown, fallback = '操作失败'): string {
  if (error instanceof ExtensionError) {
    const detail = error.message.trim()
    switch (error.code) {
      case 'already_installed':
        return '该扩展已安装，请使用升级功能替换'
      case 'id_mismatch':
        return '所选 ZIP 包的插件 ID 与当前扩展不匹配，请确认选择了正确的插件包'
      case 'invalid_package':
        return detail ? `无效的插件包：${detail}` : '无效的插件包，请检查 ZIP 结构和 manifest.json'
      case 'incompatible_package':
        return detail ? `插件包与当前宿主不兼容：${detail}` : '插件包与当前宿主版本不兼容'
      case 'not_found':
        return '未找到该扩展，可能已被卸载'
      case 'invalid_lines':
        return '日志行数参数无效'
      case 'log_read_failed':
        return detail ? `读取插件日志失败：${detail}` : '读取插件日志失败'
      default:
        return detail || fallback
    }
  }
  return error instanceof Error && error.message ? error.message : fallback
}

const base = '/api/v1/extensions'

export function extensionWebPath(id: string): string {
  return `/extensions/${encodeURIComponent(id)}/web/`
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(path, init)
  if (!response.ok) {
    let message = response.statusText || `请求失败 (${response.status})`
    let code: string | undefined
    let pluginId: string | undefined
    try {
      const payload = await response.json() as {
        error?: unknown
        message?: unknown
        code?: unknown
        pluginId?: unknown
      }
      if (typeof payload.message === 'string' && payload.message) message = payload.message
      else if (typeof payload.error === 'string' && payload.error) message = payload.error
      if (typeof payload.code === 'string' && payload.code) code = payload.code
      if (typeof payload.pluginId === 'string' && payload.pluginId) pluginId = payload.pluginId
    } catch {
      // Keep the status text when the host did not return JSON.
    }
    throw new ExtensionError(response.status, message, code, pluginId)
  }
  return response
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  return request(path, init).then(response => response.json() as Promise<T>)
}

function pluginPath(id: string, action?: string): string {
  const path = `${base}/${encodeURIComponent(id)}`
  return action ? `${path}/${action}` : path
}

function action(id: string, name: string): Promise<ExtensionPlugin> {
  return json<ExtensionPlugin>(pluginPath(id, name), { method: 'POST' })
}

export const extensionsApi = {
  async list(signal?: AbortSignal): Promise<ExtensionPlugin[]> {
    const payload = await json<{ plugins: ExtensionPlugin[] }>(base, { signal })
    return payload.plugins ?? []
  },
  install(file: File): Promise<ExtensionPlugin> {
    return json<ExtensionPlugin>(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: file,
    })
  },
  upgrade(id: string, file: File): Promise<ExtensionPlugin> {
    return json<ExtensionPlugin>(pluginPath(id, 'upgrade'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: file,
    })
  },
  async logs(id: string, lines = 200, signal?: AbortSignal): Promise<string[]> {
    const payload = await json<{ lines?: string[] }>(`${pluginPath(id, 'logs')}?lines=${lines}`, { signal })
    return payload.lines ?? []
  },
  enable(id: string): Promise<ExtensionPlugin> {
    return action(id, 'enable')
  },
  start(id: string): Promise<ExtensionPlugin> {
    return action(id, 'start')
  },
  stop(id: string): Promise<ExtensionPlugin> {
    return action(id, 'stop')
  },
  disable(id: string): Promise<ExtensionPlugin> {
    return action(id, 'disable')
  },
  uninstall(id: string, purge: boolean): Promise<void> {
    return request(`${pluginPath(id)}?purge=${purge}`, { method: 'DELETE' }).then(() => undefined)
  },
  updateConfig(id: string, config: Record<string, unknown>): Promise<ExtensionPlugin> {
    return json<ExtensionPlugin>(pluginPath(id, 'config'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    })
  },
}
