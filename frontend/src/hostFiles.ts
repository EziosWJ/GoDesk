import type { Entry } from './fileSystem'

const prefix = '/api/v1/files'

export type Conflict = 'keep' | 'skip'
export type FileAction = 'mkdir' | 'rename' | 'copy' | 'move' | 'delete'
export type PathChange = { from: string; to: string; copied?: boolean }
type Result = { path: string; skipped?: boolean; copied?: boolean }
type Document = { path: string; text: string; version: string }
type HostEntry = {
  name: string
  path: string
  kind: string
  size: number
  owner: string
  group: string
  permissions: string
  mode: string
  modTime: string
  targetKind?: string
  targetError?: string
}

export type HostFile = Pick<Entry, 'id' | 'name' | 'type' | 'size' | 'directory'>
  & Pick<HostEntry, 'kind' | 'targetKind' | 'targetError' | 'owner' | 'group' | 'permissions' | 'mode' | 'modTime'>
  & { symbolicLink: boolean; sizeBytes: number }

export type ExtractMode = 'folder' | 'here'
export type ExtractResult = { destination: string; extracted: number; skipped: number }

export class FileError extends Error {
  readonly code: string
  readonly path?: string

  constructor(code: string, message: string, path?: string) {
    super(message)
    this.code = code
    this.path = path
  }
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '操作失败'
}

export function archiveErrorMessage(error: unknown, elevated = false) {
  if (error instanceof FileError) {
    switch (error.code) {
      case 'path_traversal': return '归档包含越界路径，已拒绝解压'
      case 'invalid_archive': return '归档文件无效或已损坏'
      case 'unsupported_type': return '不支持此归档格式或文件类型'
      case 'permission': return elevated ? '权限不足，或无法以管理员身份执行此操作' : '没有权限执行此操作'
      case 'not_found': return '目标文件或目录不存在'
      case 'exists': return '目标位置已存在同名项'
    }
  }
  return errorMessage(error)
}

function responseError(data: { code?: string; message?: string; path?: string } | undefined, status: number) {
  return new FileError(data?.code ?? 'request_failed',
    status === 401 ? '登录已过期，请重新登录' : data?.message ?? `文件请求失败（${status}）`, data?.path)
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(prefix + path, init)
  const data = await response.json().catch(() => undefined)
  if (!response.ok || !data) throw responseError(data, response.status)
  return data
}

function json(method: string, data: object): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }
}

function endpoint(path: string, parameters: Record<string, string> = {}, elevated = false) {
  const query = new URLSearchParams(parameters)
  if (elevated) query.set('elevated', 'true')
  return query.size ? `${path}?${query}` : path
}

export function readFileIdentity(signal: AbortSignal) {
  return request<{ root: boolean }>('/identity', { signal })
}

export const filename = (path: string) => path.slice(path.lastIndexOf('/') + 1) || '/'
export const parentPath = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/'
export const childPath = (directory: string, name: string) => directory === '/' ? `/${name}` : `${directory}/${name}`

export function pathCrumbs(path: string) {
  let current = '/'
  return [{ id: '/', name: '/' }, ...path.split('/').filter(Boolean).map(name => {
    current = childPath(current, name)
    return { id: current, name }
  })]
}

export function regularFile(file?: HostFile) {
  return file?.kind === 'file' || file?.targetKind === 'file'
}

export function imageFile(file: HostFile) {
  return regularFile(file) && /\.(?:png|jpe?g|gif|webp|bmp|ico|svg)$/i.test(file.name)
}

export function archiveFile(file?: HostFile) {
  return !!file && regularFile(file) && /\.(?:zip|tar\.gz|tgz|tar)$/i.test(file.name)
}

export function managedFile(file: HostFile) {
  return ['file', 'directory', 'symlink'].includes(file.kind)
}

function sizeLabel(bytes: number) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let unit = 0
  while (bytes >= 1024 && unit < units.length - 1) {
    bytes /= 1024
    unit++
  }
  return `${unit ? bytes.toFixed(1) : bytes} ${units[unit]}`
}

export async function readDirectory(path = '', signal?: AbortSignal, elevated = false) {
  const data = await request<{ path: string; home: string; entries: HostEntry[] }>(
    endpoint('/directory', path ? { path } : {}, elevated), { signal },
  )
  const entries = data.entries.map((entry): HostFile => {
    const directory = entry.kind === 'directory' || entry.targetKind === 'directory'
    const kinds: Record<string, string> = { directory: '文件夹', symlink: '符号链接', fifo: 'FIFO', socket: '套接字', device: '设备', other: '特殊文件' }
    const type = kinds[entry.kind] ?? '文件'
    return {
      ...entry,
      id: entry.path,
      type,
      symbolicLink: entry.kind === 'symlink',
      directory: directory ? entry.path : undefined,
      size: entry.kind === 'file' ? sizeLabel(entry.size) : undefined,
      sizeBytes: entry.kind === 'file' ? entry.size : 0,
    }
  }).sort((a, b) => Number(!!b.directory) - Number(!!a.directory) || a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))
  return { ...data, entries }
}

