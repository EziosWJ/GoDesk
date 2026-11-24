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

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ExtensionError'
    this.status = status
  }
}

const base = '/api/v1/extensions'

async function request(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(path, init)
  if (!response.ok) {
    let message = response.statusText || `请求失败 (${response.status})`
    try {
      const payload = await response.json() as { error?: unknown }
      if (typeof payload.error === 'string' && payload.error) message = payload.error
    } catch {
      // Keep the status text when the host did not return JSON.
    }
    throw new ExtensionError(response.status, message)
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
