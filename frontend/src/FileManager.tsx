import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { Dispatch, DragEvent, KeyboardEvent, MouseEvent, SetStateAction } from 'react'
import {
  Archive, ArchiveRestore, ArrowLeft, ArrowRight, ArrowUp, ChevronDown, ChevronRight, ClipboardPaste, Copy, Download, Eye, EyeOff, FileText,
  Folder, FolderOpen, FolderPlus, Grid2X2, House, Info, LayoutList, List, MapPin, MoreHorizontal, Pencil, Scissors, Search, Trash2, Undo2, X,
} from 'lucide-react'

import { CommandMenu, type MenuAnchor, type MenuCommand, type MenuGroup } from './CommandMenu'
import { FileLocationDialog } from './FileLocationDialog'
import { FileIcon } from './fileIcons'

import {
  availableName, canTransfer, editableFile, folder, home, homePath, inTrash, locationChain, locationName, transferConflicts, transferFiles, trash, undoFileOperation,
} from './fileSystem'
import type { ConflictChoice, Entry, Transfer } from './fileSystem'

type Command = MenuCommand & { group: 'open' | 'edit' | 'organize' | 'transfer' | 'history' | 'delete' }
type Popup = MenuAnchor & { groups: MenuGroup[]; kind: 'context' | 'actions' | 'layout'; layer: HTMLElement; zIndex: number }
type Modal =
  | { kind: 'preview'; entry: Entry }
  | { kind: 'destination'; operation: Transfer['kind']; ids: string[] }
  | { kind: 'conflict'; transfer: Transfer }

const operationLabel = { move: '移动', copy: '复制', extract: '解压' }

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
const quickFolders = [
  { id: 'docs', Icon: FileText },
  { id: 'downloads', Icon: Download },
  { id: 'projects', Icon: Folder },
]
const clipboardActions = [
  { label: '剪切', Icon: Scissors },
  { label: '复制', Icon: Copy },
  { label: '粘贴', Icon: ClipboardPaste },
]
const managementActions = [
  { label: '移到回收站', Icon: Trash2 },
  { label: '撤销', Icon: Undo2 },
]

function readLayout(): FileLayout {
  try {
    const value = localStorage.getItem(layoutPreference)
    return layoutKeys.find(key => key === value) ?? 'list'
  } catch {
    return 'list'
  }
}

function isHiddenEntry(file: Entry) {
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
    group('history'),
    group('delete'),
  ]
}

