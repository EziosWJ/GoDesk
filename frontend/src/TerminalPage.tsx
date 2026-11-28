import { useEffect, useEffectEvent, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { ChevronDown, ChevronUp, Minus, Plus, Search, Shield, X } from 'lucide-react'
import { connectTerminal, terminalApi, type TerminalSession } from './terminal'
import {
  adjustTerminalFontSize,
  defaultTerminalFontSize,
  getTerminalFontSize,
  maxTerminalFontSize,
  minTerminalFontSize,
  resetTerminalFontSize,
  subscribeTerminalFontSize,
} from './terminalPreferences'
import { subscribeAppearance } from './theme'

const isApplePlatform = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent)
const primaryKeyLabel = isApplePlatform ? '⌘' : 'Ctrl'

type TerminalShortcut = 'search' | 'zoom-in' | 'zoom-out' | 'zoom-reset'

function matchTerminalShortcut(event: Pick<globalThis.KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'key' | 'code'>): TerminalShortcut | null {
  const primary = (event.metaKey || event.ctrlKey) && !event.altKey
  if (!primary) return null
  if (event.shiftKey && event.key.toLowerCase() === 'f') return 'search'
  if (event.key === '+' || event.key === '=' || event.code === 'Equal' || event.code === 'NumpadAdd') return 'zoom-in'
  if (event.key === '-' || event.key === '_' || event.code === 'Minus' || event.code === 'NumpadSubtract') return 'zoom-out'
  if (!event.shiftKey && (event.key === '0' || event.code === 'Digit0' || event.code === 'Numpad0')) return 'zoom-reset'
  return null
}

type Rgb = [number, number, number]

function parseCssRgb(raw: string): Rgb | null {
  const value = raw.trim()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value)
  if (hex) {
    const digits = hex[1]
    if (digits.length === 3) {
      return [
        parseInt(digits[0] + digits[0], 16),
        parseInt(digits[1] + digits[1], 16),
        parseInt(digits[2] + digits[2], 16),
      ]
    }
    return [
      parseInt(digits.slice(0, 2), 16),
      parseInt(digits.slice(2, 4), 16),
      parseInt(digits.slice(4, 6), 16),
    ]
  }
  const rgb = /^rgba?\(\s*(\d+(?:\.\d+)?)\s*[\s,]\s*(\d+(?:\.\d+)?)\s*[\s,]\s*(\d+(?:\.\d+)?)/i.exec(value)
  if (rgb) {
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  }
  return null
}

function toHex([r, g, b]: Rgb): string {
  const channel = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
  return `#${channel(r)}${channel(g)}${channel(b)}`
}

function mixHex(base: Rgb, tint: Rgb, ratio: number): string {
  return toHex([
    base[0] + (tint[0] - base[0]) * ratio,
    base[1] + (tint[1] - base[1]) * ratio,
    base[2] + (tint[2] - base[2]) * ratio,
  ])
}

function getSearchDecorations(element: HTMLElement | null): ISearchOptions['decorations'] {
  const styles = getComputedStyle(element ?? document.documentElement)
  const surface = parseCssRgb(styles.getPropertyValue('--godesk-surface'))
  const warning = parseCssRgb(styles.getPropertyValue('--godesk-warning'))
  const accent = parseCssRgb(styles.getPropertyValue('--godesk-accent'))
  if (!surface || !warning || !accent) return undefined
  const dark = document.documentElement.dataset.theme === 'dark'
  return {
    matchBackground: mixHex(surface, warning, dark ? 0.28 : 0.22),
    matchBorder: mixHex(surface, warning, dark ? 0.68 : 0.72),
    matchOverviewRuler: toHex(warning),
    activeMatchBackground: mixHex(surface, accent, dark ? 0.42 : 0.30),
    activeMatchBorder: toHex(accent),
    activeMatchColorOverviewRuler: toHex(accent),
  }
}

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

