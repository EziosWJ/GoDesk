import { Globe } from 'lucide-react'
import { apps, webShortcutLauncher, type AppId } from './apps'

export type AppIconId = AppId | 'web-shortcut'

export function AppIcon({
  id,
  size = 42,
  className = 'shortcut-tile',
}: {
  id: AppIconId
  size?: number
  className?: string
}) {
  const { icon: Icon, launcherIcon } = id === 'web-shortcut'
    ? { icon: Globe, launcherIcon: webShortcutLauncher }
    : apps[id]

  return (
    <span className={className} style={{ width: size, height: size }} aria-hidden="true">
      <img src={launcherIcon} alt="" width={size} height={size} draggable={false} />
      <Icon className="shortcut-tile-fallback" size={Math.max(16, Math.round(size * 0.58))} strokeWidth={1.75} />
    </span>
  )
}
