import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { gzipSync } from 'node:zlib'

const dist = process.argv[2]
const files = readdirSync(dist, { recursive: true, withFileTypes: true })
const packed = join(dist, 'packed')
mkdirSync(packed)

for (const file of files) {
  if (!file.isFile()) continue

  const source = join(file.parentPath, file.name)
  const original = readFileSync(source)
  const compressed = gzipSync(original, { level: 9 })
  const useGzip = compressed.length < original.length
  const target = join(packed, useGzip ? 'gzip' : 'identity', relative(dist, source))
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, useGzip ? compressed : original)
}
