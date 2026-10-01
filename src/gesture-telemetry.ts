/**
 * Client half of the phone's debug telemetry.
 *
 * A tab swipe that only works when it is "very fast and very light" cannot be
 * diagnosed from the machine: the headless probe shows the strip scrolling
 * normally, so whatever eats the gesture lives in WebKit's own event pipeline,
 * in the host's pointer handling, or in a touch-action decision only the real
 * browser makes. This module records what actually reached the page during one
 * drag inside the open drawer — the touch/pointer sequence, whether anything
 * called `preventDefault`, the element under the finger, the whole
 * `touch-action` chain, and the strip's scroll offset before and after — and
 * posts it to the remote proxy, which appends it to the DSH home log.
 *
 * It is a debugging aid meant to be deleted again: it records class names and
 * geometry, never text and never keystrokes, it only reports real drags (not
 * taps, not typing), and it never prevents or delays an event.
 * @module dsh-on-phone/gesture-telemetry
 */

/** Endpoint on the remote proxy; see `mobile-telemetry.ts` for the reader. */
export const TELEMETRY_ENDPOINT = '/__dsh-on-phone/telemetry'

/** Drawer root: telemetry only ever describes gestures that started inside it. */
const DRAWER_SELECTOR = '[data-dsh-on-phone-workbench]'
/** The open-files strip and its two siblings, whatever the CSS hash calls them. */
const STRIP_SELECTOR = '[class*="_stripTabs"],[class*="_tabStrip"],[class*="_detailTabs"]'
const MAX_STEPS = 120
const MAX_CHAIN = 14
const MAX_OVERLAYS = 8
const MAX_SCANNED_NODES = 4000
/** Below this the gesture was a tap or a scroll nudge, not a swipe attempt. */
const MIN_REPORT_MS = 120
const MIN_REPORT_DISTANCE = 8
/** Sending this soon after the last trace would flood the log during a burst. */
const MIN_REPORT_GAP_MS = 400
/** Sampled after the finger lifts, once the browser has settled its scrolling. */
const SAMPLE_DELAY_MS = 250
/** A host overlay sits above the app and usually above this. */
const OVERLAY_MIN_Z_INDEX = 100
/** …and it has to cover a meaningful part of the screen to be a dimming layer. */
const OVERLAY_MIN_COVERAGE = 0.2

/** Geometry and computed style of one element, as logged. */
export interface ElementFacts {
  readonly tag: string
  readonly cls: string
  readonly position: string
  readonly zIndex: string
  readonly opacity: string
  readonly background: string
  readonly width: number
  readonly height: number
  readonly coverage: number
  readonly draggable: boolean
  readonly userSelect: string
  readonly touchAction: string
  readonly overflowX: string
  readonly overflowY: string
  readonly scrollWidth: number
  readonly scrollHeight: number
  readonly clientWidth: number
  readonly clientHeight: number
}

/** One recorded event during a gesture. */
export interface GestureStep {
  readonly dt: number
  readonly type: string
  readonly x: number
  readonly y: number
  readonly target: string
  readonly top: string
  readonly prevented: boolean
  readonly cancelable: boolean
  readonly pointerType: string
}

/** Scroll state of the open-files strip. */
export interface StripSnapshot {
  readonly scrollLeft: number
  readonly scrollWidth: number
  readonly clientWidth: number
  readonly tabs: number
}

/** Viewport facts, including the pinch-zoom scale a stray zoom would change. */
export interface ViewportFacts {
  readonly width: number
  readonly height: number
  readonly dpr: number
  readonly scale: number
  readonly docWidth: number
  readonly docHeight: number
}

/** Construction inputs for the recorder; every DOM access is injectable for tests. */
export interface GestureTelemetryOptions {
  readonly endpoint?: string
  readonly send?: (endpoint: string, body: string) => void
  readonly now?: () => number
  readonly target?: Document
  readonly read?: (element: Element) => CSSStyleDeclaration
}

interface Trace {
  readonly startedAt: number
  readonly startX: number
  readonly startY: number
  readonly steps: GestureStep[]
  readonly chain: ElementFacts[]
  readonly stripStart: StripSnapshot | undefined
}

/**
 * Normalise a `className`-like value to a short string.
 *
 * `className` is an `SVGAnimatedString` on some nodes and absent on others, and
 * a hashed stylesheet produces long names, so this never throws and never keeps
 * more than `length` characters.
 * @param value - Raw class value.
 * @param length - Maximum characters kept.
 * @returns A short, loggable class list.
 */
