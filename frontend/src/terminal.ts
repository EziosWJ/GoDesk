export type TerminalSession = {
  id: string
  name: string
  createdAt: string
  lastAttachedAt: string | null
  attached: boolean
  scrollbackLines: number
}

export type TerminalSettings = { scrollbackLines: number }

const sessionsPath = '/api/v1/terminal/sessions'
const settingsPath = '/api/v1/settings/terminal'

function sessionPath(id: string) {
  return `${sessionsPath}/${encodeURIComponent(id)}`
}

async function request<T>(path: string, method = 'GET', body?: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  })
  if (!response.ok) throw new Error(`Terminal request failed (${response.status})`)
  return response.status === 204 ? undefined as T : response.json()
}

export const terminalApi = {
  list: (signal?: AbortSignal) => request<TerminalSession[]>(sessionsPath, 'GET', undefined, signal),
  create: () => request<TerminalSession>(sessionsPath, 'POST', {}),
  rename: (id: string, name: string) => request<TerminalSession>(sessionPath(id), 'PATCH', { name }),
  end: (id: string) => request<void>(sessionPath(id), 'DELETE'),
  settings: (signal?: AbortSignal) => request<TerminalSettings>(settingsPath, 'GET', undefined, signal),
  saveSettings: (settings: TerminalSettings) => request<TerminalSettings>(settingsPath, 'PUT', settings),
}

export function connectTerminal(id: string, clientId: string, takeover: boolean) {
  const url = new URL(sessionPath(id) + '/connect', window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('client', clientId)
  if (takeover) url.searchParams.set('takeover', '1')
  const socket = new WebSocket(url)
  socket.binaryType = 'arraybuffer'
  return socket
}

export function terminalWindowId(id: string) {
  return `terminal-${id}`
}
