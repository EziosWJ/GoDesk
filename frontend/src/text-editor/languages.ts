export type TextLanguage =
  | 'plaintext'
  | 'markdown'
  | 'json'
  | 'yaml'
  | 'ini'
  | 'shell'
  | 'toml'
  | 'xml'
  | 'html'
  | 'css'
  | 'sql'
  | 'dockerfile'
  | 'python'
  | 'go'
  | 'javascript'
  | 'typescript'

export type TextFileDescriptor = {
  language: TextLanguage
  type: string
}

const extensionTypes: Record<string, TextFileDescriptor> = {
  txt: { language: 'plaintext', type: '文本文档' },
  log: { language: 'plaintext', type: '日志文件' },
  md: { language: 'markdown', type: 'Markdown 文档' },
  json: { language: 'json', type: 'JSON 文件' },
  yaml: { language: 'yaml', type: 'YAML 文件' },
  yml: { language: 'yaml', type: 'YAML 文件' },
  ini: { language: 'ini', type: 'INI 配置' },
  conf: { language: 'ini', type: '配置文件' },
  cfg: { language: 'ini', type: '配置文件' },
  service: { language: 'ini', type: 'systemd 单元' },
  socket: { language: 'ini', type: 'systemd 单元' },
  timer: { language: 'ini', type: 'systemd 单元' },
  target: { language: 'ini', type: 'systemd 单元' },
  mount: { language: 'ini', type: 'systemd 单元' },
  path: { language: 'ini', type: 'systemd 单元' },
  slice: { language: 'ini', type: 'systemd 单元' },
  env: { language: 'ini', type: '环境配置' },
  sh: { language: 'shell', type: 'Shell 脚本' },
  bash: { language: 'shell', type: 'Shell 脚本' },
  zsh: { language: 'shell', type: 'Shell 脚本' },
  bashrc: { language: 'shell', type: 'Shell 脚本' },
  zshrc: { language: 'shell', type: 'Shell 脚本' },
  profile: { language: 'shell', type: 'Shell 脚本' },
  toml: { language: 'toml', type: 'TOML 配置' },
  xml: { language: 'xml', type: 'XML 文件' },
  svg: { language: 'xml', type: 'SVG 文件' },
  html: { language: 'html', type: 'HTML 文件' },
  htm: { language: 'html', type: 'HTML 文件' },
  css: { language: 'css', type: 'CSS 样式' },
  sql: { language: 'sql', type: 'SQL 脚本' },
  dockerfile: { language: 'dockerfile', type: 'Dockerfile' },
  py: { language: 'python', type: 'Python 脚本' },
  go: { language: 'go', type: 'Go 源码' },
  js: { language: 'javascript', type: 'JavaScript' },
  mjs: { language: 'javascript', type: 'JavaScript' },
  cjs: { language: 'javascript', type: 'JavaScript' },
  jsx: { language: 'javascript', type: 'JavaScript' },
  ts: { language: 'typescript', type: 'TypeScript' },
  tsx: { language: 'typescript', type: 'TypeScript' },
}

const fallbackType: TextFileDescriptor = { language: 'plaintext', type: '纯文本' }

export function detectTextLanguage(name: string): TextFileDescriptor {
  const base = name.slice(name.lastIndexOf('/') + 1).toLowerCase()
  if (base === 'dockerfile' || base.startsWith('dockerfile.')) {
    return { language: 'dockerfile', type: 'Dockerfile' }
  }
  if (base === '.env' || base.startsWith('.env.')) {
    return { language: 'ini', type: '环境配置' }
  }
  if (base === '.bashrc' || base === '.zshrc' || base === '.profile') {
    return { language: 'shell', type: 'Shell 脚本' }
  }
  const dot = base.lastIndexOf('.')
  if (dot >= 0) {
    const extension = base.slice(dot + 1)
    if (Object.hasOwn(extensionTypes, extension)) return extensionTypes[extension]
  }
  return fallbackType
}
