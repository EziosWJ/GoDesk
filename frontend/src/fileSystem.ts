import sampleImage from './assets/hero.png'

export type Entry = {
  id: string
  parent: string
  name: string
  type: string
  directory?: string
  size?: string
  content?: string
  image?: string
  archive?: Entry[]
}

export const home = 'home'
export const homePath = '/home/demo'
export const trash = 'trash'

export const textFileTypes = {
  txt: { language: 'plaintext', type: '文本文档' },
  md: { language: 'markdown', type: 'Markdown 文档' },
  log: { language: 'plaintext', type: '日志文件' },
  json: { language: 'json', type: 'JSON 文件' },
} as const

export function textFileType(name: string) {
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  return Object.hasOwn(textFileTypes, extension) ? textFileTypes[extension as keyof typeof textFileTypes] : undefined
}

export function editableFile(files: Entry[], entry: Entry) {
  return !entry.directory && !entry.archive && !!textFileType(entry.name) && !inTrash(files, entry.id)
}

export function textFileSize(text: string) {
  const bytes = new TextEncoder().encode(text).length
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
}

export function folder(id: string, parent: string, name: string): Entry {
  return { id, parent, name, type: '文件夹', directory: id }
}

export const initialFiles: Entry[] = [
  folder('docs', home, '文档'),
  folder('downloads', home, '下载'),
  folder('projects', home, '项目'),
  { id: 'sample-image', parent: 'downloads', name: '示例插图.png', type: 'PNG 图像', size: '13 KB', image: sampleImage },
  { id: 'readme', parent: home, name: 'README.md', type: 'Markdown 文档', size: '2 KB', content: '# React Web Desktop\n\nWeb 桌面前端脚手架的示例文件。' },
  { id: 'system-log', parent: home, name: 'system.log', type: '日志文件', size: '16 KB', content: '[INFO] React Web Desktop workspace ready.' },
  { id: 'manual', parent: 'docs', name: '使用手册.pdf', type: 'PDF 文档', size: '480 KB', content: 'React Web Desktop 使用手册（示例）\n\n通过位置导航切换目录，可在列表中选择多个文件。' },
  { id: 'notes', parent: 'docs', name: '操作记录.md', type: 'Markdown 文档', size: '4 KB', content: '# 操作记录\n\n工作区已初始化。' },
  { id: 'sample-archive', parent: 'projects', name: '项目示例.zip', type: 'ZIP 压缩包', size: '12 KB', archive: [
    { id: 'archive-readme', parent: home, name: 'README.md', type: 'Markdown 文档', content: '# 项目示例' },
    folder('archive-config', home, '配置'),
    { id: 'archive-json', parent: 'archive-config', name: 'settings.json', type: 'JSON 文件', content: '{ "workspace": "React Web Desktop" }' },
  ] },
  ...['react-web-desktop', 'desktop', 'monitor'].flatMap(project =>
    ['配置.json', '说明.md', '运行.log'].map((file, index) => ({
      id: `${project}-${index}`, parent: 'projects', name: `${project}-${file}`,
      type: ['JSON 文件', 'Markdown 文档', '日志文件'][index],
      size: ['3 KB', '8 KB', '24 KB'][index],
      content: [JSON.stringify({ project }, null, 2), `# ${project}`, `[INFO] ${project} started.`][index],
    })),
  ),
]

export function locationChain(files: Entry[], id: string) {
  const chain: Entry[] = []
  let entry = files.find(file => file.id === id)
  while (entry) {
    chain.unshift(entry)
    entry = files.find(file => file.id === entry?.parent)
  }
  return chain
}

export function inTrash(files: Entry[], id: string) {
  return id === trash || locationChain(files, id)[0]?.parent === trash
}

export function locationName(id: string) {
  return id === trash ? '回收站' : '主目录'
}

