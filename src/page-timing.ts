/**
 * Client-side timing for paged history — the phone's half of the measurement.
 *
 * The server log can only say how long the local app took to *produce* a page:
 * the proxy sits next to the app, drains the answer in milliseconds, and then
 * hands it to a phone link that may need seconds. So the phone times itself,
 * and it does so from the resource timeline instead of by wrapping the
 * transport: `PerformanceResourceTiming` covers `fetch` and `XMLHttpRequest`
 * alike, reports the real wire and decoded body sizes, and needs no cooperation
 * from the app.
 *
 * Around each `/api/session/page` entry the recorder samples how many turns are
 * rendered on screen (0, 250, 1000, 3000 ms after the response ended). Those
 * samples are what tells "the payload is slow" apart from "the payload arrived
 * and the view was slow to draw it" — the difference the server log could not
 * see, which is why the host's "载入历史…" placeholder could sit there while
 * every server-side number looked fast.
 */

/** The one HTTP route that carries paged session history. */
export const PAGE_TIMING_PATH = '/api/session/page'

/** Where traces go: the remote proxy answers it, never the upstream app. */
export const TELEMETRY_ENDPOINT = '/__dsh-on-phone/telemetry'

/** Rendered turns, counted to observe when a page actually appears. */
export const TURN_SELECTOR = '[data-chat-turn]'

/** How often the resource timeline is scanned for a new page request. */
export const PAGE_TIMING_POLL_MS = 250

/** Offsets after the response ended at which the turn count is sampled. */
export const PAINT_SAMPLE_DELAYS_MS = [0, 250, 1000, 3000]

/** Upper bound on reported pages per page load (a reload starts a new budget). */
export const MAX_REPORTED_PAGES = 40

/**
 * Entries to keep in the resource timeline.
 *
 * Chrome stops recording once the buffer is full (250 by default) and the app
 * is chatty — two cost-meter calls a second is enough to bury a page request
 * within minutes, which would leave this recorder silently blind on exactly the
 * long-lived phone session it exists to measure.
 */
export const RESOURCE_BUFFER_SIZE = 2000

/**
 * The part of `PerformanceResourceTiming` this module reads. Everything is
 * optional except the name, so a partial entry still yields a usable record.
 */
export interface ResourceTimingLike {
  readonly name: string
  readonly startTime?: number
  readonly duration?: number
  readonly initiatorType?: string
  readonly requestStart?: number
  readonly responseStart?: number
  readonly responseEnd?: number
  readonly transferSize?: number
  readonly encodedBodySize?: number
  readonly decodedBodySize?: number
}

/** Minimal shape of the document this module needs (counts rendered turns). */
export interface TurnSource {
  querySelectorAll?(selector: string): { readonly length: number }
}

/** The slice of `Performance` this module uses to keep the timeline alive. */
export interface ResourceBufferTarget {
  setResourceTimingBufferSize?(size: number): void
  clearResourceTimings?(): void
  addEventListener?(type: string, listener: () => void): void
  removeEventListener?(type: string, listener: () => void): void
}

/** A recorded page: timings in milliseconds, sizes in bytes. */
export interface PageTimingRecord {
  readonly kind: 'page-timing'
  readonly at: string
  readonly url: string
  readonly initiatorType: string | null
  /** `duration` from the resource timeline. */
  readonly durationMs: number | null
  /** Request sent to last body byte — the phone's transfer time. */
  readonly transferMs: number | null
  /** Request sent to first body byte (headers reached the phone). */
  readonly waitMs: number | null
  readonly transferBytes: number | null
  readonly encodedBytes: number | null
  readonly decodedBytes: number | null
  /** Rendered turns seen just before the page request was noticed. */
  readonly baselineTurns: number
  /** Rendered turns at each offset in `samplesMs`. */
  readonly turns: readonly number[]
  readonly samplesMs: readonly number[]
  /** First offset at which the rendered turn count grew, or null. */
  readonly firstPaintMs: number | null
}

/** Injectable transport and clock. */
export interface PageTimingOptions {
  readonly endpoint?: string
  readonly send?: (endpoint: string, body: string) => void
  readonly now?: () => number
  readonly document?: TurnSource
  readonly resources?: () => readonly ResourceTimingLike[]
  readonly sleep?: (ms: number) => Promise<void>
  readonly pollMs?: number
  readonly buffer?: ResourceBufferTarget
}

/** True for the paged-history route, absolute or relative. */
export function isHistoryPageUrl(url: string): boolean {
  return url.includes(PAGE_TIMING_PATH)
}

/**
 * Count rendered turns.
 * @param source - Document (or stub) to query.
 * @param selector - Turn selector.
 * @returns The number of rendered turns.
 */
export function countTurns(source: TurnSource | undefined, selector: string = TURN_SELECTOR): number {
  if (source === undefined || typeof source.querySelectorAll !== 'function') return 0
  return source.querySelectorAll(selector).length
}

/**
 * Turn one resource entry into a record, sampling the rendered turn count.
 * @param entry - Resource timing entry for a page request.
 * @param baselineTurns - Turn count before the page was noticed.
 * @param context - Injectable clock, DOM, and transport.
 * @returns The record that was sent.
 */
