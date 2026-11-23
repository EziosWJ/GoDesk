import { useLayoutEffect, useRef, useState } from 'react'

export function useSplitLayout(minWidth: number, onChange: (split: boolean) => void) {
  const root = useRef<HTMLDivElement>(null)
  const callback = useRef(onChange)
  const [split, setSplit] = useState(false)

  useLayoutEffect(() => {
    callback.current = onChange
  }, [onChange])

  useLayoutEffect(() => {
    const element = root.current
    if (!element) return
    let previous: boolean | undefined

    function update(width: number) {
      if (width === 0) return
      const next = width >= minWidth
      if (next === previous) return
      if (previous !== undefined) callback.current(next)
      previous = next
      setSplit(next)
    }

    update(element.getBoundingClientRect().width)
    const observer = new ResizeObserver(([entry]) => update(entry.contentRect.width))
    observer.observe(element)
    return () => observer.disconnect()
  }, [minWidth])

  return { root, split }
}
