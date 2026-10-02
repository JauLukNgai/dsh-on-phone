/**
 * Tailscale Serve remote transport: exposes the configured upstream over the
 * machine's own Tailscale node as a private tailnet HTTPS origin
 * (`https://<hostname>.<tailnet>.ts.net`). No Funnel (nothing is public), no
 * pairing gateway (tailnet membership is the access control) — a phone with
 * Tailscale on the same tailnet just opens the origin. This is the connection
 * method of the DSH Remote project, adapted to the dsh-on-phone plugin surface.
 *
 * The serve targets the plugin's {@link RemotePassthroughProxy} loopback
 * listener rather than the DSH web server directly: the proxy rewrites
 * Host/Origin to the live upstream (resolved from `DSH_WEB_URL` per request),
 * which both bypasses the DSH browser-trust fence and follows the web server
 * across desktop/CLI restarts without manual re-pointing. Starting also
 * recovers the common stale-config failure where port 443 is already serving a
 * TCP forward (or another entry) by clearing it when safe and retrying once.
 * Teardown and a running watchdog both compare the node's registered handler
 * against this controller's own origin, so an entry this controller never
 * created is never cleared and one that vanished is restored.
 * @module dsh-on-phone/tailscale-serve
 */

import { execFile, type ExecFileOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import type { MobileAccessControlStore } from './control.js'
import type { RemotePassthroughProxy } from './remote-proxy.js'

/** Status of the Tailscale Serve remote transport, matching the Funnel shape. */
export interface TailscaleServeStatus {
  readonly enabled: boolean
  readonly state: 'off' | 'starting' | 'ready' | 'unavailable' | 'error'
  readonly origin?: string
  readonly loginUrl?: string
  readonly setupUrl?: string
  readonly errorCode?: string
}

/** Construction inputs for one Tailscale Serve lifecycle. */
export interface TailscaleServeControllerOptions {
  /** Persisted on/off switch shared with the desktop control card. */
  readonly store: MobileAccessControlStore
  /** Loopback proxy exposing the live DSH web upstream behind the serve origin. */
  readonly proxy: RemotePassthroughProxy
  /**
   * tailscale CLI binary name or absolute path; defaults to PATH resolution.
   *
   * A string is one executable; an array is an executable plus the arguments it
   * is always spawned with. The array form exists for a platform whose CLI is
   * not a native executable — a Windows `.cmd` shim, or a script that has to be
   * run through an interpreter — so it can still be driven through `execFile`
   * without a shell.
   */
  readonly bin?: string | readonly string[]
  readonly onStatus?: (status: TailscaleServeStatus) => void
}

/** Environment escape hatch for a Tailscale install in an unusual location. */
const TAILSCALE_BIN_ENV = 'DSH_ON_PHONE_TAILSCALE_BIN'
/** Pre-rename spelling, still accepted so an existing profile keeps working. */
const TAILSCALE_BIN_ENV_LEGACY = 'DSH_MOBILE_TAILSCALE_BIN'

/** Read the node's serve configuration. Shared by teardown and the watchdog. */
const SERVE_STATUS_ARGS = ['serve', 'status', '--json'] as const

/**
 * Cadence of the serve watchdog. The port-443 entry can disappear without this
 * plugin acting: the Tailscale daemon drops the config when the node
 * re-authenticates, and a second controller for the same loopback port can run
 * `serve --https=443 off` *after* a newer one registered (the reload race).
 * Neither path changes the persisted switch, so the panel keeps reporting
 * `ready` while every phone request gets connection-refused.
 */
const SERVE_WATCHDOG_INTERVAL_MS = 60_000

/** First watchdog pass, short enough to heal a reload race before anyone notices. */
const SERVE_WATCHDOG_FIRST_MS = 5_000

function publicStatus(status: TailscaleServeStatus): TailscaleServeStatus {
  return Object.freeze({
    enabled: status.enabled,
    state: status.state,
    ...(status.origin === undefined ? {} : { origin: status.origin }),
    ...(status.errorCode === undefined ? {} : { errorCode: status.errorCode }),
  })
}

/** Trailing-slash-insensitive form of a serve origin, for entry comparison. */
export function normalizeServeOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/u, '')
}

