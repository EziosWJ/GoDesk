import { useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { editor } from 'monaco-editor/editor/editor.api'
import 'monaco-editor/editor/browser/coreCommands'
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard'
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu'
import 'monaco-editor/editor/contrib/find/browser/findController'
import 'monaco-editor/editor/contrib/gotoError/browser/gotoError'
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution'
import 'monaco-editor/editor/contrib/tokenization/browser/tokenization'
import 'monaco-editor/languages/definitions/markdown/register'
import 'monaco-editor/languages/definitions/yaml/register'
import 'monaco-editor/languages/definitions/ini/register'
import 'monaco-editor/languages/definitions/shell/register'
import 'monaco-editor/languages/definitions/xml/register'
import 'monaco-editor/languages/definitions/html/register'
import 'monaco-editor/languages/definitions/css/register'
import 'monaco-editor/languages/definitions/sql/register'
import 'monaco-editor/languages/definitions/dockerfile/register'
import 'monaco-editor/languages/definitions/python/register'
import 'monaco-editor/languages/definitions/go/register'
import 'monaco-editor/languages/definitions/javascript/register'
import 'monaco-editor/languages/definitions/typescript/register'
import 'monaco-editor/languages/features/json/register'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/languages/features/json/json.worker?worker'
import type { TextEditorProps } from './index'
import { registerTomlLanguage } from './toml'
import { getAccentPreference, subscribeAppearance } from '../theme'

// Register the services used by lazy JSON contributions before the first editor initializes.
import 'monaco-editor/editor/common/services/treeViewsDndService'
import 'monaco-editor/editor/contrib/codelens/browser/codeLensCache'
import 'monaco-editor/editor/contrib/documentSymbols/browser/outlineModel'
import 'monaco-editor/editor/contrib/suggest/browser/suggestMemory'

registerTomlLanguage()

globalThis.MonacoEnvironment = {
  getWorker: (_, label) => label === 'json' ? new JsonWorker() : new EditorWorker(),
}

export default function MonacoEditor(props: TextEditorProps) {
  const accent = useSyncExternalStore(subscribeAppearance, getAccentPreference)
  const host = useRef<HTMLDivElement>(null)
  const instance = useRef<editor.IStandaloneCodeEditor>(null)
  const latest = useRef(props)
  const applyingValue = useRef(false)

  useLayoutEffect(() => {
    latest.current = props
  }, [props])

  useLayoutEffect(() => {
    if (!host.current) return
    const styles = getComputedStyle(host.current)
    const color = (role: string) => styles.getPropertyValue('--godesk-' + role).trim()
      .replace(/^#([\da-f]{3,4})$/i, (_, digits: string) => '#' + [...digits].map(digit => digit.repeat(2)).join(''))
    const themeName = `godesk-${props.theme}`

    editor.defineTheme(themeName, {
      base: props.theme === 'dark' ? 'vs-dark' : 'vs',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': color('surface'),
        'editor.foreground': color('fg'),
        'editorCursor.foreground': color('accent'),
        'editorLineNumber.foreground': color('muted'),
        'editorLineNumber.activeForeground': color('fg'),
        'editor.lineHighlightBackground': color('subtle'),
        'editor.lineHighlightBorder': color('subtle'),
        'editor.selectionBackground': color('selected'),
        'editor.inactiveSelectionBackground': color('hover'),
        'editorWidget.background': color('raised'),
        'editorWidget.foreground': color('fg'),
        'editorWidget.border': color('border'),
        'focusBorder': color('focus'),
      },
    })
    editor.setTheme(themeName)
  }, [props.theme, accent])

  useLayoutEffect(() => {
    const container = host.current
    if (!container) return
    const { value, language, readOnly, wordWrap, fontSize } = latest.current
    const fontFamily = getComputedStyle(container).getPropertyValue('--godesk-font-mono').trim()
    const model = editor.createModel(value, language)
    const view = editor.create(container, {
      model,
      readOnly,
      ariaLabel: '正文',
      automaticLayout: true,
      fontFamily,
      fontSize,
      padding: { top: 10, bottom: 10 },
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      accessibilitySupport: 'auto',
      wordWrap,
    })
    instance.current = view
    void document.fonts.load(`${fontSize}px ${fontFamily}`).then(() => {
      if (instance.current === view) editor.remeasureFonts()
    }).catch(() => {
      // Monaco can continue using the fallback fonts.
    })
    const changes = model.onDidChangeContent(() => {
      if (!applyingValue.current) latest.current.onChange(model.getValue(undefined, true))
    })
    function handleWheel(event: WheelEvent) {
      if (!event.ctrlKey || event.deltaY === 0) return
      event.preventDefault()
      event.stopPropagation()
      latest.current.onFontSizeChange?.(event.deltaY < 0 ? 1 : -1)
    }
    container.addEventListener('wheel', handleWheel, { passive: false, capture: true })
    return () => {
      container.removeEventListener('wheel', handleWheel, { capture: true })
      changes.dispose()
      view.dispose()
      model.dispose()
      instance.current = null
    }
  }, [])

  useLayoutEffect(() => {
    const model = instance.current?.getModel()
    if (!model || model.getValue(undefined, true) === props.value) return
    applyingValue.current = true
    try {
      model.setValue(props.value)
    } finally {
      applyingValue.current = false
    }
  }, [props.value])

  useLayoutEffect(() => {
    const model = instance.current?.getModel()
    if (model) editor.setModelLanguage(model, props.language)
  }, [props.language])

  useLayoutEffect(() => {
    instance.current?.updateOptions({ readOnly: props.readOnly ?? false })
  }, [props.readOnly])

  useLayoutEffect(() => {
    instance.current?.updateOptions({ wordWrap: props.wordWrap })
  }, [props.wordWrap])

  useLayoutEffect(() => {
    instance.current?.updateOptions({ fontSize: props.fontSize })
  }, [props.fontSize])

  return <div ref={host} style={{ width: '100%', height: '100%' }} />
}
