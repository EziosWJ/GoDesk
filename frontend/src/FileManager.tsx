import { useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState } from 'react'
import type { DragEvent, FormEvent, KeyboardEvent, MouseEvent } from 'react'
import {
  ArrowLeft, ArrowRight, ArrowUp, ChevronDown, ChevronRight, ClipboardPaste, Copy, Download, Eye, EyeOff, HardDrive,
  Folder, FolderOpen, FolderPlus, Grid2X2, House, Image as ImageIcon, Info, LayoutList, List, MapPin, MoreHorizontal, Pencil, RefreshCw, Scissors, Search, Shield, Trash2, Upload, UsersRound, X,
} from 'lucide-react'

import { CommandMenu, type MenuAnchor, type MenuCommand, type MenuGroup } from './CommandMenu'
import { FileLocationDialog } from './FileLocationDialog'
import { FileImagePreview } from './FileImagePreview'
import { FileIcon } from './fileIcons'

import {
  announceFileChange, canTransfer, downloadFile, errorMessage,
  FileError, fileAction, filename, imageFile, managedFile, parentPath, pathCrumbs, readDirectory, readFileIdentity,
  regularFile, subscribeToFileChanges, uploadFile, writeOwnership, writePermissions, type Conflict, type HostFile,
} from './hostFiles'

type Command = MenuCommand & { group: 'open' | 'edit' | 'organize' | 'transfer' | 'delete' }
type Popup = MenuAnchor & { groups: MenuGroup[]; kind: 'context' | 'actions' | 'layout'; layer: HTMLElement; zIndex: number }
type Transfer = { kind: 'move' | 'copy'; ids: string[]; target: string }
type Job = { elevated: boolean } & (
  | { kind: 'copy' | 'move' | 'delete'; path: string; target?: string }
  | { kind: 'upload'; file: File; target: string })
type Outcome = { job: Job; status: 'success' | 'skipped' | 'conflict' | 'failed'; message: string; retry?: boolean }
type Modal =
  | { kind: 'destination'; operation: Transfer['kind']; ids: string[] }
  | { kind: 'image'; file: HostFile; elevated: boolean }
  | { kind: 'delete'; jobs: Job[] }
  | { kind: 'conflict' }
  | { kind: 'results' }

const operationLabel = { move: '移动', copy: '复制' }

function jobName(job: Job) {
  return job.kind === 'upload' ? job.file.name : filename(job.path)
}
type Panel = 'locations' | 'properties'

const layouts = {
  list: { label: '列表', icon: List },
  tiles: { label: '平铺', icon: LayoutList },
  icons: { label: '大图标', icon: Grid2X2 },
} as const
type FileLayout = keyof typeof layouts
const layoutPreference = 'react-web-desktop-file-layout'
const layoutKeys = Object.keys(layouts) as FileLayout[]
const popupLabels = { context: '文件上下文菜单', actions: '更多操作', layout: '文件布局' }
const clipboardActions = [
  { label: '剪切', Icon: Scissors },
  { label: '复制', Icon: Copy },
  { label: '粘贴', Icon: ClipboardPaste },
]
const managementActions = [
  { label: '下载', Icon: Download },
  { label: '永久删除', Icon: Trash2 },
]

function readLayout(): FileLayout {
  try {
    const value = localStorage.getItem(layoutPreference)
    return layoutKeys.find(key => key === value) ?? 'list'
  } catch {
    return 'list'
  }
}

function isHiddenEntry(file: HostFile) {
  return file.name.startsWith('.')
}

function fileMenuGroups(commands: Command[]): MenuGroup[] {
  const group = (name: Command['group']) => commands.filter(command => command.group === name)
  const transfers = group('transfer')
  return [
    group('open'),
    group('edit'),
    [
      ...group('organize'),
      ...(transfers.length ? [{ label: '移动或复制', icon: Folder, groups: [transfers] }] : []),
    ],
    group('delete'),
  ]
}

type PropertyEdit =
  | { kind: 'ownership'; owner: string; group: string; originalOwner: string; originalGroup: string }
  | { kind: 'permissions'; mode: string; originalMode: string }