/**
 * Whether the node's serve configuration forwards `/` to `target`.
 *
 * `tailscale serve status --json` reports handlers under
 * `Web["<host>:443"].Handlers["/"].Proxy`, so the typed shape is not needed
 * here — only the one string that decides whether a teardown would clear our
 * own entry or an unrelated 443 entry the user configured themselves.
 * @param status - Parsed `tailscale serve status --json`, or anything else.
 * @param target - Loopback origin this controller registered.
 * @returns True when some entry proxies `/` to exactly that origin.
 */
export function serveEntryTargetsProxy(status: unknown, target: string): boolean {
  const web = (status as { Web?: unknown } | null | undefined)?.Web
  if (web === null || typeof web !== 'object') return false
  const wanted = normalizeServeOrigin(target)
  for (const entry of Object.values(web as Record<string, unknown>)) {
    const handlers = (entry as { Handlers?: unknown } | null | undefined)?.Handlers
    if (handlers === null || typeof handlers !== 'object') continue
    const root = (handlers as Record<string, unknown>)['/']
    const proxy = (root as { Proxy?: unknown } | null | undefined)?.Proxy
    if (typeof proxy === 'string' && normalizeServeOrigin(proxy) === wanted) return true
  }
  return false
}

/**
 * Absolute locations the Tailscale CLI is installed to, by platform.
 *
 * This matters most on macOS. Installing the Tailscale app does put a CLI shim
 * in `/usr/local/bin` (or the binary inside the bundle), but a GUI application
 * is launched by launchd and therefore inherits the minimal
 * `/usr/bin:/bin:/usr/sbin:/sbin` PATH. A bare `tailscale` lookup spawns
 * nothing, fails with ENOENT, and the desktop card reports "Tailscale is not
 * installed" on a machine where it plainly is.
 */
export function tailscaleBinaryCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string[] {
  // Joined with the target platform's own rules, not the host's: this function
  // is parameterised by platform so a single test run can cover every install
  // layout, and a Windows path assembled with posix join is not a Windows path.
  const join = platform === 'win32' ? win32.join : posix.join
  if (platform === 'win32') {
    const candidates = [join(env.ProgramFiles ?? 'C:\\Program Files', 'Tailscale', 'tailscale.exe')]
    if (env['ProgramFiles(x86)'] !== undefined) candidates.push(join(env['ProgramFiles(x86)'], 'Tailscale', 'tailscale.exe'))
    if (env.LOCALAPPDATA !== undefined) candidates.push(join(env.LOCALAPPDATA, 'Tailscale', 'tailscale.exe'))
    return candidates
  }
  if (platform === 'darwin') {
    return [
      '/usr/local/bin/tailscale',
      '/opt/homebrew/bin/tailscale',
      '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
      join(home, 'Applications', 'Tailscale.app', 'Contents', 'MacOS', 'Tailscale'),
    ]
  }
  return ['/usr/bin/tailscale', '/usr/sbin/tailscale', '/usr/local/bin/tailscale', '/snap/bin/tailscale']
}

/**
 * Resolve the Tailscale CLI to something a GUI-launched host can actually run.
 *
 * An explicit override wins, then the well-known install locations, and PATH
 * resolution is left as the last resort so a terminal-launched host keeps its
 * existing behaviour. Falling through to the bare name preserves the
 * `tailscale_missing` diagnostic when nothing is installed.
 */
export function resolveTailscaleBinary(options: {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  home: string
  exists: (path: string) => boolean
}): string {
  const override = (options.env[TAILSCALE_BIN_ENV] ?? options.env[TAILSCALE_BIN_ENV_LEGACY])?.trim()
  if (override !== undefined && override !== '') return override
  for (const candidate of tailscaleBinaryCandidates(options.platform, options.env, options.home)) {
    if (options.exists(candidate)) return candidate
  }
  return 'tailscale'
}

