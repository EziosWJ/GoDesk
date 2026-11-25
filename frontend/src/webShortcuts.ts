import { useCallback, useEffect, useRef, useState } from 'react'

export type WebShortcut = {
  id: number
  name: string
  url: string
  parameterName: string
}

export type WebShortcutForm = Omit<WebShortcut, 'id'> & { secret: string }

const path = '/api/v1/web-shortcuts'

async function request(url: string, options?: RequestInit) {
  const response = await fetch(url, options)
  if (response.status === 401) window.location.reload()
  if (!response.ok) throw new Error((await response.text()).trim() || '无法处理网页快捷方式')
  return response
}

export const webShortcutsApi = {
  async list(signal: AbortSignal): Promise<WebShortcut[]> {
    return (await request(path, { signal })).json()
  },
  async save(form: WebShortcutForm, id?: number): Promise<WebShortcut> {
    return (await request(id === undefined ? path : `${path}/${id}`, {
      method: id === undefined ? 'POST' : 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    })).json()
  },
  async remove(id: number) {
    await request(`${path}/${id}`, { method: 'DELETE' })
  },
}

export function openWebShortcut(id: number) {
  window.open(`${path}/${id}/open`, '_blank', 'noopener')
}

export function useWebShortcuts() {
  const [items, setItems] = useState<WebShortcut[]>()
  const [error, setError] = useState('')
  const request = useRef<AbortController>(null)

  const load = useCallback(async () => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    try {
      const next = await webShortcutsApi.list(controller.signal)
      if (controller.signal.aborted) return
      setItems(next)
      setError('')
    } catch {
      if (!controller.signal.aborted) setError('无法加载网页快捷方式')
    }
  }, [])

  useEffect(() => {
    function refresh() {
      if (document.visibilityState === 'visible') void load()
    }
    refresh()
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      request.current?.abort()
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [load])

  return { items, error, load }
}
