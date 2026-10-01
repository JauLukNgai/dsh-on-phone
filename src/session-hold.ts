/**
 * Holding a session open while the app is still loading it.
 *
 * The app starts a session's first page inside `sessions.retain(id, {source})`:
 * that call records the reference and *then* awaits `manager.get(id).open()`. The
 * navigation the retain belongs to can be aborted a few milliseconds later, and
 * the app's own navigation code then releases the very reference it just took.
 * When that was the only one, the controller retires the scope and disposes the
 * session -- while the first page is still in flight -- and the view that was
 * rendering it sits on 「载入历史…」 with nothing left to wake it up.
 *
 * The phone therefore takes a reference of its own for exactly that window. It is
 * acquired as the session enters `loading`, and kept until the session has
 * actually left `loading` and the app holds it again (or until the guard's
 * bounded grace period): on the device the app's navigation released its own
 * reference again two seconds into a repaired open, so "the app holds one" does
 * not mean the open is safe. Nothing else is touched: no socket, no reload, no
 * re-navigation.
 * @module dsh-on-phone/session-hold
 */

/** Reference bookkeeping as the app's session controller publishes it. */
export interface SessionRetention {
  referenceCount?: number
  retainedBy?: Record<string, number>
}

/** The part of the app's session controller this module reaches into. */
export interface RetainableSessions {
  retain?: (target: string, options: { source: string }) => unknown
  retentionSnapshot?: (sessionId: string) => SessionRetention | undefined
}

/**
 * The reference source this plugin retains under. It is what the app's own rows
 * show in `retainedBy`, and what {@link hasOtherHolder} excludes.
 */
export const SESSION_RETENTION_SOURCE = 'dsh-on-phone'

/**
 * The phone's reference to one session.
 *
 * `release` is idempotent and never throws: the guard calls it from a sweep that
 * may run after the session is gone.
 */
export interface SessionHoldHandle {
  /** The session id this handle holds. */
  readonly sessionId: string
  /** Whether this plugin's reference is the only one left. */
  soleHolder: () => boolean
  /** Give the reference back, once. */
  release: (reason: string) => void
}

/**
 * The retention row the app publishes for one session, when it publishes one.
 *
 * Exported because it is also what the guard's telemetry reports when a session
 * is invalidated: whether the phone's own reference is in the count at that
 * moment is the difference between "the app retired a held session" and "the
 * hold never landed".
 * @param sessions - The app's `sessions` service, or anything else.
 * @param sessionId - The session to inspect.
 * @returns The published row, or undefined when there is none to read.
 */
export function readRetention(sessions: unknown, sessionId: string): SessionRetention | undefined {
  try {
    return (sessions as RetainableSessions | undefined)?.retentionSnapshot?.(sessionId)
  } catch {
    return undefined
  }
}

/**
 * Whether something other than this plugin still references the session.
 *
 * A controller that does not publish retention rows is treated as if it did --
 * the hold is then given back at the next sweep, exactly as if the app had owned
 * the session all along, which is the safe reading of "no information".
 * @param sessions - The app's `sessions` service, or anything else.
 * @param sessionId - The session to inspect.
 * @returns True when the app, or any other holder, owns a reference.
 */
export function hasOtherHolder(sessions: unknown, sessionId: string): boolean {
  const service = sessions as RetainableSessions | undefined
  if (service === undefined || typeof service.retentionSnapshot !== 'function') return true
  const retention = readRetention(sessions, sessionId)
  if (retention === undefined) return true
  const by = retention.retainedBy ?? {}
  for (const source of Object.keys(by)) {
    if (source === SESSION_RETENTION_SOURCE) continue
    if ((by[source] ?? 0) > 0) return true
  }
  return false
}

/**
 * Take the phone's own reference to a session.
 *
 * Called as the app's `doOpen` starts for the session, which is before the app's
 * aborted navigation can release its own reference. The reference this returns is
 * the caller's to give back; the stream it keeps alive is the app's own.
 * @param sessions - The app's `sessions` service, or anything else.
 * @param sessionId - The session to hold.
 * @returns The handle, or undefined when the service cannot retain it.
 */
export function holdSessionOpen(sessions: unknown, sessionId: string): SessionHoldHandle | undefined {
  if (sessionId === '') return undefined
  const service = sessions as RetainableSessions | undefined
  if (service === undefined || typeof service.retain !== 'function') return undefined
  let reference: { release?: () => void; ready?: Promise<unknown> } | undefined
  try {
    reference = service.retain(sessionId, { source: SESSION_RETENTION_SOURCE }) as typeof reference
  } catch {
    // An unknown id, or a controller that is already disposed: nothing to hold.
    return undefined
  }
  if (reference === undefined) return undefined
  // Nothing here awaits the reference's readiness, and an abandoned open makes it
  // reject; keep that from surfacing as an unhandled rejection.
  try {
    void reference.ready?.catch(() => undefined)
  } catch {
    // A reference without a usable `ready` is still a usable reference.
  }
  let released = false
  return {
    sessionId,
    soleHolder: (): boolean => !released && !hasOtherHolder(sessions, sessionId),
    release: (): void => {
      if (released) return
      released = true
      try {
        reference?.release?.()
      } catch {
        // The session is already gone; the reference is not ours to lose.
      }
    },
  }
}
