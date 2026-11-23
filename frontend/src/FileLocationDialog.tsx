import { useId, useLayoutEffect, useRef, useState, type FormEvent, type PointerEvent } from 'react'
import { ArrowLeft, ArrowRight, ArrowUp, ChevronRight, Folder, FolderPlus, House, Search, X } from 'lucide-react'
import { home, locationChain, locationName, type Entry } from './fileSystem'
import { FileIcon } from './fileIcons'
import './styles/file-location-dialog.css'

type Position = { x: number; y: number }
type Drag = { pointerId: number; handle: HTMLElement; start: Position; origin: Position }

type FileLocationDialogProps = {
  title: string
  files: Entry[]
  initialDirectory?: string
  onCreateFolder: (parent: string, name: string) => string
  onCancel: () => void
} & ({
  mode: 'save'
  formats: Readonly<Record<string, { type: string }>>
  defaultExtension: string
  initialName?: string
  onSave: (file: Pick<Entry, 'parent' | 'name' | 'type'>) => void
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
  return name && name !== '.' && name !== '..' && !/[/\\]/.test(name)
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
  const { title, files, initialDirectory = home, onCreateFolder, onCancel } = props
  const id = useId()
  const modal = useRef<HTMLDialogElement>(null)
  const drag = useRef<Drag>(undefined)
  const position = useRef<Position>({ x: 0, y: 0 })
  const address = useRef<HTMLElement>(null)
  const listing = useRef<HTMLDivElement>(null)
  const filenameInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)
  const [history, setHistory] = useState({ paths: [initialDirectory], index: 0 })
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
  const requestedDirectory = history.paths[history.index]
  const chain = locationChain(files, requestedDirectory)
  const available = requestedDirectory === home || (
    chain[0]?.parent === home && chain.at(-1)?.directory === requestedDirectory
  )
  const directory = available ? requestedDirectory : home
  const breadcrumbs = [{ id: home, name: locationName(home) }, ...(available ? chain : [])]
  const currentName = breadcrumbs.at(-1)!.name
  const children = files.filter(file => file.parent === directory)
  const entries = children.filter(file => file.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((a, b) => Number(!!b.directory) - Number(!!a.directory) || a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))
  const typedExtension = fileExtension(filename.trim()).slice(1).toLowerCase()
  const selectedFormat = props.mode === 'save' && Object.hasOwn(props.formats, typedExtension) ? typedExtension : format
  const canSelect = available && (props.mode === 'save' || props.canSelect(directory))

  useLayoutEffect(() => {
    const element = modal.current!
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
  }, [directory, currentName])

  useLayoutEffect(() => {
    if (creatingFolder) folderInput.current?.focus()
  }, [creatingFolder])

  function changeLocation(next: typeof history) {
    setHistory(next)
    setQuery('')
    setError('')
    setNewFolder(undefined)
    setFolderError('')
    if (listing.current) {
      listing.current.scrollTop = 0
      listing.current.focus()
    }
  }

  function navigate(target: string) {
    if (target === requestedDirectory) return
    changeLocation({ paths: [...history.paths.slice(0, history.index + 1), target], index: history.index + 1 })
  }

  function startDrag(event: PointerEvent<HTMLElement>) {
    if (drag.current || event.button !== 0 || (event.target instanceof Element && event.target.closest('button'))) return
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

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (props.mode !== 'save') return
    const { formats, onSave } = props
    const input = filename.trim()
    const extension = fileExtension(input)
    const name = extension ? input : `${input}.${selectedFormat}`
    const key = extension ? extension.slice(1).toLowerCase() : selectedFormat
    if (!validName(input)) setError('请输入有效的文件名，文件名中不能包含路径分隔符。')
    else if (!Object.hasOwn(formats, key)) setError('请选择支持的文件类型，或修改文件扩展名。')
    else if (!available) return
    else if (children.some(file => file.name === name)) setError('此文件夹已有同名项，请更换文件名。')
    else {
      onSave({ name, parent: directory, type: formats[key].type })
      return
    }
    filenameInput.current?.focus()
  }

  function createFolder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = newFolder?.trim() ?? ''
    if (!validName(name)) setFolderError('请输入有效的文件夹名称，名称中不能包含路径分隔符。')
    else if (!available) return
    else if (children.some(file => file.name === name)) setFolderError('此位置已有同名项，请更换文件夹名称。')
    else {
      navigate(onCreateFolder(directory, name))
      return
    }
    folderInput.current?.focus()
  }

  return (
    <dialog ref={modal} className="service-dialog file-location-dialog" aria-labelledby={`${id}-title`}
      onCancel={event => {
        event.preventDefault()
        event.stopPropagation()
        if (drag.current) endDrag(drag.current.pointerId, true)
        else onCancel()
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
        <button className="app-control file-location-icon" type="button" aria-label="关闭" onClick={onCancel}>
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      <div className="file-location-navigation">
        <div className="file-location-arrows" aria-label="目录导航" role="group">
          <button type="button" className="app-control file-location-icon" title="后退" aria-label="后退"
            disabled={history.index === 0} onClick={() => changeLocation({ ...history, index: history.index - 1 })}>
            <ArrowLeft size={16} aria-hidden="true" />
          </button>
          <button type="button" className="app-control file-location-icon" title="前进" aria-label="前进"
            disabled={history.index === history.paths.length - 1} onClick={() => changeLocation({ ...history, index: history.index + 1 })}>
            <ArrowRight size={16} aria-hidden="true" />
          </button>
          <button type="button" className="app-control file-location-icon" title="上一级" aria-label="上一级"
            disabled={directory === home} onClick={() => navigate(breadcrumbs.at(-2)!.id)}>
            <ArrowUp size={16} aria-hidden="true" />
          </button>
        </div>
        <nav ref={address} className="file-location-breadcrumbs" aria-label="当前路径">
          {breadcrumbs.map((crumb, index) => (
            <div key={crumb.id}>
              {index > 0 && <ChevronRight size={13} aria-hidden="true" />}
              {index === breadcrumbs.length - 1
                ? <span className="file-location-crumb" title={crumb.name} aria-current="location">
                  {index === 0 && <House size={15} aria-hidden="true" />}<span className="truncate">{crumb.name}</span>
                </span>
                : <button type="button" title={crumb.name} className="app-control file-location-crumb" onClick={() => navigate(crumb.id)}>
                  {index === 0 && <House size={15} aria-hidden="true" />}<span className="truncate">{crumb.name}</span>
                </button>}
            </div>
          ))}
        </nav>
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
      {folderError && <p className="file-location-error" id={`${id}-folder-error`} role="alert">{folderError}</p>}
      <div className="file-location-browser">
        <nav className="file-location-places" aria-label="常用位置">
          <button type="button" className="app-control" aria-current={available && directory === home ? 'location' : undefined}
            onClick={() => navigate(home)}><House size={16} aria-hidden="true" />主目录</button>
          {files.filter(file => file.parent === home && file.directory).map(file => (
            <button type="button" className="app-control" key={file.id} title={file.name}
              aria-current={directory === file.directory ? 'location' : undefined} onClick={() => navigate(file.directory!)}>
              <Folder size={16} aria-hidden="true" /><span className="truncate">{file.name}</span>
            </button>
          ))}
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
          {!entries.length && <p className="file-location-empty" role="status">{query.trim() ? '没有匹配的文件或文件夹。' : '此文件夹为空。'}</p>}
        </div>
      </div>
      {props.mode === 'save' ? <form className="file-location-form" onSubmit={save}>
        <div className="file-location-fields">
          <label htmlFor={`${id}-filename`}>文件名</label>
          <input id={`${id}-filename`} ref={filenameInput} value={filename}
            aria-invalid={!!error} aria-describedby={error || !available ? `${id}-error` : undefined}
            onChange={event => { setFilename(event.target.value); setError('') }} />
          <label htmlFor={`${id}-type`}>保存类型</label>
          <select id={`${id}-type`} value={selectedFormat} onChange={event => {
            const next = event.target.value
            const input = filename.trim()
            setFormat(next)
            const extension = fileExtension(input)
            if (extension) setFilename(`${input.slice(0, -extension.length)}.${next}`)
            setError('')
          }}>
            {Object.entries(props.formats).map(([extension, { type }]) => (
              <option key={extension} value={extension}>{type} (*.{extension})</option>
            ))}
          </select>
          {(error || !available) && <p className="file-location-error" id={`${id}-error`} role="alert">
            {available ? error : '目标文件夹已不可用，请重新选择。'}
          </p>}
        </div>
        <div className="service-dialog-actions">
          <button className="app-control primary-control" type="submit" disabled={!available}>保存</button>
          <button className="app-control" type="button" onClick={onCancel}>取消</button>
        </div>
      </form> : <footer className="file-location-form">
        {!canSelect && <p className="file-location-error" role="status">
          {available ? '无法使用当前文件夹，请选择其他位置。' : '目标文件夹已不可用，请重新选择。'}
        </p>}
        <div className="service-dialog-actions">
          <button className="app-control primary-control" type="button" disabled={!canSelect}
            onClick={() => props.onSelect(directory)}>{props.actionLabel}</button>
          <button className="app-control" type="button" onClick={onCancel}>取消</button>
        </div>
      </footer>}
    </dialog>
  )
}
