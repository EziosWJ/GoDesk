import { lazy, Suspense } from 'react'
import type { TextLanguage } from './languages'

export type WordWrap = 'on' | 'off'

export type TextEditorProps = {
  documentId: string
  value: string
  language: TextLanguage
  theme: 'light' | 'dark'
  wordWrap: WordWrap
  fontSize: number
  readOnly?: boolean
  onChange: (value: string) => void
  onFontSizeChange?: (delta: number) => void
}

const EditorAdapter = lazy(() => import('./MonacoEditor'))

export function TextEditor(props: TextEditorProps) {
  return (
    <Suspense fallback={
      <div role="status" style={{ display: 'grid', placeItems: 'center', height: '100%' }}>正在加载文本编辑器…</div>
    }>
      <EditorAdapter key={props.documentId} {...props} />
    </Suspense>
  )
}