function TerminalSudoSetup() {
  const label = '配置免密 sudo（可选）'
  const titleId = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const [status, setStatus] = useState<{ setupCommand?: string } | 'unavailable'>()
  const command = status === 'unavailable' ? undefined : status?.setupCommand
  const [copyStatus, setCopyStatus] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    void terminalApi.sudoStatus(controller.signal).then(result => {
      if (!controller.signal.aborted) setStatus(result)
    }).catch(() => {
      if (!controller.signal.aborted) setStatus('unavailable')
    })
    return () => controller.abort()
  }, [])

  async function copyCommand(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopyStatus('命令已复制')
    } catch {
      setCopyStatus('无法访问剪贴板，请手动复制命令。')
    }
  }

  return (
    <>
      <button className="app-control terminal-sudo-button" type="button" title={label} aria-label={label}
        aria-haspopup="dialog" onClick={() => {
          setCopyStatus('')
          dialog.current?.showModal()
        }}>
        <Shield size={14} aria-hidden="true" />
      </button>
      <dialog ref={dialog} className="service-dialog" aria-labelledby={titleId}>
        <div className="service-dialog-body terminal-sudo-note">
          <h2 id={titleId}>{label}</h2>
          {command ? (
            <>
              <p>需要使用 Go Desk 的管理员功能时，请将命令粘贴到当前终端并执行。运行 Go Desk 的 Linux 账号须已有 sudo 授权。</p>
              <pre><code>{command}</code></pre>
              <p>配置后，该账号下的所有进程都能免密执行 root 命令。重新打开终端即可刷新权限状态。</p>
            </>
          ) : (
            <p role="status">{status === 'unavailable'
              ? '暂时无法读取免密 sudo 状态。'
              : status ? '当前运行账号已可免密执行管理员命令。' : '正在检查免密 sudo…'}</p>
          )}
          {copyStatus && <p role="status">{copyStatus}</p>}
        </div>
        <div className="service-dialog-actions">
          {command && <button className="app-control primary-control" type="button"
            onClick={() => { void copyCommand(command) }}>复制命令</button>}
          <button className="app-control" type="button" onClick={() => dialog.current?.close()}>关闭</button>
        </div>
      </dialog>
    </>
  )
}

