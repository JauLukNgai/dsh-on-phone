import { describe, expect, it } from 'vitest'
import {
  ACTIVE_TAB_CLASS_TOKEN,
  STRIP_SCROLLER_SELECTOR,
  STRIP_SELECTOR,
  activeTabIndex,
  installStripSwipe,
  isHorizontalSwipe,
  siblingIndex,
  stripScrollRoom,
  stripSwipeIntent,
  tabElements,
} from '../src/strip-swipe.js'

/** A tab as far as the installer reads it: a class, a click, a scroll. */
function tab(active = false): Element & { clicked: () => number } {
  const state = { clicks: 0 }
  const node = {
    className: `_tab_1s7ij_134${active ? ` ${ACTIVE_TAB_CLASS_TOKEN}_1s7ij_346` : ''}`,
    scrollIntoView: () => undefined,
    click: () => { state.clicks += 1 },
    clicked: () => state.clicks,
  }
  return node as unknown as Element & { clicked: () => number }
}

/** A `_stripTabs` scroll box holding the given tabs. */
function strip(tabs: Element[], geometry: { scrollWidth: number; clientWidth: number; scrollLeft?: number }): Element {
  return {
    className: '_stripTabs_1s7ij_257',
    matches: (selector: string) => selector === STRIP_SCROLLER_SELECTOR,
    querySelector: () => null,
    children: tabs,
    scrollWidth: geometry.scrollWidth,
    clientWidth: geometry.clientWidth,
    scrollLeft: geometry.scrollLeft ?? 0,
  } as unknown as Element
}

/** The element the finger landed on: it only has to know its strip. */
function fingerOn(stripNode: Element): Element {
  return { closest: (selector: string) => (selector === STRIP_SELECTOR ? stripNode : null) } as unknown as Element
}

function touch(type: string, target: Element, x: number, y: number): Event & { prevented: number; stopped: number } {
  const record = {
    prevented: 0,
    stopped: 0,
    type,
    target,
    cancelable: true,
    touches: type === 'touchend' ? [] : [{ clientX: x, clientY: y }],
    changedTouches: [{ clientX: x, clientY: y }],
    preventDefault: () => { record.prevented += 1 },
    stopPropagation: () => { record.stopped += 1 },
  }
  return record as unknown as Event & { prevented: number; stopped: number }
}

/** A document that captures the installer's handlers by event type. */
function documentStub(handlers: Map<string, (event: Event) => void>): Document {
  return {
    addEventListener: (type: string, listener: (event: Event) => void) => { handlers.set(type, listener) },
    removeEventListener: (type: string) => { handlers.delete(type) },
  } as unknown as Document
}

describe('strip swipe helpers', () => {
  it('calls a gesture sideways only when it is wide enough and flat enough', () => {
    expect(isHorizontalSwipe(40, 6)).toBe(true)
    expect(isHorizontalSwipe(8, 0)).toBe(false)
    expect(isHorizontalSwipe(40, 60)).toBe(false)
    expect(isHorizontalSwipe(-40, -6)).toBe(true)
  })

  it('measures the strip room left to scroll', () => {
    expect(stripScrollRoom({ scrollWidth: 600, clientWidth: 215, scrollLeft: 0 })).toBe(385)
    expect(stripScrollRoom({ scrollWidth: 215, clientWidth: 215, scrollLeft: 0 })).toBe(0)
    expect(stripScrollRoom({ scrollWidth: 100, clientWidth: 215, scrollLeft: 0 })).toBe(0)
  })

  it('leaves a scrollable strip to the browser and selects when it cannot scroll', () => {
    const room = { scrollWidth: 600, clientWidth: 215, scrollLeft: 100 }
    expect(stripSwipeIntent(room, -60, 4)).toBe('pan')
    expect(stripSwipeIntent(room, 60, 4)).toBe('pan')
    // Vertical drags stay with the pane body however wide the strip is.
    expect(stripSwipeIntent(room, -60, 90)).toBe('ignore')
    expect(stripSwipeIntent(room, -6, 0)).toBe('ignore')
    // The open files fit: a sideways swipe selects instead.
    expect(stripSwipeIntent({ scrollWidth: 215, clientWidth: 215, scrollLeft: 0 }, -60, 4)).toBe('switch')
    // Or the strip has already reached the edge the swipe points at.
    expect(stripSwipeIntent({ scrollWidth: 600, clientWidth: 215, scrollLeft: 385 }, -60, 4)).toBe('switch')
    expect(stripSwipeIntent({ scrollWidth: 600, clientWidth: 215, scrollLeft: 0 }, 60, 4)).toBe('switch')
  })

  it('steps towards the swipe and stops at the ends', () => {
    expect(siblingIndex(0, 3, -30)).toBe(1)
    expect(siblingIndex(2, 3, -30)).toBe(-1)
    expect(siblingIndex(1, 3, 30)).toBe(0)
    expect(siblingIndex(0, 3, 30)).toBe(-1)
    expect(siblingIndex(-1, 3, 30)).toBe(-1)
  })

  it('reads the tabs and the active one, skipping the strip furniture', () => {
    const first = tab()
    const second = tab(true)
    const add = { className: '_addTab_1s7ij_399' } as unknown as Element
    const tabs = tabElements({ children: [first, second, add] })
    expect(tabs).toHaveLength(2)
    expect(activeTabIndex(tabs)).toBe(1)
  })
})

describe('installStripSwipe', () => {
  it('selects the next open file when a sideways swipe cannot scroll', () => {
    const tabs = [tab(), tab(true), tab()]
    const stripNode = strip(tabs, { scrollWidth: 215, clientWidth: 215 })
    const handlers = new Map<string, (event: Event) => void>()
    const remove = installStripSwipe(documentStub(handlers))

    const start = touch('touchstart', fingerOn(stripNode), 260, 24)
    handlers.get('touchstart')?.(start)
    const move = touch('touchmove', fingerOn(stripNode), 200, 26)
    handlers.get('touchmove')?.(move)
    expect(move.prevented).toBe(1)
    expect(move.stopped).toBe(1)

    handlers.get('touchend')?.(touch('touchend', fingerOn(stripNode), 200, 26))
    // Swiping left moves the selection to the file on the right.
    expect((tabs[2] as unknown as { clicked: () => number }).clicked()).toBe(1)
    expect((tabs[0] as unknown as { clicked: () => number }).clicked()).toBe(0)
    remove()
    expect(handlers.size).toBe(0)
  })

  it('never takes over a swipe the strip can still scroll, and ignores taps', () => {
    const tabs = [tab(), tab(true), tab()]
    const stripNode = strip(tabs, { scrollWidth: 600, clientWidth: 215 })
    const handlers = new Map<string, (event: Event) => void>()
    installStripSwipe(documentStub(handlers))

    handlers.get('touchstart')?.(touch('touchstart', fingerOn(stripNode), 260, 24))
    const move = touch('touchmove', fingerOn(stripNode), 200, 26)
    handlers.get('touchmove')?.(move)
    expect(move.prevented).toBe(0)
    handlers.get('touchend')?.(touch('touchend', fingerOn(stripNode), 200, 26))

    // A tap: sideways movement far below the threshold, then a release.
    handlers.get('touchstart')?.(touch('touchstart', fingerOn(stripNode), 260, 24))
    handlers.get('touchmove')?.(touch('touchmove', fingerOn(stripNode), 256, 26))
    handlers.get('touchend')?.(touch('touchend', fingerOn(stripNode), 256, 26))
    for (const node of tabs) expect((node as unknown as { clicked: () => number }).clicked()).toBe(0)
  })
})
