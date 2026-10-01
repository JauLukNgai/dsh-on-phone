/**
 * Ask the app to re-open a session in its main view.
 *
 * Reading the desktop bundle: the main view holds a session by *retaining* it
 * (`sessions.retain(target, { source: "mainView" })`), and a session that is no
 * longer retained is dropped from the manager and disposed. `Session.dispose()`
 * bumps the open generation without touching `openState`, so an instance the
 * phone is still rendering can stay at `"loading"` — the 「载入历史…」 hint —
 * forever, on a carrier that no longer carries it. Repairing that instance from
 * the outside is a dead end: it is no longer the instance the app hands out for
 * that id.
 *
 * The app has its own entry for this: `uiWorkspace.openSession(target)`, which is
 * what the sidebar calls when a session row is tapped. It re-retains the session
 * (a fresh instance for the current connection generation), updates the
 * selection, and releases the previous reference — all on the workspace's
 * lifetime signal, which is never aborted mid-navigation. That abort is what
 * strands a phone that switches sessions quickly.
 */

/**
 * The app's workspace navigation service, as far as this module reaches into it.
 */
export interface ReselectableWorkspace {
  openSession?: (target: string) => unknown
}

/**
 * Re-open `sessionId` in the app's main view, through the app's own navigation.
 *
 * Every step is defensive: the service is read through a plain property, the
 * call is wrapped, and a throw is reported as a refusal rather than raised into
 * the watchdog that asked for the repair.
 * @param workspace - The app's `uiWorkspace` service, whatever the plugin found.
 * @param sessionId - The session to bring back to the main view.
 * @returns True when the app was asked, false when it could not be.
 */
export function reselectSession(workspace: unknown, sessionId: string): boolean {
  if (sessionId.length === 0) return false
  if (workspace === null || typeof workspace !== 'object') return false
  let openSession: unknown
  try {
    openSession = (workspace as ReselectableWorkspace).openSession
  } catch {
    return false
  }
  if (typeof openSession !== 'function') return false
  try {
    ;(openSession as (target: string) => unknown).call(workspace, sessionId)
    return true
  } catch {
    return false
  }
}