export function FileManager({ files, setFiles, makeId, onEdit }: {
  files: Entry[]
  setFiles: Dispatch<SetStateAction<Entry[]>>
  makeId: () => string
  onEdit: (id: string) => void
}) {
  const [history, setHistory] = useState({ locations: [home], index: 0 })
  const requestedPath = history.locations[history.index]
  const path = requestedPath === trash || !inTrash(files, requestedPath) && files.some(file => file.id === requestedPath)
    ? requestedPath : home
  const [query, setQuery] = useState('')
  const [selection, setSelection] = useState<string[]>([])
  const [layout, setLayout] = useState(readLayout)
  const [showHidden, setShowHidden] = useState(false)
  const layoutScrollTarget = useRef<string>(undefined)
  const [clipboard, setClipboard] = useState<{ kind: 'move' | 'copy'; ids: string[] }>()
  const [undoStack, setUndoStack] = useState<{ before: Entry[]; after: Entry[]; selection: string[]; path: string }[]>([])
  const [feedback, setFeedback] = useState('')
  const [rename, setRename] = useState<{ id: string; name: string }>()
  const [popup, setPopup] = useState<Popup>()
  const popupId = useId()
  const [modal, setModal] = useState<Modal>()
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

  const directoryEntries = files.filter(file => file.parent === path)
  const filter = query.trim().toLocaleLowerCase()
  const entries = directoryEntries.filter(file =>
    (showHidden || !isHiddenEntry(file)) && (!filter || file.name.toLocaleLowerCase().includes(filter)),
  )
  const selectedItems = entries.filter(file => selection.includes(file.id))
  const selected = selectedItems.length === 1 ? selectedItems[0] : undefined
  const crumbs = locationChain(files, path)
  const pathText = path === trash ? '回收站' : [homePath, ...crumbs.map(file => file.name)].join('/')
  const parent = crumbs.at(-1)?.parent
  const locations = [
    { id: home, name: '主目录', Icon: House },
    ...quickFolders.flatMap(({ id, Icon }) => {
      const entry = files.find(file => file.id === id && (showHidden || !isHiddenEntry(file)) && !inTrash(files, id))
      return entry ? [{ id, name: entry.name, Icon }] : []
    }),
  ]
  const clipboardIds = clipboard?.ids.filter(id => files.some(file => file.id === id) && !inTrash(files, id)) ?? []

  function focusRow(id?: string, preventScroll = true) {
    const row = id && list.current?.querySelector<HTMLButtonElement>(`[data-entry-id="${id}"] .file-name`)
    if (row) row.focus({ preventScroll })
    else list.current?.focus({ preventScroll })
  }

  useLayoutEffect(() => {
    const id = layoutScrollTarget.current
    layoutScrollTarget.current = undefined
    if (id) list.current?.querySelector(`[data-entry-id="${id}"]`)?.scrollIntoView({ block: 'nearest' })
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
      const row = view?.focused && list.current?.querySelector<HTMLButtonElement>(`[data-entry-id="${view.focused}"] .file-name`)
      if (row) row.focus({ preventScroll: true })
      else list.current?.focus({ preventScroll: true })
    }
  }, [path])

  useLayoutEffect(() => {
    const id = needsRowFocus.current
    if (id === undefined) return
    needsRowFocus.current = undefined
    const row = list.current?.querySelector<HTMLButtonElement>(`[data-entry-id="${id}"] .file-name`)
    if (row) row.focus()
    else list.current?.focus({ preventScroll: true })
  })

  useLayoutEffect(() => {
    const element = dialog.current
    if (!modal || !element) return
    if (!element.open) element.showModal()
    element.querySelector<HTMLElement>('select, button')?.focus()
  }, [modal])

  function navigate(next: string, historyIndex?: number) {
    if (next === path && historyIndex === undefined) {
      if (panel) closePanel(panel)
      return
    }
    views.current.set(path, {
      selection,
      scroll: list.current?.scrollTop ?? 0,
      focused: focusedEntry.current,
    })
    if (next !== path) pendingView.current = next
    focusedEntry.current = views.current.get(next)?.focused
    anchor.current = focusedEntry.current
    setSelection(views.current.get(next)?.selection ?? [])
    setQuery('')
    setRename(undefined)
    setPopup(undefined)
    setPanel(undefined)
    setHistory(historyIndex === undefined
      ? { locations: [...history.locations.slice(0, history.index + 1), next], index: history.index + 1 }
      : { ...history, index: historyIndex })
  }

  function historyTarget(direction: number) {
    for (let index = history.index + direction; index >= 0 && index < history.locations.length; index += direction) {
      const id = history.locations[index]
      if (id === home || id === trash || files.some(file => file.id === id && !inTrash(files, id))) return { id, index }
    }
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

  function commit(next: Entry[], message: string, nextSelection = selection) {
    setUndoStack(stack => [...stack, { before: files, after: next, selection, path }])
    setFiles(next)
    setSelection(nextSelection)
    setFeedback(message)
  }

  function undo() {
    const previous = undoStack.at(-1)
    if (!previous) return
    setUndoStack(undoStack.slice(0, -1))
    setFiles(current => undoFileOperation(previous.before, previous.after, current))
    if (previous.path === path) {
      setQuery('')
      setSelection(previous.selection)
      needsRowFocus.current = previous.selection[0] ?? ''
    }
    setFeedback('已撤销上次文件操作')
  }

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

  function openEntry(file: Entry) {
    if (file.directory && path !== trash) navigate(file.id)
    else if (editableFile(files, file)) onEdit(file.id)
    else if (!file.directory) showModal({ kind: 'preview', entry: file })
  }

  function createFolder() {
    const id = makeId()
    const entry = folder(id, path, availableName(files, path, '新建文件夹'))
    anchor.current = id
    setQuery('')
    commit([...files, entry], `已新建「${entry.name}」`, [id])
    setRename({ id, name: entry.name })
  }

  function createDestinationFolder(parent: string, name: string) {
    const id = makeId()
    commit([...files, folder(id, parent, name)], `已新建「${name}」`)
    return id
  }

  function finishRename() {
    if (!rename) return
    const entry = files.find(file => file.id === rename.id)
    if (!entry) return
    const name = rename.name.trim()
    const invalidCharacter = [...name].some(character => character === '/' || character === '\\' || character.charCodeAt(0) < 32)
    if (!name || name === '.' || name === '..' || invalidCharacter) {
      setFeedback('请输入有效名称，名称中不能包含斜杠或控制字符')
      return
    }
    if (directoryEntries.some(file => file.id !== entry.id && file.name === name)) {
      setFeedback(`此位置已有「${name}」，请输入其他名称`)
      return
    }
    setRename(undefined)
    needsRowFocus.current = entry.id
    if (name !== entry.name) {
      if (!name.toLocaleLowerCase().includes(filter)) setQuery('')
      commit(files.map(file => file.id === entry.id ? { ...file, name } : file), `已重命名为「${name}」`)
    }
  }

  function putInTrash(ids: string[]) {
    commit(files.map(file => ids.includes(file.id) ? { ...file, parent: trash } : file), `已将 ${ids.length} 项移到回收站`, [])
    needsRowFocus.current = entries.find(entry => !ids.includes(entry.id))?.id ?? ''
  }

  function executeTransfer(transfer: Transfer, choice: ConflictChoice = 'keep') {
    const { files: next, completed, skipped } = transferFiles(files, transfer, choice, makeId)
    if (completed.length) {
      const nextSelection = transfer.kind === 'move' ? selection.filter(id => !completed.includes(id)) : selection
      commit(next, `已${operationLabel[transfer.kind]} ${completed.length} 项${skipped ? `，已跳过 ${skipped} 项` : ''}`, nextSelection)
      if (transfer.kind === 'move' && clipboard?.kind === 'move') {
        setClipboard({ ...clipboard, ids: clipboard.ids.filter(id => !completed.includes(id)) })
      }
      if (!modal) needsRowFocus.current = nextSelection[0] ?? ''
    } else setFeedback(`已跳过 ${skipped} 项同名内容`)
  }

  function requestTransfer(transfer: Transfer) {
    if (!canTransfer(files, transfer.ids, transfer.target, transfer.kind === 'move')) {
      setFeedback('请选择其他目标文件夹')
      return
    }
    if (transferConflicts(files, transfer).length) showModal({ kind: 'conflict', transfer })
    else {
      if (modal) closeModal()
      executeTransfer(transfer)
    }
  }

  function commandsFor(ids: string[], contextEntry?: Entry): Command[] {
    const entry = ids.length === 1 ? entries.find(file => file.id === ids[0]) : undefined
    const pasteTarget = contextEntry?.directory ?? path
    const canEdit = path !== trash
    const result: Command[] = []
    if (entry && (canEdit || !entry.directory)) result.push({
      label: entry.directory ? '打开' : entry.archive ? '查看压缩包' : editableFile(files, entry) ? '在文本编辑器中打开' : '预览',
      icon: entry.directory ? FolderOpen : entry.archive ? Archive : editableFile(files, entry) ? Pencil : Eye,
      group: 'open', shortcut: 'Enter', run: () => openEntry(entry),
    })
    if (canEdit && ids.length) {
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
      for (const operation of ['move', 'copy'] as const) result.push({
        label: `${operationLabel[operation]}到…`, icon: operation === 'move' ? FolderOpen : Copy,
        group: 'transfer', run: () => showModal({ kind: 'destination', operation, ids }),
      })
      if (entry?.archive) result.push({
        label: '解压到…', icon: ArchiveRestore, group: 'organize', run: () => showModal({ kind: 'destination', operation: 'extract', ids }),
      })
      result.push({ label: '移到回收站', icon: Trash2, group: 'delete', danger: true, shortcut: 'Delete', run: () => putInTrash(ids) })
    }
    if (canEdit) result.push(
      { label: '新建文件夹', icon: FolderPlus, group: 'organize', shortcut: 'Ctrl+Shift+N', run: createFolder },
      { label: '粘贴', icon: ClipboardPaste, group: 'edit', shortcut: 'Ctrl+V',
        disabled: !clipboard || !canTransfer(files, clipboardIds, pasteTarget, clipboard.kind === 'move'),
        run: () => { if (clipboard) requestTransfer({ ...clipboard, ids: clipboardIds, target: pasteTarget }) } },
    )
    result.push({ label: '撤销', icon: Undo2, group: 'history', shortcut: 'Ctrl+Z', disabled: !undoStack.length, run: undo })
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

  function contextMenu(event: MouseEvent<HTMLElement>, entry?: Entry) {
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

  function select(entry: Entry, extend: boolean, toggle: boolean) {
    const first = entries.findIndex(file => file.id === anchor.current)
    const last = entries.indexOf(entry)
    const range = entries.slice(Math.min(first, last), Math.max(first, last) + 1).map(file => file.id)
    if (extend && first >= 0) setSelection(toggle ? [...new Set([...selection, ...range])] : range)
    else {
      anchor.current = entry.id
      setSelection(toggle ? selection.includes(entry.id) ? selection.filter(id => id !== entry.id) : [...selection, entry.id] : [entry.id])
    }
  }

  function clearDrag() {
    dragItems.current = []
    setDropTarget(undefined)
  }

  function dropHandlers(target: string) {
    return {
      onDragOver(event: DragEvent) {
        if (!canTransfer(files, dragItems.current, target, true)) return
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
        if (canTransfer(files, ids, target, true)) requestTransfer({ kind: 'move', ids, target })
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
  const pasteAvailable = clipboard && canTransfer(files, clipboardIds, path, clipboard.kind === 'move')
  const toolbarDisabled: Record<string, boolean> = {
    剪切: !selectedIds.length,
    复制: !selectedIds.length,
    粘贴: !pasteAvailable,
    移到回收站: !selectedIds.length,
    撤销: !undoStack.length,
  }
  const LayoutIcon = layouts[layout].icon
  const RootIcon = path === trash ? Trash2 : House

  const emptyMessage = filter ? '没有匹配的文件或文件夹' : path === trash ? '回收站为空' : '此文件夹为空'

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

  function toolbarAction({ label, Icon }: (typeof clipboardActions)[number]) {
    return (
      <button key={label} className="app-control file-tool file-extra-action" aria-label={label} title={label}
        disabled={toolbarDisabled[label]} onClick={() => commandsFor(selectedIds).find(item => item.label === label)?.run()}>
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

  function renderEntry(file: Entry) {
    const active = selection.includes(file.id)
    const editing = rename?.id === file.id
    const details = layout === 'tiles' ? [file.type, file.size].filter(Boolean).join(' · ') : undefined
    const itemProps = {
      'data-entry-id': file.id,
      'data-selected': active,
      'data-cut': clipboard?.kind === 'move' && clipboardIds.includes(file.id),
      draggable: path !== trash && !editing,
      onDragStart(event: DragEvent) {
        if (editing || path === trash) return event.preventDefault()
        dragItems.current = active ? selectedItems.map(item => item.id) : [file.id]
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('application/x-react-web-desktop-files', 'move')
      },
      onDragEnd: clearDrag,
      ...(file.directory && path !== trash ? dropHandlers(file.id) : {}),
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
        {layout === 'icons' && file.image
          ? <img className="file-thumbnail" src={file.image} alt="" draggable={false} />
          : <FileIcon file={file} />}
        <span className="file-name-text">
          <span className="file-display-name" title={file.name}>{file.name}</span>
          {details && <small title={details}>{details}</small>}
        </span>
      </button>
    )
    if (layout === 'list') return (
      <tr key={file.id} {...itemProps}>
        <td>{name}</td><td>{file.type}</td><td>{file.size ?? '—'}</td>
      </tr>
    )
    return <li className="file-grid-entry" key={file.id} {...itemProps}>{name}</li>
  }

  function archiveNames(entry: Entry) {
    return entry.archive?.map(file => [...locationChain(entry.archive ?? [], file.parent).map(parent => parent.name), file.name].join('/'))
  }

  return (
    <div ref={root} className="file-manager @container/app" data-panel={panel}
      data-inspector-collapsed={inspectorCollapsed} onKeyDown={handleKey}>
      <div className="file-toolbar file-navigation">
        <div className="file-tool-group" role="group" aria-label="目录导航">
          <button className="app-control file-tool" aria-label="返回" title="返回" disabled={!previous}
            onClick={() => previous && navigate(previous.id, previous.index)}><ArrowLeft size={16} aria-hidden="true" /></button>
          <button className="app-control file-tool" aria-label="前进" title="前进" disabled={!forward}
            onClick={() => forward && navigate(forward.id, forward.index)}><ArrowRight size={16} aria-hidden="true" /></button>
          <button className="app-control file-tool" aria-label="上一级" title="上一级" disabled={!parent}
            onClick={() => parent && navigate(parent)}><ArrowUp size={16} aria-hidden="true" /></button>
        </div>
        <nav className="file-path" aria-label="当前路径" title={pathText}>
          <ol>
            {[{ id: path === trash ? trash : home, name: locationName(path) }, ...crumbs].map((crumb, index) => (
              <li key={crumb.id}>
                {index > 0 && <ChevronRight size={13} aria-hidden="true" />}
                {crumb.id === path
                  ? <span aria-current="page" ref={element => {
                    const nav = element?.closest('nav')
                    if (nav) nav.scrollLeft = nav.scrollWidth
                  }}>{index === 0 && <RootIcon size={15} aria-hidden="true" />}{crumb.name}</span>
                  : <button className="app-control" onClick={() => navigate(crumb.id)}>
                    {index === 0 && <RootIcon size={15} aria-hidden="true" />}{crumb.name}
                  </button>}
              </li>
            ))}
          </ol>
        </nav>
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
        {path !== trash && <button className="app-control primary-control" onClick={createFolder} title="新建文件夹 (Ctrl+Shift+N)" aria-label="新建文件夹">
          <FolderPlus size={16} aria-hidden="true" /><span className="file-new-label">新建文件夹</span>
        </button>}
        {path !== trash && <div className="file-tool-group file-extra-tools" role="group" aria-label="剪贴板">
          {clipboardActions.map(toolbarAction)}
        </div>}
        <div className="file-tool-group file-extra-tools" role="group" aria-label="管理文件">
          {(path === trash ? managementActions.slice(1) : managementActions).map(toolbarAction)}
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
          <div className="file-location-group">
            <h3>其他位置</h3>
            {locationItem({ id: trash, name: '回收站', Icon: Trash2 })}
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
              <thead><tr><th scope="col">名称</th><th scope="col">类型</th><th scope="col">大小</th></tr></thead>
              <tbody>
                {entries.map(renderEntry)}
                {!entries.length && <tr><td colSpan={3} className="muted">{emptyMessage}</td></tr>}
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
            </dl>
            {!(selected.directory && path === trash) && <button className="app-control file-open" onClick={() => openEntry(selected)}>
              {selected.directory ? '打开文件夹' : selected.archive ? '查看压缩包' : editableFile(files, selected) ? '在文本编辑器中打开' : '预览文件'}
            </button>}
          </> : <p className="muted">{selectedItems.length ? `已选中 ${selectedItems.length} 项` : '选择文件或文件夹以查看属性。'}</p>}
        </aside>
      </div>
      <footer className="app-statusbar file-status">
        <span>{selectedItems.length ? `已选中 ${selectedItems.length} 项` : `${entries.length} 项`}</span>
        <span role="status" title={feedback}>{feedback}</span>
        {undoStack.length > 0 && <button className="app-control" onClick={undo}>撤销</button>}
      </footer>
      {popup && <CommandMenu key={popup.kind} id={popupId} label={popupLabels[popup.kind]}
        variant={popup.kind === 'layout' ? 'choice' : undefined}
        anchor={popup} groups={popup.groups} layer={popup.layer}
        boundary={popup.kind === 'layout' ? popup.source.closest<HTMLElement>('[data-app-window]') ?? popup.layer : popup.layer}
        zIndex={popup.zIndex}
        onClose={() => setPopup(undefined)} restoreFocus={() => restorePopupFocus(popup.source)} />}
      {modal?.kind === 'destination' && <FileLocationDialog mode="folder" files={files}
        title={`${operationLabel[modal.operation]}到…`} actionLabel={operationLabel[modal.operation]}
        canSelect={directory => canTransfer(files, modal.ids, directory, modal.operation === 'move')}
        onSelect={target => requestTransfer({ kind: modal.operation, ids: modal.ids, target })}
        onCreateFolder={createDestinationFolder} onCancel={() => closeModal()} />}
      {modal && modal.kind !== 'destination' && <dialog className="service-dialog file-dialog" ref={dialog} aria-labelledby="file-dialog-title"
        onCancel={event => { event.preventDefault(); event.stopPropagation(); closeModal() }}>
        <div className="service-dialog-body">
          <h2 id="file-dialog-title">{modal.kind === 'preview' ? modal.entry.name : '目标目录已有同名项'}</h2>
          {modal.kind === 'preview' && (modal.entry.archive
            ? <ul className="file-archive-list">{archiveNames(modal.entry)?.map(name => <li key={name}>{name}</li>)}</ul>
            : modal.entry.image ? <img className="file-image-preview" src={modal.entry.image} alt={modal.entry.name} />
              : <pre className="file-preview">{modal.entry.content ?? '暂无预览内容'}</pre>)}
          {modal.kind === 'conflict' && <>
            <ul className="file-archive-list">{transferConflicts(files, modal.transfer).map(file => <li key={file.id}>{file.name}</li>)}</ul>
            <p className="muted">替换会将目标中的旧项移到回收站。同目录复制时，源项始终保留。</p>
          </>}
        </div>
        <div className="service-dialog-actions">
          <button className="app-control" onClick={() => closeModal()}>{modal.kind === 'preview' ? '关闭' : '取消'}</button>
          {modal.kind === 'preview' && modal.entry.archive && path !== trash && <button className="app-control"
            onClick={() => showModal({ kind: 'destination', operation: 'extract', ids: [modal.entry.id] })}>解压到…</button>}
          {modal.kind === 'conflict' && ([['skip', '跳过同名项'], ['replace', '替换'], ['keep', '保留两者']] as const).map(([choice, label]) =>
            <button key={choice} className="app-control" onClick={() => {
              closeModal()
              executeTransfer(modal.transfer, choice)
            }}>{label}</button>)}
        </div>
      </dialog>}
    </div>
  )
}
