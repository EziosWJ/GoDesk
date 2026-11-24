import { useEffect, useState } from 'react'
import { healthApi, HealthError, type HealthSnapshot } from './health'

export type ConnectionState = 'connecting' | 'connected' | 'disconnected'

export type HostHealthState = {
  snapshot: HealthSnapshot | null
  connection: ConnectionState
}

const pollInterval = 5000
const failureLimit = 3
const successWindow = 15000

export function useHostHealth(): HostHealthState {
  const [state, setState] = useState<HostHealthState>({ snapshot: null, connection: 'connecting' })

  useEffect(() => {
    let disposed = false
    let stopped = false
    let reloading = false
    let controller: AbortController | null = null
    let timer: number | undefined
    let failures = 0
    let lastSuccessAt: number | null = null
    const startedAt = Date.now()

    function visible() {
      return document.visibilityState === 'visible'
    }

    function clearTimer() {
      if (timer !== undefined) {
        window.clearTimeout(timer)
        timer = undefined
      }
    }

    function schedule() {
      clearTimer()
      if (disposed || stopped || !visible()) return
      timer = window.setTimeout(() => { void load() }, pollInterval)
    }

    async function load() {
      if (disposed || stopped || !visible()) return
      clearTimer()
      controller?.abort()
      const current = new AbortController()
      controller = current
      let timedOut = false
      // A hung request must not keep the connection state "connected" forever.
      const timeout = window.setTimeout(() => {
        timedOut = true
        current.abort()
      }, successWindow)
      try {
        const snapshot = await healthApi.status(current.signal)
        if (disposed || current.signal.aborted) return
        failures = 0
        lastSuccessAt = Date.now()
        setState({ snapshot, connection: 'connected' })
      } catch (failure) {
        if (disposed) return
        if (current.signal.aborted && !timedOut) return
        if (failure instanceof HealthError && failure.status === 401) {
          stopped = true
          if (!reloading) {
            reloading = true
            window.location.reload()
          }
          return
        }
        failures += 1
        const now = Date.now()
        const disconnected = failures >= failureLimit
          || now - (lastSuccessAt ?? startedAt) > successWindow
        if (disconnected) {
          setState(previous => ({ ...previous, connection: 'disconnected' }))
        }
      } finally {
        window.clearTimeout(timeout)
        if (!disposed && !stopped && current === controller) schedule()
      }
    }

    function refreshNow() {
      if (disposed || stopped) return
      if (!visible()) {
        clearTimer()
        return
      }
      void load()
    }

    function onVisibilityChange() {
      if (visible()) {
        refreshNow()
        return
      }
      clearTimer()
      controller?.abort()
      controller = null
    }

    void load()
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', refreshNow)
    window.addEventListener('online', refreshNow)
    return () => {
      disposed = true
      controller?.abort()
      clearTimer()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', refreshNow)
      window.removeEventListener('online', refreshNow)
    }
  }, [])

  return state
}
