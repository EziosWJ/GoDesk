import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type PointerEvent } from 'react'
import { ArrowLeft, ArrowRight, ArrowUp, ChevronRight, FolderPlus, HardDrive, House, Search, X } from 'lucide-react'
import { announceFileChange, childPath, errorMessage, FileError, fileAction, filename as pathName, pathCrumbs, readDirectory, type Conflict } from './hostFiles'
import { FileIcon } from './fileIcons'
import './styles/file-location-dialog.css'

type Position = { x: number; y: number }
type Drag = { pointerId: number; handle: HTMLElement; start: Position; origin: Position }
type Size = { width: number; height: number }
type Resize = Drag & { bounds: DOMRect; size?: Size; previousSize?: Size }
const sizePreference = 'react-web-desktop-file-location-size'
const minimumSize = { width: 520, height: 380 }
const defaultSize = { width: 820, height: 540 }

function storedSize(): Size | undefined {
  try {
    const size = JSON.parse(localStorage.getItem(sizePreference) ?? 'null')
    if (size && Number.isFinite(size.width) && size.width >= minimumSize.width
      && Number.isFinite(size.height) && size.height >= minimumSize.height) return size
  } catch {
    // The default size still works when storage is unavailable.
  }
}

function applySize(element: HTMLDialogElement, size?: Size) {
  if (size) {
    element.style.setProperty('--file-location-width', `${size.width}px`)
    element.style.setProperty('--file-location-height', `${size.height}px`)
  } else {
    element.style.removeProperty('--file-location-width')
    element.style.removeProperty('--file-location-height')
  }
}

type FileLocationDialogProps = {
  title: string
  warning?: string
  initialDirectory?: string
  onCancel: () => void
} & ({
  mode: 'save'
  formats: Readonly<Record<string, { type: string }>>
  defaultExtension: string
  initialName?: string
  onSave: (path: string, conflict?: Conflict) => Promise<void>
} | {
  mode: 'folder'
  actionLabel: string
  canSelect: (directory: string) => boolean
  onSelect: (directory: string) => void
})

function fileExtension(name: string) {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot) : ''
}

function validName(name: string) {
  return name && name !== '.' && name !== '..' && !name.includes('/')
}

function placeDialog(element: HTMLDialogElement, { x, y }: Position) {
  const { clientWidth, clientHeight } = document.documentElement
  const maxX = Math.max(0, (clientWidth - element.offsetWidth) / 2)
  const maxY = Math.max(0, (clientHeight - element.offsetHeight) / 2)
  const next = { x: Math.max(-maxX, Math.min(maxX, x)), y: Math.max(-maxY, Math.min(maxY, y)) }
  element.style.translate = `${next.x}px ${next.y}px`
  return next
}

