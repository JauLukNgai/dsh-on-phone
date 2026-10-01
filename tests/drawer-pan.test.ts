import { describe, expect, it } from 'vitest'
import { browserMovedScrolled, canScrollBy, DRAWER_PAN_AXIS_RATIO, DRAWER_PAN_MIN_DELTA, drawerPanDecision, horizontallyScrollableAncestor, isVerticalGesture, panDelta, scrollableAncestor } from '../src/drawer-pan.js'

/** A stand-in node: the helper only ever reads these four properties. */
const node = (overflowY: string, scrollHeight: number, clientHeight: number, parentElement: Element | null = null): Element =>
  ({ overflowY, scrollHeight, clientHeight, parentElement } as unknown as Element)

const readAs = (styles: ReadonlyMap<Element, string>) => (element: Element): CSSStyleDeclaration =>
  ({ overflowY: styles.get(element) ?? 'visible' } as CSSStyleDeclaration)

/** The horizontal twin of the stub above. */
const box = (overflowX: string, scrollWidth: number, clientWidth: number, parentElement: Element | null = null): Element =>
  ({ overflowX, scrollWidth, clientWidth, parentElement } as unknown as Element)

const readX = (styles: ReadonlyMap<Element, string>) => (element: Element): CSSStyleDeclaration =>
  ({ overflowX: styles.get(element) ?? 'visible' } as CSSStyleDeclaration)

describe('mobile drawer pan fallback', () => {
  it('measures a drag the way a scroll delta is applied', () => {
    // Dragging a finger up has to move the content up.
    expect(panDelta(400, 300)).toBe(100)
    expect(panDelta(300, 400)).toBe(-100)
    expect(panDelta(300, 300)).toBe(0)
    expect(DRAWER_PAN_MIN_DELTA).toBeGreaterThan(0)
  })

  it('tells a browser-driven scroll apart from an untouched one', () => {
    // This is the hand-off test: only a scroller the browser left alone may be
    // moved by hand, which is what stops the fallback from scrolling twice.
    expect(browserMovedScrolled(0, 120)).toBe(true)
    expect(browserMovedScrolled(120, 60)).toBe(true)
    expect(browserMovedScrolled(120, 120)).toBe(false)
    expect(browserMovedScrolled(120, 120.4)).toBe(false)
  })

  it('stops at both ends so the page behind can take over', () => {
    // 1000 tall content in a 300 viewport: room below until 700.
    expect(canScrollBy(0, 1000, 300, 40)).toBe(true)
    expect(canScrollBy(699, 1000, 300, 40)).toBe(false)
    expect(canScrollBy(40, 1000, 300, -40)).toBe(true)
    expect(canScrollBy(0, 1000, 300, -40)).toBe(false)
    expect(canScrollBy(40, 1000, 300, 0)).toBe(false)
  })

  it('gives the browser the first move, then takes over only if it did nothing', () => {
    // A browser-scrolled move is never touched, whoever had the last word.
    expect(drawerPanDecision(false, true, true)).toBe('native')
    expect(drawerPanDecision(true, true, false)).toBe('native')
    // The first move can never observe a native scroll (the default action runs
    // after the handler), so it must be left alone rather than cancelled.
    expect(drawerPanDecision(false, false, true)).toBe('wait')
    // From the second move on, an untouched scroller is scrolled by hand.
    expect(drawerPanDecision(true, false, true)).toBe('manual')
    // At either end the gesture is left for whatever is behind the drawer.
    expect(drawerPanDecision(true, false, false)).toBe('idle')
  })

  it('finds the nearest box that can actually scroll', () => {
    const outer = node('auto', 4000, 800)
    const middle = node('auto', 1757, 768, outer)
    const inner = node('visible', 900, 300, middle)
    // The touched node itself scrolls: nothing above it matters.
    expect(scrollableAncestor(middle, readAs(new Map([[middle, 'auto']])))).toBe(middle)
    // A visible-overflow ancestor is skipped even when its content overflows.
    expect(scrollableAncestor(inner, readAs(new Map([[inner, 'visible'], [middle, 'auto']])))).toBe(middle)
    // An auto box with nothing to scroll is skipped too: it cannot take a delta.
    const flat = node('auto', 300, 300, middle)
    expect(scrollableAncestor(flat, readAs(new Map([[flat, 'auto'], [middle, 'auto']])))).toBe(middle)
    // Nothing can scroll: the caller falls back to the drawer root itself.
    expect(scrollableAncestor(node('hidden', 900, 300), readAs(new Map()))).toBeUndefined()
    expect(scrollableAncestor(null, readAs(new Map()))).toBeUndefined()
  })

  it('tells a sideways swipe apart from a downward drag', () => {
    // The fallback cancels the move it takes over, so claiming a sideways swipe
    // would cancel the strip's own horizontal scroll with it.
    expect(isVerticalGesture(0, 20)).toBe(true)
    expect(isVerticalGesture(2, 20)).toBe(true)
    expect(isVerticalGesture(-4, -40)).toBe(true)
    // A diagonal drift down the tab strip stays with the browser.
    expect(isVerticalGesture(20, 2)).toBe(false)
    expect(isVerticalGesture(20, 20)).toBe(false)
    expect(isVerticalGesture(0, 0)).toBe(false)
    expect(DRAWER_PAN_AXIS_RATIO).toBeGreaterThan(1)
  })

  it('leaves a gesture that starts in a sideways scroller to that scroller', () => {
    // The open-files strip measured 600px of tabs in a 215px bar.
    const strip = box('auto', 600, 215)
    const tab = box('visible', 40, 40, strip)
    expect(horizontallyScrollableAncestor(tab, readX(new Map([[strip, 'auto']])))).toBe(strip)
    // A box with no room to move cannot take the swipe.
    expect(horizontallyScrollableAncestor(box('auto', 215, 215), readX(new Map()))).toBeUndefined()
    // Only a real overflow box counts, not a hidden or visible one.
    expect(horizontallyScrollableAncestor(box('hidden', 600, 215), readX(new Map()))).toBeUndefined()
    expect(horizontallyScrollableAncestor(null, readX(new Map()))).toBeUndefined()
  })
})