/**
 * A Serve failure whose diagnostic code is already known.
 *
 * The port-443 recovery path raises both of its errors itself, and their text
 * ("…is occupied by another service") matched none of the message patterns
 * below, so the panel reported the generic `serve_failed` instead of
 * `serve_port_conflict`. Carrying the code explicitly keeps the classification
 * from depending on wording.
 */
class ServeDiagnosticError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ServeDiagnosticError'
  }
}

/** Whether a failed `tailscale serve` invocation is the port-443 occupancy failure. */
function isServePortConflict(error: unknown): boolean {
  if (error instanceof ServeDiagnosticError) return error.code === 'serve_port_conflict'
  const message = error instanceof Error ? error.message : String(error)
  return /already serving|already in use|cannot serve|port .*?(?:busy|conflict|in use)/i.test(message)
}

/** Classify a failed `tailscale` invocation into a stable diagnostic code. */
function classifyServeError(error: unknown): string {
  if (error instanceof ServeDiagnosticError) return error.code
  const message = error instanceof Error ? error.message : String(error)
  if (/not logged in|logged out|login required|no node key/i.test(message)) return 'tailscale_not_logged_in'
  if (/funnel/i.test(message)) return 'funnel_unavailable'
  if (/EACCES|EPERM/i.test(message)) return 'permission_denied'
  if (/ENOENT/i.test(message)) return 'tailscale_missing'
  if (isServePortConflict(error)) return 'serve_port_conflict'
  return 'serve_failed'
}

/**
 * Owns the `tailscale serve` process, the machine's MagicDNS origin, the
 * loopback passthrough proxy, and the persisted remote switch. Enabling starts
 * the proxy, runs `tailscale serve --bg --https=443 <proxy origin>` and
 * reports the resolved `https://<hostname>.<tailnet>.ts.net`; disabling runs
 * `tailscale serve --https=443 off` and stops the proxy.
 */
export class TailscaleServeController {
  private enabled = false
  private initialized = false
  private disposed = false
  private latest: TailscaleServeStatus = Object.freeze({ enabled: false, state: 'off' })
  private queue: Promise<void> = Promise.resolve()
  /** Loopback origin the 443 entry is expected to point at while enabled. */
  private serveTarget: string | undefined
  /** Watchdog handles; unref'd so they never hold the host process open. */
  private watchdogTimers: NodeJS.Timeout[] = []
  constructor(private readonly options: TailscaleServeControllerOptions) {}

  /** Restore the remote switch without coupling it to LAN availability. */
  async initialize(): Promise<void> {
    const state = await this.options.store.load()
    this.enabled = state.enabled
    this.initialized = true
    if (this.enabled) await this.start()
      else {
        // A disabled switch means this plugin does not own `serve`, not that
        // `serve` should be cleared. `tailscale serve --https=443 off` is a
        // node-global side effect that would tear down an unrelated 443 entry
        // the user configured themselves, on every boot, because a fresh
        // install persists `enabled: false`. There is nothing of ours to stop
        // here either: nothing was started, so the proxy is already closed.
        await this.closeProxy()
        this.publish({ enabled: false, state: 'off' })
      }
  }

  /** Return state safe for the local desktop control UI. */
  status(): TailscaleServeStatus {
    return this.latest
  }

  /** Enable or disable Tailscale Serve without changing the LAN listener. */
  async setEnabled(enabled: boolean): Promise<TailscaleServeStatus> {
    if (!this.initialized || this.disposed) throw new Error('Tailscale Serve controller is unavailable')
    await this.enqueue(async () => {
      if (this.enabled === enabled) return
      this.enabled = enabled
      await this.options.store.save({ version: 1, enabled })
      if (enabled) await this.start()
      else {
        await this.stopServe()
        this.publish({ enabled: false, state: 'off' })
      }
    })
    return this.status()
  }

  /** Restart a failed or interrupted Serve session while retaining the switch. */
  async reconnect(): Promise<TailscaleServeStatus> {
    if (!this.initialized || this.disposed) throw new Error('Tailscale Serve controller is unavailable')
    await this.enqueue(async () => {
      if (!this.enabled) {
        this.enabled = true
        await this.options.store.save({ version: 1, enabled: true })
      }
      await this.stopServe()
      await this.start()
    })
    return this.status()
  }

