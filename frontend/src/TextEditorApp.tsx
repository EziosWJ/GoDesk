import {
  useEffect, useEffectEvent, useId, useImperativeHandle, useLayoutEffect, useRef, useState, useSyncExternalStore,
  type KeyboardEvent, type Ref,
} from 'react'
import { FilePenLine, FilePlus, Save, SaveAll, X } from 'lucide-react'
import { textFileType, textFileTypes } from './fileSystem'
import {
  announceFileChange, errorMessage, FileError, filename, parentPath, readText, subscribeToFileChanges, writeText,
  type Conflict, type PathChange,
} from './hostFiles'
import { FileLocationDialog } from './FileLocationDialog'
import { TextEditor } from './text-editor'
import './styles/text-editor.css'

type Draft = {
  id: string
  path?: string
  version?: string
  checking?: boolean
  name: string
  text: string
  savedText: string
}

type Dialog =
  | { kind: 'confirm'; close: string; drafts: string[] }
  | { kind: 'save-as'; drafts: string[]; close?: string; name: string; directory?: string; warning?: string }

export type EditorWindowHandle = { requestClose: () => void }

function isDirty(draft: Draft) {
  return draft.text !== draft.savedText
}

function textErrorMessage(error: unknown, path: string) {
  return error instanceof FileError && (error.code === 'permission' || error.code === 'ownership_preservation_failed')
    ? `${path}：${error.message}`
    : errorMessage(error)
}

function getTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

function subscribeToTheme(listener: () => void) {
  const observer = new MutationObserver(listener)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  return () => observer.disconnect()
}