export function shortClass(value: unknown, length = 56): string {
  const text = typeof value === 'string'
    ? value
    : typeof value === 'object' && value !== null && 'baseVal' in value
      ? String((value as { baseVal?: unknown }).baseVal ?? '')
      : ''
  return text.length > length ? text.slice(0, length) : text
}

/**
 * Whether a finished gesture is worth a trace: taps and small scrolls are not.
 * @param durationMs - Gesture duration.
 * @param dx - Horizontal travel.
 * @param dy - Vertical travel.
 * @param minimum - Overridable thresholds.
 * @returns Whether the gesture should be posted.
 */
export function shouldReportGesture(
  durationMs: number,
  dx: number,
  dy: number,
  minimum: { durationMs: number; distance: number } = { durationMs: MIN_REPORT_MS, distance: MIN_REPORT_DISTANCE },
): boolean {
  return durationMs >= minimum.durationMs && Math.max(Math.abs(dx), Math.abs(dy)) >= minimum.distance
}

/**
 * Whether a cancelled gesture is worth a trace even though it barely moved.
 *
 * A swipe that the browser or the host steals can be cancelled before the
 * finger travels anywhere, and that trace — almost empty, ending in
 * `touchcancel` — is exactly the evidence the successful-swipe case cannot give.
 * @param durationMs - Gesture duration.
 * @param minimum - Overridable threshold.
 * @returns Whether the cancellation should be posted.
 */
export function shouldReportCancelled(durationMs: number, minimum = MIN_REPORT_MS): boolean {
  return durationMs >= minimum
}

/**
 * Describe one element the way the log needs it.
 * @param node - Element to describe, or null.
 * @param read - Computed-style reader.
 * @param viewport - Viewport used to turn the rect into a coverage ratio.
 * @returns Facts, or undefined for a missing node.
 */
export function elementFacts(
  node: Element | null,
  read: (element: Element) => CSSStyleDeclaration,
  viewport: { width: number; height: number },
): ElementFacts | undefined {
  if (node === null) return undefined
  const style = read(node)
  const rect = node.getBoundingClientRect()
  const area = viewport.width > 0 && viewport.height > 0 ? (rect.width * rect.height) / (viewport.width * viewport.height) : 0
  return {
    tag: node.tagName.toLowerCase(),
    cls: shortClass(node.className),
    position: style.position,
    zIndex: style.zIndex,
    opacity: style.opacity,
    background: shortClass(style.backgroundColor, 32),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    coverage: Math.round(Math.min(1, Math.max(0, area)) * 1000) / 1000,
    draggable: 'draggable' in node && (node as { draggable?: unknown }).draggable === true,
    userSelect: style.userSelect,
    touchAction: style.touchAction,
    overflowX: style.overflowX,
    overflowY: style.overflowY,
    scrollWidth: node.scrollWidth,
    scrollHeight: node.scrollHeight,
    clientWidth: node.clientWidth,
    clientHeight: node.clientHeight,
  }
}

/**
 * Walk from the touched element up to the drawer root, recording every step.
 *
 * The `touch-action` chain is the point: WebKit hands a gesture to whichever
 * ancestor it can claim, so a single narrow rule above the strip can decide the
 * whole swipe. The walk stops at the drawer root so the trace stays small.
 * @param start - Touched element.
 * @param read - Computed-style reader.
 * @param viewport - Viewport for coverage ratios.
 * @param stopSelector - Ancestor that ends the walk (inclusive).
 * @param limit - Maximum rows.
 * @returns One row per ancestor, nearest first.
 */
export function gestureChain(
  start: Element | null,
  read: (element: Element) => CSSStyleDeclaration,
  viewport: { width: number; height: number },
  stopSelector: string = DRAWER_SELECTOR,
  limit = MAX_CHAIN,
): ElementFacts[] {
  const rows: ElementFacts[] = []
  let node: Element | null = start
  while (node !== null && rows.length < limit) {
    const facts = elementFacts(node, read, viewport)
    if (facts !== undefined) rows.push(facts)
    if (node.matches(stopSelector)) break
    node = node.parentElement
  }
  return rows
}

/**
 * Screen-covering layers that appeared over the app.
 *
 * The "the screen goes dark and the window tears out" report points at a host
 * layer above the whole surface, so anything fixed or absolute that covers a
 * fifth of the viewport and sits high in the stack is worth naming.
 * @param nodes - Candidate nodes (usually every element in the body).
 * @param read - Computed-style reader.
 * @param viewport - Viewport for coverage ratios.
 * @param limit - Maximum rows kept.
 * @returns Largest suspect first.
 */
