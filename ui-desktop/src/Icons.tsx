/** Small interface icons, drawn rather than typed.
 *
 * These were Unicode glyphs until a pencil and a multiplication sign sat next to
 * each other in the sidebar and refused to line up: `✎` is a dingbat most system
 * fonts do not carry, so Windows served it from an emoji face whose baseline and
 * weight have nothing to do with the text font next to it. Centring cannot fix
 * that, because a glyph is centred by its line box while the eye reads its ink.
 *
 * A path in a square viewBox has the same geometry on every machine, so an icon
 * button is centred once here and stays centred everywhere.
 */

import type { ReactNode } from 'react'

const BOX = '0 0 24 24'

type IconProps = { className?: string }

function Glyph({ children, className = '' }: IconProps & { children: ReactNode }) {
  return (
    <svg aria-hidden="true" className={`glyph-icon ${className}`.trim()} fill="none" viewBox={BOX}>
      {children}
    </svg>
  )
}

export function CloseIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
    </Glyph>
  )
}

export function PencilIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M4 20l.9-3.7L15.6 5.6a2 2 0 0 1 2.8 2.8L7.7 19.1 4 20Z" />
      <path d="M14.2 7l2.8 2.8" />
    </Glyph>
  )
}

export function CheckIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </Glyph>
  )
}

export function DiamondIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M12 3.2l8.8 8.8-8.8 8.8L3.2 12Z" />
    </Glyph>
  )
}

export function SearchIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <circle cx="10.5" cy="10.5" r="6.3" />
      <path d="M15.2 15.2L20 20" />
    </Glyph>
  )
}

export function EyeIcon({ className = '', open = true }: IconProps & { open?: boolean }) {
  return (
    <Glyph className={className}>
      <path d="M3.2 12s3.2-5.2 8.8-5.2 8.8 5.2 8.8 5.2-3.2 5.2-8.8 5.2S3.2 12 3.2 12Z" />
      <circle cx="12" cy="12" r="2.4" />
      {!open && <path d="M4.5 4.5l15 15" />}
    </Glyph>
  )
}

export function RefreshIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M19 8.2A7.5 7.5 0 1 0 19.2 15" />
      <path d="M19 3.8v4.6h-4.6" />
    </Glyph>
  )
}

export function TrashIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M5.5 7.5h13M9 4.5h6M7.5 7.5l.7 12h7.6l.7-12M10 10.5v5.8M14 10.5v5.8" />
    </Glyph>
  )
}

export function UndoIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M4.2 9h9.3a5.2 5.2 0 0 1 0 10.4H8" />
      <path d="M7.8 5.4 4.2 9l3.6 3.6" />
    </Glyph>
  )
}

export function MinusIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M6 12h12" />
    </Glyph>
  )
}

export function PlusIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M12 6v12M6 12h12" />
    </Glyph>
  )
}

export function FileIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M6.5 3.5h7l4 4v13h-11Z" />
      <path d="M13.5 3.5v4h4" />
    </Glyph>
  )
}

export function FolderIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M3.5 6.5h6l2 2h9v10.5a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19Z" />
      <path d="M3.5 9h17" />
    </Glyph>
  )
}

export function TargetIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4.5" />
      <circle cx="12" cy="12" r="1" />
    </Glyph>
  )
}

export function InfoIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v4.5" />
      <path d="M12 8v.1" />
    </Glyph>
  )
}

export function ArrowUpIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M12 19.5V5M5.5 11.5 12 5l6.5 6.5" />
    </Glyph>
  )
}

/** A chevron, pointed by CSS rotation so one path serves every direction. */
export function ChevronIcon({ className = '' }: IconProps) {
  return (
    <Glyph className={`chevron ${className}`.trim()}>
      <path d="M9.5 5.5l6.5 6.5-6.5 6.5" />
    </Glyph>
  )
}
