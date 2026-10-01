import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  installSessionOpenGuard,
  SESSION_OPEN_GUARD_FAST_RECHECK_MS,
  SESSION_OPEN_GUARD_HOLD_MAX_MS,
  SESSION_OPEN_GUARD_NO_FRAME_MS,
} from '../src/session-open-guard.js'

/**
 * The app's session class, as far as the guard meets it: `open()` caches the
 * pass in `openPromise` and clears it in its own `.finally`, which is exactly
 * what makes the strand permanent.
 */
class FakeSession {
  sessionId: string
  openState: unknown = 'cold'
  openPromise: unknown = null
  removed = false
  address: { mode?: unknown } | undefined = { mode: 'direct' }
  opens = 0
  resyncs = 0
  disposals = 0
  /** Reproduce the app's stale return: settle without ever publishing `open`. */
  stranded = false
  /** Reproduce a first frame that never arrives: never settle the pass. */
  pending = false
  /** Reproduce the device's order: the pass settles only after the dispose lands. */
  deferredStrand = false
  release: (() => void) | undefined

  constructor(sessionId: string) {
    this.sessionId = sessionId
  }

  open(): Promise<void> {
    this.opens += 1
    if (this.openState === 'open') return Promise.resolve()
    if (this.openPromise !== null) return this.openPromise as Promise<void>
    const promise = this.doOpen().finally(() => {
      if (this.openPromise === promise) this.openPromise = null
    })
    this.openPromise = promise
    return promise
  }

  async doOpen(): Promise<void> {
    this.openState = 'loading'
    if (this.pending) await new Promise<void>((resolve) => { this.release = resolve })
    if (this.deferredStrand) await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    if (this.stranded) return
    this.openState = 'open'
  }

  async resync(): Promise<void> {
    this.resyncs += 1
    this.openState = 'cold'
    this.openPromise = null
    await this.open()
  }

  async dispose(): Promise<void> {
    this.disposals += 1
  }
}

interface Harness {
  readonly session: FakeSession
  readonly service: () => unknown
  readonly stop: () => void
  /** The manager's id-to-instance map, as the app hands it out and drops from it. */
  readonly live: Map<string, FakeSession>
  /** The session ids the guard asked the app's navigation to re-open. */
  readonly asked: string[]
  /** The session ids the phone took a reference to. */
  readonly holds: string[]
  /** Why each held reference was given back, in order. */
  readonly handbacks: string[]
  /** The session ids the guard rebuilt the carrier for. */
  readonly reconnects: string[]
}

/**
 * A fresh subclass per harness: the guard marks and wraps one prototype per
 * page load, so tests must not share it (a mark from an earlier test would
 * leave that test's wrappers in charge).
 */
function newSession(id = 'session-1'): FakeSession {
  const Fresh = class extends FakeSession {}
  return new Fresh(id)
}

interface HarnessOptions {
  /** Whether the app's navigation accepts the re-open; it always gets asked. */
  reopenAccepted?: boolean
  maxReselects?: number
  /** Whether this harness lends the guard a session-holding callback. */
  hold?: boolean
  /** Whether the phone ends up as the only holder, as the device's strand does. */
  soleHolder?: () => boolean
  /** Called when the guard rebuilds the carrier; records the id into `reconnects`. */
  reconnect?: () => void
  /** An accepted re-open also re-runs the session's open, like the app's navigation. */
  reopenReruns?: boolean
}