export function fileAction(operation: FileAction, path: string, options: { destination?: string; name?: string; conflict?: Conflict } = {}, elevated = false) {
  return request<Result>(endpoint('/action', {}, elevated), json('POST', { operation, path, ...options }))
}

export function writeOwnership(path: string, values: { owner?: string; group?: string }, elevated = false) {
  return request<Result>(endpoint('/ownership', {}, elevated), json('PUT', { path, ...values }))
}

export function writePermissions(path: string, mode: string, elevated = false) {
  return request<Result>(endpoint('/permissions', {}, elevated), json('PUT', { path, mode }))
}

export function uploadFile(directory: string, file: File, conflict: Conflict | undefined, progress: (percent: number) => void, elevated = false) {
  return new Promise<Result>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', prefix + endpoint('/upload', { directory, name: file.name, ...(conflict ? { conflict } : {}) }, elevated))
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.responseType = 'json'
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) progress(Math.round(event.loaded * 100 / event.total))
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300 && xhr.response) resolve(xhr.response)
      else reject(responseError(xhr.response, xhr.status))
    }
    xhr.onerror = () => reject(new FileError('network', '上传连接中断'))
    xhr.send(file)
  })
}

export async function downloadFile(path: string, elevated = false) {
  const url = prefix + endpoint('/download', { path }, elevated)
  if (elevated) {
    const response = await fetch(url, { method: 'HEAD' })
    if (!response.ok) {
      if (response.status === 403) throw new FileError('permission', '无法以管理员身份下载，请检查免密 sudo 授权')
      throw responseError(undefined, response.status)
    }
  }
  // The browser streams the attachment directly to disk.
  const link = document.createElement('a')
  link.href = url
  link.download = filename(path)
  link.click()
}

export async function downloadArchive(paths: string[], elevated = false) {
  const query = new URLSearchParams()
  for (const path of paths) query.append('path', path)
  if (elevated) query.set('elevated', 'true')
  const url = `${prefix}/archive/download?${query}`
  const response = await fetch(url, { method: 'HEAD' })
  if (!response.ok) {
    if (response.status === 401) throw new FileError('unauthorized', '登录已过期，请重新登录')
    if (response.status === 403) {
      throw new FileError('permission', elevated ? '无法以管理员身份打包下载，请检查权限或免密 sudo 授权' : '没有权限读取所选文件或文件夹')
    }
    if (response.status === 404) throw new FileError('not_found', '所选文件或文件夹不存在')
    if (response.status === 415) throw new FileError('unsupported_type', '所选内容包含不支持打包的文件类型')
    if (response.status === 400) throw new FileError('invalid_request', '所选路径无效')
    throw responseError(undefined, response.status)
  }
  const link = document.createElement('a')
  link.href = url
  link.setAttribute('download', '')
  link.click()
}

export function compressArchive(paths: string[], destination: string, conflict?: Conflict, elevated = false) {
  return request<{ path: string }>(
    endpoint('/archive/compress', {}, elevated),
    json('POST', { paths, destination, ...(conflict ? { conflict } : {}) }),
  )
}

export function extractArchive(
  path: string,
  mode: ExtractMode,
  options: { destination?: string; conflict?: Conflict } = {},
  elevated = false,
) {
  return request<ExtractResult>(
    endpoint('/archive/extract', {}, elevated),
    json('POST', { path, mode, ...options }),
  )
}

export function imagePreviewURL(path: string, elevated: boolean) {
  return prefix + endpoint('/image', { path }, elevated)
}

export function readText(path: string, signal?: AbortSignal, elevated = false) {
  return request<Document>(endpoint('/text', { path }, elevated), { signal })
}

export function writeText(path: string, text: string, version?: string, conflict?: Conflict, elevated = false) {
  return request<Omit<Document, 'text'>>(endpoint('/text', {}, elevated), json('PUT', { path, text, version, conflict }))
}

export function canTransfer(paths: string[], target: string, move: boolean) {
  if (!paths.length || !target) return false
  return paths.every(path => target !== path && !target.startsWith(`${path}/`) && (!move || parentPath(path) !== target))
}

const fileChanges = new EventTarget()

export function announceFileChange(change?: PathChange) {
  fileChanges.dispatchEvent(new CustomEvent<PathChange | undefined>('change', { detail: change }))
}

export function subscribeToFileChanges(listener: (change?: PathChange) => void) {
  const handler = (event: Event) => listener((event as CustomEvent<PathChange | undefined>).detail)
  fileChanges.addEventListener('change', handler)
  return () => fileChanges.removeEventListener('change', handler)
}
