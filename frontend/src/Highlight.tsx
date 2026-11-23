import type { ReactNode } from 'react'

export function Highlight({ text, needle }: { text: string; needle: string }) {
  const query = needle.trim().toLowerCase()
  if (!query) return <>{text}</>
  const lower = text.toLowerCase()
  const parts: ReactNode[] = []
  let index = 0
  let match = lower.indexOf(query)
  while (match !== -1) {
    if (match > index) parts.push(text.slice(index, match))
    parts.push(<mark key={match}>{text.slice(match, match + query.length)}</mark>)
    index = match + query.length
    match = lower.indexOf(query, index)
  }
  if (index < text.length) parts.push(text.slice(index))
  return <>{parts}</>
}
