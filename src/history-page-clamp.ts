/**
 * Older history reaches the phone over two channels, and only one of them used
 * to be bounded. The snapshot that `session/follow` opens is clamped in
 * `websocket-frames.ts`; every page after it arrives as a plain HTTP
 * `POST /api/session/page` whose body asks the host for 500 messages. That body
 * is the phone's real cost: measured against a live session, `maxMessages: 500`
 * came back as 4,517,693 bytes / 1167 records (1,097,192 bytes once the host
 * gzipped it) where 20 messages are 277,957 bytes / 103 records. The phone
 * transfers *and parses* a page before it can paint, so the first paint and
 * every later page are both bounded here.
 *
 * This is the same rewrite DSH 0.1.7 forced off `/api/session.history` (the
 * route that commit removed, moving the clamp down into the frame layer): the
 * body is plain JSON-RPC, so shrinking it works for the LAN gateway, the
 * Tailscale proxy and any client without touching the host. The client walks its
 * `beforeSeq` cursor forward from the oldest record a page returned, so a short
 * page is a valid page — the same assumption the frame clamp already relies on.
 */
import { MOBILE_HISTORY_PAGE_MESSAGES, MOBILE_HISTORY_TURN_MIN_MESSAGES } from './websocket-frames.js'

/** The one HTTP route that carries paged session history. */
export const HISTORY_PAGE_PATH = '/api/session/page'

/**
 * Messages per page after the first one. Larger than the first page because
 * every page costs a round trip of its own, but kept small on purpose: measured
 * through the phone channel (2026-09-28), 60 messages of a tool-heavy session
 * were 0.9-1.8 MB of JSON (219-538 KB compressed) and the phone rendered
 * nothing until the last byte had arrived. At 24 a tap is a fraction of that.
 */
export const MOBILE_HISTORY_CONTINUATION_PAGE_MESSAGES = 24

/** Sessions remembered while deciding whether a page is a session's first. */
export const MAX_TRACKED_HISTORY_SESSIONS = 64

export interface HistoryPageGrant {
  readonly first: boolean
  readonly maxMessages: number
}

export interface HistoryPageClampRecord {
  readonly sessionId: string | undefined
  readonly first: boolean
  readonly requested: number | undefined
  readonly maxMessages: number
  readonly turnMinMessages: number | undefined
}

export interface HistoryPageClampResult {
  readonly body: Buffer
  readonly record: HistoryPageClampRecord
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

function requestOf(frame: Record<string, unknown>): Record<string, unknown> | undefined {
  const payload = frame.payload
  if (!isJsonRecord(payload)) return undefined
  const args = payload.args
  if (!isJsonRecord(args)) return undefined
  const request = args.request
  return isJsonRecord(request) ? request : undefined
}

function sessionIdOf(request: Record<string, unknown>): string | undefined {
  const address = request.address
  if (!isJsonRecord(address)) return undefined
  const sessionId = address.sessionId
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined
}

/**
 * Page sizes granted per session. The first page a session asks for is the one
 * the phone paints when it opens that session, so it stays as small as the
 * WebSocket snapshot; later pages can afford to be larger.
 *
 * A budget lives as long as the proxy that owns it, and a fresh document means
 * a fresh first paint, so the owner calls {@link reset} whenever it serves one.
 */
export class HistoryPageBudget {
  private readonly seen = new Set<string>()

  constructor(
    private readonly firstPageMessages: number = MOBILE_HISTORY_PAGE_MESSAGES,
    private readonly laterPageMessages: number = MOBILE_HISTORY_CONTINUATION_PAGE_MESSAGES,
  ) {}

  /** Forget every session, so the next page each of them asks for is a first page. */
  reset(): void {
    this.seen.clear()
  }

  /** The page `sessionId` may ask for next, remembering it as seen; never below one. */
  nextPage(sessionId: string | undefined): HistoryPageGrant {
    const first = sessionId === undefined || !this.seen.has(sessionId)
    if (sessionId !== undefined && first) {
      this.seen.add(sessionId)
      while (this.seen.size > MAX_TRACKED_HISTORY_SESSIONS) {
        const oldest = this.seen.values().next().value as string | undefined
        if (oldest === undefined) break
        this.seen.delete(oldest)
      }
    }
    return { first, maxMessages: Math.max(1, first ? this.firstPageMessages : this.laterPageMessages) }
  }
}

/**
 * Shrink the history page one `POST /api/session/page` body asks for.
 * @returns the rewritten body plus what changed, or `undefined` when the body is
 * not a page request this rewrite applies to (or already asks for less).
 */
export function clampHistoryPageBody(body: Buffer, budget: HistoryPageBudget): HistoryPageClampResult | undefined {
  let frame: unknown
  try {
    frame = JSON.parse(body.toString('utf8'))
  } catch {
    return undefined
  }
  if (!isJsonRecord(frame) || frame.method !== 'session/page') return undefined
  const request = requestOf(frame)
  if (request === undefined) return undefined
  const sessionId = sessionIdOf(request)
  const grant = budget.nextPage(sessionId)
  const requested = positiveInteger(request.maxMessages)
  const maxMessages = requested === undefined ? grant.maxMessages : Math.min(requested, grant.maxMessages)
  const turnWindow = request.turnWindow
  const turnMinMessages = isJsonRecord(turnWindow) ? positiveInteger(turnWindow.minMessages) : undefined
  // The host rejects a request whose `turnWindow.minMessages` exceeds
  // `maxMessages` ("gateway/bad-request"), so the two stay consistent.
  let nextTurnWindow: Record<string, unknown>
  if (turnMinMessages !== undefined) {
    nextTurnWindow = { ...(turnWindow as Record<string, unknown>), minMessages: Math.max(1, Math.min(turnMinMessages, maxMessages)) }
  } else if (turnWindow === undefined) {
    nextTurnWindow = { minMessages: Math.min(MOBILE_HISTORY_TURN_MIN_MESSAGES, maxMessages), minTurns: 2 }
  } else {
    return undefined
  }
  // Nothing to shrink and nothing to reconcile: leave the request alone.
  if (maxMessages === requested && nextTurnWindow.minMessages === turnMinMessages) return undefined
  const next = {
    ...frame,
    payload: {
      ...(frame.payload as Record<string, unknown>),
      args: {
        ...((frame.payload as { args: Record<string, unknown> }).args),
        request: { ...request, maxMessages, turnWindow: nextTurnWindow },
      },
    },
  }
  return {
    body: Buffer.from(JSON.stringify(next)),
    record: {
      sessionId,
      first: grant.first,
      requested,
      maxMessages,
      turnMinMessages: positiveInteger(nextTurnWindow.minMessages),
    },
  }
}
