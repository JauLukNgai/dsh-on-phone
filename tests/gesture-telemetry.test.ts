import { describe, expect, it, vi } from 'vitest'
import {
  elementFacts,
  gestureChain,
  installGestureTelemetry,
  overlaySuspects,
  shortClass,
  shouldReportGesture,
  shouldReportCancelled,
  stripSnapshot,
} from '../src/gesture-telemetry.js'

/** A computed style as far as the recorder reads it. */
function style(overrides: Partial<CSSStyleDeclaration> = {}): CSSStyleDeclaration {
  return {
    position: 'static',
    zIndex: 'auto',
    opacity: '1',
    backgroundColor: 'rgba(0, 0, 0, 0)',
    userSelect: 'auto',
    touchAction: 'auto',
    overflowX: 'visible',
    overflowY: 'visible',
    ...overrides,
  } as unknown as CSSStyleDeclaration
}

/** A stand-in element: geometry, scroll state, and the ancestor chain. */
function element(options: {
  className?: string
  tagName?: string
  parentElement?: Element | null
  matchesStop?: boolean
  width?: number
  height?: number
  scrollWidth?: number
  clientWidth?: number
  scrollLeft?: number
  tabs?: number
  closestDrawer?: boolean
} = {}): Element {
  const node = {
    className: options.className ?? '',
    tagName: options.tagName ?? 'DIV',
    parentElement: options.parentElement ?? null,
    scrollWidth: options.scrollWidth ?? 0,
    scrollHeight: 0,
    clientWidth: options.clientWidth ?? 0,
    clientHeight: 0,
    getBoundingClientRect: () => ({ width: options.width ?? 0, height: options.height ?? 0 }),
    matches: (selector: string) => (options.matchesStop ?? false) && selector === '[data-dsh-on-phone-workbench]',
    closest: () => (options.closestDrawer === true ? {} : null),
    querySelectorAll: () => new Array(options.tabs ?? 0).fill(null),
    scrollLeft: options.scrollLeft ?? 0,
  }
  return node as unknown as Element
}

const readOf = (styles: (node: Element) => CSSStyleDeclaration) => styles

describe('gesture telemetry helpers', () => {
  it('names classes it can read and truncates the hashed ones', () => {
    expect(shortClass(undefined)).toBe('')
    expect(shortClass({ baseVal: '_svg_1s7ij_2' })).toBe('_svg_1s7ij_2')
    expect(shortClass('abcdef', 3)).toBe('abc')
  })

  it('reports a real drag and ignores a tap', () => {
    expect(shouldReportGesture(180, 140, 6)).toBe(true)
    expect(shouldReportGesture(180, 3, 2)).toBe(false)
    expect(shouldReportGesture(60, 140, 0)).toBe(false)
  })

  it('still reports a swipe the browser cancelled before it moved', () => {
    // A stolen gesture ends in touchcancel wherever the finger happens to be,
    // so the distance threshold must not be what discards it.
    expect(shouldReportCancelled(150)).toBe(true)
    expect(shouldReportCancelled(40)).toBe(false)
  })

  it('summarises geometry, style, and scroll room', () => {
    const node = element({ className: '_tab_1', width: 120, height: 40, scrollWidth: 600, clientWidth: 215 })
    const facts = elementFacts(node, readOf(() => style({ touchAction: 'pan-x pinch-zoom', overflowX: 'auto' })), { width: 400, height: 800 })
    expect(facts).toMatchObject({
      tag: 'div',
      cls: '_tab_1',
      touchAction: 'pan-x pinch-zoom',
      overflowX: 'auto',
      width: 120,
      height: 40,
      scrollWidth: 600,
      clientWidth: 215,
    })
    // 120 × 40 over a 400 × 800 viewport.
    expect(facts?.coverage).toBe(0.015)
    expect(elementFacts(null, readOf(() => style()), { width: 400, height: 800 })).toBeUndefined()
  })

  it('walks up to the drawer root and stops there', () => {
    const root = element({ className: '_panel_root', matchesStop: true })
    const middle = element({ className: '_pane_1', parentElement: root })
    const tab = element({ className: '_tab_1', parentElement: middle })
    const rows = gestureChain(tab, readOf(() => style({ touchAction: 'pan-x' })), { width: 400, height: 800 })
    expect(rows.map((row) => row.cls)).toEqual(['_tab_1', '_pane_1', '_panel_root'])
  })

  it('keeps only screen-covering layers stacked high enough to dim the app', () => {
    const dim = element({ className: '_overlay_1', width: 400, height: 800 })
    const ghost = element({ className: '_ghost_1', width: 380, height: 700 })
    const small = element({ className: '_badge_1', width: 40, height: 20 })
    const plain = element({ className: '_pane_1', width: 400, height: 800 })
    const styles = new Map<Element, CSSStyleDeclaration>([
      [dim, style({ position: 'fixed', zIndex: '900' })],
      [ghost, style({ position: 'absolute', zIndex: '500' })],
      [small, style({ position: 'fixed', zIndex: '900' })],
      [plain, style({ position: 'static', zIndex: '900' })],
    ])
    const suspects = overlaySuspects(styles.keys(), readOf((node) => styles.get(node) ?? style()), { width: 400, height: 800 })
    expect(suspects.map((row) => row.cls)).toEqual(['_overlay_1', '_ghost_1'])
  })

  it('reads the strip scroll state and its tab count', () => {
    const strip = element({ className: '_stripTabs_1', scrollLeft: 120, scrollWidth: 600, clientWidth: 215, tabs: 6 })
    expect(stripSnapshot(strip as unknown as HTMLElement)).toEqual({ scrollLeft: 120, scrollWidth: 600, clientWidth: 215, tabs: 6 })
    expect(stripSnapshot(null)).toBeUndefined()
  })
})

