/**
 * Live-upstream resolution for the mobile access paths.
 *
 * The DSH Desktop app binds its web server on a random loopback port on every
 * launch (`reservePort`), so the plugin's configured `upstreamOrigin`
 * (historically a fixed 127.0.0.1:3080) cannot be trusted to point at the
 * live web server — and 3080 is often occupied by a different, older instance.
 *
 * The authoritative live origin comes from the host `webServer` service the
 * plugin is injected with; `DSH_WEB_URL` (a shell variable the web profile
 * publishes for spawned shells) is the second candidate, and the configured
 * origin is the last-resort fallback. Each candidate is validated as an HTTP
 * loopback origin, so an invalid value can never hijack the remote channel.
 * @module dsh-on-phone/upstream
 */

import { parseUpstream } from './config.js'

/**
 * Resolve the live DSH web upstream. Candidates are tried in order: an
 * explicit live origin (from the host webServer service), the loopback origin
 * carried by `DSH_WEB_URL`, then the configured fallback origin. Invalid
 * candidates are skipped, never thrown.
 */
export function resolveLiveUpstream(fallbackOrigin: string, liveOrigin?: string): URL {
  const candidates: Array<string | undefined> = [liveOrigin, process.env.DSH_WEB_URL]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      try {
        return parseUpstream(candidate)
      } catch {
        // Fall through to the next candidate.
      }
    }
  }
  return parseUpstream(fallbackOrigin)
}
