import { useCallback, useEffect, useRef, useState } from 'react'
import { ExtensionError, extensionsApi, type ExtensionPlugin } from './api'

export function useExtensionCatalog(active: boolean) {
  const [plugins, setPlugins] = useState<ExtensionPlugin[]>()
  const [loadError, setLoadError] = useState('')
  const request = useRef<AbortController>(null)

  const load = useCallback(async () => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    try {
      const next = await extensionsApi.list(controller.signal)
      if (controller.signal.aborted) return
      setPlugins(next)
      setLoadError('')
    } catch (cause) {
      if (controller.signal.aborted) return
      if (cause instanceof ExtensionError && cause.status === 401) {
        window.location.reload()
        return
      }
      setLoadError(cause instanceof Error ? cause.message : '无法加载扩展列表')
    }
  }, [])

  useEffect(() => {
    if (!active) return
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
  }, [active, load])

  return { plugins, loadError, load }
}