  /** Disable Serve; the tailnet origin is a property of the Tailscale node, so there is no private state to clear. */
  async reset(): Promise<TailscaleServeStatus> {
    if (!this.initialized || this.disposed) throw new Error('Tailscale Serve controller is unavailable')
    await this.enqueue(async () => {
      await this.stopServe()
      this.enabled = false
      await this.options.store.save({ version: 1, enabled: false })
      this.publish({ enabled: false, state: 'off' })
    })
    return this.status()
  }

  /** No gateway: the serve exposes the upstream (DSH web) directly. */
  gateway(): undefined {
    return undefined
  }

  /**
   * Re-register the port-443 entry when it no longer points at this
   * controller's proxy. Called by the watchdog, and safe to call directly: a
   * healthy entry is left untouched and an unrelated 443 entry is never
   * modified, only replaced once this controller owns it.
   */
  async reconcile(): Promise<void> {
    if (this.disposed || !this.enabled) return
    const target = this.serveTarget
    if (target === undefined) return
    const status = await this.readServeEntries()
    if (status !== undefined && serveEntryTargetsProxy(status, target)) return
    try {
      await this.enqueue(() => this.applyServe(target))
    } catch {
      // A pass that cannot re-register retries on the next tick; the published
      // status keeps the last known state instead of flapping to an error.
    }
  }

  async close(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.enqueue(() => this.stopServe())
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const task = this.queue.then(operation, operation)
    this.queue = task.then(() => undefined, () => undefined)
    return task
  }

  private publish(status: TailscaleServeStatus): void {
    this.latest = publicStatus(status)
    try {
      this.options.onStatus?.(this.latest)
    } catch {
      // A status listener must not break the controller.
    }
  }

  private bin(): readonly string[] {
    // Resolved per invocation, not once at construction: a host that resolves it
    // on first use keeps working when the user installs Tailscale after starting
    // DSH, instead of reporting tailscale_missing until the next restart.
    const configured = this.options.bin
    if (configured !== undefined) return typeof configured === 'string' ? [configured] : configured
    return [resolveTailscaleBinary({ platform: process.platform, env: process.env, home: homedir(), exists: existsSync })]
  }

