import { createElement } from 'react'
import { FileArchive, FileText, Link2 } from 'lucide-react'
import C from '~icons/vscode-icons/file-type-c'
import CMake from '~icons/vscode-icons/file-type-cmake'
import Cpp from '~icons/vscode-icons/file-type-cpp'
import Docker from '~icons/vscode-icons/file-type-docker'
import Go from '~icons/vscode-icons/file-type-go'
import Json from '~icons/vscode-icons/file-type-json'
import License from '~icons/vscode-icons/file-type-license'
import Log from '~icons/vscode-icons/file-type-log'
import Makefile from '~icons/vscode-icons/file-type-makefile'
import Markdown from '~icons/vscode-icons/file-type-markdown'
import Npm from '~icons/vscode-icons/file-type-npm'
import Pdf from '~icons/vscode-icons/file-type-pdf'
import Python from '~icons/vscode-icons/file-type-python'
import Rust from '~icons/vscode-icons/file-type-rust'
import Yaml from '~icons/vscode-icons/file-type-yaml'

const byName = new Map([
  ['dockerfile', Docker], ['containerfile', Docker],
  ['makefile', Makefile], ['gnumakefile', Makefile],
  ['cmakelists.txt', CMake],
  ['license', License], ['license.md', License], ['license.txt', License],
  ['package.json', Npm], ['package-lock.json', Npm],
])

const byExtension = new Map([
  ['go', Go], ['c', C], ['h', C], ['cc', Cpp], ['cpp', Cpp], ['cxx', Cpp],
  ['hh', Cpp], ['hpp', Cpp], ['hxx', Cpp], ['rs', Rust], ['py', Python], ['pyi', Python],
  ['json', Json], ['jsonc', Json], ['yaml', Yaml], ['yml', Yaml],
  ['md', Markdown], ['markdown', Markdown], ['pdf', Pdf], ['log', Log],
  ['cmake', CMake], ['mk', Makefile], ['dockerfile', Docker],
])

export function FileIcon({ file }: { file: { name: string; directory?: string; symbolicLink?: boolean } }) {
  if (file.symbolicLink) return <Link2 className="file-type-icon muted" aria-hidden="true" />
  if (file.directory) return (
    <svg className="file-type-icon file-folder-icon" width={24} height={24} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M2 7a2 2 0 0 1 2-2h4.5l2 2H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2Z"
        fill="var(--folder-back, #e3a23a)" stroke="var(--folder-edge, #a76c1c)" strokeLinejoin="round" />
      <rect x="2" y="9" width="20" height="11" rx="2"
        fill="var(--folder-front, #f7ca62)" stroke="var(--folder-edge, #a76c1c)" />
    </svg>
  )

  const name = file.name.toLowerCase()
  const extensionStart = name.lastIndexOf('.')
  const extension = extensionStart > 0 ? name.slice(extensionStart + 1) : ''
  if (extension === 'zip') return <FileArchive className="file-type-icon muted" aria-hidden="true" />
  const Icon = byName.get(name) ?? byExtension.get(extension)
  return Icon
    ? createElement(Icon, { className: 'file-type-icon', 'aria-hidden': true })
    : <FileText className="file-type-icon muted" aria-hidden="true" />
}
