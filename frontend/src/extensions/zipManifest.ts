export type ZipManifest = {
  id?: string
  name?: string
  version?: string
}

export type VersionComparison = 'upgrade' | 'same' | 'downgrade' | 'unknown'

const EOCD_SIG = 0x06054b50
const CD_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

function findEndOfCentralDirectory(view: DataView, length: number): number {
  const minOffset = Math.max(0, length - 65557)
  for (let offset = length - 22; offset >= minOffset; offset--) {
    if (view.getUint32(offset, true) === EOCD_SIG) return offset
  }
  return -1
}

async function decompressDeflateRaw(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('DecompressionStream unavailable')
  }
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  const buffer = await new Response(stream).arrayBuffer()
  return new Uint8Array(buffer)
}

/**
 * Best-effort client-side reader for root `manifest.json` inside a plugin ZIP.
 * Returns null if the archive is malformed, encrypted, uses an unsupported
 * compression method, or the browser lacks `DecompressionStream`.
 */
export async function readZipManifest(file: File): Promise<ZipManifest | null> {
  try {
    const buffer = await file.arrayBuffer()
    const bytes = new Uint8Array(buffer)
    if (bytes.length < 22) return null
    const view = new DataView(buffer)

    const eocd = findEndOfCentralDirectory(view, bytes.length)
    if (eocd < 0) return null

    const cdSize = view.getUint32(eocd + 12, true)
    const cdOffset = view.getUint32(eocd + 16, true)
    if (cdOffset + cdSize > bytes.length) return null

    const decoder = new TextDecoder()
    let offset = cdOffset
    const cdEnd = cdOffset + cdSize

    while (offset + 46 <= cdEnd) {
      if (view.getUint32(offset, true) !== CD_SIG) return null
      const method = view.getUint16(offset + 10, true)
      const compressedSize = view.getUint32(offset + 20, true)
      const nameLen = view.getUint16(offset + 28, true)
      const extraLen = view.getUint16(offset + 30, true)
      const commentLen = view.getUint16(offset + 32, true)
      const localHeaderOffset = view.getUint32(offset + 42, true)

      const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLen))
      if (name === 'manifest.json' || name === './manifest.json') {
        if (localHeaderOffset + 30 > bytes.length) return null
        if (view.getUint32(localHeaderOffset, true) !== LOCAL_SIG) return null
        const localNameLen = view.getUint16(localHeaderOffset + 26, true)
        const localExtraLen = view.getUint16(localHeaderOffset + 28, true)
        const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen
        if (dataStart + compressedSize > bytes.length) return null

        let raw: Uint8Array
        if (method === 0) {
          raw = bytes.subarray(dataStart, dataStart + compressedSize)
        } else if (method === 8) {
          raw = await decompressDeflateRaw(bytes.slice(dataStart, dataStart + compressedSize))
        } else {
          return null
        }

        const parsed = JSON.parse(decoder.decode(raw)) as Record<string, unknown>
        if (!parsed || typeof parsed !== 'object') return null
        return {
          id: typeof parsed.id === 'string' && parsed.id.trim() ? parsed.id.trim() : undefined,
          name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : undefined,
          version: typeof parsed.version === 'string' && parsed.version.trim() ? parsed.version.trim() : undefined,
        }
      }

      offset += 46 + nameLen + extraLen + commentLen
    }
    return null
  } catch {
    return null
  }
}

type ParsedSemver = {
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

function parseSemver(input: string): ParsedSemver | null {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(input.trim())
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
    prerelease: match[4] ? match[4].split('.') : [],
  }
}

function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    if (i >= a.length) return -1
    if (i >= b.length) return 1
    const left = a[i]
    const right = b[i]
    if (left === right) continue
    const leftNum = /^\d+$/.test(left)
    const rightNum = /^\d+$/.test(right)
    if (leftNum && rightNum) return Number(left) - Number(right)
    if (leftNum) return -1
    if (rightNum) return 1
    return left < right ? -1 : 1
  }
  return 0
}

export function compareVersions(next: string, current: string): VersionComparison {
  const nextTrim = next.trim()
  const currentTrim = current.trim()
  if (!nextTrim || !currentTrim) return 'unknown'
  if (nextTrim === currentTrim) return 'same'

  const a = parseSemver(nextTrim)
  const b = parseSemver(currentTrim)
  if (!a || !b) return 'unknown'

  const diff = a.major - b.major || a.minor - b.minor || a.patch - b.patch || comparePrerelease(a.prerelease, b.prerelease)
  if (diff > 0) return 'upgrade'
  if (diff < 0) return 'downgrade'
  return 'same'
}
