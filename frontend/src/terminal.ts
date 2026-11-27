export type TerminalSession = {
  id: string
  name: string
  createdAt: string
  lastAttachedAt: string | null
  attached: boolean
  controllerClientId: string | null
  scrollbackLines: number
}

export type TerminalSettings = { scrollbackLines: number }

const sessionsPath = '/api/v1/terminal/sessions'
const settingsPath = '/api/v1/settings/terminal'

function sessionPath(id: string) {
  return `${sessionsPath}/${encodeURIComponent(id)}`
}

export class TerminalError extends Error {
  readonly status: number
  readonly code?: string

  constructor(status: number, code?: string, message?: string) {
    super(message || `Terminal request failed (${status})`)
    this.status = status
    this.code = code
  }
}

async function request<T>(path: string, method = 'GET', body?: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  })
  if (!response.ok) {
    const data = await response.json().catch(() => undefined) as { code?: string; message?: string } | undefined
    throw new TerminalError(response.status, data?.code, data?.message)
  }
  return response.status === 204 ? undefined as T : response.json()
}

export const terminalApi = {
  list: (signal?: AbortSignal) => request<TerminalSession[]>(sessionsPath, 'GET', undefined, signal),
  create: (options?: { cwd?: string }) =>
    request<TerminalSession>(sessionsPath, 'POST', options?.cwd ? { cwd: options.cwd } : {}),
  rename: (id: string, name: string) => request<TerminalSession>(sessionPath(id), 'PATCH', { name }),
  end: (id: string) => request<void>(sessionPath(id), 'DELETE'),
  sudoStatus: (signal?: AbortSignal) => request<{ setupCommand?: string }>('/api/v1/terminal/sudo', 'GET', undefined, signal),
  settings: (signal?: AbortSignal) => request<TerminalSettings>(settingsPath, 'GET', undefined, signal),
  saveSettings: (settings: TerminalSettings) => request<TerminalSettings>(settingsPath, 'PUT', settings),
}

export function connectTerminal(id: string, clientId: string) {
  const url = new URL(sessionPath(id) + '/connect', window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('client', clientId)
  const socket = new WebSocket(url)
  socket.binaryType = 'arraybuffer'
  return socket
}

export function terminalWindowId(id: string) {
  return `terminal-${id}`
}

export function terminalClientId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), octet => octet.toString(16).padStart(2, '0')).join('')
}