function harness(
  shape: 'session' | 'empty' | 'array' | 'none' = 'session',
  held?: FakeSession,
  options: HarnessOptions = {},
): Harness {
  const session = held ?? newSession()
  const asked: string[] = []
  const holds: string[] = []
  const handbacks: string[] = []
  const reconnects: string[] = []
  const holding = new Set<string>()
  const live = new Map<string, FakeSession>([[session.sessionId, session]])
  const service = (): unknown => {
    if (shape === 'session') return { manager: { sessions: live } }
    if (shape === 'empty') return { manager: { sessions: new Map() } }
    if (shape === 'array') return { manager: { sessions: [] } }
    return undefined
  }
  const stop = installSessionOpenGuard({
    sessions: service,
    reopenSession: (sessionId) => {
      asked.push(sessionId)
      if (options.reopenReruns === true) void session.open()
      return options.reopenAccepted ?? true
    },
    ...(options.reconnect === undefined
      ? {}
      : {
          reconnectCarrier: () => {
            reconnects.push(session.sessionId)
            options.reconnect?.()
          },
        }),
    ...(options.hold === true
      ? {
          holdSession: (sessionId: string) => {
            holds.push(sessionId)
            holding.add(sessionId)
            return {
              sessionId,
              soleHolder: () => options.soleHolder?.() ?? false,
              release: (reason: string): void => {
                if (!holding.delete(sessionId)) return
                handbacks.push(reason)
              },
            }
          },
        }
      : {}),
    ...(options.maxReselects === undefined ? {} : { maxReselects: options.maxReselects }),
  })
  return { session, service, stop, live, asked, holds, handbacks, reconnects }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('installSessionOpenGuard', () => {
  /**
   * A strand is only repaired once the open has stood for a whole opening frame:
   * what settles a pass earlier than that is the app disposing its own stream on
   * the way to the next one, which the device measured 20-24 ms into a switch.
   */
  const settleGrace = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(SESSION_OPEN_GUARD_NO_FRAME_MS)
  }

  it('leaves a healthy open alone', async () => {
    const { session, stop } = harness()
    await session.open()
    await vi.advanceTimersByTimeAsync(50)
    expect(session.openState).toBe('open')
    expect(session.opens).toBe(1)
    stop()
  })

  it('opens a session again when the app let the pass go stale', async () => {
    const { session, stop } = harness()
    session.stranded = true
    const pass = session.open()
    // The app's own `open()` settled without publishing anything: repair it.
    session.stranded = false
    await pass
    await settleGrace()
    expect(session.openPromise).toBe(null)
    expect(session.opens).toBe(2)
    expect(session.openState).toBe('open')
    stop()
  })

  it('waits out the opening frame before it calls a settled pass stranded', async () => {
    const { session, stop } = harness()
    session.stranded = true
    await session.open()
    // The app disposes its own stream on the way to the next one, so the pass
    // settles long before the first frame could have landed: not a strand yet.
    await vi.advanceTimersByTimeAsync(SESSION_OPEN_GUARD_NO_FRAME_MS - 1)
    expect(session.opens).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(session.opens).toBe(2)
    stop()
  })

  it('escalates to the app\'s own navigation once the in-place repairs are spent', async () => {
    const { session, asked, stop } = harness()
    session.stranded = true
    await session.open()
    await settleGrace()
    await settleGrace()
    await settleGrace()
    // Two in-place rounds, then the app's own navigation.
    expect(session.opens).toBe(3)
    expect(asked).toEqual(['session-1'])
    stop()
  })

  it('gives up after the in-place cap when the app refuses to re-open the session', async () => {
    const { session, asked, stop } = harness('session', undefined, { reopenAccepted: false })
    session.stranded = true
    await session.open()
    await settleGrace()
    await settleGrace()
    await settleGrace()
    // Asked once, refused, and not asked again; the spent in-place budget then
    // leaves the session alone instead of reopening in a loop.
    expect(asked).toEqual(['session-1'])
    expect(session.opens).toBe(3)
    await settleGrace()
    await settleGrace()
    expect(session.opens).toBe(3)
    stop()
  })

  it('never repairs a session the app has removed', async () => {
    const { session, stop } = harness()
    session.removed = true
    session.stranded = true
    await session.open()
    await vi.advanceTimersByTimeAsync(50)
    expect(session.opens).toBe(1)
    stop()
  })

  it('asks the app for its own resync when the first frame never arrives', async () => {
    const { session, stop } = harness()
    session.pending = true
    void session.open()
    await vi.advanceTimersByTimeAsync(SESSION_OPEN_GUARD_NO_FRAME_MS)
    expect(session.resyncs).toBe(1)
    // The retry is capped per session and page load, whatever the state after.
    await vi.advanceTimersByTimeAsync(SESSION_OPEN_GUARD_NO_FRAME_MS * 10)
    expect(session.resyncs).toBe(2)
    session.pending = false
    session.release?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(session.openState).toBe('open')
    stop()
  })

  it('leaves the app\'s own dispose untouched while it watches for mid-open kills', async () => {
    const { session, stop } = harness()
    session.stranded = true
    session.deferredStrand = true
    void session.open()
    await session.dispose()
    expect(session.disposals).toBe(1)
    stop()
  })

  it('repairs a live instance invalidated mid-open at the short gate', async () => {
    const { session, stop } = harness()
    session.stranded = true
    session.deferredStrand = true
    void session.open()
    // The device's order: the app disposes the pass while it is still in flight,
    // and only then does the pass settle into the strand.
    await session.dispose()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(SESSION_OPEN_GUARD_FAST_RECHECK_MS)
    // The observed disposal proves the pass can never publish, so the repair
    // fires at the short gate instead of the full four-second window.
    expect(session.opens).toBe(2)
    stop()
  })

  it('rebuilds the carrier once the app\'s navigation has been asked without success', async () => {
    const { session, asked, reconnects, stop } = harness('session', undefined, { reconnect: () => undefined, reopenReruns: true })
    session.stranded = true
    session.deferredStrand = true
    void session.open()
    await session.dispose()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(SESSION_OPEN_GUARD_FAST_RECHECK_MS)   // in-place #1
    await vi.advanceTimersByTimeAsync(SESSION_OPEN_GUARD_FAST_RECHECK_MS)   // in-place #2
    await vi.advanceTimersByTimeAsync(SESSION_OPEN_GUARD_FAST_RECHECK_MS)   // reselect #1
    expect(asked).toEqual(['session-1'])
    expect(reconnects).toEqual([])
    await vi.advanceTimersByTimeAsync(SESSION_OPEN_GUARD_FAST_RECHECK_MS)   // carrier rebuild
    expect(reconnects).toEqual(['session-1'])
    // The rebuild is once per session per page load.
    await vi.advanceTimersByTimeAsync(SESSION_OPEN_GUARD_FAST_RECHECK_MS)
    expect(reconnects).toEqual(['session-1'])
    stop()
  })

  it('gives a settled session a fresh repair budget', async () => {
    const { session, stop } = harness()
    session.stranded = true
    await session.open()
    await settleGrace()
    await settleGrace()
    expect(session.opens).toBe(3)
    session.stranded = false
    await session.open()
    await vi.advanceTimersByTimeAsync(250)
    // A later strand starts from a fresh budget instead of staying silent.
    session.openState = 'loading'
    session.openPromise = null
    session.stranded = true
    void session.open()
    await settleGrace()
    expect(session.opens).toBe(6)
    stop()
  })

  it('asks the app to re-open a session whose instance it has already retired', async () => {
    const { session, live, asked, stop } = harness()
    // The main view's navigation was aborted: the retain was released, the scope
    // retired, and the manager dropped the instance the phone is still rendering.
    session.stranded = true
    live.delete(session.sessionId)
    await session.open()
    await settleGrace()
    expect(asked).toEqual(['session-1'])
    // The orphan itself is left alone: opening it again only waits on a carrier
    // that is gone, which is the loop the device sat in for thirty seconds.
    expect(session.opens).toBe(1)
    stop()
  })

  it('repairs the retired instance in place when the app refuses to re-open it', async () => {
    const { session, live, asked, stop } = harness('session', undefined, { reopenAccepted: false })
    session.stranded = true
    live.delete(session.sessionId)
    await session.open()
    await settleGrace()
    await settleGrace()
    // Asked once, refused, and not asked again; the in-place repair takes over
    // and spends its own budget.
    expect(asked).toEqual(['session-1'])
    expect(session.opens).toBe(3)
    stop()
  })

  it('re-opens a retired session from the app only up to its own cap', async () => {
    const { session, live, asked, stop } = harness('session', undefined, { maxReselects: 1 })
    session.stranded = true
    live.delete(session.sessionId)
    await session.open()
    await settleGrace()
    // Budget spent, so the next strand falls back to the in-place repair.
    await session.open()
    await settleGrace()
    await settleGrace()
    expect(asked).toEqual(['session-1'])
    expect(session.opens).toBe(4)
    stop()
  })

  it('wraps a prototype once, whatever the number of installs', async () => {
    const { session, stop } = harness()
    // The same session, and so the same already-wrapped prototype.
    const second = harness('session', session)
    session.stranded = true
    await session.open()
    await settleGrace()
    // One repair chain, not two stacked wrappers each repairing the strand.
    expect(session.opens).toBe(2)
    expect(second.asked).toEqual([])
    stop()
    second.stop()
  })

  it('stays quiet, and returns a working stop, for a service of another shape', async () => {
    for (const shape of ['empty', 'array', 'none'] as const) {
      const { session, stop } = harness(shape)
      session.stranded = true
      await session.open()
      await vi.advanceTimersByTimeAsync(50)
      expect(session.opens).toBe(1)
      expect(() => stop()).not.toThrow()
    }
  })

  it('holds its own reference while a session opens, and hands it back once it is open and the app owns it', async () => {
    const { session, stop, holds, handbacks } = harness('session', undefined, { hold: true })
    session.pending = true
    void session.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(holds).toEqual(['session-1'])
    // The first frame lands and the app takes the session back: no reason left
    // for the phone to keep it alive.
    session.release?.()
    await vi.advanceTimersByTimeAsync(250)
    expect(handbacks).toEqual(['app'])
    stop()
  })

  it('keeps its reference while the session is still loading, even when the app already holds one', async () => {
    const { session, stop, holds, handbacks } = harness('session', undefined, { hold: true })
    session.pending = true
    void session.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(holds).toEqual(['session-1'])
    // The app holds its own reference (soleHolder is false), but the open has
    // not finished. The device showed the app releasing that reference again
    // two seconds into a repaired open, so the phone keeps its hold.
    await vi.advanceTimersByTimeAsync(SESSION_OPEN_GUARD_NO_FRAME_MS * 3)
    expect(handbacks).toEqual([])
    // The first frame lands; only the next sweep hands the reference back.
    session.release?.()
    await vi.advanceTimersByTimeAsync(250)
    expect(handbacks).toEqual(['app'])
    stop()
  })

  it('keeps its reference through a repaired open, handing back only after it succeeds', async () => {
    const { session, stop, handbacks } = harness('session', undefined, { hold: true })
    session.stranded = true
    await session.open()
    await settleGrace()
    // The repaired pass is in flight and the app holds its own reference; the
    // phone's must outlive it, because the app can let go again mid-open.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(handbacks).toEqual([])
    expect(session.opens).toBe(2)
    // The repaired pass publishes `open`; only now does the sweep hand back.
    session.stranded = false
    await settleGrace()
    await vi.advanceTimersByTimeAsync(250)
    expect(handbacks).toEqual(['app'])
    stop()
  })

  it('bounds a loading hold with the grace period even when the app keeps referencing the session', async () => {
    const { session, stop, holds, handbacks } = harness('session', undefined, { hold: true })
    session.pending = true
    void session.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(holds).toEqual(['session-1'])
    await vi.advanceTimersByTimeAsync(SESSION_OPEN_GUARD_HOLD_MAX_MS)
    expect(handbacks).toEqual(['expired'])
    expect(holds).toEqual(['session-1'])
    stop()
  })

  it('takes its reference synchronously, inside the `open()` call itself', () => {
    // The app's release happens in the same synchronous task as the open, so a
    // microtask is already too late: no timer, no await here on purpose.
    const { session, holds, stop } = harness('session', undefined, { hold: true })
    void session.open()
    expect(holds).toEqual(['session-1'])
    stop()
  })

  it('takes its reference as the open starts, before `loading` is even visible', async () => {
    // The device releases its own reference 12-16 ms into the open. A hold that
    // waited for `openState === 'loading'` to be observable missed that window,
    // so the guard takes it from the pass itself.
    const Deferred = class extends FakeSession {
      override async doOpen(): Promise<void> {
        await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
        this.openState = 'open'
      }
    }
    const session = new Deferred('session-1')
    const { holds, stop } = harness('session', session, { hold: true })
    void session.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(holds).toEqual(['session-1'])
    stop()
  })

  it('keeps the session alive when the app dropped it, then lets go of the hold', async () => {
    const { session, stop, holds, handbacks } = harness('session', undefined, {
      hold: true,
      soleHolder: () => true,
    })
    session.pending = true
    void session.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(holds).toEqual(['session-1'])
    // The app's navigation was aborted and released the only reference it had:
    // the phone is now what keeps the session from being retired mid-open.
    await vi.advanceTimersByTimeAsync(SESSION_OPEN_GUARD_HOLD_MAX_MS - 250)
    expect(handbacks).toEqual([])
    // The hold is not repeated for the same session and page load: it is given
    // back once, at the end of its grace period.
    await vi.advanceTimersByTimeAsync(SESSION_OPEN_GUARD_HOLD_MAX_MS)
    expect(holds).toEqual(['session-1'])
    expect(handbacks).toEqual(['expired'])
    stop()
  })

  it('gives the hold back when the instance it was taken on is dropped', async () => {
    const { session, live, stop, holds, handbacks } = harness('session', undefined, {
      hold: true,
      soleHolder: () => true,
    })
    session.pending = true
    void session.open()
    await vi.advanceTimersByTimeAsync(0)
    live.delete(session.sessionId)
    await vi.advanceTimersByTimeAsync(250)
    expect(holds).toEqual(['session-1'])
    expect(handbacks).toEqual(['gone'])
    stop()
  })

  it('gives every hold back when the surface is stopped', async () => {
    const { session, stop, holds, handbacks } = harness('session', undefined, {
      hold: true,
      soleHolder: () => true,
    })
    session.pending = true
    void session.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(holds).toEqual(['session-1'])
    stop()
    expect(handbacks).toEqual(['stopped'])
    // Nothing is released twice.
    await vi.advanceTimersByTimeAsync(SESSION_OPEN_GUARD_HOLD_MAX_MS * 2)
    expect(handbacks).toEqual(['stopped'])
  })

  it('survives a sessions service that throws when read', async () => {
    const stop = installSessionOpenGuard({
      sessions: () => { throw new Error('service is half built') },
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(() => stop()).not.toThrow()
  })
})