export function FileLocationDialog(props: FileLocationDialogProps) {
  const { title, initialDirectory = '', onCancel } = props
  const id = useId()
  const modal = useRef<HTMLDialogElement>(null)
  const drag = useRef<Drag>(undefined)
  const resize = useRef<Resize>(undefined)
  const preferredSize = useRef<Size>(undefined)
  const position = useRef<Position>({ x: 0, y: 0 })
  const address = useRef<HTMLElement>(null)
  const currentCrumb = useRef<HTMLButtonElement>(null)
  const listing = useRef<HTMLDivElement>(null)
  const filenameInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)
  const [history, setHistory] = useState({ paths: [] as string[], index: -1 })
  const [data, setData] = useState<Awaited<ReturnType<typeof readDirectory>>>()
  const [locationInput, setLocationInput] = useState<string>()
  const [locationError, setLocationError] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [conflictPath, setConflictPath] = useState<string>()
  const request = useRef<AbortController>(undefined)
  const [query, setQuery] = useState('')
  const [filename, setFilename] = useState(props.mode === 'save' ? props.initialName ?? '' : '')
  const [format, setFormat] = useState(() => {
    if (props.mode === 'folder') return ''
    const extension = fileExtension(props.initialName ?? '').slice(1).toLowerCase()
    return Object.hasOwn(props.formats, extension) ? extension : props.defaultExtension
  })
  const [error, setError] = useState('')
  const [newFolder, setNewFolder] = useState<string>()
  const [folderError, setFolderError] = useState('')
  const directory = data?.path ?? ''
  const editingLocation = locationInput !== undefined
  const available = !!directory && !loading && !busy
  const breadcrumbs = pathCrumbs(directory)
  const currentName = directory ? pathName(directory) : '主目录'
  const entries = (data?.entries ?? []).filter(file => file.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const typedExtension = fileExtension(filename.trim()).slice(1).toLowerCase()
  const selectedFormat = props.mode === 'save' && Object.hasOwn(props.formats, typedExtension) ? typedExtension : format
  const canSelect = available && (props.mode === 'save' || props.canSelect(directory))

  useLayoutEffect(() => {
    const element = modal.current!
    preferredSize.current = storedSize()
    applySize(element, preferredSize.current)
    element.showModal()
    const initialFocus = filenameInput.current ?? listing.current
    initialFocus?.focus()
    filenameInput.current?.select()
    function keepVisible() {
      position.current = placeDialog(element, position.current)
    }
    window.addEventListener('resize', keepVisible)
    return () => {
      window.removeEventListener('resize', keepVisible)
      element.close()
    }
  }, [])

  const creatingFolder = newFolder !== undefined
  useLayoutEffect(() => {
    const element = address.current
    if (element) element.scrollLeft = element.scrollWidth
  }, [directory, editingLocation])

  useLayoutEffect(() => {
    if (creatingFolder) folderInput.current?.focus()
  }, [creatingFolder])

  async function loadLocation(target: string, index?: number, initial = false) {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setLoading(true)
    try {
      const next = await readDirectory(target, controller.signal)
      if (controller.signal.aborted) return
      setData(next)
      setHistory(current => index !== undefined ? { ...current, index }
        : current.paths[current.index] === next.path ? current
          : { paths: [...current.paths.slice(0, current.index + 1), next.path], index: current.index + 1 })
      setQuery('')
      setError('')
      setLocationError('')
      setLocationInput(undefined)
      setConflictPath(undefined)
      setNewFolder(undefined)
      setFolderError('')
      if (listing.current) listing.current.scrollTop = 0
      if (!initial) listing.current?.focus()
    } catch (error) {
      if (!controller.signal.aborted) setLocationError(errorMessage(error))
    } finally {
      if (request.current === controller) setLoading(false)
    }
  }

  useEffect(() => {
    let active = true
    void Promise.resolve().then(() => {
      if (active) return loadLocation(initialDirectory, undefined, true)
    })
    return () => {
      active = false
      request.current?.abort()
    }
  }, [initialDirectory])

  function navigate(target: string, index?: number) {
    if (!busy) void loadLocation(target, index)
  }

  function startDrag(event: PointerEvent<HTMLElement>) {
    if (drag.current || resize.current || event.button !== 0 || (event.target instanceof Element && event.target.closest('button'))) return
    event.preventDefault()
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    handle.dataset.dragging = 'true'
    drag.current = { pointerId: event.pointerId, handle, start: { x: event.clientX, y: event.clientY }, origin: position.current }
  }

  function endDrag(pointerId: number, revert = false) {
    const active = drag.current
    if (active?.pointerId !== pointerId) return
    drag.current = undefined
    delete active.handle.dataset.dragging
    if (active.handle.hasPointerCapture(pointerId)) active.handle.releasePointerCapture(pointerId)
    if (revert) position.current = placeDialog(modal.current!, active.origin)
  }

  function startResize(event: PointerEvent<HTMLElement>) {
    if (drag.current || resize.current || event.button !== 0) return
    event.preventDefault()
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    resize.current = {
      pointerId: event.pointerId, handle, start: { x: event.clientX, y: event.clientY }, origin: position.current,
      bounds: modal.current!.getBoundingClientRect(), previousSize: preferredSize.current,
    }
  }

  function resizeDialog(event: PointerEvent<HTMLElement>) {
    const active = resize.current
    if (active?.pointerId !== event.pointerId) return
    const element = modal.current!
    const { clientWidth, clientHeight } = document.documentElement
    const maxWidth = clientWidth - 24
    const maxHeight = clientHeight - 24
    const startWidth = Math.round(active.bounds.width)
    const startHeight = Math.round(active.bounds.height)
    const width = Math.min(maxWidth, Math.max(Math.min(startWidth, minimumSize.width), startWidth + event.clientX - active.start.x))
    const height = Math.min(maxHeight, Math.max(Math.min(startHeight, minimumSize.height), startHeight + event.clientY - active.start.y))
    if (element.offsetWidth === width && element.offsetHeight === height) return
    const previous = active.previousSize ?? defaultSize
    const size = {
      width: width === startWidth ? previous.width : Math.max(minimumSize.width, width),
      height: height === startHeight ? previous.height : Math.max(minimumSize.height, height),
    }
    applySize(element, size)
    position.current = placeDialog(element, {
      x: active.bounds.left - (clientWidth - element.offsetWidth) / 2,
      y: active.bounds.top - (clientHeight - element.offsetHeight) / 2,
    })
    active.size = size
  }

  function endResize(pointerId: number, revert = false) {
    const active = resize.current
    if (active?.pointerId !== pointerId) return
    resize.current = undefined
    if (active.handle.hasPointerCapture(pointerId)) active.handle.releasePointerCapture(pointerId)
    if (revert) {
      applySize(modal.current!, active.previousSize)
      position.current = placeDialog(modal.current!, active.origin)
    } else if (active.size) {
      preferredSize.current = active.size
      try {
        localStorage.setItem(sizePreference, JSON.stringify(active.size))
      } catch {
        // The current dialog still keeps the new size.
      }
    }
  }

  function startLocationEdit() {
    if (busy) return
    setLocationError('')
    setLocationInput(directory || '/')
  }

  async function saveTo(path: string, conflict?: Conflict) {
    if (props.mode !== 'save' || busy) return
    setBusy(true)
    setError('')
    try {
      await props.onSave(path, conflict)
    } catch (error) {
      if (error instanceof FileError && error.code === 'exists') {
        setConflictPath(path)
        setError('此位置已有同名项，可以换名或保留两者。')
      } else setError(errorMessage(error))
      filenameInput.current?.focus()
    } finally {
      setBusy(false)
    }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (props.mode !== 'save' || !available) return
    const input = filename
    const extension = fileExtension(input)
    const name = extension ? input : `${input}.${selectedFormat}`
    const key = extension ? extension.slice(1).toLowerCase() : selectedFormat
    if (!validName(input)) setError('请输入有效的文件名，文件名中不能包含路径分隔符。')
    else if (!Object.hasOwn(props.formats, key)) setError('请选择支持的文件类型，或修改文件扩展名。')
    else {
      void saveTo(childPath(directory, name))
      return
    }
    filenameInput.current?.focus()
  }

  async function createFolder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = newFolder ?? ''
    if (!available) return
    if (!validName(name)) {
      setFolderError('请输入有效的文件夹名称。')
      return
    }
    setBusy(true)
    try {
      const result = await fileAction('mkdir', directory, { name })
      announceFileChange()
      await loadLocation(result.path)
    } catch (error) {
      setFolderError(error instanceof FileError && error.code === 'exists'
        ? '此位置已有同名项，请更换文件夹名称。' : errorMessage(error))
      folderInput.current?.focus()
    } finally {
      setBusy(false)
    }
  }

  return (
    <dialog ref={modal} className="service-dialog file-location-dialog" aria-labelledby={`${id}-title`}
      onCancel={event => {
        event.preventDefault()
        event.stopPropagation()
        if (resize.current) endResize(resize.current.pointerId, true)
        else if (drag.current) endDrag(drag.current.pointerId, true)
        else if (!busy) onCancel()
      }}>
      <header className="file-location-title" onPointerDown={startDrag} onPointerMove={event => {
        const active = drag.current
        if (active?.pointerId !== event.pointerId) return
        position.current = placeDialog(modal.current!, {
          x: active.origin.x + event.clientX - active.start.x,
          y: active.origin.y + event.clientY - active.start.y,
        })
      }} onPointerUp={event => endDrag(event.pointerId)}
        onPointerCancel={event => endDrag(event.pointerId, true)} onLostPointerCapture={event => endDrag(event.pointerId)}>
        <h2 id={`${id}-title`}>{title}</h2>
        <button className="app-control file-location-icon" type="button" aria-label="关闭" disabled={busy} onClick={onCancel}>
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      <div className="file-location-navigation">
        <div className="file-location-arrows" aria-label="目录导航" role="group">
          <button type="button" className="app-control file-location-icon" title="后退" aria-label="后退"
            disabled={history.index <= 0 || busy} onClick={() => navigate(history.paths[history.index - 1], history.index - 1)}>
            <ArrowLeft size={16} aria-hidden="true" />
          </button>
          <button type="button" className="app-control file-location-icon" title="前进" aria-label="前进"
            disabled={history.index >= history.paths.length - 1 || busy} onClick={() => navigate(history.paths[history.index + 1], history.index + 1)}>
            <ArrowRight size={16} aria-hidden="true" />
          </button>
          <button type="button" className="app-control file-location-icon" title="上一级" aria-label="上一级"
            disabled={breadcrumbs.length < 2 || busy} onClick={() => navigate(breadcrumbs.at(-2)!.id)}>
            <ArrowUp size={16} aria-hidden="true" />
          </button>
        </div>
        {editingLocation ? <form className="file-address-form" onKeyDown={event => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          setLocationInput(undefined)
          setLocationError('')
          requestAnimationFrame(() => currentCrumb.current?.focus())
        }} onSubmit={event => {
          event.preventDefault()
          if (locationInput.startsWith('/')) navigate(locationInput)
          else setLocationError('请输入以 / 开头的绝对路径')
        }}>
          <input autoFocus aria-label="目标绝对路径" value={locationInput} onChange={event => setLocationInput(event.target.value)}
            onFocus={event => event.target.select()} />
          <button className="app-control" type="submit" disabled={busy}>前往</button>
        </form> : <nav ref={address} className="file-location-breadcrumbs" aria-label="当前路径" onClick={event => {
          if (!(event.target as Element).closest('button')) startLocationEdit()
        }}>
          {breadcrumbs.map((crumb, index) => (
            <div key={crumb.id}>
              {index > 0 && <ChevronRight size={13} aria-hidden="true" />}
              {index === breadcrumbs.length - 1
                ? <button ref={currentCrumb} type="button" className="app-control file-location-crumb" title="编辑绝对路径"
                  aria-current="location" disabled={busy} onClick={startLocationEdit}>
                  {index === 0 && <House size={15} aria-hidden="true" />}<span className="truncate">{crumb.name}</span>
                </button>
                : <button type="button" title={crumb.name} className="app-control file-location-crumb" onClick={() => navigate(crumb.id)}>
                  {index === 0 && <House size={15} aria-hidden="true" />}<span className="truncate">{crumb.name}</span>
                </button>}
            </div>
          ))}
        </nav>}
        <label className="file-location-search">
          <Search size={16} aria-hidden="true" />
          <input type="search" aria-label="搜索当前文件夹" placeholder={`搜索${currentName}`}
            value={query} onChange={event => { setQuery(event.target.value); if (listing.current) listing.current.scrollTop = 0 }} />
        </label>
      </div>
      <div className="file-location-tools">
        <button type="button" className="app-control" disabled={!available || creatingFolder}
          onClick={() => setNewFolder('')}>
          <FolderPlus size={16} aria-hidden="true" />新建文件夹
        </button>
        {creatingFolder && <form className="file-location-new-folder" onSubmit={createFolder}>
          <input ref={folderInput} aria-label="文件夹名称" placeholder="文件夹名称" value={newFolder}
            aria-invalid={!!folderError} aria-describedby={folderError ? `${id}-folder-error` : undefined}
            onChange={event => { setNewFolder(event.target.value); setFolderError('') }} />
          <button type="submit" className="app-control" disabled={!available}>创建</button>
          <button type="button" className="app-control" onClick={() => { setNewFolder(undefined); setFolderError(''); listing.current?.focus() }}>取消</button>
        </form>}
      </div>
      {props.warning && <p className="file-location-error" role="status">{props.warning}</p>}
      {locationError && <p className="file-location-error" role="alert">{locationError}</p>}
      {folderError && <p className="file-location-error" id={`${id}-folder-error`} role="alert">{folderError}</p>}
      <div className="file-location-browser">
        <nav className="file-location-places" aria-label="常用位置">
          <button type="button" className="app-control" aria-current={available && directory === data?.home ? 'location' : undefined}
            disabled={busy} onClick={() => navigate(data?.home ?? '')}><House size={16} aria-hidden="true" />主目录</button>
          <button type="button" className="app-control" aria-current={directory === '/' ? 'location' : undefined}
            disabled={busy} onClick={() => navigate('/')}><HardDrive size={16} aria-hidden="true" />根目录</button>
        </nav>
        <div className="file-location-list" ref={listing} tabIndex={-1} role="region" aria-label={`${currentName}的内容`}>
          <table aria-label="文件和文件夹">
            <thead><tr><th scope="col">名称</th><th scope="col">类型</th><th scope="col">大小</th></tr></thead>
            <tbody>
              {entries.map(file => (
                <tr key={file.id} data-folder={!!file.directory}>
                  <td>{file.directory
                    ? <button type="button" title={file.name} className="file-location-entry" onClick={() => navigate(file.directory!)}>
                      <FileIcon file={file} /><span className="truncate">{file.name}</span>
                    </button>
                    : <span className="file-location-entry" title={file.name}><FileIcon file={file} /><span className="truncate">{file.name}</span></span>}
                  </td>
                  <td className="truncate">{file.type}</td>
                  <td>{file.size}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!entries.length && <p className="file-location-empty" role="status">{loading ? '正在读取目录…' : query.trim() ? '没有匹配的文件或文件夹。' : '此文件夹为空。'}</p>}
        </div>
      </div>
      {props.mode === 'save' ? <form className="file-location-form" onSubmit={save}>
        <div className="file-location-fields">
          <label htmlFor={`${id}-filename`}>文件名</label>
          <input id={`${id}-filename`} ref={filenameInput} value={filename}
            aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined}
            onChange={event => { setFilename(event.target.value); setError(''); setConflictPath(undefined) }} />
          <label htmlFor={`${id}-type`}>保存类型</label>
          <select id={`${id}-type`} value={selectedFormat} onChange={event => {
            const next = event.target.value
            const input = filename
            setFormat(next)
            const extension = fileExtension(input)
            if (extension) setFilename(`${input.slice(0, -extension.length)}.${next}`)
            setError('')
            setConflictPath(undefined)
          }}>
            {Object.entries(props.formats).map(([extension, { type }]) => (
              <option key={extension} value={extension}>{type} (*.{extension})</option>
            ))}
          </select>
          {error && <p className="file-location-error" id={`${id}-error`} role="alert">{error}</p>}
        </div>
        <div className="service-dialog-actions">
          <button className="app-control primary-control" type="submit" disabled={!available}>保存</button>
          {conflictPath && <button className="app-control" type="button" disabled={!available}
            onClick={() => void saveTo(conflictPath, 'keep')}>保留两者</button>}
          <button className="app-control" type="button" disabled={busy} onClick={onCancel}>取消</button>
        </div>
      </form> : <footer className="file-location-form">
        {!canSelect && <p className="file-location-error" role="status">
          {available ? '无法使用当前文件夹，请选择其他位置。' : '目标文件夹已不可用，请重新选择。'}
        </p>}
        <div className="service-dialog-actions">
          <button className="app-control primary-control" type="button" disabled={!canSelect}
            onClick={() => props.onSelect(directory)}>{props.actionLabel}</button>
          <button className="app-control" type="button" disabled={busy} onClick={onCancel}>取消</button>
        </div>
      </footer>}
      <div className="file-location-resize" aria-hidden="true" onPointerDown={startResize} onPointerMove={resizeDialog}
        onPointerUp={event => endResize(event.pointerId)} onPointerCancel={event => endResize(event.pointerId, true)}
        onLostPointerCapture={event => endResize(event.pointerId)} />
    </dialog>
  )
}
