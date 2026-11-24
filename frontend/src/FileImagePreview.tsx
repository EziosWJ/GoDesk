import { useId, useState, type Ref } from 'react'
import { X } from 'lucide-react'
import { imagePreviewURL, type HostFile } from './hostFiles'
import './styles/file-image-preview.css'

export function FileImagePreview({ ref, file, elevated, onClose }: {
  ref: Ref<HTMLDialogElement>
  file: HostFile
  elevated: boolean
  onClose: () => void
}) {
  const title = useId()
  const source = imagePreviewURL(file.id, elevated)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')

  async function imageFailed() {
    try {
      const { status } = await fetch(source, { method: 'HEAD' })
      const errors: Record<number, string> = {
        401: '登录已过期，请重新登录。',
        403: '没有权限读取图片。',
        404: '图片文件已不存在。',
        415: '文件内容不是受支持的图片格式。',
      }
      setError(errors[status] ?? '无法显示图片，文件可能已损坏或浏览器不支持此格式。')
    } catch {
      setError('无法连接主机以读取图片。')
    }
  }

  return (
    <dialog ref={ref} className="service-dialog file-image-preview" aria-labelledby={title}
      onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose() }}>
      <header className="file-image-preview-header">
        <h2 id={title} className="truncate" title={file.id}>{file.name}</h2>
        <button className="app-control" type="button" aria-label="关闭图片预览" onClick={onClose}>
          <X size={18} aria-hidden="true" />
        </button>
      </header>
      <div className="file-image-preview-content">
        {!loaded && (error ? <p role="alert">{error}</p> : <p role="status">正在读取图片…</p>)}
        <img src={source} alt={file.name} hidden={!loaded} onLoad={() => setLoaded(true)} onError={() => void imageFailed()} />
      </div>
    </dialog>
  )
}