export function overlaySuspects(
  nodes: Iterable<Element>,
  read: (element: Element) => CSSStyleDeclaration,
  viewport: { width: number; height: number },
  limit = MAX_OVERLAYS,
): ElementFacts[] {
  const found: ElementFacts[] = []
  let scanned = 0
  for (const node of nodes) {
    if (scanned >= MAX_SCANNED_NODES) break
    scanned += 1
    const style = read(node)
    if (style.position !== 'fixed' && style.position !== 'absolute') continue
    if (Number.parseInt(style.zIndex, 10) < OVERLAY_MIN_Z_INDEX) continue
    const facts = elementFacts(node, read, viewport)
    if (facts === undefined || facts.coverage < OVERLAY_MIN_COVERAGE) continue
    found.push(facts)
  }
  found.sort((left, right) => right.coverage - left.coverage)
  return found.slice(0, limit)
}

/**
 * Read the open-files strip's scroll state.
 * @param strip - The strip element, if the caller already found it.
 * @returns Scroll metrics, or undefined when there is no strip.
 */
export function stripSnapshot(strip: HTMLElement | null): StripSnapshot | undefined {
  if (strip === null) return undefined
  return {
    scrollLeft: Math.round(strip.scrollLeft),
    scrollWidth: strip.scrollWidth,
    clientWidth: strip.clientWidth,
    tabs: strip.querySelectorAll('[class*="_tab_"]').length,
  }
}

/**
 * Treat an event target as an element without touching the DOM globals.
 *
 * `instanceof Element` is not available outside a browser (the test runner is a
 * plain Node environment) and would throw there, so the check is duck-typed.
 * @param target - Event target.
 * @returns The target when it can act as an element.
 */
function asElement(target: EventTarget | null): Element | null {
  return target !== null && typeof (target as Element).closest === 'function' ? (target as Element) : null
}

/**
 * Install the recorder.
 *
 * Every listener is capture-phase and passive, so it runs before the app's own
 * handlers without being able to change the outcome of the gesture it measures.
 * @param options - Injectable DOM, clock, and transport.
 * @returns A function that removes every listener.
 */
