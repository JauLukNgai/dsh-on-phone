/**
 * Repairing the app's own `openState = "loading"`, at the object layer.
 *
 * 「载入历史…」 is the host's view of `session.openState === "loading"`, and the
 * app sets that state in the session controller's `doOpen` *before* awaiting the
 * opening frame of the session's `session/follow` stream. That whole pass is
 * fenced by a generation number:
 *
 *     if (generation !== this.openGeneration || this.events !== events) return;
 *
 * so when something bumps `openGeneration` mid-open the pass returns without
 * publishing `openState = "open"` — and `open()`'s own `.finally` has already
 * cleared `openPromise`, so nothing is scheduled to try again. The view then sits
 * on the hint with no error and a perfectly healthy HTTP history page behind it,
 * which is exactly the ~2.5-3.0 s stall (and, before the DOM watch, the 13 s or
 * never) measured on the phone.
 *
 * `openGeneration` is bumped in only three places in the controller: `resync()`,
 * `dispose()` and `failEventStream()`. `dispose()` is the interesting one: it
 * does *not* touch `openState`, so disposing a session whose open is in flight
 * leaves it at `"loading"` forever. The device showed exactly that: a session
 * whose open started, and was disposed 12-24 ms later, because the navigation
 * that retained it was aborted and the app released the only reference.
 *
 * Two things answer for it, both where the state actually lives. The first is the
 * hold ({@link holdSessionOpen}): the phone takes a reference of its own as the
 * open starts, so the app's release cannot drop the count to zero mid-open, and
 * keeps it for the whole loading window — the app's navigation released its own
 * reference again two seconds into a repaired open on the device, so the phone
 * only hands the reference back once the session has actually left `loading` —
 * no socket, no reload, no re-navigation. When
 * the app's own pass still settles with the state at `"loading"` and nobody
 * opening, the guard clears the stale `openPromise` and calls the app's own
 * `open()` again: a round trip, no socket touched — but only once the open has
 * stood for the same four seconds a first frame gets, because a pass settles the
 * instant the app disposes its stream, which is not the same thing as a session
 * that nothing will publish. A disposal observed mid-open shortens that wait
 * for the killed instance — its pass can never publish, so only the app's own
 * healthy re-open needs the grace — and once the same-carrier ladder (in-place
 * rounds, then the app's own navigation) has come up empty, the guard rebuilds
 * the carrier through the app Connection's own `reconnect()`: on the device
 * every same-carrier repair failed while a full page reload, which is a fresh
 * carrier, always opened the session. It also times out a first
 * frame that never arrives and asks the app for its own `resync()`.
 *
 * Everything here is feature-detected and wrapped: this is a guest in the app's
 * internals, so a shape that does not match reports zero and changes nothing.
 * @module dsh-on-phone/session-open-guard
 */

import { holdSessionOpen, type SessionHoldHandle } from './session-hold.js'

/**
 * How long a `doOpen` pass gets to publish its opening frame before the app's
 * own `resync()` is asked for one.
 *
 * The opening frame is a single atomic mux item, and for the heavy 242-turn
 * session it measured 297 KB / 68 records. The phone moves a comparable payload
 * in ~544 ms (a 232 KB page), and the p99 of 490 measured pages was 1.9 s, so
 * this deadline has to sit above a real transfer: the app has no timeout of its
 * own, and a repair that fires mid-transfer aborts the very frame it is waiting
 * for. Four seconds is 2x the worst healthy page we have seen and still leaves a
 * lost frame corrected while the user is watching.
 */
export const SESSION_OPEN_GUARD_NO_FRAME_MS = 4000

/**
 * Grace before the first repair after an observed mid-open disposal, and the
 * cadence of the invalidation fast chain after it.
 *
 * The app's own navigation re-opens a session right after the dispose race
 * (measured 350-1100 ms on the device), so a repair may only fire once that
 * healthy re-open is absent. But the dispose itself proves the killed pass can
 * never publish — its generation is gone — so the chain does not wait out a
 * whole opening frame the way the silent strand does. The same cadence carries
 * the chain: one in-place round, then the app's own navigation.
 */
export const SESSION_OPEN_GUARD_FAST_RECHECK_MS = 2000

/** App-navigation re-selections before the carrier is rebuilt once per session. */
const RECONNECT_AFTER_RESELECTS = 1

/**
 * No-frame repairs allowed per sessionId per page load. One lost opening frame
 * is expected to be the whole story; the second is kept for a session switched
 * away from and back, and the cap stops a session that cannot open at all from
 * resyncing in a loop.
 */
