import './styles.css'

// The plugin page runs in a same-origin iframe, matching the standalone host.
export function ExtensionWindow({ plugin }: { plugin: { id: string; name: string } }) {
  return (
    <iframe
      className="extension-frame"
      title={plugin.name}
      src={`/extensions/${encodeURIComponent(plugin.id)}/web/`}
    />
  )
}
