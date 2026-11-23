import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal, type IMarker } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { home, homePath, inTrash, locationChain, type Entry } from './fileSystem'

const homeDirectory: Entry = { id: home, parent: '', name: '主目录', type: '文件夹', directory: home }
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

const help = [
  'help        显示命令列表',
  'pwd         显示当前路径',
  'ls [路径]   列出目录内容',
  'cd [路径]   切换目录',
  'cat <文件>  读取文本内容',
  'clear       清屏',
].join('\n')

function plainText(text: string) {
  return Array.from(text, char => {
    const code = char.codePointAt(0) ?? 0
    if (char === '\t') return '    '
    return char === '\n' || code >= 32 && (code < 127 || code > 159) ? char : ''
  }).join('')
}

function resolvePath(files: Entry[], directory: string, value: string): Entry | undefined {
  const path = value.replace(/^(['"])(.*)\1$/, '$2').replace(/^~(?=\/|$)/, homePath)
  const absolute = path.startsWith('/')
  if (absolute && path !== homePath && !path.startsWith(homePath + '/')) return undefined
  let entry = absolute ? homeDirectory : files.find(file => file.id === directory) ?? homeDirectory
  for (const part of (absolute ? path.slice(homePath.length) : path).split('/').filter(Boolean)) {
    if (!entry.directory) return undefined
    if (part === '.') continue
    if (part === '..' && entry.id === home) continue
    const next = part === '..'
      ? files.find(file => file.id === entry.parent) ?? homeDirectory
      : files.find(file => file.parent === entry.id && file.name === part)
    if (!next) return undefined
    entry = next
  }
  return entry
}

function attachSession(terminal: Terminal, getFiles: () => Entry[]) {
  let directory = home
  let marker: IMarker | undefined
  let line: string[] = []
  let cursor = 0
  const history: string[] = []
  let historyIndex = 0
  let draft = ''
  const inputQueue: string[] = []
  let busy = false

  function currentDirectory(files: Entry[]) {
    if (directory !== home && (!files.some(file => file.id === directory && file.directory) || inTrash(files, directory))) {
      directory = home
    }
    return [homePath, ...locationChain(files, directory).map(file => file.name)].join('/')
  }

  function prompt() {
    const path = currentDirectory(getFiles()).replace(homePath, '~')
    return '\x1b[32mdemo@react-web-desktop\x1b[0m:\x1b[34m' + plainText(path) + '\x1b[0m$ '
  }

  function execute(commandLine: string) {
    const [command = '', argument = ''] = commandLine.trim().match(/^(\S+)\s*(.*)$/s)?.slice(1) ?? []
    const files = getFiles()
    const path = currentDirectory(files)
    if (!command || command === 'clear') return
    if (command === 'help') return help
    if (command === 'pwd') return path
    if (command !== 'ls' && command !== 'cd' && command !== 'cat') return `${command}：未知命令。输入 help 查看可用命令。`
    if (command === 'cat' && !argument) return 'cat：请输入文件路径。'
    if (command === 'cd' && !argument) {
      directory = home
      return
    }
    const entry = resolvePath(files, directory, argument || '.')
    if (!entry) return `${command}：找不到 ${argument}`
    if (command === 'cat') {
      if (entry.directory) return 'cat：该路径是目录。'
      return entry.content ?? 'cat：该文件没有可读的文本内容。'
    }
    if (command === 'ls' && !entry.directory) return entry.name
    if (!entry.directory) return 'cd：该路径不是目录。'
    if (command === 'cd') {
      directory = entry.id
      return
    }
    return files.filter(file => file.parent === entry.id).map(file => file.name + (file.directory ? '/' : '')).join('  ')
  }

  function nextInput() {
    const data = inputQueue.shift()
    busy = data !== undefined
    if (data === undefined) return
    update(data)
  }

  function newPrompt() {
    marker?.dispose()
    marker = terminal.registerMarker()
    terminal.write(prompt(), nextInput)
  }

  function redraw() {
    const { baseY, cursorY } = terminal.buffer.active
    const offset = marker && !marker.isDisposed ? Math.max(0, baseY + cursorY - marker.line) : 0
    const moveUp = offset ? '\x1b[' + Math.min(offset, cursorY) + 'A' : ''
    terminal.write(moveUp + '\r\x1b[J' + prompt() + line.slice(0, cursor).join(''), () => {
      if (cursor === line.length) {
        nextInput()
        return
      }
      const start = terminal.buffer.active
      const row = start.baseY + start.cursorY
      const column = Math.min(start.cursorX + 1, terminal.cols)
      terminal.write(line.slice(cursor).join(''), () => {
        const end = terminal.buffer.active
        const rows = Math.max(0, Math.min(end.cursorY, end.baseY + end.cursorY - row))
        const move = rows ? '\x1b[' + rows + 'A' : ''
        terminal.write(move + '\x1b[' + column + 'G', nextInput)
      })
    })
  }

  function setLine(value: string) {
    line = Array.from(graphemes.segment(value), ({ segment }) => segment)
    cursor = line.length
  }

  function update(data: string) {
    if (data === '\r' || data === '\x03' || data === '\x0c') {
      const command = line.join('').trim()
      const cancel = data === '\x03'
      const clear = data === '\x0c' || !cancel && command === 'clear'
      if (data === '\x0c') {
        terminal.write('\x1b[H\x1b[2J\x1b[3J', () => {
          marker?.dispose()
          marker = terminal.registerMarker()
          redraw()
        })
        return
      }
      if (!cancel && command) history.push(command)
      if (history.length > 100) history.shift()
      historyIndex = history.length
      draft = ''
      const suffix = line.slice(cursor).join('')
      setLine('')
      if (clear) terminal.write('\x1b[H\x1b[2J\x1b[3J', newPrompt)
      else {
        const result = cancel ? '' : plainText(execute(command) ?? '')
        const output = result && !result.endsWith('\n') ? result + '\n' : result
        terminal.write(suffix + (cancel ? '^C' : '') + '\n' + output, newPrompt)
      }
      return
    }

    switch (data) {
      case '\x1b[A':
      case '\x1b[B':
        if (historyIndex === history.length) draft = line.join('')
        historyIndex = Math.max(0, Math.min(history.length, historyIndex + (data === '\x1b[A' ? -1 : 1)))
        setLine(history[historyIndex] ?? draft)
        break
      case '\x1b[D': cursor = Math.max(0, cursor - 1); break
      case '\x1b[C': cursor = Math.min(line.length, cursor + 1); break
      case '\x1b[H': cursor = 0; break
      case '\x1b[F': cursor = line.length; break
      case '\x7f':
      case '\b':
        if (cursor > 0) line.splice(--cursor, 1)
        break
      case '\x1b[3~':
        line.splice(cursor, 1)
        break
      default: {
        const text = data.startsWith('\x1b') ? '' : plainText(data)
        if (!text) {
          nextInput()
          return
        }
        const atEnd = cursor === line.length
        const before = line.slice(0, cursor).join('') + text
        const after = line.slice(cursor).join('')
        line = Array.from(graphemes.segment(before + after), ({ segment }) => segment)
        cursor = Array.from(graphemes.segment(before)).length
        if (atEnd) {
          terminal.write(text, nextInput)
          return
        }
      }
    }
    redraw()
  }

  function receive(data: string) {
    const parts = data.split(/\r\n|\r|\n/)
    parts.forEach((part, index) => {
      if (index) inputQueue.push('\r')
      if (part) inputQueue.push(part)
    })
    if (!busy) nextInput()
  }

  busy = true
  terminal.write('输入 help 查看可用命令。\n\n', newPrompt)
  return terminal.onData(receive)
}

export default function TerminalPage({ files, active }: { files: Entry[]; active: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal>(null)
  const latestFiles = useRef(files)
  const [size, setSize] = useState<{ cols: number; rows: number }>()

  useLayoutEffect(() => { latestFiles.current = files }, [files])

  useEffect(() => {
    const element = host.current!
    const styles = getComputedStyle(element)
    const fontFamily = styles.getPropertyValue('--react-web-desktop-font-mono').trim()
    const fontSize = 13
    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      cursorStyle: 'bar',
      fontFamily: styles.getPropertyValue('--react-web-desktop-font-mono-fallback').trim(),
      fontSize,
      lineHeight: 1.25,
      screenReaderMode: true,
      scrollback: 1000,
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
      event.key !== 'Tab' && !((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c' && terminal.hasSelection()))
    const themeObserver = new MutationObserver(updateTheme)
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    const resize = () => {
      if (element.clientWidth && element.clientHeight) fit.fit()
    }
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
    const session = attachSession(terminal, () => latestFiles.current)
    return () => {
      resizeObserver.disconnect()
      themeObserver.disconnect()
      sizeChange.dispose()
      session.dispose()
      terminal.dispose()
      terminalRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!active) return
    const frame = requestAnimationFrame(() => {
      const window = host.current?.closest('[data-app-window]')
      if (document.activeElement === document.body || document.activeElement === window) terminalRef.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [active])

  return (
    <section className="terminal-page" aria-label="模拟终端">
      <div className="terminal-screen"><div className="terminal-host" ref={host} /></div>
      <footer className="app-statusbar terminal-status">
        <span><i aria-hidden="true" />本地模拟</span>
        {size && <span aria-label={`${size.cols} 列，${size.rows} 行`}>{size.cols} × {size.rows}</span>}
      </footer>
    </section>
  )
}