export function installGestureTelemetry(options: GestureTelemetryOptions = {}): () => void {
  const doc = options.target ?? (typeof document === 'undefined' ? undefined : document)
  if (doc === undefined) return () => undefined
  const now = options.now ?? ((): number => Date.now())
  const read = options.read ?? ((element: Element): CSSStyleDeclaration => getComputedStyle(element))
  const endpoint = options.endpoint ?? TELEMETRY_ENDPOINT
  const send = options.send ?? postTrace
  let trace: Trace | undefined
  let lastSentAt = 0

  const viewport = (): ViewportFacts => {
    const view = doc.defaultView
    return {
      width: view?.innerWidth ?? 0,
      height: view?.innerHeight ?? 0,
      dpr: view?.devicePixelRatio ?? 1,
      scale: view?.visualViewport?.scale ?? 1,
      docWidth: doc.documentElement.scrollWidth,
      docHeight: doc.documentElement.scrollHeight,
    }
  }
  const stripElement = (): HTMLElement | null => doc.querySelector<HTMLElement>(STRIP_SELECTOR)

  const record = (type: string, event: Event, x: number, y: number, target: Element | null): void => {
    if (trace === undefined || trace.steps.length >= MAX_STEPS) return
    const top = doc.elementFromPoint(x, y)
    trace.steps.push({
      dt: Math.round(now() - trace.startedAt),
      type,
      x: Math.round(x),
      y: Math.round(y),
      target: shortClass(target?.className) || target?.tagName.toLowerCase() || '',
      top: shortClass(top?.className) || top?.tagName.toLowerCase() || '',
      prevented: event.defaultPrevented,
      cancelable: event.cancelable,
      pointerType: (event as Partial<PointerEvent>).pointerType ?? '',
    })
  }

  const begin = (event: TouchEvent): void => {
    if (trace !== undefined) return
    const touch = event.touches[0]
    const target = asElement(event.target)
    if (touch === undefined || target === null || target.closest(DRAWER_SELECTOR) === null) return
    trace = {
      startedAt: now(),
      startX: touch.clientX,
      startY: touch.clientY,
      steps: [],
      chain: gestureChain(target, read, viewport()),
      stripStart: stripSnapshot(stripElement()),
    }
    record('touchstart', event, touch.clientX, touch.clientY, target)
  }

  const move = (event: TouchEvent): void => {
    const touch = event.touches[0]
    if (touch === undefined) return
    record('touchmove', event, touch.clientX, touch.clientY, asElement(event.target))
  }

  const note = (type: string): void => {
    const target = doc.activeElement
    record(type, new Event(type), -1, -1, target)
  }

  const finish = (type: string, event: TouchEvent): void => {
    const current = trace
    const touch = event.changedTouches[0]
    if (touch !== undefined) record(type, event, touch.clientX, touch.clientY, asElement(event.target))
    trace = undefined
    if (current === undefined || touch === undefined) return
    const duration = now() - current.startedAt
    const dx = touch.clientX - current.startX
    const dy = touch.clientY - current.startY
    const stolen = type === 'touchcancel' && shouldReportCancelled(duration)
    if (!stolen && !shouldReportGesture(duration, dx, dy)) return
    if (now() - lastSentAt < MIN_REPORT_GAP_MS) return
    lastSentAt = now()
    setTimeout(() => {
      const view = viewport()
      send(endpoint, JSON.stringify({
        kind: 'gesture',
        at: new Date(now()).toISOString(),
        durationMs: Math.round(duration),
        delta: { x: Math.round(dx), y: Math.round(dy) },
        endType: type,
        /** The gesture died in a cancellation rather than the finger lifting. */
        cancelled: stolen,
        viewport: view,
        userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
        chain: current.chain,
        strip: { start: current.stripStart ?? null, settled: stripSnapshot(stripElement()) ?? null },
        steps: current.steps,
        overlays: overlaySuspects(doc.querySelectorAll('body *'), read, view),
        panLog: panLog(doc),
      }))
    }, SAMPLE_DELAY_MS)
  }

  const listeners: Array<[string, EventListener]> = [
    ['touchstart', (event) => begin(event as TouchEvent)],
    ['touchmove', (event) => move(event as TouchEvent)],
    ['touchend', (event) => finish('touchend', event as TouchEvent)],
    ['touchcancel', (event) => finish('touchcancel', event as TouchEvent)],
    ['pointerdown', (event) => record('pointerdown', event, (event as PointerEvent).clientX, (event as PointerEvent).clientY, asElement(event.target))],
    ['pointercancel', (event) => record('pointercancel', event, (event as PointerEvent).clientX, (event as PointerEvent).clientY, asElement(event.target))],
    ['pointerup', (event) => record('pointerup', event, (event as PointerEvent).clientX, (event as PointerEvent).clientY, asElement(event.target))],
    ['dragstart', () => note('dragstart')],
    ['dragend', () => note('dragend')],
    ['contextmenu', () => note('contextmenu')],
    ['selectstart', () => note('selectstart')],
    ['scroll', (event) => {
      const scroller = event.target as Partial<HTMLElement> | null
      const x = typeof scroller?.scrollLeft === 'number' ? scroller.scrollLeft : -1
      const y = typeof scroller?.scrollTop === 'number' ? scroller.scrollTop : -1
      record(`scroll:${x},${y}`, event, -1, -1, asElement(event.target))
    }],
  ]
  for (const [type, listener] of listeners) doc.addEventListener(type, listener, { capture: true, passive: true })
  return () => {
    for (const [type, listener] of listeners) doc.removeEventListener(type, listener, { capture: true })
  }
}

/**
 * Read the drawer-pan module's own decision log, so one trace explains both
 * halves of the gesture: what the page saw, and what our fallback did about it.
 * @param doc - Document owning the window.
 * @returns The last few pan notes.
 */
function panLog(doc: Document): unknown[] {
  const host = doc.defaultView as (Window & { __DSH_ON_PHONE_DRAWER_PAN__?: unknown[] }) | null
  const entries = host?.__DSH_ON_PHONE_DRAWER_PAN__
  return Array.isArray(entries) ? entries.slice(-3) : []
}

/**
 * Post one trace. `keepalive` lets the last trace of a page survive a reload,
 * and a failure is ignored: telemetry must never surface as an error.
 * @param endpoint - Telemetry URL.
 * @param body - Serialised trace.
 */
function postTrace(endpoint: string, body: string): void {
  if (typeof fetch !== 'function') return
  void fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => undefined)
}
