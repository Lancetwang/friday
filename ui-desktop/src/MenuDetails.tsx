import { useEffect, useRef, type ReactNode } from 'react'

// macOS buttons do not take focus on click, so a blur-based dismiss closes the
// menu before the click lands. Dismiss on outside pointerdown instead.
export function MenuDetails({ children, className }: { children: ReactNode; className: string }) {
  const ref = useRef<HTMLDetailsElement>(null)

  useEffect(() => {
    const element = ref.current
    if (!element) return
    const onPointerDown = (event: PointerEvent) => {
      if (element.open && !element.contains(event.target as Node)) element.removeAttribute('open')
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && element.open) element.removeAttribute('open')
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  return (
    <details className={className} ref={ref}>
      {children}
    </details>
  )
}
