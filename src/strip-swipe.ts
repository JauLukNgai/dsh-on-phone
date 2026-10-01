/**
 * Selecting among the drawer's open files by swiping is the one phone gesture
 * the remote surface never had. The strip the user swipes is the host's pane
 * header, and the host keeps that header for itself: `_tabStrip` and the
 * `_stripTabs` scroller both declare `touch-action:none`, because a drag there
 * reorders, docks or floats the whole pane. On a phone the drag has nowhere to
 * go, so a sideways swipe over the strip either does nothing useful or yanks the
 * pane out of the drawer.
 *
 * The honest target is the scroller under the strip (`_stripTabs`,
 * `overflow-x:auto`). When the open files overflow it, the browser's own pan
 * scrolls it - the phone stylesheet grants `pan-x` on that chain - and this
 * module stays out of the way. When they fit, which is the common case and the
 * only one any trace from the phone showed (`scrollWidth === clientWidth` for
 * every recorded gesture), there is nothing to pan, so a sideways swipe is read
 * as "move the selection one tab over" and a click is dispatched on that
 * sibling tab.
 *
 * Measured in a headless Chrome with six cloned tabs: a touch drag panned the
 * strip 152px, while a *mouse* drag (which can never trigger a native pan) left
 * `scrollLeft` at 0 and never created a drag or a float host - so the host has
 * no hand-rolled drag-scroll the browser could be duplicating, and a strip that
 * does not overflow has nothing to pan. That is the case this module covers.
 */

/** The strip row and its scroller, matched by their stable class prefixes. */
export const STRIP_SELECTOR = ':is([class*="_tabStrip"],[class*="_stripTabs"],[class*="_detailTabs"])'

/** The scrolling box inside the strip; the tabs are its element children. */
export const STRIP_SCROLLER_SELECTOR = '[class*="_stripTabs"]'

/** The token the host puts on the tab the user is looking at. */
export const ACTIVE_TAB_CLASS_TOKEN = '_tabActive'

/** Tokens that are strip furniture rather than open files. */
const NON_TAB_CLASS_TOKENS = ['_addTab', '_stripFill', '_stripChrome'] as const

/** A sideways swipe has to travel this far before it counts as one. */
export const STRIP_SWIPE_MIN_DELTA = 12

/** A swipe shorter than this never changes the selection. */
export const STRIP_SWITCH_MIN_DELTA = 24

/** A swipe this much wider than it is tall is sideways; see `drawer-pan.ts`. */
export const STRIP_SWIPE_AXIS_RATIO = 1.2

const SCROLL_EPSILON = 1

/** How long a dispatched selection keeps the browser's own click suppressed. */
const SWALLOW_CLICK_MS = 500

export interface StripGeometry {
  readonly scrollWidth: number
  readonly clientWidth: number
  readonly scrollLeft: number
}

/** What a sideways swipe over the strip should do. */
export type StripSwipeIntent = 'ignore' | 'pan' | 'switch'

/** How much of the strip is still hidden to the right of the viewport. */
export function stripScrollRoom(geometry: StripGeometry): number {
  return Math.max(0, geometry.scrollWidth - geometry.clientWidth)
}

/** True when the gesture is clearly sideways rather than a downward drag. */
export function isHorizontalSwipe(
  dx: number,
  dy: number,
  minDelta: number = STRIP_SWIPE_MIN_DELTA,
  ratio: number = STRIP_SWIPE_AXIS_RATIO,
): boolean {
  const across = Math.abs(dx)
  return across >= minDelta && across >= Math.abs(dy) * ratio
}

/**
 * Decide who owns a gesture over the strip: nobody (not sideways yet), the
 * browser's native pan (the strip still has somewhere to go in that direction)
 * or this module (the strip is already at the edge, or never scrolled at all).
 */
export function stripSwipeIntent(
  geometry: StripGeometry,
  dx: number,
  dy: number,
  minDelta: number = STRIP_SWIPE_MIN_DELTA,
): StripSwipeIntent {
  if (!isHorizontalSwipe(dx, dy, minDelta)) return 'ignore'
  const room = stripScrollRoom(geometry)
  if (room <= SCROLL_EPSILON) return 'switch'
  // A swipe to the left browses the files to the right, and vice versa.
  const forward = dx < 0
  const atEdge = forward
    ? geometry.scrollLeft >= room - SCROLL_EPSILON
    : geometry.scrollLeft <= SCROLL_EPSILON
  return atEdge ? 'switch' : 'pan'
}

/** The tab the swipe selects: `index` one step towards the swipe, or -1. */
export function siblingIndex(index: number, count: number, dx: number): number {
  if (index < 0 || count <= 0) return -1
  const next = index + (dx < 0 ? 1 : -1)
  return next < 0 || next >= count ? -1 : next
}

/** The strip's element children that are open files rather than furniture. */
export function tabElements(container: { readonly children: ArrayLike<unknown> }): unknown[] {
  const tabs: unknown[] = []
  for (let i = 0; i < container.children.length; i += 1) {
    const child = container.children[i]
    const className = (child as { className?: unknown } | null | undefined)?.className
    if (typeof className !== 'string') continue
    if (NON_TAB_CLASS_TOKENS.some((token) => className.includes(token))) continue
    tabs.push(child)
  }
  return tabs
}