export default function TerminalPage({ session, clientId, controlRequest, active, closing }: {
  session: TerminalSession
  clientId: string
  controlRequest: number
  active: boolean
  closing: boolean
}) {
  const fontSize = useSyncExternalStore(subscribeTerminalFontSize, getTerminalFontSize)
  const host = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal>(null)
  const searchAddonRef = useRef<SearchAddon>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const measureRef = useRef<() => Size | undefined>(null)
  const sendSizeRef = useRef<() => void>(null)
  const requestControlRef = useRef<() => void>(null)
  const requestedControl = useRef(0)
  const sentControl = useRef(0)
  const [size, setSize] = useState<Size>()
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [regex, setRegex] = useState(false)
  const [searchResults, setSearchResults] = useState({ resultIndex: -1, resultCount: 0 })
  const [searchRegexError, setSearchRegexError] = useState(false)
  const [hoveredLink, setHoveredLink] = useState<string | null>(null)

  function runSearch(
    direction: 'next' | 'previous',
    query: string,
    options: { caseSensitive: boolean; regex: boolean; incremental?: boolean },
  ) {
    const searchAddon = searchAddonRef.current
    const terminal = terminalRef.current
    if (!searchAddon || !terminal) return
    if (!query) {
      searchAddon.clearDecorations()
      terminal.clearSelection()
      setSearchResults({ resultIndex: -1, resultCount: 0 })
      setSearchRegexError(false)
      return
    }
    if (options.regex) {
      try {
        new RegExp(query)
      } catch {
        searchAddon.clearDecorations()
        terminal.clearSelection()
        setSearchResults({ resultIndex: -1, resultCount: 0 })
        setSearchRegexError(true)
        return
      }
    }
    setSearchRegexError(false)
    const decorations = getSearchDecorations(host.current)
    const searchOptions: ISearchOptions = {
      caseSensitive: options.caseSensitive,
      regex: options.regex,
      incremental: options.incremental,
      ...(decorations ? { decorations } : {}),
    }
    try {
      if (direction === 'next') searchAddon.findNext(query, searchOptions)
      else searchAddon.findPrevious(query, searchOptions)
    } catch {
      searchAddon.clearDecorations()
      terminal.clearSelection()
      setSearchResults({ resultIndex: -1, resultCount: 0 })
    }
  }

  function openSearch() {
    setSearchOpen(true)
    if (searchQuery) {
      runSearch('next', searchQuery, { caseSensitive, regex, incremental: true })
    }
    requestAnimationFrame(() => {
      const input = searchInputRef.current
      if (!input) return
      input.focus()
      input.select()
    })
  }

  function closeSearch() {
    setSearchOpen(false)
    searchAddonRef.current?.clearDecorations()
    terminalRef.current?.clearSelection()
    setSearchResults({ resultIndex: -1, resultCount: 0 })
    setSearchRegexError(false)
    terminalRef.current?.focus()
  }

  function handleShortcutAction(action: TerminalShortcut) {
    switch (action) {
      case 'search':
        openSearch()
        break
      case 'zoom-in':
        adjustTerminalFontSize(1)
        break
      case 'zoom-out':
        adjustTerminalFontSize(-1)
        break
      case 'zoom-reset':
        resetTerminalFontSize()
        break
    }
  }

  const onTerminalShortcut = useEffectEvent((action: TerminalShortcut) => {
    handleShortcutAction(action)
  })

  const onAppearanceRefreshSearch = useEffectEvent(() => {
    if (searchOpen && searchQuery) {
      runSearch('next', searchQuery, { caseSensitive, regex, incremental: true })
    }
  })

  function handlePageKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.defaultPrevented || event.nativeEvent.isComposing) return
    const action = matchTerminalShortcut(event.nativeEvent)
    if (!action) return
    event.preventDefault()
    event.stopPropagation()
    handleShortcutAction(action)
  }

  useEffect(() => {
    const element = host.current!
    const styles = getComputedStyle(element)
    const fontFamily = styles.getPropertyValue('--godesk-font-mono').trim()
    const initialFontSize = getTerminalFontSize()
    const terminal = new Terminal({
      allowProposedApi: true,
      cursorBlink: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      cursorStyle: 'bar',
      fontFamily: styles.getPropertyValue('--godesk-font-mono-fallback').trim(),
      fontSize: initialFontSize,
      lineHeight: 1.25,
      screenReaderMode: true,
      scrollback: session.scrollbackLines,
      disableStdin: true,
    })
    terminalRef.current = terminal
    const fit = new FitAddon()
    const searchAddon = new SearchAddon()
    const webLinks = new WebLinksAddon((event, uri) => {
      if (!event.ctrlKey && !event.metaKey) return
      if (!/^https?:\/\//i.test(uri)) return
      window.open(uri, '_blank', 'noopener,noreferrer')
    }, {
      hover: (_event, uri) => setHoveredLink(uri),
      leave: () => setHoveredLink(null),
    })
    terminal.loadAddon(fit)
    terminal.loadAddon(searchAddon)
    terminal.loadAddon(webLinks)
    searchAddonRef.current = searchAddon
    const searchResultsChange = searchAddon.onDidChangeResults(setSearchResults)
    const updateTheme = () => {
      const colors = getComputedStyle(element)
      const color = (name: string) => colors.getPropertyValue('--godesk-' + name).trim()
      terminal.options.theme = {
        background: color('surface'), foreground: color('fg'), cursor: color('fg'),
        cursorAccent: color('surface'), selectionBackground: color('selected'),
        green: color('success'), blue: color('info'),
      }
      onAppearanceRefreshSearch()
    }
    updateTheme()
    terminal.open(element)
    terminal.textarea?.setAttribute('aria-label', '终端输入')
    terminal.attachCustomKeyEventHandler(event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c' && terminal.hasSelection()) {
        return false
      }
      const action = matchTerminalShortcut(event)
      if (action) {
        event.preventDefault()
        event.stopPropagation()
        if (event.type === 'keydown') onTerminalShortcut(action)
        return false
      }
      return true
    })
    const unsubscribeAppearance = subscribeAppearance(updateTheme)
    measureRef.current = () => element.clientWidth && element.clientHeight ? fit.proposeDimensions() : undefined
    const sendSize = () => sendSizeRef.current?.()
    void document.fonts.load(`${initialFontSize}px ${fontFamily}`).then(() => {
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
      unsubscribeAppearance()
      sizeChange.dispose()
      searchResultsChange.dispose()
      terminal.dispose()
      terminalRef.current = null
      searchAddonRef.current = null
      measureRef.current = null
      setHoveredLink(null)
    }
  }, [session.scrollbackLines])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal || terminal.options.fontSize === fontSize) return
    terminal.options.fontSize = fontSize
    sendSizeRef.current?.()
  }, [fontSize])

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

  const searchStatusText = searchRegexError
    ? '正则无效'
    : !searchQuery
      ? ''
      : searchResults.resultCount === 0
        ? '无结果'
        : searchResults.resultIndex >= 0
          ? `${searchResults.resultIndex + 1}/${searchResults.resultCount}`
          : `${searchResults.resultCount}+`

  return (
    <section className="terminal-page" aria-label="主机终端" onKeyDown={handlePageKeyDown}>
      <div className="terminal-screen" data-read-only={status !== 'controller' || undefined}>
        <div className="terminal-host" ref={host} />
        {searchOpen && (
          <div
            className="terminal-search"
            role="search"
            aria-label="查找终端输出"
            onKeyDown={event => {
              if (event.key !== 'Escape') return
              event.preventDefault()
              event.stopPropagation()
              closeSearch()
            }}
          >
            <input
              ref={searchInputRef}
              className="terminal-search-input"
              type="text"
              value={searchQuery}
              placeholder="查找输出…"
              aria-label="查找终端输出"
              aria-invalid={searchRegexError || undefined}
              onChange={event => {
                const next = event.target.value
                setSearchQuery(next)
                runSearch('next', next, { caseSensitive, regex, incremental: true })
              }}
              onKeyDown={event => {
                if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
                event.preventDefault()
                runSearch(event.shiftKey ? 'previous' : 'next', searchQuery, { caseSensitive, regex })
              }}
            />
            {searchStatusText && (
              <span className="terminal-search-count" data-error={searchRegexError || undefined} aria-live="polite">
                {searchStatusText}
              </span>
            )}
            <div className="terminal-search-actions">
              <button
                type="button"
                className="app-control terminal-search-button terminal-search-toggle"
                aria-label="区分大小写"
                aria-pressed={caseSensitive}
                title="区分大小写"
                onClick={() => {
                  const next = !caseSensitive
                  setCaseSensitive(next)
                  if (searchQuery) runSearch('next', searchQuery, { caseSensitive: next, regex, incremental: true })
                }}
              >
                Aa
              </button>
              <button
                type="button"
                className="app-control terminal-search-button terminal-search-toggle"
                aria-label="使用正则表达式"
                aria-pressed={regex}
                title="使用正则表达式"
                onClick={() => {
                  const next = !regex
                  setRegex(next)
                  if (searchQuery) runSearch('next', searchQuery, { caseSensitive, regex: next, incremental: true })
                }}
              >
                .*
              </button>
              <button
                type="button"
                className="app-control terminal-search-button"
                aria-label="上一个匹配"
                title="上一个匹配 (Shift+Enter)"
                disabled={!searchQuery || searchRegexError}
                onClick={() => runSearch('previous', searchQuery, { caseSensitive, regex })}
              >
                <ChevronUp size={14} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="app-control terminal-search-button"
                aria-label="下一个匹配"
                title="下一个匹配 (Enter)"
                disabled={!searchQuery || searchRegexError}
                onClick={() => runSearch('next', searchQuery, { caseSensitive, regex })}
              >
                <ChevronDown size={14} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="app-control terminal-search-button"
                aria-label="关闭查找"
                title="关闭查找 (Esc)"
                onClick={closeSearch}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          </div>
        )}
        {hoveredLink && (
          <div className="terminal-link-hint" aria-hidden="true">
            <span>按住 {primaryKeyLabel} 并点击打开：</span>
            <code>{hoveredLink}</code>
          </div>
        )}
      </div>
      <footer className="app-statusbar terminal-status">
        <span role="status"><i aria-hidden="true" />{connectionLabels[status]}</span>
        <div className="terminal-status-actions">
          <button
            className="app-control terminal-status-button"
            type="button"
            aria-label="查找终端输出"
            aria-pressed={searchOpen}
            title={`查找输出 (${primaryKeyLabel}+Shift+F)`}
            onClick={() => {
              if (searchOpen) closeSearch()
              else openSearch()
            }}
          >
            <Search size={14} aria-hidden="true" />
          </button>
          <div className="terminal-zoom-group" role="group" aria-label="终端字号">
            <button
              type="button"
              className="app-control terminal-status-button"
              aria-label="减小字号"
              title={`减小字号 (${primaryKeyLabel}+-)`}
              disabled={fontSize <= minTerminalFontSize}
              onClick={() => adjustTerminalFontSize(-1)}
            >
              <Minus size={13} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="app-control terminal-status-button terminal-font-size"
              aria-label={`当前字号 ${fontSize}px，点击重置为 ${defaultTerminalFontSize}px`}
              title={fontSize === defaultTerminalFontSize
                ? `终端字号 ${fontSize}px (${primaryKeyLabel}+0 重置)`
                : `点击重置为 ${defaultTerminalFontSize}px (${primaryKeyLabel}+0)`}
              onClick={resetTerminalFontSize}
            >
              {fontSize}px
            </button>
            <button
              type="button"
              className="app-control terminal-status-button"
              aria-label="增大字号"
              title={`增大字号 (${primaryKeyLabel}+=)`}
              disabled={fontSize >= maxTerminalFontSize}
              onClick={() => adjustTerminalFontSize(1)}
            >
              <Plus size={13} aria-hidden="true" />
            </button>
          </div>
          {size && <span className="terminal-status-size" aria-label={`${size.cols} 列，${size.rows} 行`}>{size.cols} × {size.rows}</span>}
          {status === 'controller' && !closing && <TerminalSudoSetup />}
        </div>
      </footer>
    </section>
  )
}