export async function describePage(
  entry: ResourceTimingLike,
  baselineTurns: number,
  context: Required<Pick<PageTimingOptions, 'now' | 'sleep' | 'endpoint' | 'send'>> & { readonly document?: TurnSource },
): Promise<PageTimingRecord> {
  const startedAt = entry.startTime ?? 0
  const requestStart = entry.requestStart ?? startedAt
  const responseStart = entry.responseStart ?? requestStart
  const responseEnd = entry.responseEnd ?? startedAt + (entry.duration ?? 0)
  const turns: number[] = []
  const samplesMs: number[] = []
  let elapsed = 0
  let firstPaintMs: number | null = null
  for (const delay of PAINT_SAMPLE_DELAYS_MS) {
    if (delay > elapsed) {
      await context.sleep(delay - elapsed)
      elapsed = delay
    }
    const counted = countTurns(context.document)
    turns.push(counted)
    samplesMs.push(Math.round(context.now() - responseEnd))
    if (firstPaintMs === null && counted > baselineTurns) firstPaintMs = samplesMs[samplesMs.length - 1] ?? null
  }
  const record: PageTimingRecord = {
    kind: 'page-timing',
    at: new Date().toISOString(),
    url: entry.name.replace(/^https?:\/\/[^/]+/, ''),
    initiatorType: entry.initiatorType ?? null,
    durationMs: entry.duration === undefined ? null : Math.round(entry.duration),
    transferMs: Math.round(responseEnd - requestStart),
    waitMs: Math.round(responseStart - requestStart),
    transferBytes: entry.transferSize ?? null,
    encodedBytes: entry.encodedBodySize ?? null,
    decodedBytes: entry.decodedBodySize ?? null,
    baselineTurns,
    turns,
    samplesMs,
    firstPaintMs,
  }
  context.send(context.endpoint, JSON.stringify(record))
  return record
}

/**
 * Ask for room in the resource timeline and keep sweeping it when it fills.
 *
 * Chrome silently drops new entries once the timeline is full, so a session
 * open for minutes would starve this recorder. Sweeping costs at most the
 * entries recorded since the previous poll (a quarter second) and keeps the
 * timeline readable for as long as the page lives.
 * @param target - The performance object (injectable for tests).
 * @returns A function that stops sweeping.
 */
export function reserveResourceBuffer(target: ResourceBufferTarget | undefined): () => void {
  if (target === undefined) return () => undefined
  try {
    target.setResourceTimingBufferSize?.(RESOURCE_BUFFER_SIZE)
  } catch {
    // A browser that refuses the size still gets the sweep below.
  }
  if (typeof target.addEventListener !== 'function') return () => undefined
  const sweep = (): void => {
    try {
      target.clearResourceTimings?.()
    } catch {
      // Nothing to do: the recorder will simply see fewer entries.
    }
  }
  target.addEventListener('resourcetimingbufferfull', sweep)
  return () => target.removeEventListener?.('resourcetimingbufferfull', sweep)
}

/**
 * Install the recorder.
 *
 * It never touches the app's transport: it only reads the resource timeline,
 * so a page that never uses `fetch` is still measured. The poll is one
 * `getEntriesByType` plus one turn count per tick.
 * @param options - Injectable DOM, timeline, clock, and transport.
 * @returns A function that stops the recorder.
 */
export function installPageTiming(options: PageTimingOptions = {}): () => void {
  const doc = options.document ?? (typeof document === 'undefined' ? undefined : document)
  const resources = options.resources ?? defaultResources()
  if (resources === undefined) return () => undefined
  const buffer = options.buffer ?? (typeof performance === 'undefined' ? undefined : performance)
  const releaseBuffer = reserveResourceBuffer(buffer)
  const now = options.now ?? ((): number => (typeof performance === 'undefined' ? Date.now() : performance.now()))
  const sleep = options.sleep ?? wait
  const endpoint = options.endpoint ?? TELEMETRY_ENDPOINT
  const send = options.send ?? postTrace
  const pollMs = options.pollMs ?? PAGE_TIMING_POLL_MS
  const seen = new Set<number>()
  let baselineTurns = countTurns(doc)
  let stopped = false
  const tick = (): void => {
    let turns: number | undefined
    for (const entry of resources()) {
      if (stopped || !isHistoryPageUrl(entry.name)) continue
      const key = entry.startTime ?? 0
      if (seen.has(key)) continue
      seen.add(key)
      if (seen.size > MAX_REPORTED_PAGES) return
      // `exactOptionalPropertyTypes` forbids an explicit undefined here.
      const context = doc === undefined ? { now, sleep, endpoint, send } : { now, sleep, endpoint, send, document: doc }
      void describePage(entry, turns ?? baselineTurns, context)
      turns = countTurns(doc)
    }
    baselineTurns = turns ?? countTurns(doc)
  }
  tick()
  const timer = setInterval(tick, pollMs)
  return () => {
    stopped = true
    clearInterval(timer)
    releaseBuffer()
  }
}

/**
 * Read the browser's resource timeline.
 * @returns A reader, or undefined when the timeline is unavailable.
 */
function defaultResources(): (() => readonly ResourceTimingLike[]) | undefined {
  if (typeof performance === 'undefined' || typeof performance.getEntriesByType !== 'function') return undefined
  return () => performance.getEntriesByType('resource') as unknown as readonly ResourceTimingLike[]
}

/**
 * Wait.
 * @param ms - Milliseconds.
 * @returns A promise resolved after the delay.
 */
function wait(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * Post one record. A failure is ignored: telemetry must never surface as an
 * error in the app.
 * @param endpoint - Telemetry URL.
 * @param body - Serialised record.
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