  /**
   * Run one tailscale subcommand, prepending however the CLI has to be spawned.
   * @param subcommand - Arguments after the executable.
   * @param options - Spawn options, always including the shared timeout.
   * @returns The child's stdout.
   */
  private async execTailscale(subcommand: readonly string[], options: ExecFileOptions): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      const [file, ...prefix] = this.bin()
      execFile(file ?? 'tailscale', [...prefix, ...subcommand], options, (error, stdout) => {
        if (error === null) resolve(String(stdout))
        else reject(error)
      })
    })
  }

  private async start(): Promise<void> {
    this.publish({ enabled: true, state: 'starting' })
    try {
      await this.runServe()
      const origin = await this.resolveOrigin()
      this.publish({ enabled: true, state: 'ready', origin })
    } catch (error) {
      // `runServe` registers the 443 entry before `resolveOrigin` reads the
      // MagicDNS name back, so a failure after the registration would otherwise
      // leave `serve` pointing at a proxy we are about to close — the phone
      // then sees connection-refused while the panel reports an error. Clear
      // the entry we just created, then report.
      try { await this.stopServe() } catch {
        // The proxy must not mask the serve error reported below.
      }
      this.publish({ enabled: true, state: 'error', errorCode: classifyServeError(error) })
    }
  }

  private async runServe(): Promise<void> {
    await this.options.proxy.start()
    const target = this.options.proxy.origin()
    try {
      await this.applyServe(target)
    } catch (error) {
      if (isServePortConflict(error)) {
        await this.recoverServePortConflict()
        await this.applyServe(target)
      } else {
        throw error
      }
    }
    this.serveTarget = target
    this.startWatchdog()
  }

  /**
   * Re-verify the 443 entry shortly after enabling and then on a slow cadence.
   * A registration that vanishes (daemon restart, reload race) is restored
   * without the user touching the desktop panel.
   */
  private startWatchdog(): void {
    this.stopWatchdog()
    const tick = (): void => { void this.reconcile() }
    this.watchdogTimers = [setTimeout(tick, SERVE_WATCHDOG_FIRST_MS), setInterval(tick, SERVE_WATCHDOG_INTERVAL_MS)]
    for (const timer of this.watchdogTimers) timer.unref?.()
  }

  private stopWatchdog(): void {
    for (const timer of this.watchdogTimers) {
      clearTimeout(timer)
      clearInterval(timer)
    }
    this.watchdogTimers = []
  }

  /** Parsed `serve status --json`, or undefined when it cannot be read. */
  private async readServeEntries(): Promise<unknown | undefined> {
    try {
      const stdout = await this.execTailscale([...SERVE_STATUS_ARGS], {
        windowsHide: true,
        timeout: 30_000,
      })
      return JSON.parse(stdout) as unknown
    } catch {
      return undefined
    }
  }

  private async applyServe(target: string): Promise<void> {
    await this.execTailscale(['serve', '--bg', '--yes', '--https=443', target], {
      windowsHide: true,
      timeout: 30_000,
    })
  }

  /**
   * Clear a stale port-443 occupancy so the HTTPS serve can register. Only
   * when 443 is the sole serve entry is it safe to reset the whole config;
   * otherwise the conflict is surfaced as a dedicated diagnostic code.
   */
  private async recoverServePortConflict(): Promise<void> {
    let status: unknown
    try {
      const stdout = await this.execTailscale(['serve', 'status', '--json'], {
        windowsHide: true,
        timeout: 30_000,
      })
      status = JSON.parse(stdout) as unknown
    } catch {
      throw new ServeDiagnosticError('serve_port_conflict', 'serve port 443 is occupied by another service and its status could not be read')
    }
    const tcp = (status as { TCP?: Record<string, unknown> })?.TCP
    const entries = tcp === undefined || tcp === null ? [] : Object.keys(tcp)
    if (entries.length !== 1 || entries[0] !== '443') {
      throw new ServeDiagnosticError('serve_port_conflict', 'serve port 443 is occupied by another service')
    }
    await this.execTailscale(['serve', 'reset'], {
      windowsHide: true,
      timeout: 30_000,
    })
  }

  private async stopServe(): Promise<void> {
    this.stopWatchdog()
    // Only clear the entry this controller registered. `serve --https=443 off`
    // is a node-global switch: running it while the 443 entry belongs to
    // someone else (a user's own serve entry, or a newer controller for the
    // same loopback port during a reload) would take their origin down
    // instead. No registration of ours means there is nothing to clear.
    const target = this.serveTarget
    this.serveTarget = undefined
    if (target !== undefined) {
      const status = await this.readServeEntries()
      if (status === undefined || serveEntryTargetsProxy(status, target)) {
        try {
          await this.execTailscale(['serve', '--https=443', 'off'], {
            windowsHide: true,
            timeout: 30_000,
          })
        } catch {
          // Turning serve off when nothing is configured is harmless.
        }
      }
    }
    await this.closeProxy()
  }

  /** Stop the loopback proxy if it is running. Never touches `tailscale serve`. */
  private async closeProxy(): Promise<void> {
    try {
      await this.options.proxy.close()
    } catch {
      // A proxy that failed to close must not break the disable flow.
    }
  }

  private async resolveOrigin(): Promise<string> {
    const stdout = await this.execTailscale(['status', '--json'], {
      windowsHide: true,
      timeout: 30_000,
    })
    let parsed: unknown
    try {
      parsed = JSON.parse(stdout)
    } catch {
      throw new Error('tailscale status --json is not valid JSON')
    }
    const self = (parsed as { Self?: { DNSName?: unknown } }).Self
    const dnsName = typeof self?.DNSName === 'string' ? self.DNSName.replace(/\.$/u, '') : undefined
    if (dnsName === undefined || dnsName === '') throw new Error('tailscale status did not report a MagicDNS name')
    return `https://${dnsName}/`
  }
}