export const SESSION_OPEN_GUARD_MAX_NO_FRAME_REPAIRS = 2

/**
 * Stranded repairs allowed per sessionId per page load. The strand is a single
 * lost wake-up, so the first repair is expected to be the end of it; a second is
 * kept for a session invalidated twice in a row, and the cap stops a session that
 * cannot open at all from being re-opened in a loop.
 */
export const SESSION_OPEN_GUARD_MAX_REPAIRS = 2

/**
 * App-level re-selections allowed per sessionId per page load.
 *
 * When the instance the phone renders is no longer the one the app hands out for
 * that id — the main view's retain was aborted, so the scope was retired and the
 * instance disposed — the only repair that can work is the app's own "open this
 * session", the call the sidebar makes on a tap. It is idempotent and cheap, but
 * it does move the main view, so it is budgeted separately from the in-place
 * repairs and a little more generously: the device showed the same session
 * stranded twice within three seconds.
 */
export const SESSION_OPEN_GUARD_MAX_RESELECTS = 6

/**
 * How long the phone's own reference may outlive the app's interest in a session.
 *
 * A hold taken while a session opens is given back as soon as the app holds it
 * again, which on the healthy path is the same tick. A session the app dropped
 * and never asked for again is the case where the phone is the only thing keeping
 * the view it already renders alive; it is held for this long, and then the
 * reference goes back so an abandoned session cannot be kept open for the life of
 * the page.
 */
export const SESSION_OPEN_GUARD_HOLD_MAX_MS = 60_000

/** How often the sessions service is looked for while it is still absent. */
export const SESSION_OPEN_GUARD_ARM_INTERVAL_MS = 250

/**
 * How many times the service is looked for. The shell paints before the
 * remembered session opens, so the prototype is normally found on the first
 * attempt; the bound (240 x 250 ms, one minute) only covers a host that restores
 * no session at all, and it stops early the moment a prototype is wrapped —
 * after that the wrapper covers every instance the app creates later.
 */
export const SESSION_OPEN_GUARD_ARM_ATTEMPTS = 240

/**
 * Hidden own property marking a prototype this module already wrapped. Like
 * `open()`'s own `.finally`, it is what keeps a re-install from stacking wrappers
 * on a class the host may evaluate more than once.
 */
const PROTOTYPE_MARK = '__dshMobileSessionOpenGuard__'

/** Session id reported when the app exposes none. */
const UNKNOWN_SESSION_ID = 'unknown'

/** The method that bumped the generation while a session was loading. */
export type SessionInvalidator = 'dispose' | 'resync'

/** One session instance, as far as this guard reaches into it. */
export interface GuardableSession {
  sessionId?: unknown
  openState?: unknown
  openPromise?: unknown
  removed?: unknown
  address?: { mode?: unknown } | undefined
  open?(): unknown
  doOpen?(...args: unknown[]): unknown
  dispose?(): unknown
  resync?(): unknown
}

/** One held reference: the instance it was taken on, and when. */
interface HoldEntry {
  handle: SessionHoldHandle
  session: GuardableSession
  startedAt: number
}

/** The app's `sessions` service, as far as this guard reaches into it. */
export interface SessionOpenGuardService {
  manager?: {
    /**
     * The app's id-to-instance map. `get` is what tells a live instance from one
     * the app has already retired: the retired instance is no longer the value
     * under its own id, and nothing will ever open it again.
     */
    sessions?: {
      get?: (sessionId: string) => unknown
      values?: () => Iterable<GuardableSession | undefined>
    }
  }
}

/** Injectable environment, so the repair can be driven turn by turn in tests. */
export interface SessionOpenGuardOptions {
  /** The app's `sessions` service, resolved lazily: it may register after mount. */
  sessions: () => unknown
  /**
   * The app's own "open this session in the main view", normally
   * {@link reselectSession} over `ctx.get('uiWorkspace')`. Called when the
   * instance the phone renders is no longer the one the app hands out for that
   * id; returns whether the app could be asked.
   */
  reopenSession?: (sessionId: string) => boolean
  /**
   * Rebuild the browser's connection to the host — the app Connection service's
   * own `reconnect()`. Called once per session once the same-carrier ladder
   * (in-place rounds, then the app's own navigation) has come up empty, because
   * on the device every same-carrier repair failed while a full page reload —
   * a fresh carrier — always opened the session.
   */
  reconnectCarrier?: () => void
  /**
   * The phone's own reference to a session that is opening, normally
   * {@link holdSessionOpen} over `ctx.get('sessions')`. This is what keeps the
   * app from retiring — and disposing — a session whose open is in flight.
   * Absent, or returning undefined, leaves the app exactly as it was.
   */
  holdSession?: (sessionId: string) => SessionHoldHandle | undefined
  now?: () => number
  setTimeout?: (callback: () => void, ms: number) => number
  clearTimeout?: (handle: number) => void
  setInterval?: (callback: () => void, ms: number) => number
  clearInterval?: (handle: number) => void
  noFrameMs?: number
  fastRecheckMs?: number
  maxRepairs?: number
  maxNoFrameRepairs?: number
  maxReselects?: number
  holdMaxMs?: number
  armIntervalMs?: number
  armAttempts?: number
}

