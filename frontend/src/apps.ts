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
import settingsLauncher from './assets/apps/settings.svg'

export const apps = {
  files: { name: '文件管理器', icon: FolderClosed, launcherIcon: filesLauncher, width: 684, height: 430 },
  editor: { name: '文本编辑器', icon: FilePenLine, launcherIcon: editorLauncher, width: 720, height: 460 },
  terminal: { name: '终端', icon: Terminal, launcherIcon: terminalLauncher, width: 600, height: 366 },
  sessions: { name: '会话管理', icon: List, launcherIcon: sessionsLauncher, width: 660, height: 430 },
  monitor: { name: '系统监控', icon: Activity, launcherIcon: monitorLauncher, Content: SystemMonitor, width: 760, height: 520 },
  services: { name: '服务管理', icon: Cable, launcherIcon: servicesLauncher, Content: Services, width: 1000, height: 640 },
  extensions: { name: '扩展', icon: Puzzle, launcherIcon: extensionsLauncher, width: 820, height: 580 },
  icons: { name: '图标管理', icon: LayoutGrid, launcherIcon: undefined, width: 640, height: 440 },
  settings: { name: '系统设置', icon: Settings2, launcherIcon: settingsLauncher, Content: Settings, width: 720, height: 480 },
}
export type AppId = keyof typeof apps