function FilePropertyActions({ file, open, elevated }: { file: HostFile; open: () => void; elevated: boolean }) {
  const [form, setForm] = useState<PropertyEdit>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const editOwnership = useRef<HTMLButtonElement>(null)
  const editPermissions = useRef<HTMLButtonElement>(null)
  const modeHint = useId()
  const ownership = form?.kind === 'ownership' ? {
    owner: form.owner.trim() === form.originalOwner ? undefined : form.owner.trim(),
    group: form.group.trim() === form.originalGroup ? undefined : form.group.trim(),
  } : undefined
  const mode = form?.kind === 'permissions' ? form.mode.trim() : ''
  const canSave = form?.kind === 'permissions'
    ? mode.padStart(4, '0') !== form.originalMode
    : !!ownership && (ownership.owner !== undefined || ownership.group !== undefined)

  function close() {
    const edit = form?.kind === 'permissions' ? editPermissions : editOwnership
    setForm(undefined)
    requestAnimationFrame(() => edit.current?.focus())
  }

  function start(next: PropertyEdit) {
    setError('')
    setForm(next)
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || !canSave) return
    setBusy(true)
    setError('')
    try {
      if (ownership) await writeOwnership(file.id, ownership, elevated)
      else await writePermissions(file.id, mode, elevated)
      announceFileChange()
      close()
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  if (form) return <form className="file-property-form" onSubmit={save} onKeyDown={event => {
    if (event.key !== 'Escape' || busy) return
    event.preventDefault()
    event.stopPropagation()
    close()
  }}>
    {form.kind === 'ownership' ? <>
      <label>所有者<input autoFocus required value={form.owner} disabled={busy} onChange={event => setForm({ ...form, owner: event.target.value })} /></label>
      <label>所属组<input required value={form.group} disabled={busy} onChange={event => setForm({ ...form, group: event.target.value })} /></label>
    </> : <>
      <label>八进制权限<input autoFocus required className="file-mode-input" inputMode="numeric" value={form.mode}
        aria-describedby={modeHint} disabled={busy} onFocus={event => event.target.select()}
        onChange={event => setForm({ ...form, mode: event.target.value })} /></label>
      <p id={modeHint} className="muted">输入 3 或 4 位八进制值，例如 <code>644</code>、<code>0755</code>。</p>
    </>}
    {error && <p role="alert">{error}</p>}
    <div>
      <button className="app-control primary-control" type="submit" disabled={busy || !canSave}>保存</button>
      <button className="app-control" type="button" disabled={busy} onClick={close}>取消</button>
    </div>
  </form>

  const regular = regularFile(file)
  const image = imageFile(file)
  const openable = file.directory || regular || file.targetError
  const OpenIcon = image ? ImageIcon : regular ? Pencil : FolderOpen
  return <div className="file-property-actions">
    {managedFile(file) && <div className="file-property-edits">
      <button className="app-control" ref={editOwnership} onClick={() => start({ kind: 'ownership',
        owner: file.owner, group: file.group, originalOwner: file.owner, originalGroup: file.group })}>
        <UsersRound size={15} aria-hidden="true" />修改所有权
      </button>
      {(file.kind === 'file' || file.kind === 'directory') && <button className="app-control" ref={editPermissions}
        onClick={() => start({ kind: 'permissions', mode: file.mode, originalMode: file.mode })}>
        <Shield size={15} aria-hidden="true" />修改权限
      </button>}
    </div>}
    {openable && <button className="app-control file-property-open" onClick={open}>
      <OpenIcon size={16} aria-hidden="true" />
      {file.directory ? '打开文件夹' : image ? '打开图片' : regular ? '在文本编辑器中打开' : '打开链接'}
    </button>}
  </div>
}

export function FileManager({ onOpenText }: { onOpenText: (path: string, elevated: boolean, readOnly: boolean) => void }) {
  const [history, setHistory] = useState({ locations: [] as string[], index: -1 })
  const [directory, setDirectory] = useState<Awaited<ReturnType<typeof readDirectory>>>()
  const [runningAsRoot, setRunningAsRoot] = useState<boolean>()
  const [elevated, setElevated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [directoryError, setDirectoryError] = useState('')
  const [address, setAddress] = useState<string>()
  const currentCrumb = useRef<HTMLButtonElement>(null)
  const [operation, setOperation] = useState('')
  const [outcomes, setOutcomes] = useState<Outcome[]>([])
  const operationLock = useRef(false)
  const currentPath = useRef('')
  const directoryRequest = useRef<AbortController>(undefined)
  const navigating = useRef(false)
  const uploadInput = useRef<HTMLInputElement>(null)
  const fileDragDepth = useRef(0)
  const [fileDragging, setFileDragging] = useState(false)
  const path = directory?.path ?? ''
  const [query, setQuery] = useState('')
  const [selection, setSelection] = useState<string[]>([])
  const [layout, setLayout] = useState(readLayout)
  const [showHidden, setShowHidden] = useState(false)
  const layoutScrollTarget = useRef<string>(undefined)
  const [clipboard, setClipboard] = useState<{ kind: 'move' | 'copy'; ids: string[] }>()
  const [feedback, setFeedback] = useState('')
  const [rename, setRename] = useState<{ id: string; name: string }>()
  const [popup, setPopup] = useState<Popup>()
  const popupId = useId()
  const [modal, setModal] = useState<Modal>()
  const canUpload = !!path && !loading && !directoryError && !operation && !modal
  const [dropTarget, setDropTarget] = useState<string>()
  const dragItems = useRef<string[]>([])
  const anchor = useRef<string>(undefined)
  const focusedEntry = useRef<string>(undefined)
  const views = useRef(new Map<string, { selection: string[]; scroll: number; focused?: string }>())
  const pendingView = useRef<string>(undefined)
  const needsRowFocus = useRef<string>(undefined)
  const dialog = useRef<HTMLDialogElement>(null)
  const modalSource = useRef<HTMLElement | null>(null)
  const more = useRef<HTMLButtonElement>(null)
  const [panel, setPanel] = useState<Panel>()
  const [inlineInspector, setInlineInspector] = useState(false)
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const navigation = useRef<HTMLElement>(null)
  const inspector = useRef<HTMLElement>(null)
  const locationButton = useRef<HTMLButtonElement>(null)
  const propertiesButton = useRef<HTMLButtonElement>(null)
  const inspectorClose = useRef<HTMLButtonElement>(null)
  const lastFocus = useRef<HTMLElement | null>(null)

  useLayoutEffect(() => {
    const container = root.current!
    const rememberFocus = (event: FocusEvent) => {
      lastFocus.current = event.target instanceof HTMLElement && container.contains(event.target) ? event.target : null
    }
    document.addEventListener('focusin', rememberFocus)
    const observer = new ResizeObserver(() => {
      const panes = list.current?.parentElement
      if (!panes || !container.clientWidth) return
      const layout = getComputedStyle(panes)
      const inline = layout.getPropertyValue('--file-inspector-position').trim() === 'static'
      setInlineInspector(inline)
      setPanel(current => {
        if (current === 'locations' && layout.getPropertyValue('--file-sidebar-position') === 'static') return undefined
        if (current === 'properties' && inline) return undefined
        return current
      })
      const focused = lastFocus.current
      if (!focused || focused.getClientRects().length ||
          (document.activeElement !== focused && document.activeElement !== document.body)) return
      if (focused === locationButton.current || focused.classList.contains('file-close-locations')) {
        const currentLocation = navigation.current?.querySelector<HTMLButtonElement>('[aria-current="location"]')
          ?? navigation.current?.querySelector<HTMLButtonElement>('button:not(.file-close-locations)')
        currentLocation?.focus({ preventScroll: true })
      } else if (navigation.current?.contains(focused)) {
        locationButton.current?.focus({ preventScroll: true })
      } else if (focused.classList.contains('file-extra-action')) {
        more.current?.focus({ preventScroll: true })
      } else if (inspector.current?.contains(focused)) {
        propertiesButton.current?.focus({ preventScroll: true })
      }
    })
    observer.observe(container)
    return () => {
      document.removeEventListener('focusin', rememberFocus)
      observer.disconnect()
    }
  }, [])

  useLayoutEffect(() => {
    if (panel === 'locations') (navigation.current?.querySelector<HTMLButtonElement>('[aria-current="location"]')
      ?? navigation.current?.querySelector<HTMLButtonElement>('button:not(.file-close-locations)'))?.focus()
    if (panel === 'properties') inspectorClose.current?.focus()
  }, [panel])

  const directoryEntries = directory?.entries ?? []
  const filter = query.trim().toLocaleLowerCase()
  const entries = directoryEntries.filter(file =>
    (showHidden || !isHiddenEntry(file)) && (!filter || file.name.toLocaleLowerCase().includes(filter)),
  )
  const selectedItems = entries.filter(file => selection.includes(file.id))
  const selected = selectedItems.length === 1 ? selectedItems[0] : undefined
  const crumbs = pathCrumbs(path)
  const pathText = path || '主目录'
  const parent = path && path !== '/' ? parentPath(path) : undefined
  const locations = [
    { id: directory?.home ?? '', name: '主目录', Icon: House },
    { id: '/', name: '根目录', Icon: HardDrive },
  ]
  const clipboardIds = clipboard?.ids ?? []

  function rowElement(id: string, selector = '') {
    return list.current?.querySelector<HTMLButtonElement>(`[data-entry-id="${CSS.escape(id)}"]${selector}`)
  }

  function focusRow(id?: string, preventScroll = true) {
    const row = id && rowElement(id, ' .file-name')
    if (row) row.focus({ preventScroll })
    else list.current?.focus({ preventScroll })
  }

  useLayoutEffect(() => {
    const id = layoutScrollTarget.current
    layoutScrollTarget.current = undefined
    if (id) rowElement(id)?.scrollIntoView({ block: 'nearest' })
  }, [layout])

  function changeLayout(next: FileLayout) {
    if (next === layout) return
    layoutScrollTarget.current = selectedItems.find(file => file.id === focusedEntry.current)?.id ?? selectedItems[0]?.id
    setLayout(next)
    try {
      localStorage.setItem(layoutPreference, next)
    } catch {
      // The layout still applies for this window.
    }
  }

  useLayoutEffect(() => {
    const view = views.current.get(path)
    if (pendingView.current === path) {
      pendingView.current = undefined
      if (list.current) list.current.scrollTop = view?.scroll ?? 0
      const row = view?.focused && rowElement(view.focused, ' .file-name')
      if (row) row.focus({ preventScroll: true })
      else list.current?.focus({ preventScroll: true })
    }
  }, [path])

  useLayoutEffect(() => {
    const id = needsRowFocus.current
    if (id === undefined) return
    needsRowFocus.current = undefined
    const row = rowElement(id, ' .file-name')
    if (row) row.focus()
    else list.current?.focus({ preventScroll: true })
  })

  useLayoutEffect(() => {
    const element = dialog.current
    if (!modal || !element) return
    if (!element.open) element.showModal()
    element.querySelector<HTMLElement>('select, button')?.focus()
  }, [modal])

  async function loadDirectory(next: string, navigation?: (target: string) => void, asRoot = elevated) {
    if (!navigation && navigating.current) return
    directoryRequest.current?.abort()
    const controller = new AbortController()
    directoryRequest.current = controller
    navigating.current = !!navigation
    setLoading(true)
    try {
      const data = await readDirectory(next, controller.signal, asRoot)
      if (controller.signal.aborted) return
      navigation?.(data.path)
      currentPath.current = data.path
      setDirectory(data)
      setDirectoryError('')
    } catch (error) {
      if (controller.signal.aborted) return
      if (navigation && currentPath.current) setFeedback(errorMessage(error))
      else {
        setDirectory(previous => previous && { ...previous, entries: [] })
        setDirectoryError(errorMessage(error))
      }
    } finally {
      if (directoryRequest.current === controller) {
        navigating.current = false
        setLoading(false)
      }
    }
  }

  const refreshDirectory = useEffectEvent(() => void loadDirectory(currentPath.current))

  useEffect(() => {
    const identityRequest = new AbortController()
    void readFileIdentity(identityRequest.signal).then(identity => {
      if (!identityRequest.signal.aborted) setRunningAsRoot(identity.root)
    }).catch(error => {
      if (!identityRequest.signal.aborted) setFeedback(errorMessage(error))
    })
    let active = true
    void Promise.resolve().then(() => {
      if (!active) return
      return loadDirectory('', target => setHistory({ locations: [target], index: 0 }))
    })
    const unsubscribe = subscribeToFileChanges(refreshDirectory)
    return () => {
      active = false
      identityRequest.abort()
      directoryRequest.current?.abort()
      unsubscribe()
    }
  }, [])

  function toggleElevation() {
    const next = !elevated
    setElevated(next)
    setSelection([])
    anchor.current = undefined
    focusedEntry.current = undefined
    views.current.clear()
    setPopup(undefined)
    setPanel(undefined)
    setFeedback('')
    setDirectory(previous => previous && { ...previous, entries: [] })
    void loadDirectory(currentPath.current, undefined, next)
  }

  function navigate(next: string, historyIndex?: number) {
    void loadDirectory(next, target => {
      if (target !== path) {
        views.current.set(path, { selection, scroll: list.current?.scrollTop ?? 0, focused: focusedEntry.current })
        pendingView.current = target
        focusedEntry.current = views.current.get(target)?.focused
        anchor.current = focusedEntry.current
        setSelection(views.current.get(target)?.selection ?? [])
        setQuery('')
        setRename(undefined)
        setHistory(historyIndex === undefined
          ? { locations: [...history.locations.slice(0, history.index + 1), target], index: history.index + 1 }
          : { ...history, index: historyIndex })
      }
      setFeedback('')
      setAddress(undefined)
      setPopup(undefined)
      setPanel(undefined)
    })
  }

  function historyTarget(direction: number) {
    const index = history.index + direction
    const id = history.locations[index]
    return id ? { id, index } : undefined
  }

  function closePanel(which: Panel) {
    setPanel(undefined)
    if (which === 'locations') locationButton.current?.focus()
    else {
      if (inlineInspector) {
        setInspectorCollapsed(true)
      }
      requestAnimationFrame(() => propertiesButton.current?.focus())
    }
  }

  const propertiesOpen = inlineInspector ? !inspectorCollapsed : panel === 'properties'
  const previous = historyTarget(-1)
  const forward = historyTarget(1)

  function showModal(next: Modal) {
    if (!modal) modalSource.current = popup?.source ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    if (next.kind === 'destination') dialog.current?.close()
    setModal(next)
  }

  function closeModal(restore = true) {
    dialog.current?.close()
    setModal(undefined)
    if (restore) requestAnimationFrame(() => {
      const source = modalSource.current
      if (source?.getClientRects().length && !source.matches(':disabled')) source.focus({ preventScroll: true })
      else focusRow(selection[0])
    })
  }

  function download(path: string) {
    void downloadFile(path, elevated).catch(error => setFeedback(errorMessage(error)))
  }

  function openEntry(file: HostFile, readOnly = false) {
    const asRoot = elevated || runningAsRoot === true
    if (file.directory) navigate(file.id)
    else if (imageFile(file)) showModal({ kind: 'image', file, elevated: asRoot })
    else if (regularFile(file)) onOpenText(file.id, asRoot, readOnly)
    else if (file.targetError) setFeedback(file.targetError)
  }

  async function createFolder() {
    if (!path || directoryError || operationLock.current) return
    operationLock.current = true
    setOperation('正在新建文件夹…')
    try {
      for (let number = 0; ; number++) {
        const name = number ? `新建文件夹 (${number})` : '新建文件夹'
        try {
          const result = await fileAction('mkdir', path, { name }, elevated)
          if (currentPath.current === path) {
            setQuery('')
            setSelection([result.path])
            setRename({ id: result.path, name })
          }
          setFeedback(`已新建「${name}」`)
          announceFileChange()
          break
        } catch (error) {
          if (!(error instanceof FileError) || error.code !== 'exists') throw error
        }
      }
    } catch (error) {
      setFeedback(errorMessage(error))
    } finally {
      operationLock.current = false
      setOperation('')
    }
  }

  async function finishRename() {
    if (!rename || operationLock.current) return
    const name = rename.name
    if (!name || name === '.' || name === '..' || name.includes('/')) {
      setFeedback('请输入有效名称，名称中不能包含斜杠')
      return
    }
    operationLock.current = true
    setOperation('正在重命名…')
    try {
      const result = await fileAction('rename', rename.id, { name }, elevated)
      setRename(undefined)
      if (currentPath.current === path) {
        setSelection([result.path])
        if (!name.toLocaleLowerCase().includes(filter)) setQuery('')
      }
      setFeedback(`已重命名为「${name}」`)
      if (rename.id !== result.path) announceFileChange({ from: rename.id, to: result.path })
    } catch (error) {
      setFeedback(error instanceof FileError && error.code === 'exists' ? `此位置已有「${name}」，请输入其他名称` : errorMessage(error))
    } finally {
      operationLock.current = false
      setOperation('')
    }
  }

  async function runJobs(jobs: Job[], conflict?: Conflict, previous: Outcome[] = []) {
    if (!jobs.length || operationLock.current) return
    operationLock.current = true
    let results = previous
    setOutcomes(results)
    for (const [index, job] of jobs.entries()) {
      const name = jobName(job)
      const progress = `${index + 1}/${jobs.length} · ${name}`
      setOperation(progress)
      let outcome: Outcome
      try {
        const result = job.kind === 'upload'
          ? await uploadFile(job.target, job.file, conflict, percent => setOperation(`${progress} · ${percent}%`), job.elevated)
          : await fileAction(job.kind, job.path, { destination: job.target, conflict }, job.elevated)
        outcome = result.skipped
          ? { job, status: 'skipped', message: '已跳过' }
          : { job, status: 'success', message: `已完成 · ${result.path}` }
        if (!result.skipped && job.kind === 'move') {
          announceFileChange({ from: job.path, to: result.path, copied: result.copied })
          setClipboard(current => current?.kind === 'move' ? { ...current, ids: current.ids.filter(id => id !== job.path) } : current)
        }
      } catch (error) {
        const fileError = error instanceof FileError ? error : undefined
        outcome = fileError?.code === 'exists' && job.kind !== 'delete'
          ? { job, status: 'conflict', message: '目标位置有同名项' }
          : { job, status: 'failed', message: fileError?.path ? `${errorMessage(error)} · ${fileError.path}` : errorMessage(error),
            retry: fileError?.code !== 'source_cleanup_failed' }
      }
      results = [...results, outcome]
      setOutcomes(results)
    }
    operationLock.current = false
    setOperation('')
    const succeeded = results.filter(item => item.status === 'success').length
    const skipped = results.filter(item => item.status === 'skipped').length
    const failed = results.filter(item => item.status === 'failed').length
    const conflicts = results.filter(item => item.status === 'conflict').length
    setFeedback(`完成 ${succeeded} 项，跳过 ${skipped} 项，失败 ${failed} 项${conflicts ? `，${conflicts} 项待处理` : ''}`)
    announceFileChange()
    if (conflicts) showModal({ kind: 'conflict' })
    else if (failed) showModal({ kind: 'results' })
  }

  function requestTransfer(transfer: Transfer) {
    if (!canTransfer(transfer.ids, transfer.target, transfer.kind === 'move')) {
      setFeedback('请选择其他目标文件夹')
      return
    }
    if (modal) closeModal()
    void runJobs(transfer.ids.map(id => ({ kind: transfer.kind, path: id, target: transfer.target, elevated })))
  }

  function commandsFor(ids: string[], contextEntry?: HostFile): Command[] {
    const entry = ids.length === 1 ? entries.find(file => file.id === ids[0]) : undefined
    const pasteTarget = contextEntry?.directory ?? path
    const canEdit = !!path && !directoryError && !operation
    const actionable = ids.length > 0 && ids.every(id => entries.some(file => file.id === id && managedFile(file)))
    const result: Command[] = []
    if (entry && (entry.directory || regularFile(entry) || entry.targetError)) result.push({
      label: entry.directory ? '打开' : imageFile(entry) ? '打开图片' : regularFile(entry) ? '在文本编辑器中打开' : '打开链接',
      icon: imageFile(entry) ? ImageIcon : regularFile(entry) ? Pencil : FolderOpen,
      group: 'open', shortcut: 'Enter', run: () => openEntry(entry),
    })
    if (entry && regularFile(entry)) result.push(
      { label: '预览', icon: Eye, group: 'open', run: () => openEntry(entry, true) },
      { label: '下载', icon: Download, group: 'open', run: () => download(entry.id) },
    )
    if (canEdit && actionable) {
      if (entry) result.push({ label: '重命名', icon: Pencil, group: 'edit', shortcut: 'F2', run: () => setRename({ id: entry.id, name: entry.name }) })
      for (const kind of ['move', 'copy'] as const) {
        result.push({
          label: kind === 'move' ? '剪切' : '复制', icon: kind === 'move' ? Scissors : Copy,
          group: 'edit', shortcut: kind === 'move' ? 'Ctrl+X' : 'Ctrl+C',
          run: () => {
            setClipboard({ kind, ids })
            setFeedback(`已${kind === 'move' ? '剪切' : '复制'} ${ids.length} 项，可前往目标目录粘贴`)
          },
        })
      }
      for (const operation of ['move', 'copy'] as const) {
        result.push({
          label: `${operationLabel[operation]}到…`, icon: operation === 'move' ? FolderOpen : Copy,
          group: 'transfer', run: () => showModal({ kind: 'destination', operation, ids }),
        })
      }
      result.push({ label: '永久删除', icon: Trash2, group: 'delete', danger: true, shortcut: 'Delete',
        run: () => showModal({ kind: 'delete', jobs: ids.map(path => ({ kind: 'delete', path, elevated })) }) })
    }
    if (canEdit) result.push(
      { label: '新建文件夹', icon: FolderPlus, group: 'organize', shortcut: 'Ctrl+Shift+N', run: createFolder },
      { label: '上传文件', icon: Upload, group: 'organize', disabled: !canUpload, run: () => uploadInput.current?.click() },
      { label: '粘贴', icon: ClipboardPaste, group: 'edit', shortcut: 'Ctrl+V',
        disabled: !clipboard || !canTransfer(clipboardIds, pasteTarget, clipboard.kind === 'move'),
        run: () => { if (clipboard) requestTransfer({ ...clipboard, ids: clipboardIds, target: pasteTarget }) } },
    )
    return result
  }

  function showPopup(source: HTMLElement, groups: MenuGroup[], kind: Popup['kind'], event?: MouseEvent) {
    const window = source.closest<HTMLElement>('[data-app-window]')
    setPopup({
      groups, source, kind,
      point: event && { x: event.clientX, y: event.clientY },
      layer: window?.parentElement ?? root.current!,
      zIndex: Number(window?.style.zIndex) || 0,
    })
  }

  function openPopup(source: HTMLElement, commands: Command[], event?: MouseEvent) {
    showPopup(source, fileMenuGroups(commands), 'context', event)
  }

  function openLayout(source: HTMLElement) {
    showPopup(source, [layoutKeys.map(key => ({
      ...layouts[key], checked: layout === key, run: () => changeLayout(key),
    }))], 'layout')
  }

  function contextMenu(event: MouseEvent<HTMLElement>, entry?: HostFile) {
    event.preventDefault()
    event.stopPropagation()
    if (rename) return
    const ids = entry ? selection.includes(entry.id) ? selectedItems.map(file => file.id) : [entry.id] : []
    if (entry && !selection.includes(entry.id)) {
      setSelection(ids)
      anchor.current = entry.id
      focusRow(entry.id)
    }
    const source = entry ? event.currentTarget.querySelector('button') ?? event.currentTarget : event.currentTarget
    openPopup(source, commandsFor(ids, ids.length === 1 ? entry : undefined), event)
  }

  function restorePopupFocus(source: HTMLElement) {
    if (source.getClientRects().length && !source.matches(':disabled')) source.focus({ preventScroll: true })
    else focusRow(selection[0])
  }

  function select(entry: HostFile, extend: boolean, toggle: boolean) {
    const first = entries.findIndex(file => file.id === anchor.current)
    const last = entries.indexOf(entry)
    const range = entries.slice(Math.min(first, last), Math.max(first, last) + 1).map(file => file.id)
    if (extend && first >= 0) setSelection(toggle ? [...new Set([...selection, ...range])] : range)
    else {
      anchor.current = entry.id
      setSelection(toggle ? selection.includes(entry.id) ? selection.filter(id => id !== entry.id) : [...selection, entry.id] : [entry.id])
    }
  }

  function uploadFiles(files: File[]) {
    if (!canUpload || operationLock.current || !files.length) return
    setPopup(undefined)
    void runJobs(files.map(file => ({ kind: 'upload', file, target: path, elevated })))
  }

  function handleFileDragEnter(event: DragEvent) {
    if (!event.dataTransfer.types.includes('Files')) return
    fileDragDepth.current++
    setFileDragging(true)
  }

  function handleFileDragOver(event: DragEvent) {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = canUpload ? 'copy' : 'none'
  }

  function handleFileDragLeave() {
    if (fileDragDepth.current > 0 && --fileDragDepth.current === 0) setFileDragging(false)
  }

  function handleFileDrop(event: DragEvent) {
    const transfer = event.dataTransfer
    if (!transfer.types.includes('Files')) return
    event.preventDefault()
    fileDragDepth.current = 0
    setFileDragging(false)
    if (!canUpload) return
    const items = Array.from(transfer.items)
    const files = items.length
      ? items.flatMap(item => {
        if (item.kind !== 'file' || item.webkitGetAsEntry?.()?.isDirectory) return []
        const file = item.getAsFile()
        return file ? [file] : []
      })
      : Array.from(transfer.files)
    if (files.length) uploadFiles(files)
    else setFeedback('请拖入本地文件，文件夹暂不支持上传')
  }

  function clearDrag() {
    dragItems.current = []
    setDropTarget(undefined)
  }

  function dropHandlers(target: string) {
    return {
      onDragOver(event: DragEvent) {
        if (!canTransfer(dragItems.current, target, true) || operationLock.current) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        setDropTarget(target)
      },
      onDragLeave(event: DragEvent) {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
        setDropTarget(current => current === target ? undefined : current)
      },
      onDrop(event: DragEvent) {
        if (!dragItems.current.length) return
        event.preventDefault()
        const ids = dragItems.current
        clearDrag()
        if (canTransfer(ids, target, true)) requestTransfer({ kind: 'move', ids, target })
      },
      'data-drop-target': dropTarget === target || undefined,
    }
  }

  function handleKey(event: KeyboardEvent) {
    if (event.nativeEvent.isComposing || event.defaultPrevented) return
    const ctrl = event.ctrlKey || event.metaKey
    if (!modal && !popup && !rename && ctrl && !event.altKey && event.key.toLowerCase() === 'f') {
      event.preventDefault()
      search.current?.focus()
      search.current?.select()
      return
    }
    if (event.key === 'Escape') {
      if (modal) return
      if (event.target === search.current && query) changeQuery('')
      else if (dragItems.current.length) clearDrag()
      else if (panel && !popup) closePanel(panel)
      else return
      event.stopPropagation()
      event.preventDefault()
      return
    }
    if (modal || popup || event.target instanceof HTMLInputElement) return
    const inList = event.target instanceof HTMLElement && list.current?.contains(event.target)
    const itemId = inList ? (event.target as HTMLElement).closest<HTMLElement>('[data-entry-id]')?.dataset.entryId : undefined
    const entry = entries.find(file => file.id === itemId)
    const ids = entry && !selection.includes(entry.id) ? [entry.id] : selectedItems.map(file => file.id)
    if ((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu') {
      if (!inList) return
      event.preventDefault()
      if (entry && !selection.includes(entry.id)) setSelection([entry.id])
      openPopup(event.target as HTMLElement, commandsFor(entry ? ids : [], ids.length === 1 ? entry : undefined))
      return
    }
    const directions = layout === 'list' ? ['ArrowUp', 'ArrowDown'] : ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']
    if (inList && [...directions, 'Home', 'End'].includes(event.key) && !event.altKey) {
      const index = entry ? entries.indexOf(entry) : -1
      const grid = layout === 'list' ? null : list.current?.querySelector('.file-grid')
      const columns = grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 1
      let nextIndex = Math.max(0, index)
      const lastIndex = entries.length - 1
      if (event.key === 'Home') nextIndex = 0
      else if (event.key === 'End') nextIndex = lastIndex
      else if (index >= 0) {
        const column = index % columns
        if (event.key === 'ArrowUp' && index >= columns) nextIndex -= columns
        if (event.key === 'ArrowDown' && index - column + columns <= lastIndex) nextIndex = Math.min(index + columns, lastIndex)
        if (event.key === 'ArrowLeft' && column > 0) nextIndex--
        if (event.key === 'ArrowRight' && column < columns - 1 && index < lastIndex) nextIndex++
      }
      const next = entries[nextIndex]
      if (next) {
        event.preventDefault()
        if (!ctrl || event.shiftKey) select(next, event.shiftKey, ctrl)
        focusRow(next.id, false)
      }
      return
    }
    if (inList && ctrl && event.key.toLowerCase() === 'a') {
      event.preventDefault()
      setSelection(entries.map(file => file.id))
      return
    }
    if (entry && event.key === 'Enter' && !ctrl) {
      event.preventDefault()
      openEntry(entry)
      return
    }
    if ((!inList && !ctrl) || event.altKey) return
    const shortcut = ctrl ? `Ctrl+${event.shiftKey ? 'Shift+' : ''}${event.key.toUpperCase()}` : event.key
    const command = commandsFor(ids).find(item => item.shortcut === shortcut && !item.disabled)
    if (command) {
      event.preventDefault()
      command.run()
    }
  }

  const selectedIds = selectedItems.map(file => file.id)
  const LayoutIcon = layouts[layout].icon
  const emptyMessage = loading ? '正在读取目录…' : directoryError || (filter ? '没有匹配的文件或文件夹' : '此文件夹为空')

  function changeQuery(value: string) {
    setQuery(value)
    setSelection([])
    setRename(undefined)
    anchor.current = undefined
    if (list.current) list.current.scrollTop = 0
  }

  function toggleHidden() {
    if (showHidden) {
      const hiddenIds = new Set(directoryEntries.filter(isHiddenEntry).map(file => file.id))
      setSelection(current => current.filter(id => !hiddenIds.has(id)))
      if (anchor.current && hiddenIds.has(anchor.current)) anchor.current = undefined
      if (focusedEntry.current && hiddenIds.has(focusedEntry.current)) focusedEntry.current = undefined
      if (rename && hiddenIds.has(rename.id)) setRename(undefined)
    }
    setShowHidden(!showHidden)
  }

  function toolbarAction({ label, Icon }: { label: string; Icon: typeof Copy }) {
    const manageable = selectedItems.length > 0 && selectedItems.every(managedFile)
    const disabled = label === '下载' ? !regularFile(selected)
      : !!operation || !!directoryError || (label === '粘贴'
        ? !clipboard || !canTransfer(clipboardIds, path, clipboard.kind === 'move')
        : !manageable)
    return (
      <button key={label} className="app-control file-tool file-extra-action" aria-label={label} title={label}
        disabled={disabled} onClick={() => commandsFor(selectedIds).find(item => item.label === label)?.run()}>
        <Icon size={16} aria-hidden="true" />
      </button>
    )
  }

  function locationItem({ id, name, Icon }: (typeof locations)[number]) {
    return (
      <button key={id} className="app-control" aria-current={path === id ? 'location' : undefined}
        title={name} onClick={() => navigate(id)} {...dropHandlers(id)}>
        <Icon size={16} aria-hidden="true" /><span className="truncate">{name}</span>
      </button>
    )
  }

  function renderEntry(file: HostFile) {
    const active = selection.includes(file.id)
    const editing = rename?.id === file.id
    const details = layout === 'tiles' ? [file.type, file.size].filter(Boolean).join(' · ') : undefined
    const itemProps = {
      'data-entry-id': file.id,
      'data-selected': active,
      'data-cut': clipboard?.kind === 'move' && clipboardIds.includes(file.id),
      draggable: managedFile(file) && !editing && !operation,
      onDragStart(event: DragEvent) {
        if (editing || !managedFile(file) || operationLock.current) return event.preventDefault()
        dragItems.current = active ? selectedItems.filter(managedFile).map(item => item.id) : [file.id]
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('application/x-react-web-desktop-files', 'move')
      },
      onDragEnd: clearDrag,
      ...(file.directory ? dropHandlers(file.id) : {}),
      onContextMenu: (event: MouseEvent<HTMLElement>) => contextMenu(event, file),
      onClick(event: MouseEvent) {
        if (editing) return
        select(file, event.shiftKey, event.ctrlKey || event.metaKey)
        focusRow(file.id)
      },
      onDoubleClick: () => { if (!editing) openEntry(file) },
    }
    const name = editing ? (
      <form className="file-rename" onSubmit={event => { event.preventDefault(); finishRename() }}>
        <FileIcon file={file} />
        <input aria-label="名称" value={rename.name}
          ref={element => { if (element && document.activeElement !== element) { element.focus(); element.select() } }}
          onChange={event => setRename({ id: file.id, name: event.target.value })}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing || event.key !== 'Escape') return
            event.stopPropagation()
            event.preventDefault()
            setRename(undefined)
            needsRowFocus.current = file.id
          }} />
        <button className="app-control" type="submit">保存</button>
      </form>
    ) : (
      <button className="app-control file-name" aria-pressed={active} aria-label={file.name} aria-description={details}>
        <FileIcon file={file} />
        <span className="file-name-text">
          <span className="file-display-name" title={file.name}>{file.name}</span>
          {details && <small title={details}>{details}</small>}
        </span>
      </button>
    )
    if (layout === 'list') return (
      <tr key={file.id} {...itemProps}>
        <td>{name}</td><td>{file.type}</td><td>{file.owner}</td><td>{file.group}</td>
        <td><code>{file.permissions}</code></td><td>{file.size ?? '—'}</td>
      </tr>
    )
    return <li className="file-grid-entry" key={file.id} {...itemProps}>{name}</li>
  }

  return (
    <div ref={root} className="file-manager @container/app" data-panel={panel}
      data-inspector-collapsed={inspectorCollapsed} onKeyDown={handleKey}
      onDragEnter={handleFileDragEnter} onDragOver={handleFileDragOver}
      onDragLeave={handleFileDragLeave} onDrop={handleFileDrop}>
      <div className="file-toolbar file-navigation">
        <div className="file-tool-group" role="group" aria-label="目录导航">
          <button className="app-control file-tool" aria-label="返回" title="返回" disabled={!previous}
            onClick={() => previous && navigate(previous.id, previous.index)}><ArrowLeft size={16} aria-hidden="true" /></button>
          <button className="app-control file-tool" aria-label="前进" title="前进" disabled={!forward}
            onClick={() => forward && navigate(forward.id, forward.index)}><ArrowRight size={16} aria-hidden="true" /></button>
          <button className="app-control file-tool" aria-label="上一级" title="上一级" disabled={!parent}
            onClick={() => parent && navigate(parent)}><ArrowUp size={16} aria-hidden="true" /></button>
          <button className="app-control file-tool" aria-label="刷新" title="刷新" onClick={() => void loadDirectory(path)}>
            <RefreshCw size={16} aria-hidden="true" />
          </button>
        </div>
        {address !== undefined ? <form className="file-address-form" onKeyDown={event => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          setAddress(undefined)
          setFeedback('')
          requestAnimationFrame(() => currentCrumb.current?.focus())
        }} onSubmit={event => {
          event.preventDefault()
          if (address.startsWith('/')) navigate(address)
          else setFeedback('请输入以 / 开头的绝对路径')
        }}>
          <input autoFocus aria-label="绝对路径" value={address} onChange={event => setAddress(event.target.value)}
            onFocus={event => event.target.select()} />
          <button className="app-control" type="submit">前往</button>
        </form> : <nav className="file-path" aria-label="当前路径" title={pathText} onClick={event => {
          if (!(event.target as Element).closest('button')) setAddress(path)
        }}>
          <ol>
            {crumbs.map((crumb, index) => (
              <li key={crumb.id}>
                {index > 0 && <ChevronRight size={13} aria-hidden="true" />}
                {index === crumbs.length - 1
                  ? <button type="button" className="app-control" aria-current="page" title="编辑绝对路径"
                    onClick={() => setAddress(path)} ref={element => {
                    currentCrumb.current = element
                    const nav = element?.closest('nav')
                    if (nav) nav.scrollLeft = nav.scrollWidth
                  }}>{index === 0 && <HardDrive size={15} aria-hidden="true" />}{crumb.name}</button>
                  : <button className="app-control" onClick={() => navigate(crumb.id)}>
                    {index === 0 && <HardDrive size={15} aria-hidden="true" />}{crumb.name}
                  </button>}
              </li>
            ))}
          </ol>
        </nav>}
        <label className="file-search">
          <Search size={16} aria-hidden="true" />
          <input ref={search} type="search" aria-label="搜索当前文件夹" placeholder="搜索文件"
            title="搜索当前文件夹 (Ctrl+F)" value={query} onChange={event => changeQuery(event.target.value)} />
        </label>
      </div>
      <div className="file-toolbar file-actions" aria-label="文件操作" role="group">
        <button ref={locationButton} className="app-control file-locations-button" aria-label="位置" aria-controls="file-locations"
          aria-expanded={panel === 'locations'} onClick={() => panel === 'locations' ? closePanel('locations') : setPanel('locations')}>
          <MapPin size={16} aria-hidden="true" /><span>位置</span>
        </button>
        <button className="app-control primary-control" disabled={!path || !!directoryError || !!operation}
          onClick={createFolder} title="新建文件夹 (Ctrl+Shift+N)" aria-label="新建文件夹">
          <FolderPlus size={16} aria-hidden="true" /><span className="file-new-label">新建文件夹</span>
        </button>
        <button className="app-control file-tool" aria-label="上传文件" title="上传文件"
          disabled={!canUpload} onClick={() => uploadInput.current?.click()}>
          <Upload size={16} aria-hidden="true" />
        </button>
        <input ref={uploadInput} type="file" aria-label="选择上传文件" hidden multiple onChange={event => {
          const files = Array.from(event.target.files ?? [])
          event.target.value = ''
          uploadFiles(files)
        }} />
        <div className="file-tool-group file-extra-tools" role="group" aria-label="剪贴板">
          {clipboardActions.map(toolbarAction)}
        </div>
        <div className="file-tool-group file-extra-tools" role="group" aria-label="管理文件">
          {managementActions.map(toolbarAction)}
        </div>
        <button ref={more} className="app-control file-tool file-more" aria-label="更多" title="更多操作"
          aria-haspopup="menu" aria-expanded={popup?.kind === 'actions'}
          aria-controls={popup?.kind === 'actions' ? popupId : undefined}
          onKeyDown={event => {
            if (event.key !== 'ArrowDown' || event.nativeEvent.isComposing) return
            event.preventDefault()
            if (popup?.kind !== 'actions') showPopup(event.currentTarget, fileMenuGroups(commandsFor(selectedIds)), 'actions')
          }}
          onClick={event => popup?.kind === 'actions' ? setPopup(undefined)
            : showPopup(event.currentTarget, fileMenuGroups(commandsFor(selectedIds)), 'actions')}>
          <MoreHorizontal size={17} aria-hidden="true" />
        </button>
        <button type="button" className="app-control file-tool file-hidden-toggle" aria-label="显示隐藏文件"
          aria-pressed={showHidden} title={showHidden ? '不显示隐藏文件' : '显示隐藏文件'} onClick={toggleHidden}>
          {showHidden ? <Eye size={16} aria-hidden="true" /> : <EyeOff size={16} aria-hidden="true" />}
        </button>
        {runningAsRoot === true ? <span className="file-root-status">
          <Shield size={16} aria-hidden="true" />root
        </span> : <button type="button" className={`app-control${elevated ? ' primary-control' : ''}`} aria-pressed={elevated}
          disabled={runningAsRoot === undefined || loading || !!operation || !!modal || !!rename}
          onClick={toggleElevation}>
          <Shield size={16} aria-hidden="true" /><span>管理员模式</span>
        </button>}
        <span className="file-action-spacer" />
        <button className="app-control file-layout-button" aria-label="布局" title={`布局：${layouts[layout].label}`}
          aria-haspopup="menu" aria-expanded={popup?.kind === 'layout'}
          aria-controls={popup?.kind === 'layout' ? popupId : undefined}
          onKeyDown={event => {
            if (event.key !== 'ArrowDown' || event.nativeEvent.isComposing) return
            event.preventDefault()
            if (popup?.kind !== 'layout') openLayout(event.currentTarget)
          }}
          onClick={event => popup?.kind === 'layout' ? setPopup(undefined) : openLayout(event.currentTarget)}>
          <LayoutIcon size={16} aria-hidden="true" /><span className="file-layout-label">布局</span>
          <ChevronDown className="file-layout-label" size={12} aria-hidden="true" />
        </button>
        <button ref={propertiesButton} className="app-control file-properties-button" aria-label="属性" aria-controls="file-inspector"
          aria-expanded={propertiesOpen} onClick={() => {
            if (propertiesOpen) closePanel('properties')
            else {
              setInspectorCollapsed(false)
              if (inlineInspector) requestAnimationFrame(() => inspectorClose.current?.focus())
              else setPanel('properties')
            }
          }}>
          <Info size={16} aria-hidden="true" /><span>属性</span>
        </button>
      </div>
      <div className="file-panes">
        <nav id="file-locations" ref={navigation} className="file-sidebar" aria-label="位置导航">
          <div className="file-panel-heading file-location-heading"><h2>位置</h2>
            <button className="app-control file-close-locations" aria-label="关闭位置" onClick={() => closePanel('locations')}><X size={16} aria-hidden="true" /></button>
          </div>
          <div className="file-location-group">
            <h3>快速访问</h3>
            {locations.map(locationItem)}
          </div>
        </nav>
        <div ref={list} className="file-list" role="region" aria-label={layout === 'list' ? '文件列表' : '文件'} tabIndex={0}
          onContextMenu={event => contextMenu(event)}
          onClick={event => { if (!(event.target as HTMLElement).closest('[data-entry-id]')) setSelection([]) }}
          onFocusCapture={event => {
            setPanel(undefined)
            focusedEntry.current = (event.target as HTMLElement).closest<HTMLElement>('[data-entry-id]')?.dataset.entryId
          }}>
          {layout === 'list' ? (
            <table className="data-table file-table" aria-label={pathText}>
              <thead><tr><th scope="col">名称</th><th scope="col">类型</th><th scope="col">所有者</th>
                <th scope="col">所属组</th><th scope="col">权限</th><th scope="col">大小</th></tr></thead>
              <tbody>
                {entries.map(renderEntry)}
                {!entries.length && <tr><td colSpan={6} className="muted">{emptyMessage}</td></tr>}
              </tbody>
            </table>
          ) : (
            <>
              <ul className="file-grid" data-layout={layout} aria-label={pathText}>{entries.map(renderEntry)}</ul>
              {!entries.length && <p className="file-grid-empty muted">{emptyMessage}</p>}
            </>
          )}
        </div>
        <aside id="file-inspector" ref={inspector} className="file-inspector" aria-labelledby="file-inspector-title">
          <div className="file-panel-heading"><h2 id="file-inspector-title">属性</h2>
            <button ref={inspectorClose} className="app-control" aria-label="关闭属性" onClick={() => closePanel('properties')}><X size={16} aria-hidden="true" /></button>
          </div>
          {selected ? <>
            <div className="file-object">
              <FileIcon file={selected} />
              <p className="file-object-name">{selected.name}</p>
            </div>
            <dl>
              <div><dt>类型</dt><dd>{selected.type}</dd></div>
              <div><dt>位置</dt><dd>{pathText}</dd></div>
              {selected.size && <div><dt>大小</dt><dd>{selected.size}</dd></div>}
              <div><dt>所有者</dt><dd>{selected.owner}</dd></div>
              <div><dt>所属组</dt><dd>{selected.group}</dd></div>
              <div><dt>权限</dt><dd className="file-permission-values"><code>{selected.permissions}</code><code>{selected.mode}</code></dd></div>
            </dl>
            <FilePropertyActions key={selected.id} file={selected} elevated={elevated} open={() => openEntry(selected)} />
          </> : <p className="muted">{selectedItems.length ? `已选中 ${selectedItems.length} 项` : '选择文件或文件夹以查看属性。'}</p>}
        </aside>
      </div>
      <footer className="app-statusbar file-status">
        <span>{selectedItems.length ? `已选中 ${selectedItems.length} 项` : `${entries.length} 项`}</span>
        <span role="status" title={operation || feedback}>{operation || feedback}</span>
        {outcomes.length > 0 && <button className="app-control" disabled={!!operation} onClick={() =>
          showModal({ kind: outcomes.some(item => item.status === 'conflict') ? 'conflict' : 'results' })}>操作结果</button>}
      </footer>
      {fileDragging && canUpload && <div className="file-upload-drop" aria-hidden="true">
        <span><Upload size={18} />松开以上传到当前目录</span>
      </div>}
      {popup && <CommandMenu key={popup.kind} id={popupId} label={popupLabels[popup.kind]}
        variant={popup.kind === 'layout' ? 'choice' : undefined}
        anchor={popup} groups={popup.groups} layer={popup.layer}
        boundary={popup.kind === 'layout' ? popup.source.closest<HTMLElement>('[data-app-window]') ?? popup.layer : popup.layer}
        zIndex={popup.zIndex}
        onClose={() => setPopup(undefined)} restoreFocus={() => restorePopupFocus(popup.source)} />}
      {modal?.kind === 'destination' && <FileLocationDialog mode="folder" initialDirectory={path} elevated={elevated}
        title={`${operationLabel[modal.operation]}到…`} actionLabel={operationLabel[modal.operation]}
        canSelect={directory => canTransfer(modal.ids, directory, modal.operation === 'move')}
        onSelect={target => requestTransfer({ kind: modal.operation, ids: modal.ids, target })}
        onCancel={() => closeModal()} />}
      {modal?.kind === 'image' && <FileImagePreview key={modal.file.id} ref={dialog} file={modal.file}
        elevated={modal.elevated} onClose={() => closeModal()} />}
      {modal && modal.kind !== 'destination' && modal.kind !== 'image' && <dialog className="service-dialog file-dialog" ref={dialog} aria-labelledby="file-dialog-title"
        onCancel={event => { event.preventDefault(); event.stopPropagation(); closeModal() }}>
        <div className="service-dialog-body">
          <h2 id="file-dialog-title">{modal.kind === 'delete' ? `永久删除 ${modal.jobs.length} 项？`
            : modal.kind === 'conflict' ? '目标位置有同名项' : '操作结果'}</h2>
          {modal.kind === 'delete' ? <ul className="file-dialog-list">{modal.jobs.map(job => <li key={jobName(job)}>{jobName(job)}</li>)}</ul>
            : <ul className="file-dialog-list">{outcomes.map((item, index) => (
              <li key={index}>
                <strong>{jobName(item.job)}</strong> · {item.message}
                {item.retry && <button className="app-control" onClick={() => {
                  closeModal()
                  void runJobs([item.job], undefined, outcomes.filter(outcome => outcome !== item))
                }}>重试</button>}
              </li>
            ))}</ul>}
        </div>
        <div className="service-dialog-actions">
          <button className="app-control" onClick={() => closeModal()}>{modal.kind === 'results' ? '关闭' : '取消'}</button>
          {modal.kind === 'delete' && <button className="app-control" onClick={() => {
            closeModal()
            void runJobs(modal.jobs)
          }}>永久删除</button>}
          {modal.kind === 'conflict' && ([['skip', '跳过同名项'], ['keep', '保留两者']] as const).map(([choice, label]) =>
            <button key={choice} className="app-control" onClick={() => {
              closeModal()
              void runJobs(outcomes.filter(item => item.status === 'conflict').map(item => item.job), choice,
                outcomes.filter(item => item.status !== 'conflict'))
            }}>{label}</button>)}
        </div>
      </dialog>}
    </div>
  )
}
