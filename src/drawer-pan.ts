/**
 * Vertical panning inside the phone's right drawer.
 *
 * The drawer is a fixed panel whose inner app pane keeps its own scroller, and
 * the drag has to cross three claims on the gesture: the app's own rows (which
 * grab the pointer for dragging), the drawer root (which the plugin turns into a
 * scrolling box as a fallback) and the pane's scroller. Re-granting
 * `touch-action: pan-y` to everything is enough for Chrome, but a device that
 * still swallows the move leaves the pane nailed in place, and none of that can
 * be inspected from here.
 *
 * So instead of betting on one more CSS combination, this module watches the
 * gesture and only steps in when the browser did *not* move the scroller by
 * itself. That hand-off test is what keeps it from ever double-scrolling: each
 * move compares the position against the position the gesture last knew about.
 * A browser that moved it is already doing the job and this module does nothing;
 * a browser that left it untouched gets the delta applied by hand, with the move
 * cancelled so the page behind the drawer stays put.
 *
 * Two things stay out of its way on purpose. A gesture that starts inside a box
 * that scrolls sideways (the dockkit tab strip of open files) belongs to that
 * box, and a gesture whose own axis is sideways belongs to the browser: the
 * fallback cancels the touch to apply its delta by hand, which would also kill
 * the strip's horizontal scroll, so it must never claim either of them.
 */

/** A drag shorter than this is a tap, not a pan. */
export const DRAWER_PAN_MIN_DELTA = 3

/**
 * How much more vertical than horizontal a drag has to be before the fallback
 * may take it over.
 */
export const DRAWER_PAN_AXIS_RATIO = 1.2

/** Slack for comparing scroll positions across frames. */
const SCROLL_EPSILON = 1

/** How many recent pans are kept for on-device diagnosis. */
const DRAWER_PAN_LOG_LIMIT = 12

/**
 * How far a finger has travelled, measured the way a scroll delta is applied:
 * dragging up (a smaller clientY) moves the content up.
 * @param baseY - The clientY the gesture was last measured from.
 * @param currentY - The current `touch.clientY`.
 * @returns The scroll delta in pixels.
 */
export function panDelta(baseY: number, currentY: number): number {
  return baseY - currentY
}

/**
 * Whether the browser moved a scroller on its own between two samples.
 * @param from - The scroll position the gesture last knew about.
 * @param to - The scroll position now.
 * @returns Whether the change came from the browser rather than this module.
 */
export function browserMovedScrolled(from: number, to: number): boolean {
  return Math.abs(to - from) > SCROLL_EPSILON
}

/**
 * Whether a scroller can still take more of a delta in the drag's direction.
 *
 * Both ends matter: at the boundary the gesture has to be left alone so the page
 * behind the drawer (or the drawer's own overscroll) can move instead.
 * @param scrollTop - The scroller's current position.
 * @param scrollHeight - The scroller's content height.
 * @param clientHeight - The scroller's viewport height.
 * @param delta - The scroll delta being applied.
 * @returns Whether the delta has anywhere to go.
 */
export function canScrollBy(scrollTop: number, scrollHeight: number, clientHeight: number, delta: number): boolean {
  if (delta > 0) return scrollTop + clientHeight < scrollHeight - SCROLL_EPSILON
  if (delta < 0) return scrollTop > SCROLL_EPSILON
  return false
}

/**
 * Whether a drag is vertical enough for the fallback to own it.
 *
 * A sideways swipe (the tab strip, a wide table) has to be left to the browser
 * even when the finger drifts a few pixels down: `preventDefault()` on the move
 * would take the horizontal scroll away with it.
 * @param dx - Horizontal travel since the gesture started.
 * @param dy - Vertical travel since the gesture started.
 * @param ratio - How dominant the vertical axis must be.
 * @returns Whether the fallback may treat this as a vertical pan.
 */
export function isVerticalGesture(dx: number, dy: number, ratio = DRAWER_PAN_AXIS_RATIO): boolean {
  const across = Math.abs(dx)
  const along = Math.abs(dy)
  if (across === 0 && along === 0) return false
  return along >= across * ratio
}

/**
 * The nearest box that can scroll sideways right now.
 *
 * The dockkit tab strip is one (measured: 600px of tabs in a 215px bar), and a
 * gesture that starts inside it belongs to it.
 * @param start - The node the finger landed on.
 * @param read - Computed-style reader, injectable for tests.
 * @returns The sideways scroller, or `undefined` when there is none.
 */
export function horizontallyScrollableAncestor(start: Element | null, read: (element: Element) => CSSStyleDeclaration = (element) => getComputedStyle(element)): Element | undefined {
  for (let node: Element | null = start; node !== null; node = node.parentElement) {
    const overflowX = read(node).overflowX
    if (overflowX !== 'auto' && overflowX !== 'scroll') continue
    if (node.scrollWidth - node.clientWidth > SCROLL_EPSILON) return node
  }
  return undefined
}

/**
 * The nearest box that can scroll vertically right now.
 *
 * Walking up from the touched node is what makes the fallback work on either
 * layout: the app's own pane body when it is a real scroller, or the drawer root
 * when the pane collapsed and the root became the only one.
 * @param start - The node the finger landed on.
 * @param read - Computed-style reader, injectable for tests.
 * @returns The scroller, or `undefined` when nothing can scroll.
 */
export function scrollableAncestor(start: Element | null, read: (element: Element) => CSSStyleDeclaration = (element) => getComputedStyle(element)): Element | undefined {
  for (let node: Element | null = start; node !== null; node = node.parentElement) {
    const overflowY = read(node).overflowY
    if (overflowY !== 'auto' && overflowY !== 'scroll') continue
    if (node.scrollHeight - node.clientHeight > SCROLL_EPSILON) return node
  }
  return undefined
}