/** A method as it arrives from the app's class. */
type GuardMethod = (this: GuardableSession, ...args: unknown[]) => unknown

/**
 * Wrap the session class' `doOpen`/`dispose`/`resync`, once per prototype.
 *
 * The sessions service is resolved on every arm attempt rather than at mount:
 * the plugin's client half is evaluated before the app's own services exist, and
 * the class prototype found on any later attempt covers every instance — present
 * and future — because the app dispatches through the prototype.
 * @param options - The service getter and injectable clock and timers.
 * @returns A function that stops the arming poll; installed wrappers stay.
 */
export function installSessionOpenGuard(options: SessionOpenGuardOptions): () => void {
  const now = options.now ?? ((): number => Date.now())
  const schedule = options.setTimeout
    ?? ((callback: () => void, ms: number): number => globalThis.setTimeout(callback, ms) as unknown as number)
  const unschedule = options.clearTimeout
    ?? ((handle: number): void => {
      globalThis.clearTimeout(handle as unknown as ReturnType<typeof globalThis.setTimeout>)
    })
  const scheduleInterval = options.setInterval
    ?? ((callback: () => void, ms: number): number => globalThis.setInterval(callback, ms) as unknown as number)
  const unscheduleInterval = options.clearInterval
    ?? ((handle: number): void => {
      globalThis.clearInterval(handle as unknown as ReturnType<typeof globalThis.setInterval>)
    })
  const noFrameMs = options.noFrameMs ?? SESSION_OPEN_GUARD_NO_FRAME_MS
  const fastRecheckMs = options.fastRecheckMs ?? SESSION_OPEN_GUARD_FAST_RECHECK_MS
  const maxRepairs = options.maxRepairs ?? SESSION_OPEN_GUARD_MAX_REPAIRS
  const maxNoFrameRepairs = options.maxNoFrameRepairs ?? SESSION_OPEN_GUARD_MAX_NO_FRAME_REPAIRS
  const maxReselects = options.maxReselects ?? SESSION_OPEN_GUARD_MAX_RESELECTS
  const holdMaxMs = options.holdMaxMs ?? SESSION_OPEN_GUARD_HOLD_MAX_MS
  const armIntervalMs = options.armIntervalMs ?? SESSION_OPEN_GUARD_ARM_INTERVAL_MS
  const armAttempts = options.armAttempts ?? SESSION_OPEN_GUARD_ARM_ATTEMPTS

  /** Sessions this guard has actually seen, for the invalidation diagnosis. */
  const known = new WeakSet<object>()
  /** Stranded repairs spent, per sessionId, for this page load. */
  const repairs = new Map<string, number>()
  /** No-frame repairs spent, per sessionId, for this page load. */
  const noFrameRepairs = new Map<string, number>()
  /** The phone's own reference to each session whose open is in flight. */
  const holds = new Map<string, HoldEntry>()
  /** App-level re-selections the app accepted, per sessionId, for this page load. */
  const reselects = new Map<string, number>()
  /** Sessions the app would not re-open; one refusal ends the app-level path. */
  const reselectRefused = new Set<string>()
  /** Sessions whose stranded repair is waiting out the opening frame's own deadline. */
  const strandRechecks = new Set<string>()
  /** Instances a mid-open disposal was observed on; their strands get the short gate. */
  const invalidatedByDispose = new WeakSet<object>()
  /** Sessions whose carrier was rebuilt once the same-carrier ladder came up empty. */
  const reconnected = new Set<string>()
  /** When each session last entered a pass, for the strand gates. */
  const loadingSince = new Map<string, number>()

  const idOf = (session: GuardableSession): string => {
    try {
      const id = session.sessionId
      if (typeof id === 'string' && id.length > 0) return id
      if (typeof id === 'number') return String(id)
    } catch {
      // A getter that throws is not a session this guard can name.
    }
    return UNKNOWN_SESSION_ID
  }

  const isLoading = (session: GuardableSession): boolean => {
    try {
      return session.openState === 'loading'
    } catch {
      return false
    }
  }

  /**
   * Whether the session has not started opening yet. A hold can exist in this
   * state — it is taken inside `open()` before `doOpen` publishes `loading`,
   * and `resync()` passes through `cold` again while it disposes the old
   * stream — so the sweep treats it like `loading` rather than handing the
   * reference back mid-transition.
   */
  const isCold = (session: GuardableSession): boolean => {
    try {
      return session.openState === 'cold'
    } catch {
      return false
    }
  }

  const isRemoved = (session: GuardableSession): boolean => {
    try {
      return session.removed === true
    } catch {
      return false
    }
  }

  /**
   * Whether `openPromise` is this settled pass' own, rather than a newer one.
   *
   * `open()`'s `.finally` nulls the field as the pass settles, so at repair time
   * a live open shows up as a promise this pass never produced. Identity is a
   * second signal for a host (or a fixture) that stores the `doOpen` return value
   * verbatim: a promise that has already settled is not an open in flight.
   * @param session - The session the pass ran on.
   * @param pass - The value this pass' own `doOpen` returned.
   * @returns True when nothing is scheduled to publish the opening frame.
   */
  const isStaleOpenPromise = (session: GuardableSession, pass: unknown): boolean => {
    try {
      const promise = session.openPromise
      return promise === null || promise === undefined || promise === pass
    } catch {
      return true
    }
  }

  /**
   * Whether the app has already retired this instance.
   *
   * The main view holds a session by retaining it; when a fast switch aborts the
   * navigation, the retain is released, the scope retires, and the manager drops
   * the instance. That instance is what the phone keeps rendering, and it can
   * never open again — its transport belongs to a connection generation that is
   * gone. The managers map is the only place that says so.
   * @param session - The instance the stranded pass ran on.
   * @param sessionId - The id it was published under.
   * @returns True when the app no longer hands this instance out for that id.
   */
  const isRetired = (session: GuardableSession, sessionId: string): boolean => {
    if (sessionId === UNKNOWN_SESSION_ID) return false
    let service: unknown
    try {
      service = options.sessions()
    } catch {
      return false
    }
    const live = (service as SessionOpenGuardService | undefined)?.manager?.sessions
    if (live === undefined || typeof live.get !== 'function') return false
    try {
      return live.get(sessionId) !== session
    } catch {
      return false
    }
  }

  /** The live sessions the app is holding, when the service has the shape we know. */
  const liveSessions = (): GuardableSession[] => {
    let service: unknown
    try {
      service = options.sessions()
    } catch {
      return []
    }
    const live = (service as SessionOpenGuardService | undefined)?.manager?.sessions
    if (live === undefined || typeof live.values !== 'function') return []
    const found: GuardableSession[] = []
    try {
      for (const session of live.values()) {
        if (session === null || typeof session !== 'object') continue
        found.push(session)
      }
    } catch {
      // A map that throws mid-iteration still yields the sessions it gave.
    }
    return found
  }

  /**
   * Take the phone's own reference to a session that is opening.
   *
   * This is the repair that makes a session switch instant: the app's navigation
   * releases its reference 12-16 ms into the open (measured), and an unheld
   * session is then retired and disposed *while loading*, which is the state the
   * view never leaves. The hold is taken as the pass starts, without waiting for
   * `loading` to be observable, so it is in place before that release. One row is
   * written per session per page load; the sweeps that follow report the
   * hand-back.
   * @param session - The instance entering `loading`.
   * @param sessionId - Its published id.
   */
  const takeHold = (session: GuardableSession, sessionId: string): void => {
    if (sessionId === UNKNOWN_SESSION_ID) return
    const existing = holds.get(sessionId)
    if (existing !== undefined) {
      if (existing.session === session) return
      // The app re-materialised the id; the old instance is not what is opening.
      releaseHold(sessionId, 'replaced')
    }
    let handle: SessionHoldHandle | undefined
    try {
      handle = options.holdSession?.(sessionId)
    } catch {
      handle = undefined
    }
    if (handle === undefined) return
    holds.set(sessionId, { handle, session, startedAt: now() })
  }

  /** Give one held reference back, and say why. */
  const releaseHold = (sessionId: string, reason: string): void => {
    const entry = holds.get(sessionId)
    if (entry === undefined) return
    holds.delete(sessionId)
    try {
      entry.handle.release(reason)
    } catch {
      // The reference is gone either way; the session keeps its own life.
    }
  }

  /**
   * Give each held reference back once the session has opened and the app owns
   * it again.
   *
   * The phone keeps its reference for the whole loading window, even once the
   * app holds one of its own: on the device the app's navigation released its
   * own reference again two seconds into a repaired open (the retention row
   * read `0`), retiring and disposing the very pass this guard had just
   * restarted. "The app holds one" is therefore not "the open is safe". The
   * healthy path hands the reference back on the first sweep after the session
   * leaves `loading`/`cold`, so the phone is never the reason a session stays
   * alive; a session the app dropped — the aborted-navigation case — keeps the
   * phone's reference until {@link SESSION_OPEN_GUARD_HOLD_MAX_MS} has passed,
   * because the view that is already rendering it must finish its open.
   */
  const sweepHolds = (): void => {
    if (holds.size === 0) return
    const live = new Map<string, GuardableSession>()
    for (const session of liveSessions()) live.set(idOf(session), session)
    for (const sessionId of [...holds.keys()]) {
      const entry = holds.get(sessionId)
      if (entry === undefined) continue
      const session = live.get(sessionId)
      if (session === undefined) {
        releaseHold(sessionId, 'gone')
        continue
      }
      if (session !== entry.session) {
        releaseHold(sessionId, 'replaced')
        continue
      }
      // The grace period bounds every hold, including one for a session the
      // app keeps referencing while its open never finishes.
      if (now() - entry.startedAt >= holdMaxMs) {
        releaseHold(sessionId, 'expired')
        continue
      }
      // While the open has not settled one way or the other, the phone is what
      // guarantees the instance stays live; an app reference can vanish again.
      if (isLoading(session) || isCold(session)) continue
      if (!entry.handle.soleHolder()) {
        releaseHold(sessionId, 'app')
        continue
      }
    }
  }

  /**
   * Give a session that settled (open or error) a fresh repair budget. The
   * caps exist to stop a session that cannot open from being repaired in a
   * loop, not to leave a long-lived page naked: a session that opened once
   * must be repairable again when it strands hours later.
   */
  const resetSettledBudgets = (): void => {
    for (const session of liveSessions()) {
      if (isLoading(session) || isCold(session)) continue
      const sessionId = idOf(session)
      if (sessionId === UNKNOWN_SESSION_ID) continue
      repairs.delete(sessionId)
      noFrameRepairs.delete(sessionId)
      reselects.delete(sessionId)
      reselectRefused.delete(sessionId)
      reconnected.delete(sessionId)
      invalidatedByDispose.delete(session)
    }
  }

  /** The first known session the app currently reports as loading. */
  const firstKnownLoading = (): GuardableSession | undefined => {
    for (const session of liveSessions()) {
      if (!known.has(session)) continue
      if (isLoading(session)) return session
    }
    return undefined
  }

  /**
   * Record an invalidation that will strand a loading session.
   *
   * `dispose()` bumps the generation without touching `openState`; `resync()`
   * bumps it and re-opens. Both can run while an open is in flight.
   */
  const diagnose = (by: SessionInvalidator, session: GuardableSession): void => {
    const victim = known.has(session) && isLoading(session) ? session : firstKnownLoading()
    if (victim === undefined) return
    // A mid-open disposal proves the killed pass can never publish: the strand
    // for this instance gets the short gate instead of the full frame window.
    if (by === 'dispose' && victim === session) invalidatedByDispose.add(session)
  }

  /**
   * Ask the app's own navigation to re-open the session — the sidebar's call,
   * which retains a fresh instance on a lifetime signal the app never aborts.
   * @returns whether the app was asked, refused, or the budget/refusal skips it.
   */
  const attemptReselect = (
    sessionId: string,
  ): 'accepted' | 'refused' | 'skipped' => {
    const asked = reselects.get(sessionId) ?? 0
    if (asked >= maxReselects || reselectRefused.has(sessionId)) return 'skipped'
    let reopened = false
    try {
      reopened = options.reopenSession?.(sessionId) === true
    } catch {
      reopened = false
    }
    if (!reopened) {
      // Asked and refused: the app's navigation is not going to move for this
      // session, so asking again would only add a call per strand.
      reselectRefused.add(sessionId)
      return 'refused'
    }
    reselects.set(sessionId, asked + 1)
    loadingSince.set(sessionId, now())
    return 'accepted'
  }

  /**
   * The stale-return strand: the pass settled, the state is still `"loading"`,
   * and no open is scheduled. Repairing means clearing the promise the settled
   * pass already cleared (so `open()` cannot return it) and asking the app to
   * open again on the carrier that is up.
   *
   * One instance cannot be repaired that way at all: the retired one. Its
   * transport belongs to a connection generation that is gone, so every pass on
   * it — including one this guard starts — hangs until something kills it, which
   * is exactly the loop the device showed. For that case the repair is the app's
   * own navigation instead, which retains a current instance for the id.
   *
   * The device also showed the in-place repair failing on instances the app
   * still hands out: the same session stranded on every repaired pass (each new
   * pass was silently invalidated by the app's own navigation) while the
   * instance stayed in the manager map, so `isRetired` never turned true and
   * the escalation never ran — the two in-place repairs were spent on passes
   * that could never finish. Once that budget is gone, the repair therefore
   * escalates to the app's own navigation anyway: it is the sidebar's call,
   * re-retaining a fresh instance on a lifetime signal the app never aborts.
   *
   * Neither repair runs before the open has stood for its gate: a whole
   * opening frame ({@link SESSION_OPEN_GUARD_NO_FRAME_MS}) normally, or the
   * short gate ({@link SESSION_OPEN_GUARD_FAST_RECHECK_MS}) for a live instance
   * whose mid-open disposal was observed — that pass can never publish, so only
   * the app's own healthy re-open (measured 350-1100 ms) needs the grace. A
   * retired instance keeps the full window: its strand is checked against a
   * fresh instance's in-flight open, which deserves the frame it may still be
   * waiting for.
   *
   * When the app's navigation has been asked a few times without the session
   * opening, the guard rebuilds the carrier once — the connection's own
   * `reconnect()` — because the device showed every same-carrier repair fail
   * while a full page reload, which is a fresh carrier, always opened the
   * session.
   */
  const repairStranded = (
    session: GuardableSession,
    sessionId: string,
    pass: unknown,
    startedAt: number,
    resyncedThisPass: boolean,
  ): void => {
    if (resyncedThisPass) return
    if (isRemoved(session)) return
    if (!isLoading(session)) return
    const retired = isRetired(session, sessionId)
    const canReopen = session.open !== undefined
    // A live instance is repaired only when its own pass settled without opening
    // it; a retired one is repaired whenever it is still loading, because the pass
    // it may be waiting on belongs to a dead generation. Either way an open has to
    // be available, or there is nothing to hand the repair to.
    const stranded = isStaleOpenPromise(session, pass) && canReopen
    const spent = repairs.get(sessionId) ?? 0
    // A retired instance escalates immediately; a live one escalates once its
    // in-place repairs are spent, because the device showed those repairs
    // landing on passes the app's navigation kills every time.
    const canReselect = (retired || spent >= maxRepairs) && options.reopenSession !== undefined
    if (!canReselect && !stranded) return
    // A pass settles the moment the app disposes its stream — measured 20-24 ms
    // into a switch — and that settle lands while the opening frame the view is
    // waiting for is still on the wire. Repairing there aborts a frame that is
    // simply still arriving (297 KB, about 1.1 s on the device) and starts the
    // whole open over: the device showed two such repairs inside 340 ms and no
    // history on screen for the wait that followed. The strand is only real once
    // the open has stood for its gate: the full frame window, or the short gate
    // for a live instance whose mid-open disposal was observed — that pass can
    // never publish, so only the app's healthy re-open needs the grace. Until
    // then this looks again.
    const gateMs = !retired && invalidatedByDispose.has(session) ? fastRecheckMs : noFrameMs
    const elapsed = now() - startedAt
    if (elapsed < gateMs) {
      if (strandRechecks.has(sessionId)) return
      strandRechecks.add(sessionId)
      schedule(() => {
        strandRechecks.delete(sessionId)
        try {
          repairStranded(session, sessionId, pass, startedAt, resyncedThisPass)
        } catch {
          // A repair that throws is still better than a broken app.
        }
      }, gateMs - elapsed)
      return
    }
    if (canReselect) {
      const asked = reselects.get(sessionId) ?? 0
      // Every same-carrier repair failed on the device while a full page reload
      // — a fresh carrier — always opened the session. Once the app's own
      // navigation has been asked once without the session opening, rebuild the
      // carrier before asking again; the reconnect resets the connection
      // generation the app's streams are built to resume on.
      if (
        asked >= RECONNECT_AFTER_RESELECTS
        && !reconnected.has(sessionId)
        && options.reconnectCarrier !== undefined
      ) {
        reconnected.add(sessionId)
        try {
          options.reconnectCarrier()
        } catch {
          // The ladder continues without a rebuilt carrier.
        }
        return
      }
      if (attemptReselect(sessionId) === 'accepted') return
      // Asked and refused, or the budget/refusal skips it: the in-place repair
      // below is what is left, and asking again would only add a call per strand.
    }
    if (!stranded) return
    const reopen = session.open
    if (reopen === undefined) return
    if (spent >= maxRepairs) return
    repairs.set(sessionId, spent + 1)
    loadingSince.set(sessionId, now())
    session.openPromise = null
    reopen.call(session)
  }

  /**
   * Wrap one prototype. Re-installs are no-ops: the prototype carries a hidden
   * mark, and the wrapper is shared by every instance the app builds afterwards.
   * @param prototype - The session class' prototype.
   * @returns One when this call wrapped it, zero when it was already wrapped.
   */
  const wrapPrototype = (prototype: object): number => {
    if ((prototype as Record<string, unknown>)[PROTOTYPE_MARK] === true) return 0
    const methods = prototype as { open?: unknown; doOpen?: unknown; dispose?: unknown; resync?: unknown }
    const originalDoOpen = methods.doOpen
    if (typeof originalDoOpen !== 'function') return 0
    const openPass = originalDoOpen as GuardMethod
    const originalOpen = typeof methods.open === 'function' ? (methods.open as GuardMethod) : undefined
    const originalDispose = typeof methods.dispose === 'function' ? (methods.dispose as GuardMethod) : undefined
    const originalResync = typeof methods.resync === 'function' ? (methods.resync as GuardMethod) : undefined

    /** Guards the re-entrant `open()` that `retain()` itself performs. */
    let takingHold = false

    /**
     * The public `open()`: the point at which the reference has to exist.
     *
     * `retain()` starts the open, and the navigation it was retained under can
     * release its reference in the *same synchronous task* — measured 13-18 ms
     * after the pass began, with the phone's hold 15 ms later, because a
     * microtask cannot run inside that task. Taking the hold here, before the
     * pass runs at all, puts it ahead of the release instead of behind it.
     * `retain()` itself calls `open()`, which re-enters this wrapper; the flag
     * makes that re-entry take the original path.
     */
    const wrappedOpen = function (this: GuardableSession, ...args: unknown[]): unknown {
      if (originalOpen === undefined) return undefined
      try {
        const session = this
        const sessionId = idOf(session)
        const held = holds.get(sessionId)
        if (
          !takingHold &&
          sessionId !== UNKNOWN_SESSION_ID &&
          held?.session !== session &&
          session.openState !== 'open' &&
          session.openPromise === null
        ) {
          takingHold = true
          try {
            takeHold(session, sessionId)
          } catch {
            // A hold that cannot be taken leaves the app exactly as it was.
          } finally {
            takingHold = false
          }
        }
      } catch {
        // Observation only: the caller still gets the original result.
      }
      return originalOpen.apply(this, args)
    }

    /**
     * The original pass, observed. The returned value is the original's own, so
     * a caller (and `open()`'s `.finally`) sees exactly what it would have seen.
     */
    const wrappedDoOpen = function (this: GuardableSession, ...args: unknown[]): unknown {
      const result = openPass.apply(this, args)
      try {
        const session = this
        known.add(session)
        const sessionId = idOf(session)
        const startedAt = now()
        loadingSince.set(sessionId, startedAt)
        // Take the phone's reference as the open starts — but a microtask later,
        // because retaining calls `open()` again and `open()` has not yet wired
        // its own `openPromise` during this synchronous frame; taking it here
        // would re-enter `doOpen` and start a second pass.
        void Promise.resolve().then(() => {
          try {
            takeHold(session, sessionId)
          } catch {
            // A hold that cannot be taken leaves the app exactly as it was.
          }
        })
        let settled = false
        let resyncedThisPass = false

        const settle = (): void => {
          settled = true
          try {
            unschedule(timer)
          } catch {
            // A timer that cannot be cleared only costs one no-op callback.
          }
          // After `open()`'s own `.finally`: that is where `openPromise` is
          // cleared, so the strand check has to read the finished state.
          schedule(() => {
            try {
              repairStranded(session, sessionId, result, startedAt, resyncedThisPass)
            } catch {
              // A repair that throws is still better than a broken app.
            }
          }, 0)
        }

        // The opening frame never arrives: ask the app for its own resync, which
        // disposes the stuck stream and opens again on the carrier already up.
        const timer = schedule(() => {
          try {
            if (settled) return
            if (isRemoved(session)) return
            if (!isLoading(session)) return
            if (resyncedThisPass) return
            const spent = noFrameRepairs.get(sessionId) ?? 0
            if (spent >= maxNoFrameRepairs) return
            noFrameRepairs.set(sessionId, spent + 1)
            resyncedThisPass = true
            void session.resync?.()
          } catch {
            // The resync is best-effort; once the repair budget is spent a
            // session that cannot open is left to the app.
          }
        }, noFrameMs)

        void Promise.resolve(result).then(settle, settle)
      } catch {
        // Observation only: the caller still gets the original result.
      }
      return result
    }

    const wrappedDispose = function (this: GuardableSession, ...args: unknown[]): unknown {
      try {
        diagnose('dispose', this)
      } catch {
        // Diagnosis is best-effort; the disposal keeps its own behaviour.
      }
      return originalDispose === undefined ? undefined : originalDispose.apply(this, args)
    }

    const wrappedResync = function (this: GuardableSession, ...args: unknown[]): unknown {
      try {
        diagnose('resync', this)
      } catch {
        // Diagnosis is best-effort; the resync keeps its own behaviour.
      }
      return originalResync === undefined ? undefined : originalResync.apply(this, args)
    }

    try {
      Object.defineProperty(prototype, 'doOpen', {
        value: wrappedDoOpen,
        writable: true,
        configurable: true,
        enumerable: false,
      })
    } catch {
      return 0
    }
    if (originalOpen !== undefined) {
      try {
        Object.defineProperty(prototype, 'open', {
          value: wrappedOpen,
          writable: true,
          configurable: true,
          enumerable: false,
        })
      } catch {
        // The microtask hold in `doOpen` remains as the later net.
      }
    }
    if (originalDispose !== undefined) {
      try {
        Object.defineProperty(prototype, 'dispose', {
          value: wrappedDispose,
          writable: true,
          configurable: true,
          enumerable: false,
        })
      } catch {
        // `doOpen` is the repair; the diagnosis is a bonus.
      }
    }
    if (originalResync !== undefined) {
      try {
        Object.defineProperty(prototype, 'resync', {
          value: wrappedResync,
          writable: true,
          configurable: true,
          enumerable: false,
        })
      } catch {
        // Same: losing the diagnosis does not lose the repair.
      }
    }
    try {
      Object.defineProperty(prototype, PROTOTYPE_MARK, { value: true })
    } catch {
      // The mark only guards against a double install of an already-wrapped class.
    }
    return 1
  }

  /** Look for the sessions service, and wrap the class prototype once it exists. */
  const tryArm = (): number => {
    let wrapped = 0
    for (const session of liveSessions()) {
      known.add(session)
      let prototype: object | null = null
      try {
        prototype = Object.getPrototypeOf(session) as object | null
      } catch {
        prototype = null
      }
      if (prototype === null || typeof prototype !== 'object') continue
      try {
        wrapped += wrapPrototype(prototype)
      } catch {
        // A prototype that refuses the hook is left exactly as it was.
      }
    }
    return wrapped
  }

  let interval: number | undefined
  const stopArming = (): void => {
    if (interval === undefined) return
    try {
      unscheduleInterval(interval)
    } catch {
      // Nothing to stop.
    }
    interval = undefined
  }

  let attempts = 0
  const armTick = (): void => {
    attempts += 1
    let wrapped = 0
    try {
      wrapped = tryArm()
    } catch {
      wrapped = 0
    }
    if (wrapped > 0 || attempts >= armAttempts) stopArming()
  }

  // Immediate first attempt, then the bounded poll: the shell paints before the
  // remembered session opens, so this normally wraps on the first tick.
  interval = scheduleInterval(armTick, armIntervalMs)
  armTick()

  // Holds outlive the arming poll, so their sweep gets its own interval: it runs
  // for as long as this surface is mounted, which is exactly as long as a held
  // reference may exist.
  let sweep: number | undefined
  const stopSweeping = (): void => {
    if (sweep !== undefined) {
      try {
        unscheduleInterval(sweep)
      } catch {
        // Nothing to stop.
      }
      sweep = undefined
    }
    // Never leave a reference behind: a page that is going away must not keep a
    // session open.
    for (const sessionId of [...holds.keys()]) {
      try {
        releaseHold(sessionId, 'stopped')
      } catch {
        // The page is going away; a failed release is the app's to reap.
      }
    }
  }
  sweep = scheduleInterval(() => {
    try {
      sweepHolds()
      resetSettledBudgets()
    } catch {
      // A sweep that throws must not take the app down with it.
    }
  }, armIntervalMs)

  return () => { stopArming(); stopSweeping() }
}
