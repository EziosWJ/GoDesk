import { lazy, Suspense } from 'react'

export type TextEditorProps = {
  documentId: string
  value: string
  language: 'plaintext' | 'markdown' | 'json'
  theme: 'light' | 'dark'
  readOnly?: boolean
  onChange: (value: string) => void
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