export function TextEditorApp({ ref, openRequest, onClose }: {
  ref: Ref<EditorWindowHandle>
  openRequest?: { path: string }
  onClose: () => void
}) {
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [activeId, setActiveId] = useState<string>()
  const [dialog, setDialog] = useState<Dialog>()
  const [status, setStatus] = useState('')
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(false)
  const saveLock = useRef(false)
  const openController = useRef<AbortController>(undefined)
  const root = useRef<HTMLElement>(null)
  const modal = useRef<HTMLDialogElement>(null)
  const handledRequest = useRef<typeof openRequest>(undefined)
  const nextDocument = useRef(1)
  const nextUntitled = useRef(1)
  const prefix = useId()
  const theme = useSyncExternalStore(subscribeToTheme, getTheme)

  const active = drafts.find(draft => draft.id === activeId)
  const hasDirty = drafts.some(isDirty)
  const unavailable = !!active?.path && !active.checking && (!active.version || !textFileType(active.name))
  const pendingDraft = drafts.find(draft => draft.id === dialog?.drafts[0])
  const pendingName = pendingDraft?.name

  function focusTab(id: string) {
    const tab = document.getElementById(`${id}-tab`)
    tab?.focus({ preventScroll: true })
    tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  const openDocument = useEffectEvent(async (target: NonNullable<typeof openRequest>) => {
    const existing = drafts.find(draft => draft.path === target.path)
    if (existing) {
      setActiveId(existing.id)
      setLoading(false)
      requestAnimationFrame(() => focusTab(existing.id))
      return
    }
    const controller = new AbortController()
    openController.current = controller
    setStatus('')
    setLoading(true)
    try {
      const data = await readText(target.path, controller.signal)
      if (controller.signal.aborted) return
      const id = `${prefix}-${nextDocument.current++}`
      setDrafts(current => [...current, { id, path: data.path, version: data.version,
        name: filename(data.path), text: data.text, savedText: data.text }])
      setActiveId(id)
      requestAnimationFrame(() => focusTab(id))
    } catch (error) {
      if (!controller.signal.aborted) setStatus(textErrorMessage(error, target.path))
    } finally {
      if (openController.current === controller) setLoading(false)
    }
  })

  useEffect(() => {
    if (!openRequest || handledRequest.current === openRequest) return
    handledRequest.current = openRequest
    openController.current?.abort()
    void openDocument(openRequest)
    return () => {
      handledRequest.current = undefined
      openController.current?.abort()
    }
  }, [openRequest])

  const updatePaths = useEffectEvent((change?: PathChange) => {
    if (!change) return
    const { from, to } = change
    function movedPath(path?: string) {
      if (path === from || path?.startsWith(`${from}/`)) return to + path.slice(from.length)
    }
    setDrafts(current => current.map(draft => {
      const path = movedPath(draft.path)
      return path ? { ...draft, path, name: filename(path), checking: change.copied } : draft
    }))
    if (change.copied) {
      for (const draft of drafts) {
        const path = movedPath(draft.path)
        if (!path) continue
        void readText(path).then(data => data.text === draft.savedText ? data.version : undefined)
          .catch(() => undefined).then(version => setDrafts(current => current.map(item =>
            item.id === draft.id && item.path === path && item.checking ? { ...item, version, checking: false } : item,
          )))
      }
    }
  })

  useEffect(() => subscribeToFileChanges(updatePaths), [])

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
    setDrafts(current => current.filter(draft => draft.id !== target))
    const next = activeId === target ? remaining[Math.min(index, remaining.length - 1)]?.id : activeId
    setActiveId(next)
    requestAnimationFrame(() => {
      if (next) focusTab(next)
      else root.current?.querySelector<HTMLButtonElement>('button')?.focus()
    })
  }

  function requestClose(target: string) {
    if (dialog || saveLock.current) return
    const dirty = drafts.filter(draft => (target === 'window' || draft.id === target) && isDirty(draft))
    if (dirty.length) setDialog({ kind: 'confirm', close: target, drafts: dirty.map(draft => draft.id) })
    else finishClose(target)
  }

  useImperativeHandle(ref, () => ({ requestClose: () => requestClose('window') }))

  function requestSaveAs(draft: Draft, ids: string[], close?: string, warning?: string) {
    const name = draft.path
      ? textFileType(draft.name) ? draft.name : `${draft.name.replace(/\.[^.]+$/, '')}.txt`
      : ''
    modal.current?.close()
    setDialog({
      kind: 'save-as', drafts: ids, close, name, warning,
      directory: draft.path ? parentPath(draft.path) : undefined,
    })
  }

  async function saveDrafts(ids: string[], close?: string, newPath?: string, conflict?: Conflict) {
    if (saveLock.current) return
    saveLock.current = true
    setSaving(true)
    try {
      for (const [index, id] of ids.entries()) {
        const draft = drafts.find(item => item.id === id)
        if (!draft) continue
        const created = index === 0 ? newPath : undefined
        if (!created && (!draft.path || !draft.version || !textFileType(draft.name))) {
          requestSaveAs(draft, ids.slice(index), close)
          return
        }
        if (draft.checking && !created) return
        try {
          const data = await writeText(created ?? draft.path!, draft.text, created ? undefined : draft.version, conflict)
          setDrafts(current => current.map(item => {
            if (item.id !== id) return item
            const path = created ? data.path : item.path ?? data.path
            if (!created && item.checking) return { ...item, savedText: draft.text }
            return { ...item, path, name: filename(path), version: data.version, savedText: draft.text, checking: false }
          }))
          setStatus(`已保存「${filename(data.path)}」`)
          announceFileChange()
        } catch (error) {
          if (created) throw error
          const message = textErrorMessage(error, draft.path!)
          setStatus(message)
          if (error instanceof FileError && ['changed', 'not_found'].includes(error.code)) {
            setDrafts(current => current.map(item => item.id === id ? { ...item, version: undefined } : item))
            if (close) requestSaveAs(draft, ids.slice(index), close, message)
          } else if (close && error instanceof FileError && ['permission', 'ownership_preservation_failed'].includes(error.code)) {
            requestSaveAs(draft, ids.slice(index), close, message)
          }
          return
        }
      }
      if (close) finishClose(close)
      else closeDialog()
    } finally {
      saveLock.current = false
      setSaving(false)
    }
  }

  function handleShortcut(event: KeyboardEvent<HTMLElement>) {
    if ((!event.ctrlKey && !event.metaKey) || event.altKey ||
        event.key.toLowerCase() !== 's' || event.nativeEvent.isComposing) return
    event.preventDefault()
    event.stopPropagation()
    if (!dialog && active && !saving && !active.checking) {
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
        <button className="app-control" disabled={saving} onClick={newDraft}><FilePlus size={16} />新建文件</button>
        <button className="app-control primary-control" disabled={!active || saving || active.checking} aria-keyshortcuts="Control+s Meta+s"
          onClick={() => { if (active) saveDrafts([active.id]) }}>
          <Save size={16} />{!active?.path || unavailable ? '另存为…' : '保存'}
        </button>
        {active?.path && !unavailable && <button className="app-control" disabled={saving || active.checking} aria-keyshortcuts="Control+Shift+s Meta+Shift+s"
          onClick={() => requestSaveAs(active, [active.id])}>
          <SaveAll size={16} />另存为…
        </button>}
      </header>
      {drafts.length > 0 && <div className="editor-tabs" role="tablist" aria-label="打开的文件">
        {drafts.map((draft, index) => {
          const name = draft.name
          const selected = activeId === draft.id
          return (
            <div key={draft.id} className="editor-tab" data-selected={selected}>
              <button type="button" role="tab" id={`${draft.id}-tab`} aria-selected={selected}
                aria-controls={`${draft.id}-panel`} tabIndex={selected ? 0 : -1} title={draft.path ?? name}
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
              language={textFileType(draft.name)?.language ?? 'plaintext'} theme={theme} readOnly={saving}
              onChange={text => setDrafts(current => current.map(item => item.id === draft.id ? { ...item, text } : item))} />
          </div>
        )) : <div className="editor-empty">
          <FilePenLine size={30} strokeWidth={1.5} aria-hidden="true" />
          <p>{loading ? '正在读取主机文件…' : '新建文件，或从文件管理器打开文本文件。'}</p>
        </div>}
      </div>
      <footer className="app-statusbar editor-status">
        <span role="status" data-warning={unavailable} title={status}>
          {saving ? '正在保存…' : loading ? '正在读取主机文件…' : status || (unavailable ? '原文件已不可编辑，可另存为新文件。' : '')}
        </span>
        {active && <span>{textFileType(active.name)?.type ?? '纯文本'}</span>}
      </footer>
      {dialog?.kind === 'confirm' && <dialog ref={modal} className="service-dialog editor-dialog" aria-labelledby={`${prefix}-dialog-title`}
        onCancel={event => { event.preventDefault(); event.stopPropagation(); if (!saving) closeDialog() }}>
        <div className="service-dialog-body">
          <h2 id={`${prefix}-dialog-title`}>保存修改？</h2>
          {status && <p role="status">{status}</p>}
          <p className="muted editor-dialog-message">{dialog.drafts.length === 1
            ? `「${pendingName}」有未保存的修改。`
            : `有 ${dialog.drafts.length} 个标签页尚未保存。`}</p>
        </div>
        <div className="service-dialog-actions">
          <button className="app-control" data-cancel disabled={saving} onClick={closeDialog}>取消</button>
          <button className="app-control" disabled={saving} onClick={() => finishClose(dialog.close)}>放弃修改</button>
          <button className="app-control primary-control" disabled={saving} onClick={() => void saveDrafts(dialog.drafts, dialog.close)}>保存</button>
        </div>
      </dialog>}
      {dialog?.kind === 'save-as' && <FileLocationDialog key={dialog.drafts[0]} mode="save"
        title={pendingDraft?.path ? '另存为' : '保存新文件'} formats={textFileTypes} warning={dialog.warning}
        defaultExtension="txt" initialDirectory={dialog.directory} initialName={dialog.name}
        onCancel={closeDialog}
        onSave={(path, conflict) => saveDrafts(dialog.drafts, dialog.close, path, conflict)} />}
    </section>
  )
}
