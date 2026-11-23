import { Fragment, useMemo, useRef, useState } from 'react'
import * as Menu from '@radix-ui/react-menu'
import { Check, ChevronRight, type LucideIcon } from 'lucide-react'
import './styles/command-menu.css'

type MenuItem = { label: string; icon: LucideIcon; shortcut?: string; disabled?: boolean }

export type MenuCommand = MenuItem & {
  run: () => void
  checked?: boolean
  danger?: boolean
}

type MenuBranch = MenuItem & { groups: MenuGroup[] }
export type MenuGroup = (MenuCommand | MenuBranch)[]

export type MenuAnchor = {
  source: HTMLElement
  point?: { x: number; y: number }
}

type Props = {
  label: string
  id?: string
  variant?: 'choice'
  anchor: MenuAnchor
  groups: MenuGroup[]
  layer: HTMLElement
  boundary: HTMLElement
  zIndex: number
  onClose: () => void
  restoreFocus: () => void
}

type MenuLayer = Pick<Props, 'layer' | 'boundary' | 'zIndex'>

function ItemContents({ item }: { item: MenuGroup[number] }) {
  const Icon = item.icon
  return (
    <>
      <Icon className="command-menu-icon" size={16} aria-hidden="true" />
      <span className="command-menu-label">{item.label}</span>
      {item.shortcut && <kbd className="command-menu-shortcut" aria-hidden="true">{item.shortcut}</kbd>}
      {'groups' in item && <ChevronRight className="command-menu-trailing" size={14} aria-hidden="true" />}
      {'checked' in item && <Menu.ItemIndicator className="command-menu-trailing">
        <Check size={14} aria-hidden="true" />
      </Menu.ItemIndicator>}
    </>
  )
}

function itemAttributes(item: MenuItem) {
  return {
    className: 'command-menu-item',
    textValue: item.label,
    disabled: item.disabled,
    'aria-keyshortcuts': item.shortcut?.replace('Ctrl+', 'Control+'),
  }
}

function Submenu({ item, layer, boundary, zIndex }: MenuLayer & { item: MenuBranch }) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLDivElement>(null)
  return (
    <Menu.Sub open={open} onOpenChange={setOpen}>
      <Menu.SubTrigger ref={trigger} {...itemAttributes(item)}>
        <ItemContents item={item} />
      </Menu.SubTrigger>
      <Menu.Portal container={layer}>
        <Menu.SubContent className="command-menu command-menu-submenu" style={{ zIndex }} loop
          sideOffset={2} alignOffset={-5} collisionBoundary={boundary} collisionPadding={6}
          onEscapeKeyDown={event => {
            event.preventDefault()
            setOpen(false)
            trigger.current?.focus({ preventScroll: true })
          }}>
          <MenuGroups groups={item.groups} layer={layer} boundary={boundary} zIndex={zIndex} />
        </Menu.SubContent>
      </Menu.Portal>
    </Menu.Sub>
  )
}

function MenuGroups({ groups, layer, boundary, zIndex, singleChoice }: MenuLayer & { groups: MenuGroup[]; singleChoice?: boolean }) {
  return groups.filter(group => group.length).map((group, index) => (
    <Fragment key={group[0].label}>
      {index > 0 && <Menu.Separator className="command-menu-separator" />}
      <Menu.Group>
        {group.map(item => {
          if ('groups' in item) return (
            <Submenu key={item.label} item={item} layer={layer} boundary={boundary} zIndex={zIndex} />
          )
          if (singleChoice) return (
            <Menu.RadioItem key={item.label} {...itemAttributes(item)} value={item.label} onSelect={item.run}>
              <ItemContents item={item} />
            </Menu.RadioItem>
          )
          if (item.checked !== undefined) return (
            <Menu.CheckboxItem key={item.label} {...itemAttributes(item)} checked={item.checked} onSelect={item.run}>
              <ItemContents item={item} />
            </Menu.CheckboxItem>
          )
          return (
            <Menu.Item key={item.label} {...itemAttributes(item)} data-danger={item.danger || undefined} onSelect={item.run}>
              <ItemContents item={item} />
            </Menu.Item>
          )
        })}
      </Menu.Group>
    </Fragment>
  ))
}

export function CommandMenu({ label, id, variant, anchor, groups, layer, boundary, zIndex, onClose, restoreFocus }: Props) {
  const skipRestore = useRef(false)
  const entered = useRef(false)
  const virtualRef = useMemo(() => ({
    current: {
      getBoundingClientRect: () => anchor.point
        ? new DOMRect(anchor.point.x, anchor.point.y)
        : anchor.source.getBoundingClientRect(),
    },
  }), [anchor])
  const singleChoice = variant === 'choice'
  const checked = singleChoice ? groups.flat().find(item => 'checked' in item && item.checked) : undefined
  const items = <MenuGroups groups={groups} layer={layer} boundary={boundary} zIndex={zIndex} singleChoice={singleChoice} />

  return (
    <Menu.Root open modal={false} onOpenChange={open => { if (!open) onClose() }}>
      <Menu.Anchor virtualRef={virtualRef} />
      <Menu.Portal container={layer}>
        <Menu.Content id={id} aria-label={label} className="command-menu" data-variant={variant} style={{ zIndex }} loop
          align={singleChoice ? 'end' : 'start'} sideOffset={anchor.point ? 2 : 5} collisionBoundary={boundary} collisionPadding={6}
          onEntryFocus={event => {
            if (entered.current) return
            entered.current = true
            const content = event.currentTarget as HTMLElement
            const current = singleChoice ? content.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]:not([data-disabled])') : null
            const first = current ?? content.querySelector<HTMLElement>('[role^="menuitem"]:not([data-disabled])')
            if (first) {
              event.preventDefault()
              first.focus({ preventScroll: true })
            }
          }}
          onInteractOutside={event => {
            if (!anchor.point && event.target instanceof Node && anchor.source.contains(event.target)) {
              event.preventDefault()
              return
            }
            skipRestore.current = true
          }}
          onCloseAutoFocus={event => {
            event.preventDefault()
            if (!skipRestore.current && document.activeElement === document.body) restoreFocus()
          }}
          onKeyDownCapture={event => {
            if (event.key !== 'Tab') return
            // Let native Tab continue in the trigger's document order, outside the portalled menu.
            event.stopPropagation()
            skipRestore.current = true
            restoreFocus()
            onClose()
          }}
          onClick={event => event.stopPropagation()}
          onContextMenu={event => { event.preventDefault(); event.stopPropagation() }}>
          {singleChoice ? <Menu.RadioGroup value={checked?.label}>{items}</Menu.RadioGroup> : items}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  )
}
