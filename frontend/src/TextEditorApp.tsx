import {
  useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState, useSyncExternalStore,
  type Dispatch, type KeyboardEvent, type Ref, type SetStateAction,
} from 'react'
import { FilePenLine, FilePlus, Save, SaveAll, X } from 'lucide-react'
import { editableFile, folder, textFileSize, textFileType, textFileTypes, type Entry } from './fileSystem'
import { FileLocationDialog } from './FileLocationDialog'
import { TextEditor } from './text-editor'
import './styles/text-editor.css'

type Draft = {
  id: string
  fileId?: string
  name: string
  text: string
  savedText: string
}

type Dialog =
  | { kind: 'confirm'; close: string; drafts: string[] }
  | { kind: 'save-as'; drafts: string[]; close?: string; name: string; directory?: string }

export type EditorWindowHandle = { requestClose: () => void }

function isDirty(draft: Draft) {
  return draft.text !== draft.savedText
}

function getTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

function subscribeToTheme(listener: () => void) {
  const observer = new MutationObserver(listener)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  return () => observer.disconnect()
}

export function TextEditorApp({ ref, files, setFiles, makeId, openRequest, onClose }: {
  ref: Ref<EditorWindowHandle>
  files: Entry[]
  setFiles: Dispatch<SetStateAction<Entry[]>>
  makeId: () => string
  openRequest?: { id: string }
  onClose: () => void
}) {
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [activeId, setActiveId] = useState<string>()
  const [dialog, setDialog] = useState<Dialog>()
  const [status, setStatus] = useState('')
  const [previousFiles, setPreviousFiles] = useState(files)
  const root = useRef<HTMLElement>(null)
  const modal = useRef<HTMLDialogElement>(null)
  const handledRequest = useRef<typeof openRequest>(undefined)
  const nextDocument = useRef(1)
  const nextUntitled = useRef(1)
  const prefix = useId()
  const theme = useSyncExternalStore(subscribeToTheme, getTheme)

  if (files !== previousFiles) {
    setPreviousFiles(files)
    const updated = drafts.map(draft => {
      const entry = files.find(file => file.id === draft.fileId)
      return !entry || entry.name === draft.name ? draft : { ...draft, name: entry.name }
    })
    if (updated.some((draft, index) => draft !== drafts[index])) setDrafts(updated)
  }

  const active = drafts.find(draft => draft.id === activeId)
  const hasDirty = drafts.some(isDirty)
  const activeEntry = files.find(file => file.id === active?.fileId)
  const unavailable = !!active?.fileId && (!activeEntry || !editableFile(files, activeEntry))
  const pendingDraft = drafts.find(draft => draft.id === dialog?.drafts[0])
  const pendingName = pendingDraft && (files.find(file => file.id === pendingDraft.fileId)?.name ?? pendingDraft.name)

  function focusTab(id: string) {
    const tab = document.getElementById(`${id}-tab`)
    tab?.focus({ preventScroll: true })
    tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  useLayoutEffect(() => {
    if (!openRequest || handledRequest.current === openRequest) return
    handledRequest.current = openRequest
    const entry = files.find(file => file.id === openRequest.id)
    if (!entry || !editableFile(files, entry)) return
    const existing = drafts.find(draft => draft.fileId === entry.id)
    const id = existing?.id ?? `${prefix}-${nextDocument.current++}`
    if (!existing) {
      const text = entry.content ?? ''
      setDrafts(current => [...current, { id, fileId: entry.id, name: entry.name, text, savedText: text }])
    }
    setActiveId(id)
    requestAnimationFrame(() => {
      if (handledRequest.current === openRequest) focusTab(id)
    })
  }, [openRequest, files, drafts, prefix])

  useEffect(() => {
    if (!hasDirty) return
    function preventUnload(event: BeforeUnloadEvent) {
      event.preventDefault()
      event.returnValue = true
    }
    window.addEventListener('beforeunload', preventUnload)
    return () => window.removeEventListener('beforeunload', preventUnload)
  }, [hasDirty])

  useLayoutEffect(() => {
    const element = modal.current
    if (!element || dialog?.kind !== 'confirm') return
    if (!element.open) element.showModal()
    element.querySelector<HTMLElement>('[data-cancel]')?.focus()
    return () => element.close()
  }, [dialog])

  function newDraft() {
    const id = `${prefix}-${nextDocument.current++}`
    const name = `未命名 ${nextUntitled.current++}`
    setDrafts(current => [...current, { id, name, text: '', savedText: '' }])
    setActiveId(id)
    setStatus('')
    requestAnimationFrame(() => focusTab(id))
  }

  function closeDialog() {
    modal.current?.close()
    setDialog(undefined)
  }

  function finishClose(target: string) {
    closeDialog()
    if (target === 'window') {
      onClose()
      return
    }
    const index = drafts.findIndex(draft => draft.id === target)
    const remaining = drafts.filter(draft => draft.id !== target)
    setDrafts(remaining)
    const next = activeId === target ? remaining[Math.min(index, remaining.length - 1)]?.id : activeId
    setActiveId(next)
    requestAnimationFrame(() => {
      if (next) focusTab(next)
      else root.current?.querySelector<HTMLButtonElement>('button')?.focus()
    })
  }

  function requestClose(target: string) {
    if (dialog) return
    const dirty = drafts.filter(draft => (target === 'window' || draft.id === target) && isDirty(draft))
    if (dirty.length) setDialog({ kind: 'confirm', close: target, drafts: dirty.map(draft => draft.id) })
    else finishClose(target)
  }

  useImperativeHandle(ref, () => ({ requestClose: () => requestClose('window') }))

  function requestSaveAs(draft: Draft, ids: string[], close?: string) {
    const entry = files.find(file => file.id === draft.fileId)
    const original = entry?.name ?? draft.name
    const name = draft.fileId
      ? textFileType(original) ? original : `${original.replace(/\.[^.]+$/, '')}.txt`
      : ''
    modal.current?.close()
    setDialog({
      kind: 'save-as', drafts: ids, close, name,
      directory: entry && editableFile(files, entry) ? entry.parent : undefined,
    })
  }

  function saveDrafts(ids: string[], close?: string, newFile?: Entry) {
    let nextFiles = files
    let nextDrafts = drafts
    let savedName = ''
    let needsDestination = false
    for (const [index, id] of ids.entries()) {
      const draft = drafts.find(item => item.id === id)
      if (!draft) continue
      const entry = nextFiles.find(file => file.id === draft.fileId)
      const created = index === 0 ? newFile : undefined
      const target = created ?? (entry && editableFile(nextFiles, entry) ? entry : undefined)
      if (!target) {
        requestSaveAs(draft, ids.slice(index), close)
        needsDestination = true
        break
      }
      const updated = { ...target, content: draft.text, size: textFileSize(draft.text) }
      nextFiles = created ? [...nextFiles, updated] : nextFiles.map(file => file.id === target.id ? updated : file)
      nextDrafts = nextDrafts.map(item => item.id === id
        ? { ...item, fileId: target.id, name: target.name, savedText: draft.text }
        : item)
      savedName = target.name
    }
    if (nextFiles !== files) {
      setFiles(nextFiles)
      setDrafts(nextDrafts)
      setStatus(`已保存「${savedName}」`)
    }
    if (needsDestination) return
    if (close) finishClose(close)
    else closeDialog()
  }

  function createFolder(parent: string, name: string) {
    const id = makeId()
    setFiles(current => [...current, folder(id, parent, name)])
    return id
  }

  function handleShortcut(event: KeyboardEvent<HTMLElement>) {
    if ((!event.ctrlKey && !event.metaKey) || event.altKey ||
        event.key.toLowerCase() !== 's' || event.nativeEvent.isComposing) return
    event.preventDefault()
    event.stopPropagation()
    if (!dialog && active) {
      if (event.shiftKey) requestSaveAs(active, [active.id])
      else saveDrafts([active.id])
    }
  }

  function handleTabKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = drafts.length - 1
    const targets: Record<string, number> = {
      ArrowLeft: (index + last) % drafts.length,
      ArrowRight: (index + 1) % drafts.length,
      Home: 0,
      End: last,
    }
    if (event.key === 'Delete') {
      event.preventDefault()
      requestClose(drafts[index].id)
    } else if (Object.hasOwn(targets, event.key)) {
      event.preventDefault()
      const target = drafts[targets[event.key]].id
      setActiveId(target)
      focusTab(target)
    }
  }

  return (
    <section className="text-editor-app" ref={root} onKeyDownCapture={handleShortcut}>
      <header className="editor-toolbar" aria-label="编辑器操作">
        <button className="app-control" onClick={newDraft}><FilePlus size={16} />新建文件</button>
        <button className="app-control primary-control" disabled={!active} aria-keyshortcuts="Control+s Meta+s"
          onClick={() => { if (active) saveDrafts([active.id]) }}>
          <Save size={16} />{unavailable ? '另存为…' : '保存'}
        </button>
        {active?.fileId && !unavailable && <button className="app-control" aria-keyshortcuts="Control+Shift+s Meta+Shift+s"
          onClick={() => requestSaveAs(active, [active.id])}>
          <SaveAll size={16} />另存为…
        </button>}
      </header>
      {drafts.length > 0 && <div className="editor-tabs" role="tablist" aria-label="打开的文件">
        {drafts.map((draft, index) => {
          const name = files.find(file => file.id === draft.fileId)?.name ?? draft.name
          const selected = activeId === draft.id
          return (
            <div key={draft.id} className="editor-tab" data-selected={selected}>
              <button type="button" role="tab" id={`${draft.id}-tab`} aria-selected={selected}
                aria-controls={`${draft.id}-panel`} tabIndex={selected ? 0 : -1} title={name}
                onClick={() => setActiveId(draft.id)} onKeyDown={event => handleTabKey(event, index)}>
                <span className="truncate">{name}</span>
                {isDirty(draft) && <span className="editor-dirty" role="img" aria-label="未保存" />}
              </button>
              <button type="button" className="editor-tab-close" aria-label={`关闭 ${name}`} onClick={() => requestClose(draft.id)}>
                <X size={14} />
              </button>
            </div>
          )
        })}
      </div>}
      <div className="editor-workspace">
        {drafts.length ? drafts.map(draft => (
          <div key={draft.id} role="tabpanel" id={`${draft.id}-panel`} aria-labelledby={`${draft.id}-tab`}
            className="editor-panel" hidden={activeId !== draft.id}>
            <TextEditor documentId={draft.id} value={draft.text}
              language={textFileType(draft.name)?.language ?? 'plaintext'} theme={theme}
              onChange={text => setDrafts(current => current.map(item => item.id === draft.id ? { ...item, text } : item))} />
          </div>
        )) : <div className="editor-empty">
          <FilePenLine size={30} strokeWidth={1.5} aria-hidden="true" />
          <p>新建文件，或从文件管理器打开文本文件。</p>
        </div>}
      </div>
      <footer className="app-statusbar editor-status">
        <span role="status" data-warning={unavailable} title={unavailable ? '原文件已不可编辑，可另存为新文件。' : status}>
          {unavailable ? '原文件已不可编辑，可另存为新文件。' : status}
        </span>
        {active && <span>{textFileType(active.name)?.type ?? '纯文本'}</span>}
      </footer>
      {dialog?.kind === 'confirm' && <dialog ref={modal} className="service-dialog editor-dialog" aria-labelledby={`${prefix}-dialog-title`}
        onCancel={event => { event.preventDefault(); event.stopPropagation(); closeDialog() }}>
        <div className="service-dialog-body">
          <h2 id={`${prefix}-dialog-title`}>保存修改？</h2>
          <p className="muted editor-dialog-message">{dialog.drafts.length === 1
            ? `「${pendingName}」有未保存的修改。`
            : `有 ${dialog.drafts.length} 个标签页尚未保存。`}</p>
        </div>
        <div className="service-dialog-actions">
          <button className="app-control" data-cancel onClick={closeDialog}>取消</button>
          <button className="app-control" onClick={() => finishClose(dialog.close)}>放弃修改</button>
          <button className="app-control primary-control" onClick={() => saveDrafts(dialog.drafts, dialog.close)}>保存</button>
        </div>
      </dialog>}
      {dialog?.kind === 'save-as' && <FileLocationDialog key={dialog.drafts[0]} mode="save"
        title={pendingDraft?.fileId ? '另存为' : '保存新文件'} files={files} formats={textFileTypes}
        defaultExtension="txt" initialDirectory={dialog.directory} initialName={dialog.name}
        onCancel={closeDialog} onCreateFolder={createFolder}
        onSave={file => saveDrafts(dialog.drafts, dialog.close, { ...file, id: makeId() })} />}
    </section>
  )
}