/**
 * What the fallback should do with one move of a drag.
 *
 * `wait` exists because the browser applies its default action *after* the move
 * handler has run: a native scroll can only be observed on the following move,
 * so the first decisive move has to be left alone. From then on this module
 * either keeps rebasing (the browser is panning) or takes the delta itself.
 */
export type DrawerPanDecision = 'native' | 'wait' | 'manual' | 'idle'

/**
 * Decide what to do with one move of a drag.
 * @param gaveBrowserChance - Whether a previous move was already left to the browser.
 * @param browserMoved - Whether the scroller moved on its own since the last sample.
 * @param canScroll - Whether the scroller still has room in the drag's direction.
 * @returns The decision for this move.
 */
export function drawerPanDecision(gaveBrowserChance: boolean, browserMoved: boolean, canScroll: boolean): DrawerPanDecision {
  if (browserMoved) return 'native'
  if (!gaveBrowserChance) return 'wait'
  return canScroll ? 'manual' : 'idle'
}

/** One pan the fallback had to apply by hand, kept for on-device diagnosis. */
export interface DrawerPanNote {
  readonly at: number
  readonly delta: number
  readonly mode: 'native' | 'manual'
}

type PanLogHost = { __DSH_ON_PHONE_DRAWER_PAN__?: DrawerPanNote[] }

/** Drag bookkeeping for the gesture the module is following. */
interface DrawerDrag {
  readonly scroller: Element
  baseX: number
  baseY: number
  baseScrollTop: number
  gaveBrowserChance: boolean
}

/**
 * Install the drawer pan fallback.
 * @param selector - The open-drawer selector; the fallback only listens inside it.
 * @returns Uninstaller that removes every listener.
 */
export function installDrawerPan(selector = '[data-dsh-on-phone-workbench][data-dsh-on-phone-workbench-open="true"]'): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return () => {}
  const log = (note: DrawerPanNote): void => {
    try {
      const host = window as unknown as PanLogHost
      const entries = host.__DSH_ON_PHONE_DRAWER_PAN__ ?? []
      entries.push(note)
      if (entries.length > DRAWER_PAN_LOG_LIMIT) entries.shift()
      host.__DSH_ON_PHONE_DRAWER_PAN__ = entries
    } catch {
      // A read-only host object must never break scrolling.
    }
  }
  let drag: DrawerDrag | null = null
  let drawer: HTMLElement | null = null
  const stop = (): void => {
    // The move listener is attached per gesture so that the rest of the app
    // keeps the browser's passive fast path for its own scrolling.
    if (drawer !== null) drawer.removeEventListener('touchmove', onTouchMove, true)
    document.removeEventListener('touchend', stop, true)
    document.removeEventListener('touchcancel', stop, true)
    drag = null
    drawer = null
  }
  const onTouchMove = (event: TouchEvent): void => {
    const state = drag
    if (state === null) return
    const touch = event.touches[0]
    if (touch === undefined) return
    const delta = panDelta(state.baseY, touch.clientY)
    const across = touch.clientX - state.baseX
    if (Math.abs(across) >= DRAWER_PAN_MIN_DELTA && !isVerticalGesture(across, delta)) {
      // A sideways swipe belongs to the browser (the open-files strip, a wide
      // table). Taking it over would cancel that scroll, so let go for good.
      stop()
      return
    }
    if (Math.abs(delta) < DRAWER_PAN_MIN_DELTA) return
    const decision = drawerPanDecision(
      state.gaveBrowserChance,
      browserMovedScrolled(state.baseScrollTop, state.scroller.scrollTop),
      canScrollBy(state.baseScrollTop, state.scroller.scrollHeight, state.scroller.clientHeight, delta),
    )
    if (decision === 'native') {
      // The browser is panning this scroller by itself: stay out of the way and
      // re-base so a later manual move starts from where the browser left it.
      state.baseY = touch.clientY
      state.baseScrollTop = state.scroller.scrollTop
      log({ at: Date.now(), delta, mode: 'native' })
      return
    }
    if (decision === 'wait') {
      state.gaveBrowserChance = true
      return
    }
    if (decision === 'idle') return
    event.preventDefault()
    state.scroller.scrollTop = state.baseScrollTop + delta
    state.baseY = touch.clientY
    state.baseScrollTop = state.scroller.scrollTop
    log({ at: Date.now(), delta, mode: 'manual' })
  }
  const onTouchStart = (event: TouchEvent): void => {
    stop()
    const target = event.target
    if (!(target instanceof Element)) return
    const scope = target.closest(selector)
    if (!(scope instanceof HTMLElement)) return
    const touch = event.touches[0]
    if (touch === undefined) return
    // A finger that lands in a sideways scroller (the strip of open files) is
    // swiping that scroller: the fallback must not claim its moves.
    if (horizontallyScrollableAncestor(target) !== undefined) return
    const scroller = scrollableAncestor(target) ?? scope
    drag = { scroller, baseX: touch.clientX, baseY: touch.clientY, baseScrollTop: scroller.scrollTop, gaveBrowserChance: false }
    drawer = scope
    scope.addEventListener('touchmove', onTouchMove, { passive: false, capture: true })
    document.addEventListener('touchend', stop, true)
    document.addEventListener('touchcancel', stop, true)
  }
  document.addEventListener('touchstart', onTouchStart, { passive: true, capture: true })
  return () => {
    stop()
    document.removeEventListener('touchstart', onTouchStart, true)
  }
}
