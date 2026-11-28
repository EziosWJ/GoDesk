import { useEffect, useId, useRef, useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import { ExtensionError, extensionErrorMessage, extensionsApi, localizedPluginName, type ExtensionPlugin } from './api'
import { compareVersions, readZipManifest, type ZipManifest } from './zipManifest'

export type UpgradeSource = 'install' | 'row'

export function UpgradeDialog({ plugin, file, source, onClose, onUpgraded }: {
  plugin: ExtensionPlugin
  file: File
  source: UpgradeSource
  onClose: () => void
  onUpgraded: (updated: ExtensionPlugin, previousVersion: string) => Promise<void>
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const [inspected, setInspected] = useState<{ file: File; manifest: ZipManifest | null }>()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])

  useEffect(() => {
    let cancelled = false
    void readZipManifest(file).then(parsed => {
      if (!cancelled) setInspected({ file, manifest: parsed })
    })
    return () => { cancelled = true }
  }, [file])

  const inspecting = inspected?.file !== file
  const manifest = inspecting ? undefined : inspected.manifest
  const manifestId = manifest?.id
  const idMismatch = Boolean(manifestId && manifestId !== plugin.id)

  function close() {
    if (pending) return
    dialog.current?.close()
    onClose()
  }

  async function confirm() {
    if (inspecting || idMismatch) return
    setPending(true)
    setError('')
    try {
      const updated = await extensionsApi.upgrade(plugin.id, file)
      await onUpgraded(updated, plugin.version)
    } catch (cause) {
      if (cause instanceof ExtensionError && cause.status === 401) {
        window.location.reload()
        return
      }
      setError(extensionErrorMessage(cause, '升级失败'))
    } finally {
      setPending(false)
    }
  }

  const nextVersion = manifest?.version
  const comparison = nextVersion ? compareVersions(nextVersion, plugin.version) : 'unknown'

  return (
    <dialog
      ref={dialog}
      className="extension-dialog"
      aria-labelledby={titleId}
      onCancel={event => { event.preventDefault(); close() }}
    >
      <div className="extension-dialog-body">
        <h2 id={titleId}>升级 {localizedPluginName(plugin)}</h2>

        {source === 'install' && (
          <p className="extension-hint">检测到该扩展已安装，确认后将使用所选插件包原地升级。</p>
        )}

        <dl className="extension-upgrade-summary">
          <div>
            <dt>扩展 ID</dt>
            <dd className="extension-mono">{plugin.id}</dd>
          </div>
          <div>
            <dt>插件包</dt>
            <dd className="extension-mono">{file.name}</dd>
          </div>
          <div>
            <dt>版本变更</dt>
            <dd className="extension-mono">
              {inspecting && `${plugin.version} → 正在读取…`}
              {!inspecting && nextVersion && `${plugin.version} → ${nextVersion}`}
              {!inspecting && !nextVersion && `当前 ${plugin.version}（上传后由宿主校验新版本）`}
            </dd>
          </div>
        </dl>

        {idMismatch && (
          <p className="extensions-error" role="alert">
            所选插件包的扩展 ID 为「{manifestId}」，与当前升级目标「{plugin.id}」不一致，无法用于升级此扩展。
          </p>
        )}

        {!idMismatch && comparison === 'same' && nextVersion && (
          <p className="extension-warning-box" role="note">
            <TriangleAlert size={15} aria-hidden="true" />
            <span>新版本与当前版本相同（{plugin.version}），确认后将覆盖现有插件包。</span>
          </p>
        )}

        {!idMismatch && comparison === 'downgrade' && nextVersion && (
          <p className="extension-warning-box" role="note">
            <TriangleAlert size={15} aria-hidden="true" />
            <span>新版本（{nextVersion}）低于当前版本（{plugin.version}），确认后将降级替换现有插件包。</span>
          </p>
        )}

        <p className="extension-hint">升级会保留现有配置（含密钥）与业务数据；若扩展当前已启用，替换后会自动重新启动。</p>

        {error && <p className="extensions-error" role="alert">{error}</p>}
      </div>

      <div className="extension-dialog-actions">
        <button type="button" className="app-control" disabled={pending} onClick={close}>取消</button>
        <button type="button" className="app-control primary-control" disabled={pending || inspecting || idMismatch} autoFocus onClick={() => void confirm()}>
          {pending ? '正在升级…' : inspecting ? '正在检查…' : '确认升级'}
        </button>
      </div>
    </dialog>
  )
}
