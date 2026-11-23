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
