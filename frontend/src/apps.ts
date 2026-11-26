import { Activity, Cable, FilePenLine, FolderClosed, LayoutGrid, List, Puzzle, Settings2, Terminal } from 'lucide-react'
import { Settings } from './AppPages'
import { Services } from './Services'
import { SystemMonitor } from './SystemMonitor'
import filesLauncher from './assets/apps/file-manager.svg'
import editorLauncher from './assets/apps/editor.svg'
import terminalLauncher from './assets/apps/terminal.svg'
import sessionsLauncher from './assets/apps/sessions.svg'
import monitorLauncher from './assets/apps/monitor.svg'
import servicesLauncher from './assets/apps/services.svg'
import extensionsLauncher from './assets/apps/extensions.svg'
import iconsLauncher from './assets/apps/icons.svg'
import settingsLauncher from './assets/apps/settings.svg'
import webShortcutLauncher from './assets/apps/web-shortcut.svg'

export { webShortcutLauncher }

export const apps = {
  files: { name: '文件管理器', icon: FolderClosed, launcherIcon: filesLauncher, width: 920, height: 600 },
  editor: { name: '文本编辑器', icon: FilePenLine, launcherIcon: editorLauncher, width: 880, height: 580 },
  terminal: { name: '终端', icon: Terminal, launcherIcon: terminalLauncher, width: 760, height: 480 },
  sessions: { name: '会话管理', icon: List, launcherIcon: sessionsLauncher, width: 780, height: 500 },
  monitor: { name: '系统监控', icon: Activity, launcherIcon: monitorLauncher, Content: SystemMonitor, width: 920, height: 620 },
  services: { name: '服务管理', icon: Cable, launcherIcon: servicesLauncher, Content: Services, width: 1040, height: 660 },
  extensions: { name: '扩展', icon: Puzzle, launcherIcon: extensionsLauncher, width: 880, height: 600 },
  icons: { name: '图标管理', icon: LayoutGrid, launcherIcon: iconsLauncher, width: 720, height: 500 },
  settings: { name: '系统设置', icon: Settings2, launcherIcon: settingsLauncher, Content: Settings, width: 860, height: 580 },
}
export type AppId = keyof typeof apps