export function canTransfer(files: Entry[], ids: string[], target: string, move: boolean) {
  if (!ids.length || inTrash(files, target) || (target !== home && !files.some(file => file.id === target && file.directory))) return false
  if (locationChain(files, target).some(file => ids.includes(file.id))) return false
  return ids.every(id => files.some(file => file.id === id && (!move || file.parent !== target)) && !inTrash(files, id))
}

export type Transfer = { kind: 'move' | 'copy' | 'extract'; ids: string[]; target: string }
export type ConflictChoice = 'keep' | 'replace' | 'skip'

function sourceEntries(files: Entry[], transfer: Transfer) {
  const archive = transfer.kind === 'extract' ? files.find(file => file.id === transfer.ids[0])?.archive ?? [] : files
  return { archive, entries: archive.filter(file => transfer.kind === 'extract' ? file.parent === home : transfer.ids.includes(file.id)) }
}

export function transferConflicts(files: Entry[], transfer: Transfer) {
  return sourceEntries(files, transfer).entries.filter(source =>
    files.some(file => file.parent === transfer.target && file.name === source.name),
  )
}

export function availableName(files: Entry[], parent: string, name: string) {
  const taken = (candidate: string) => files.some(file => file.parent === parent && file.name === candidate)
  const extension = name.lastIndexOf('.')
  const base = extension > 0 ? name.slice(0, extension) : name
  const suffix = extension > 0 ? name.slice(extension) : ''
  let candidate = name
  for (let index = 2; taken(candidate); index++) candidate = `${base} (${index})${suffix}`
  return candidate
}

export function undoFileOperation(before: Entry[], after: Entry[], current: Entry[]) {
  const oldEntries = new Map(before.map(entry => [entry.id, entry]))
  const operationEntries = new Map(after.map(entry => [entry.id, entry]))
  const currentEntries = new Map(current.map(entry => [entry.id, entry]))
  const restored = before.map(entry => {
    const latest = currentEntries.get(entry.id)
    if (!latest) return entry
    if (entry === operationEntries.get(entry.id)) return latest
    return { ...latest, name: entry.name, parent: entry.parent }
  })
  for (const entry of current) {
    if (oldEntries.has(entry.id) || operationEntries.has(entry.id)) continue
    // A document saved after the operation can outlive the folder the operation created.
    const parent = operationEntries.has(entry.parent) && !oldEntries.has(entry.parent) ? home : entry.parent
    const name = availableName(restored, parent, entry.name)
    restored.push(parent === entry.parent && entry.name === name ? entry : { ...entry, parent, name })
  }
  return restored
}

export function transferFiles(files: Entry[], transfer: Transfer, choice: ConflictChoice, makeId: () => string) {
  const { archive, entries } = sourceEntries(files, transfer)
  let next = [...files]
  const completed: string[] = []

  function clone(entry: Entry, parent: string, name: string) {
    const id = makeId()
    next.push({ ...entry, id, parent, name, directory: entry.directory ? id : undefined })
    for (const child of archive.filter(file => file.parent === entry.id)) clone(child, id, child.name)
  }

  for (const entry of entries) {
    const collision = files.find(file => file.parent === transfer.target && file.name === entry.name)
    if (collision && choice === 'skip') continue
    // Keep the source of a same-folder copy and the ancestry of an item being copied.
    const replace = collision && choice === 'replace' && !transfer.ids.includes(collision.id)
      && !entries.some(source => locationChain(files, source.id).some(ancestor => ancestor.id === collision.id))
    if (replace) next = next.map(file => file.id === collision.id ? { ...file, parent: trash } : file)
    const reserved = entries.filter(source => source.id !== entry.id).map(source => ({ ...source, parent: transfer.target }))
    const name = availableName([...next, ...reserved], transfer.target, entry.name)
    if (transfer.kind === 'move') next = next.map(file => file.id === entry.id ? { ...file, parent: transfer.target, name } : file)
    else clone(entry, transfer.target, name)
    completed.push(entry.id)
  }

  return { files: next, completed, skipped: entries.length - completed.length }
}
