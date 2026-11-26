import { useCallback, useLayoutEffect, useRef, type ReactNode } from 'react'
import type { WindowState } from '@surdeddd/wmkit'
import { useWmWindowRef, type UseDesktopResult } from '@surdeddd/wmkit/react'
import { Minus, Square, SquaresSubtract, X } from 'lucide-react'
import { AppIcon } from './AppIcon'
import type { AppId } from './apps'

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

function windowMotionDuration(style: CSSStyleDeclaration, token: 'overlay' | 'feedback') {
  const duration = style.getPropertyValue(`--godesk-duration-${token}`).trim()
  return Number.parseFloat(duration) * (duration.endsWith('ms') ? 1 : 1000)
}

export function AppWindow({ binder, win, appId, closing, children, onRequestClose, onExited }: {
  binder: UseDesktopResult['binder']
  win: Pick<WindowState, 'id' | 'openedSeq' | 'title' | 'stage'>
  appId: AppId
  closing: boolean
  children: ReactNode
  onRequestClose?: () => void
  onExited: (openedSeq: number) => void
}) {
  const bindWindow = useWmWindowRef(binder, win.id)
  const element = useRef<HTMLElement>(null)
  const entrance = useRef<Animation>(null)
  const ref = useCallback((node: HTMLElement | null) => {
    element.current = node
    if (!closing) bindWindow(node)
  }, [bindWindow, closing])
  const maximized = win.stage === 'maximized'
  const MaximizeIcon = maximized ? SquaresSubtract : Square

  useLayoutEffect(() => {
    const node = element.current
    if (!node || reducedMotion.matches) return

    // WMKit owns transform. The individual translate property adds the entry offset.
    const animation = node.animate([
      { opacity: 0, translate: '0 8px' },
      { opacity: 1, translate: '0 0' },
    ], { duration: windowMotionDuration(getComputedStyle(node), 'overlay'), easing: 'ease-out', fill: 'backwards' })
    entrance.current = animation

    function reduceMotion(event: MediaQueryListEvent) {
      if (event.matches) animation.cancel()
    }

    reducedMotion.addEventListener('change', reduceMotion)
    return () => {
      reducedMotion.removeEventListener('change', reduceMotion)
      animation.cancel()
    }
  }, [])

  useLayoutEffect(() => {
    if (!closing && win.stage !== 'normal') entrance.current?.cancel()
  }, [closing, win.stage])

  useLayoutEffect(() => {
    const node = element.current
    if (!closing || !node) return
    if (reducedMotion.matches) {
      onExited(win.openedSeq)
      return
    }

    const style = getComputedStyle(node)
    const { opacity, translate } = style
    entrance.current?.cancel()
    const animation = node.animate([
      { opacity, translate },
      { opacity: 0, translate },
    ], { duration: windowMotionDuration(style, 'feedback'), easing: 'ease-out', fill: 'forwards' })
    let active = true
    function finish() {
      if (active) onExited(win.openedSeq)
    }
    function reduceMotion(event: MediaQueryListEvent) {
      if (event.matches) finish()
    }

    void animation.finished.then(finish, finish)
    reducedMotion.addEventListener('change', reduceMotion)
    return () => {
      active = false
      reducedMotion.removeEventListener('change', reduceMotion)
      animation.cancel()
    }
  }, [closing, onExited, win.openedSeq])

  return (
    <section ref={ref} className="app-window" tabIndex={-1} aria-label={win.title} data-app-window={appId}
      inert={closing}>
      <header className="titlebar" data-wm-drag>
        <span className="flex min-w-0 items-center gap-2">
          <AppIcon id={appId} size={16} className="window-title-icon" />
          <span data-wm-title className="truncate">{win.title}</span>
        </span>
        <span className="window-controls" data-wm-controls>
          <button type="button" data-wm-minimize aria-label="最小化" title="最小化"><Minus size={16} aria-hidden="true" /></button>
          <button type="button" data-wm-maximize aria-label={maximized ? '还原' : '最大化'} title={maximized ? '还原' : '最大化'}>
            <MaximizeIcon size={14} aria-hidden="true" />
          </button>
          <button type="button" data-wm-close aria-label="关闭" title="关闭" onClickCapture={onRequestClose && (event => {
            event.stopPropagation()
            onRequestClose()
          })}><X size={17} aria-hidden="true" /></button>
        </span>
      </header>
      <div className="window-content" data-wm-content>
        {children}
      </div>
    </section>
  )
}
