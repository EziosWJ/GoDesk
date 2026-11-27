import {
  useEffect, useEffectEvent, useId, useImperativeHandle, useLayoutEffect, useRef, useState, useSyncExternalStore,
  type KeyboardEvent, type Ref,
} from 'react'
import { FilePenLine, FilePlus, FolderOpen, Minus, Plus, RefreshCw, Save, SaveAll, WrapText, X } from 'lucide-react'
import {
  announceFileChange, errorMessage, FileError, filename, parentPath, readText, subscribeToFileChanges, writeText,
  type Conflict, type PathChange,
} from './hostFiles'
import { FileLocationDialog } from './FileLocationDialog'
import { TextEditor, type WordWrap } from './text-editor'
import { detectTextLanguage } from './text-editor/languages'
import './styles/text-editor.css'

const wordWrapStorageKey = 'godesk-editor-word-wrap'
const fontSizeStorageKey = 'godesk-editor-font-size'
const minFontSize = 11
const maxFontSize = 28
const defaultFontSize = 14

type Draft = {
  id: string
  path?: string
  version?: string
  checking?: boolean
  elevated?: boolean
  readOnly?: boolean
  name: string
  text: string
  savedText: string
}

type Dialog =
  | { kind: 'confirm'; close: string; drafts: string[] }
  | { kind: 'reload-confirm'; drafts: string[] }
  | { kind: 'conflict'; drafts: string[]; close?: string; message: string }
  | { kind: 'open'; directory?: string; elevated: boolean }
  | { kind: 'save-as'; drafts: string[]; close?: string; name: string; directory?: string; warning?: string }

export type EditorWindowHandle = { requestClose: () => void }
export type EditorOpenRequest = { path: string; elevated: boolean; readOnly: boolean }

function isDirty(draft: Draft) {
  return draft.text !== draft.savedText
}

function clampFontSize(size: number) {
  return Math.max(minFontSize, Math.min(maxFontSize, Math.round(size)))
}

function loadWordWrap(): WordWrap {
  try {
    return localStorage.getItem(wordWrapStorageKey) === 'off' ? 'off' : 'on'
  } catch {
    return 'on'
  }
}

function loadFontSize(): number {
  try {
    const parsed = Number(localStorage.getItem(fontSizeStorageKey))
    return Number.isFinite(parsed) && parsed > 0 ? clampFontSize(parsed) : defaultFontSize
  } catch {
    return defaultFontSize
  }
}

