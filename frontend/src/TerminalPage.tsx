import { useEffect, useRef, useState } from 'react'
import { List } from 'lucide-react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { connectTerminal, terminalApi, type TerminalSession } from './terminal'

const connectionLabels = {
  connecting: '正在连接…',
  connected: '已连接',
  reconnecting: '连接中断，正在重连…',
  busy: '会话已在其他位置打开',
  ended: '会话已结束',
}
type ConnectionStatus = keyof typeof connectionLabels
type Size = { cols: number; rows: number }
type Snapshot = Size & { type: 'snapshot'; output: string }

export default function TerminalPage({ session, active, closing, initialTakeover, onManage }: {
  session: TerminalSession
  active: boolean
  closing: boolean
  initialTakeover: boolean
  onManage: () => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal>(null)
  const fitRef = useRef<() => void>(null)
  const takeoverRef = useRef<() => void>(null)
  const [clientId] = useState(() => Array.from(crypto.getRandomValues(new Uint8Array(16)), octet => octet.toString(16).padStart(2, '0')).join(''))
  const [size, setSize] = useState<Size>()
  const [status, setStatus] = useState<ConnectionStatus>('connecting')

  useEffect(() => {
    const element = host.current!
    const styles = getComputedStyle(element)
    const fontFamily = styles.getPropertyValue('--react-web-desktop-font-mono').trim()
    const fontSize = 13
    const terminal = new Terminal({
      cursorBlink: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      cursorStyle: 'bar',
      fontFamily: styles.getPropertyValue('--react-web-desktop-font-mono-fallback').trim(),
      fontSize,
      lineHeight: 1.25,
      screenReaderMode: true,
      scrollback: session.scrollbackLines,
      disableStdin: true,
    })
    terminalRef.current = terminal
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    const updateTheme = () => {
      const colors = getComputedStyle(element)
      const color = (name: string) => colors.getPropertyValue('--react-web-desktop-' + name).trim()
      terminal.options.theme = {
        background: color('surface'), foreground: color('fg'), cursor: color('fg'),
        cursorAccent: color('surface'), selectionBackground: color('selected'),
        green: color('success'), blue: color('info'),
      }
    }
    updateTheme()
    terminal.open(element)
    terminal.textarea?.setAttribute('aria-label', '终端输入')
    terminal.attachCustomKeyEventHandler(event =>
      !((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c' && terminal.hasSelection()))
    const themeObserver = new MutationObserver(updateTheme)
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    const resize = () => {
      if (element.clientWidth && element.clientHeight) fit.fit()
    }
    fitRef.current = resize
    void document.fonts.load(`${fontSize}px ${fontFamily}`).then(() => {
      if (terminalRef.current !== terminal) return
      terminal.options.fontFamily = fontFamily
      resize()
    }).catch(() => {
      // Keep measuring with the fallback stack if the web font is unavailable.
    })
    const sizeChange = terminal.onResize(setSize)
    resize()
    setSize({ cols: terminal.cols, rows: terminal.rows })
    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(element)
    return () => {
      resizeObserver.disconnect()
      themeObserver.disconnect()
      sizeChange.dispose()
      terminal.dispose()
      terminalRef.current = null
      fitRef.current = null
    }
  }, [session.scrollbackLines])

  useEffect(() => {
    if (closing) return
    const terminal = terminalRef.current!
    const encoder = new TextEncoder()
    let socket: WebSocket | undefined
    let retry: number | undefined
    let retryDelay = 1000
    let ready = false
    let stopped = false

    function send(data: string | Uint8Array<ArrayBuffer>) {
      if (ready && socket?.readyState === WebSocket.OPEN) socket.send(data)
    }

    function resize({ cols, rows }: Size) {
      send(JSON.stringify({ type: 'resize', cols, rows }))
    }

    function connect(takeover = false) {
      window.clearTimeout(retry)
      socket?.close()
      ready = false
      terminal.options.disableStdin = true
      const current = connectTerminal(session.id, clientId, takeover)
      socket = current
      current.onmessage = event => {
        if (socket !== current) return
        if (typeof event.data !== 'string') {
          terminal.write(new Uint8Array(event.data as ArrayBuffer))
          return
        }
        const initial = JSON.parse(event.data) as Snapshot
        terminal.resize(initial.cols, initial.rows)
        // Queue the reset after any output still buffered from the old socket.
        terminal.write('\x1bc' + initial.output, () => {
          if (socket !== current || current.readyState !== WebSocket.OPEN) return
          ready = true
          terminal.options.disableStdin = false
          retryDelay = 1000
          setStatus('connected')
          fitRef.current?.()
          resize({ cols: terminal.cols, rows: terminal.rows })
          const terminalWindow = host.current?.closest('[data-app-window]')
          if (document.activeElement === terminalWindow) terminal.focus()
        })
      }
      current.onclose = event => {
        if (socket !== current) return
        socket = undefined
        ready = false
        terminal.options.disableStdin = true
        if (event.code === 4404 || event.code === 4409) {
          stopped = true
          setStatus(event.code === 4404 ? 'ended' : 'busy')
          return
        }
        setStatus('reconnecting')
        if (navigator.onLine) {
          retry = window.setTimeout(connect, retryDelay)
          retryDelay = Math.min(retryDelay * 2, 5000)
        }
      }
    }

    function online() {
      if (!stopped && !ready) connect()
    }

    function offline() {
      if (stopped) return
      window.clearTimeout(retry)
      const current = socket
      socket = undefined
      ready = false
      terminal.options.disableStdin = true
      current?.close()
      setStatus('reconnecting')
    }

    takeoverRef.current = () => {
      stopped = false
      setStatus('connecting')
      connect(true)
    }
    const userInput = terminal.onData(data => send(encoder.encode(data)))
    const binaryInput = terminal.onBinary(data => send(Uint8Array.from(data, char => char.charCodeAt(0))))
    const sizeChange = terminal.onResize(resize)
    window.addEventListener('online', online)
    window.addEventListener('offline', offline)
    connect(initialTakeover)
    return () => {
      window.removeEventListener('online', online)
      window.removeEventListener('offline', offline)
      window.clearTimeout(retry)
      userInput.dispose()
      binaryInput.dispose()
      sizeChange.dispose()
      const current = socket
      socket = undefined
      current?.close()
      takeoverRef.current = null
    }
  }, [clientId, closing, initialTakeover, session.id])

  useEffect(() => {
    if (status !== 'busy' || closing) return
    const controller = new AbortController()
    const timer = window.setInterval(() => {
      void terminalApi.list(controller.signal).then(sessions => {
        if (!controller.signal.aborted && !sessions.some(item => item.id === session.id)) setStatus('ended')
      }, () => {})
    }, 3000)
    return () => {
      controller.abort()
      window.clearInterval(timer)
    }
  }, [closing, session.id, status])

  useEffect(() => {
    if (!active) return
    const frame = requestAnimationFrame(() => {
      const terminalWindow = host.current?.closest('[data-app-window]')
      if (document.activeElement === document.body || document.activeElement === terminalWindow) terminalRef.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [active])

  return (
    <section className="terminal-page" aria-label="主机终端">
      <div className="terminal-toolbar">
        <button className="app-control" type="button" onClick={onManage}>
          <List size={16} aria-hidden="true" />会话管理
        </button>
        {status === 'busy' && <button className="app-control" type="button" onClick={() => takeoverRef.current?.()}>接管</button>}
      </div>
      <div className="terminal-screen"><div className="terminal-host" ref={host} /></div>
      <footer className="app-statusbar terminal-status">
        <span role="status"><i aria-hidden="true" />{connectionLabels[status]}</span>
        {size && <span aria-label={`${size.cols} 列，${size.rows} 行`}>{size.cols} × {size.rows}</span>}
      </footer>
    </section>
  )
}