/** Index of the tab the host marked active, or -1 when it cannot be told. */
export function activeTabIndex(tabs: readonly unknown[]): number {
  return tabs.findIndex((tab) => {
    const className = (tab as { className?: unknown } | null | undefined)?.className
    return typeof className === 'string' && className.includes(ACTIVE_TAB_CLASS_TOKEN)
  })
}

/**
 * Turn a sideways swipe over the drawer's tab strip into "select the next or
 * previous open file" whenever the strip has nothing left to scroll. A swipe
 * that the browser can still pan is left alone, so the module never competes
 * with a real scroll or with momentum.
 */
export function installStripSwipe(doc: Document | undefined = typeof document === 'undefined' ? undefined : document): () => void {
  if (doc === undefined) return () => undefined

  interface Swipe {
    readonly scroller: Element
    readonly x0: number
    readonly y0: number
    decided: boolean
  }

  let swipe: Swipe | undefined
  let swallowClicksUntil = 0

  const asElement = (value: unknown): Element | undefined =>
    typeof (value as { closest?: unknown } | null | undefined)?.closest === 'function' ? (value as Element) : undefined
  const number = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  const pointOf = (event: Event): { x: number; y: number } | undefined => {
    const touches = (event as TouchEvent).touches
    const changed = (event as TouchEvent).changedTouches
    const touch = touches !== undefined && touches.length > 0 ? touches[0] : changed !== undefined && changed.length > 0 ? changed[0] : undefined
    return touch === undefined ? undefined : { x: number(touch.clientX), y: number(touch.clientY) }
  }
  const geometryOf = (scroller: Element): StripGeometry => ({
    scrollWidth: number((scroller as HTMLElement).scrollWidth),
    clientWidth: number((scroller as HTMLElement).clientWidth),
    scrollLeft: number((scroller as HTMLElement).scrollLeft),
  })

  const onTouchStart = (event: Event): void => {
    const target = asElement(event.target)
    const point = pointOf(event)
    if (target === undefined || point === undefined) return
    const strip = target.closest(STRIP_SELECTOR)
    if (strip === null) return
    const scroller = strip.matches(STRIP_SCROLLER_SELECTOR) ? strip : strip.querySelector(STRIP_SCROLLER_SELECTOR)
    swipe = { scroller: scroller ?? strip, x0: point.x, y0: point.y, decided: false }
  }
  const onTouchMove = (event: Event): void => {
    const active = swipe
    const point = pointOf(event)
    if (active === undefined || active.decided || point === undefined) return
    const intent = stripSwipeIntent(geometryOf(active.scroller), point.x - active.x0, point.y - active.y0)
    if (intent === 'ignore') return
    active.decided = true
    // A strip that can still scroll that way belongs to the browser.
    if (intent === 'pan') { swipe = undefined; return }
    if (event.cancelable) event.preventDefault()
    event.stopPropagation()
  }
  const onTouchEnd = (event: Event): void => {
    const active = swipe
    swipe = undefined
    if (active === undefined || !active.decided) return
    const point = pointOf(event)
    const dx = point === undefined ? 0 : point.x - active.x0
    if (Math.abs(dx) < STRIP_SWITCH_MIN_DELTA) return
    const tabs = tabElements(active.scroller)
    const next = siblingIndex(activeTabIndex(tabs), tabs.length, dx)
    const tab = tabs[next] as HTMLElement | undefined
    if (tab === undefined || typeof tab.click !== 'function') return
    try { tab.click() } catch { return }
    // The browser may still deliver its own click for the finger-down target;
    // eat that one so the swipe does not immediately undo the selection.
    swallowClicksUntil = Date.now() + SWALLOW_CLICK_MS
    const intoView = tab.scrollIntoView
    if (typeof intoView === 'function') {
      try { intoView.call(tab, { block: 'nearest', inline: 'nearest' }) } catch { /* optional */ }
    }
  }
  const onTouchCancel = (): void => { swipe = undefined }
  const onClick = (event: Event): void => {
    if (Date.now() > swallowClicksUntil) return
    swallowClicksUntil = 0
    event.preventDefault()
    event.stopPropagation()
  }

  doc.addEventListener('touchstart', onTouchStart, { capture: true, passive: true })
  doc.addEventListener('touchmove', onTouchMove, { capture: true, passive: false })
  doc.addEventListener('touchend', onTouchEnd, { capture: true, passive: true })
  doc.addEventListener('touchcancel', onTouchCancel, { capture: true, passive: true })
  doc.addEventListener('click', onClick, true)
  return () => {
    doc.removeEventListener('touchstart', onTouchStart, true)
    doc.removeEventListener('touchmove', onTouchMove, true)
    doc.removeEventListener('touchend', onTouchEnd, true)
    doc.removeEventListener('touchcancel', onTouchCancel, true)
    doc.removeEventListener('click', onClick, true)
  }
}