/** A document just rich enough for the recorder, capturing its listeners. */
function documentStub(handlers: Map<string, EventListener>, strip: Element | null): Document {
  return {
    addEventListener: (type: string, listener: EventListener) => { handlers.set(type, listener) },
    removeEventListener: (type: string) => { handlers.delete(type) },
    querySelector: () => strip,
    querySelectorAll: () => [],
    elementFromPoint: () => null,
    defaultView: { innerWidth: 390, innerHeight: 844, devicePixelRatio: 3, visualViewport: { scale: 1 } },
    documentElement: { scrollWidth: 390, scrollHeight: 844 },
    activeElement: null,
  } as unknown as Document
}

/** A touch event carrying one contact point. */
function touchEvent(target: Element, x: number, y: number): TouchEvent {
  return {
    touches: [{ clientX: x, clientY: y }],
    changedTouches: [{ clientX: x, clientY: y }],
    target,
    cancelable: true,
    defaultPrevented: false,
  } as unknown as TouchEvent
}

interface TraceEntry {
  kind: string
  cancelled: boolean
  endType: string
  delta: { x: number; y: number }
  steps: Array<{ type: string }>
  chain: Array<{ cls: string }>
  strip: { start: { scrollLeft: number } | null; settled: { tabs: number } | null }
}

describe('gesture telemetry recorder', () => {
  it('posts one trace for a drag that started inside the drawer', () => {
    vi.useFakeTimers()
    try {
      const sent: Array<{ endpoint: string; body: string }> = []
      const handlers = new Map<string, EventListener>()
      const strip = element({ className: '_stripTabs_1', scrollLeft: 120, scrollWidth: 600, clientWidth: 215, tabs: 6 })
      const tab = element({ className: '_tab_1', closestDrawer: true, matchesStop: true })
      // A controllable clock: the trace's duration decides whether it is sent.
      let clock = 1_000
      const remove = installGestureTelemetry({
        target: documentStub(handlers, strip),
        now: () => clock,
        read: () => style({ touchAction: 'pan-x pinch-zoom', overflowX: 'auto' }),
        send: (endpoint, body) => sent.push({ endpoint, body }),
      })
      handlers.get('touchstart')?.(touchEvent(tab, 320, 700))
      handlers.get('touchmove')?.(touchEvent(tab, 200, 702))
      expect(sent).toHaveLength(0)
      clock += 200
      handlers.get('touchend')?.(touchEvent(tab, 150, 704))
      // Nothing is posted until the settle sample, after the finger is gone.
      expect(sent).toHaveLength(0)
      vi.advanceTimersByTime(300)
      expect(sent).toHaveLength(1)
      expect(sent[0]?.endpoint).toBe('/__dsh-on-phone/telemetry')
      const entry = JSON.parse(sent[0]?.body ?? '{}') as TraceEntry
      expect(entry.kind).toBe('gesture')
      expect(entry.cancelled).toBe(false)
      expect(entry.endType).toBe('touchend')
      expect(entry.delta).toEqual({ x: -170, y: 4 })
      expect(entry.steps.map((step) => step.type)).toEqual(['touchstart', 'touchmove', 'touchend'])
      expect(entry.chain.map((row) => row.cls)).toEqual(['_tab_1'])
      expect(entry.strip.start?.scrollLeft).toBe(120)
      expect(entry.strip.settled?.tabs).toBe(6)
      remove()
      expect(handlers.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('posts a barely-moved swipe that was cancelled before it could travel', () => {
    vi.useFakeTimers()
    try {
      const sent: string[] = []
      const handlers = new Map<string, EventListener>()
      const tab = element({ className: '_tab_1', closestDrawer: true, matchesStop: true })
      let clock = 5_000
      installGestureTelemetry({
        target: documentStub(handlers, null),
        now: () => clock,
        read: () => style({ touchAction: 'pan-x' }),
        send: (_endpoint, body) => sent.push(body),
      })
      handlers.get('touchstart')?.(touchEvent(tab, 300, 700))
      clock += 160
      handlers.get('touchcancel')?.(touchEvent(tab, 302, 701))
      vi.advanceTimersByTime(300)
      expect(sent).toHaveLength(1)
      const entry = JSON.parse(sent[0] ?? '{}') as TraceEntry
      expect(entry.cancelled).toBe(true)
      expect(entry.endType).toBe('touchcancel')
      expect(entry.strip.settled).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores a touch that starts outside the drawer', () => {
    vi.useFakeTimers()
    try {
      const sent: string[] = []
      const handlers = new Map<string, EventListener>()
      const outside = element({ className: '_row_1', closestDrawer: false })
      installGestureTelemetry({
        target: documentStub(handlers, null),
        read: () => style(),
        send: (_endpoint, body) => sent.push(body),
      })
      handlers.get('touchstart')?.(touchEvent(outside, 320, 400))
      handlers.get('touchend')?.(touchEvent(outside, 40, 400))
      vi.advanceTimersByTime(1_000)
      expect(sent).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})
