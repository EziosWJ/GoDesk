import { useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { connectTerminal, type TerminalSession } from './terminal'

const connectionLabels = {
  connecting: '正在连接…',
  controller: '可输入',
  viewer: '只读',
  reconnecting: '连接中断，正在重连…',
  ended: '会话已结束',
}
type ConnectionStatus = keyof typeof connectionLabels
type Size = { cols: number; rows: number }
type TerminalEvent =
  | (Size & { type: 'snapshot'; output: string; controller: boolean })
  | (Size & { type: 'resize' })
  | { type: 'control'; controller: boolean }

export default function TerminalPage({ session, clientId, controlRequest, active, closing }: {
  session: TerminalSession
  clientId: string
  controlRequest: number
  active: boolean
  closing: boolean
}) {
  const host = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal>(null)
  const measureRef = useRef<() => Size | undefined>(null)
  const sendSizeRef = useRef<() => void>(null)
  const requestControlRef = useRef<() => void>(null)
  const requestedControl = useRef(0)
  const sentControl = useRef(0)
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
    measureRef.current = () => element.clientWidth && element.clientHeight ? fit.proposeDimensions() : undefined
    const sendSize = () => sendSizeRef.current?.()
    void document.fonts.load(`${fontSize}px ${fontFamily}`).then(() => {
      if (terminalRef.current !== terminal) return
      terminal.options.fontFamily = fontFamily
      sendSize()
    }).catch(() => {
      // Keep measuring with the fallback stack if the web font is unavailable.
    })
    const sizeChange = terminal.onResize(setSize)
    const resizeObserver = new ResizeObserver(sendSize)
    resizeObserver.observe(element)
    return () => {
      resizeObserver.disconnect()
      themeObserver.disconnect()
      sizeChange.dispose()
      terminal.dispose()
      terminalRef.current = null
      measureRef.current = null
    }
  }, [session.scrollbackLines])

  useEffect(() => {
    if (closing) return
    const terminal = terminalRef.current!
    const encoder = new TextEncoder()
    let socket: WebSocket | undefined
    let renderingSocket: WebSocket | undefined
    let retry: number | undefined
    let retryDelay = 1000
    let ready = false
    let controller = false
    let ended = false
    let requestedSize: Size | undefined

    function send(data: string | Uint8Array<ArrayBuffer>) {
      if (ready && controller && socket?.readyState === WebSocket.OPEN) socket.send(data)
    }

    function sendSize() {
      if (!ready || !controller) return
      const size = measureRef.current?.()
      if (!size || (size.cols === requestedSize?.cols && size.rows === requestedSize.rows)) return
      requestedSize = size
      send(JSON.stringify({ type: 'resize', ...size }))
    }

    function requestControl() {
      if (!ready || sentControl.current === requestedControl.current || socket?.readyState !== WebSocket.OPEN) return
      socket.send(JSON.stringify({ type: 'takeover' }))
      sentControl.current = requestedControl.current
    }

    function updateRole() {
      terminal.options.disableStdin = !(ready && controller)
      if (!ready) return
      setStatus(controller ? 'controller' : 'viewer')
      if (controller) sendSize()
      else requestedSize = undefined
    }

    function resetConnection() {
      ready = false
      controller = false
      requestedSize = undefined
      updateRole()
    }

    function connect() {
      window.clearTimeout(retry)
      socket?.close()
      resetConnection()
      const current = connectTerminal(session.id, clientId)
      socket = current
      renderingSocket = current
      current.onmessage = event => {
        if (socket !== current) return
        if (typeof event.data !== 'string') {
          terminal.write(new Uint8Array(event.data as ArrayBuffer))
          return
        }
        const message = JSON.parse(event.data) as TerminalEvent
        switch (message.type) {
          case 'snapshot': {
            controller = message.controller
            terminal.resize(message.cols, message.rows)
            setSize({ cols: message.cols, rows: message.rows })
            // The reset follows any bytes already queued by the old connection.
            terminal.write('\x1bc' + message.output, () => {
              if (socket !== current || current.readyState !== WebSocket.OPEN) return
              ready = true
              retryDelay = 1000
              updateRole()
              requestControl()
              const terminalWindow = host.current?.closest('[data-app-window]')
              if (document.activeElement === terminalWindow) terminal.focus()
            })
            break
          }
          case 'control':
            controller = message.controller
            updateRole()
            break
          case 'resize':
            // Apply dimensions after earlier output has been parsed.
            terminal.write('', () => {
              if (renderingSocket === current) terminal.resize(message.cols, message.rows)
            })
            break
        }
      }
      current.onclose = event => {
        if (socket !== current) return
        socket = undefined
        resetConnection()
        if (event.code === 4404) {
          ended = true
          setStatus('ended')
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
      if (!ended && !socket) connect()
    }

    function offline() {
      if (ended) return
      window.clearTimeout(retry)
      const current = socket
      socket = undefined
      resetConnection()
      current?.close()
      setStatus('reconnecting')
    }

    sendSizeRef.current = sendSize
    requestControlRef.current = requestControl
    const userInput = terminal.onData(data => send(encoder.encode(data)))
    const binaryInput = terminal.onBinary(data => send(Uint8Array.from(data, char => char.charCodeAt(0))))
    window.addEventListener('online', online)
    window.addEventListener('offline', offline)
    connect()
    return () => {
      window.removeEventListener('online', online)
      window.removeEventListener('offline', offline)
      window.clearTimeout(retry)
      userInput.dispose()
      binaryInput.dispose()
      const current = socket
      socket = undefined
      current?.close()
      renderingSocket = undefined
      sendSizeRef.current = null
      requestControlRef.current = null
    }
  }, [clientId, closing, session.id])

  useEffect(() => {
    requestedControl.current = controlRequest
    requestControlRef.current?.()
  }, [controlRequest])

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
      <div className="terminal-screen" data-read-only={status !== 'controller' || undefined}>
        <div className="terminal-host" ref={host} />
      </div>
      <footer className="app-statusbar terminal-status">
        <span role="status"><i aria-hidden="true" />{connectionLabels[status]}</span>
        {size && <span aria-label={`${size.cols} 列，${size.rows} 行`}>{size.cols} × {size.rows}</span>}
      </footer>
    </section>
  )
}