function persistPreference(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Keep in-memory state when storage is unavailable.
  }
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
  openRequest?: EditorOpenRequest
  onClose: () => void
}) {
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [activeId, setActiveId] = useState<string>()
  const [dialog, setDialog] = useState<Dialog>()
  const [status, setStatus] = useState('')
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(false)
  const [wordWrap, setWordWrap] = useState<WordWrap>(loadWordWrap)
  const [fontSize, setFontSize] = useState<number>(loadFontSize)
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
  const unavailable = !!active?.path && !active.readOnly && !active.checking && !active.version
  const pendingDraftId = dialog && 'drafts' in dialog ? dialog.drafts[0] : undefined
  const pendingDraft = drafts.find(draft => draft.id === pendingDraftId)
  const pendingName = pendingDraft?.name
  const simpleModal = dialog?.kind === 'confirm' || dialog?.kind === 'reload-confirm' || dialog?.kind === 'conflict'

  function focusTab(id: string) {
    const tab = document.getElementById(`${id}-tab`)
    tab?.focus({ preventScroll: true })
    tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  function toggleWordWrap() {
    setWordWrap(current => {
      const next: WordWrap = current === 'on' ? 'off' : 'on'
      persistPreference(wordWrapStorageKey, next)
      return next
    })
  }

  function adjustFontSize(delta: number) {
    setFontSize(current => {
      const next = clampFontSize(current + delta)
      if (next !== current) persistPreference(fontSizeStorageKey, String(next))
      return next
    })
  }

  function resetFontSize() {
    setFontSize(defaultFontSize)
    persistPreference(fontSizeStorageKey, String(defaultFontSize))
  }

  const openDocument = useEffectEvent(async (target: EditorOpenRequest) => {
    const existing = drafts.find(draft => draft.path === target.path &&
      !!draft.elevated === target.elevated && !!draft.readOnly === target.readOnly)
    setStatus('')
    if (existing && !target.readOnly) {
      setActiveId(existing.id)
      setLoading(false)
      requestAnimationFrame(() => focusTab(existing.id))
      return
    }
    const controller = new AbortController()
    openController.current = controller
    setLoading(true)
    try {
      const data = await readText(target.path, controller.signal, target.elevated)
      if (controller.signal.aborted) return
      const id = existing?.id ?? `${prefix}-${nextDocument.current++}`
      const draft: Draft = { id, path: data.path, version: data.version, elevated: target.elevated,
        readOnly: target.readOnly, name: filename(data.path), text: data.text, savedText: data.text }
      setDrafts(current => {
        if (current.some(item => item.id === id)) return current.map(item => item.id === id ? draft : item)
        return [...current, draft]
      })
      setActiveId(id)
      requestAnimationFrame(() => focusTab(id))
    } catch (error) {
      if (!controller.signal.aborted) {
        const reason = error instanceof FileError && error.code === 'permission' ? '没有权限读取文件：' : ''
        setStatus(`${reason}${errorMessage(error)}（${target.path}）`)
      }
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
        void readText(path, undefined, draft.elevated).then(data => data.text === draft.savedText ? data.version : undefined)
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
    if (!element || !simpleModal) return
    if (!element.open) element.showModal()
    element.querySelector<HTMLElement>('[data-cancel]')?.focus()
    return () => element.close()
  }, [dialog, simpleModal])

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

  function requestOpen() {
    if (dialog || saveLock.current) return
    setDialog({
      kind: 'open',
      directory: active?.path ? parentPath(active.path) : undefined,
      elevated: !!active?.elevated,
    })
  }

  async function openFromDialog(path: string, elevated: boolean) {
    const existing = drafts.find(draft => draft.path === path && !!draft.elevated === elevated && !draft.readOnly)
    if (existing) {
      setActiveId(existing.id)
      setStatus('')
      closeDialog()
      requestAnimationFrame(() => focusTab(existing.id))
      return
    }
    const data = await readText(path, undefined, elevated)
    const id = `${prefix}-${nextDocument.current++}`
    const draft: Draft = {
      id, path: data.path, version: data.version, elevated, readOnly: false,
      name: filename(data.path), text: data.text, savedText: data.text,
    }
    setDrafts(current => [...current, draft])
    setActiveId(id)
    setStatus('')
    closeDialog()
    requestAnimationFrame(() => focusTab(id))
  }

  async function reloadDraft(draft: Draft) {
    if (!draft.path || saveLock.current) return
    openController.current?.abort()
    const controller = new AbortController()
    openController.current = controller
    setLoading(true)
    setStatus('')
    try {
      const data = await readText(draft.path, controller.signal, draft.elevated)
      if (controller.signal.aborted) return
      setDrafts(current => current.map(item => item.id === draft.id
        ? { ...item, path: data.path, name: filename(data.path), version: data.version, text: data.text, savedText: data.text, checking: false }
        : item))
      closeDialog()
      setStatus(`已重新加载「${filename(data.path)}」`)
    } catch (error) {
      if (!controller.signal.aborted) {
        const message = textErrorMessage(error, draft.path)
        setStatus(message)
        if (error instanceof FileError && error.code === 'not_found') {
          setDrafts(current => current.map(item => item.id === draft.id ? { ...item, version: undefined } : item))
        }
        if (dialog?.kind === 'reload-confirm') closeDialog()
      }
    } finally {
      if (openController.current === controller) setLoading(false)
    }
  }

  function requestReload(draft: Draft) {
    if (!draft.path || dialog || saveLock.current || loading || draft.checking) return
    if (isDirty(draft)) setDialog({ kind: 'reload-confirm', drafts: [draft.id] })
    else void reloadDraft(draft)
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
    modal.current?.close()
    setDialog({
      kind: 'save-as', drafts: ids, close, name: draft.path ? draft.name : '', warning,
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
        if (!draft || draft.readOnly) continue
        const created = index === 0 ? newPath : undefined
        if (!created && (!draft.path || !draft.version)) {
          requestSaveAs(draft, ids.slice(index), close)
          return
        }
        if (draft.checking && !created) return
        try {
          const data = await writeText(created ?? draft.path!, draft.text, created ? undefined : draft.version, conflict, draft.elevated)
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
          if (error instanceof FileError && error.code === 'changed') {
            modal.current?.close()
            setDialog({ kind: 'conflict', drafts: ids.slice(index), close, message })
          } else if (error instanceof FileError && error.code === 'not_found') {
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
    if ((!event.ctrlKey && !event.metaKey) || event.altKey || event.nativeEvent.isComposing) return
    const key = event.key.toLowerCase()
    if (key === 's') {
      event.preventDefault()
      event.stopPropagation()
      if (!dialog && active && !active.readOnly && !saving && !active.checking) {
        if (event.shiftKey) requestSaveAs(active, [active.id])
        else void saveDrafts([active.id])
      }
    } else if (key === 'o' && !event.shiftKey) {
      event.preventDefault()
      event.stopPropagation()
      if (!dialog && !saving) requestOpen()
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
        <button className="app-control" disabled={saving} aria-keyshortcuts="Control+o Meta+o" onClick={requestOpen}>
          <FolderOpen size={16} />打开文件…
        </button>
        {!active?.readOnly && <button className="app-control primary-control" disabled={!active || saving || active.checking} aria-keyshortcuts="Control+s Meta+s"
          onClick={() => { if (active) void saveDrafts([active.id]) }}>
          <Save size={16} />{!active?.path || unavailable ? '另存为…' : '保存'}
        </button>}
        {active?.path && !active.readOnly && !unavailable && <button className="app-control" disabled={saving || active.checking} aria-keyshortcuts="Control+Shift+s Meta+Shift+s"
          onClick={() => requestSaveAs(active, [active.id])}>
          <SaveAll size={16} />另存为…
        </button>}
        {active?.path && <button className="app-control" disabled={saving || loading || active.checking}
          onClick={() => requestReload(active)}>
          <RefreshCw size={16} />重新加载
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
                {draft.elevated && <span>管理员</span>}
                {draft.readOnly && <span>只读预览</span>}
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
              language={detectTextLanguage(draft.name).language} theme={theme}
              wordWrap={wordWrap} fontSize={fontSize} readOnly={saving || draft.readOnly}
              onFontSizeChange={adjustFontSize}
              onChange={text => {
                if (!draft.readOnly) setDrafts(current => current.map(item => item.id === draft.id ? { ...item, text } : item))
              }} />
          </div>
        )) : <div className="editor-empty">
          <FilePenLine size={30} strokeWidth={1.5} aria-hidden="true" />
          <p>{loading ? '正在读取主机文件…' : '新建或打开文件，也可从文件管理器打开文本文件。'}</p>
        </div>}
      </div>
      <footer className="app-statusbar editor-status">
        <span role="status" data-warning={unavailable} title={status}>
          {saving ? '正在保存…' : loading ? '正在读取主机文件…' : status || (unavailable ? '原文件已不可编辑，可另存为新文件。' : '')}
        </span>
        <div className="editor-status-controls">
          <button type="button" className="app-control editor-status-btn" aria-pressed={wordWrap === 'on'}
            title={wordWrap === 'on' ? '自动换行：开' : '自动换行：关'} onClick={toggleWordWrap}>
            <WrapText size={14} aria-hidden="true" />
            <span>{wordWrap === 'on' ? '自动换行' : '不换行'}</span>
          </button>
          <div className="editor-zoom-group" role="group" aria-label="字号调整">
            <button type="button" className="app-control editor-status-btn" aria-label="减小字号" title="减小字号"
              disabled={fontSize <= minFontSize} onClick={() => adjustFontSize(-1)}>
              <Minus size={13} aria-hidden="true" />
            </button>
            <button type="button" className="app-control editor-status-btn editor-font-size"
              aria-label={`当前字号 ${fontSize}px，点击重置为 ${defaultFontSize}px`}
              title={fontSize === defaultFontSize ? `字号 ${fontSize}px（支持 Ctrl+滚轮缩放）` : `点击重置为 ${defaultFontSize}px`}
              onClick={resetFontSize}>
              {fontSize}px
            </button>
            <button type="button" className="app-control editor-status-btn" aria-label="增大字号" title="增大字号"
              disabled={fontSize >= maxFontSize} onClick={() => adjustFontSize(1)}>
              <Plus size={13} aria-hidden="true" />
            </button>
          </div>
          {active && <span className="editor-status-lang">{detectTextLanguage(active.name).type}</span>}
        </div>
      </footer>
      {dialog?.kind === 'confirm' && <dialog key="confirm" ref={modal} className="service-dialog editor-dialog" aria-labelledby={`${prefix}-dialog-title`}
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
      {dialog?.kind === 'reload-confirm' && <dialog key="reload-confirm" ref={modal} className="service-dialog editor-dialog" aria-labelledby={`${prefix}-reload-title`}
        onCancel={event => { event.preventDefault(); event.stopPropagation(); if (!loading) closeDialog() }}>
        <div className="service-dialog-body">
          <h2 id={`${prefix}-reload-title`}>重新加载文件？</h2>
          <p className="muted editor-dialog-message">
            {`「${pendingName}」有未保存的修改。重新加载将放弃当前本地修改，并从磁盘读取最新内容。`}
          </p>
        </div>
        <div className="service-dialog-actions">
          <button className="app-control" data-cancel disabled={loading} onClick={closeDialog}>取消</button>
          <button className="app-control danger-control" disabled={loading || !pendingDraft}
            onClick={() => { if (pendingDraft) void reloadDraft(pendingDraft) }}>
            放弃修改并重新加载
          </button>
        </div>
      </dialog>}
      {dialog?.kind === 'conflict' && <dialog key="conflict" ref={modal} className="service-dialog editor-dialog" aria-labelledby={`${prefix}-conflict-title`}
        onCancel={event => { event.preventDefault(); event.stopPropagation(); if (!saving && !loading) closeDialog() }}>
        <div className="service-dialog-body">
          <h2 id={`${prefix}-conflict-title`}>文件已被外部修改</h2>
          {pendingDraft?.path && <p className="service-target">{pendingDraft.path}{pendingDraft.elevated ? ' · 管理员' : ''}</p>}
          <p className="muted editor-dialog-message">{dialog.message}</p>
          {status && status !== dialog.message && <p role="alert" className="editor-dialog-error">{status}</p>}
        </div>
        <div className="service-dialog-actions">
          <button className="app-control" data-cancel disabled={saving || loading} onClick={closeDialog}>取消</button>
          <button className="app-control" disabled={saving || loading || !pendingDraft}
            onClick={() => { if (pendingDraft) requestSaveAs(pendingDraft, dialog.drafts, dialog.close, dialog.message) }}>
            另存为新文件
          </button>
          <button className="app-control danger-control" disabled={saving || loading || !pendingDraft}
            onClick={() => { if (pendingDraft) void reloadDraft(pendingDraft) }}>
            重新加载磁盘版本（放弃本地修改）
          </button>
        </div>
      </dialog>}
      {dialog?.kind === 'open' && <FileLocationDialog mode="open" elevated={dialog.elevated}
        title="打开文件" initialDirectory={dialog.directory}
        onCancel={closeDialog}
        onOpen={path => openFromDialog(path, dialog.elevated)} />}
      {dialog?.kind === 'save-as' && <FileLocationDialog key={dialog.drafts[0]} mode="save" elevated={pendingDraft?.elevated}
        title={pendingDraft?.path ? '另存为' : '保存新文件'} warning={dialog.warning}
        initialDirectory={dialog.directory} initialName={dialog.name}
        onCancel={closeDialog}
        onSave={(path, conflict) => saveDrafts(dialog.drafts, dialog.close, path, conflict)} />}
    </section>
  )
}
