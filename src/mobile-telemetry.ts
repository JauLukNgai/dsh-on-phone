/**
 * Debug telemetry channel for the phone surface.
 *
 * Two questions can only be answered on the device, so both sides of the fixed:
 * what a real finger does to the open drawer (the client posts one trace per
 * drag, see `gesture-telemetry.ts`), and how long the host takes to answer a
 * history page while an agent turn is running (the proxy times it here). Both
 * land in one JSON-lines file inside the DSH home so a developer can read the
 * device's behaviour from the machine.
 *
 * This is a debugging aid, not a product feature: it is written to be removed
 * again, it records class names and timings only (never text, never keystrokes),
 * and it rotates its own file so a forgotten run cannot fill the disk.
 * @module dsh-on-phone/mobile-telemetry
 */

import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Path the phone posts traces to; only this proxy (tailnet) reaches it. */
export const TELEMETRY_PATH = '/__dsh-on-phone/telemetry'

/** Largest trace this channel will accept, so one runaway page cannot fill the disk. */
export const MAX_TELEMETRY_BODY_BYTES = 256 * 1024

/** Size at which the log is rotated to `<file>.1`, replacing the previous one. */
export const MAX_TELEMETRY_FILE_BYTES = 4 * 1024 * 1024

/**
 * Where the telemetry log lives.
 * @param env - Environment to read `DSH_HOME` from.
 * @param home - Fallback home directory.
 * @returns Absolute path of the JSON-lines log.
 */
export function telemetryFile(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const configured = env.DSH_HOME
  return join(configured !== undefined && configured !== '' ? configured : join(home, '.dsh'), 'mobile-telemetry.jsonl')
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

/**
 * Describe a history page request without keeping its (large) body.
 *
 * The page request carries the budget the phone asks for, nested the same way
 * the clamp reads it (`payload.args.request`); the botched paging complaint was
 * about the host answering a five-hundred-message request with megabytes, so
 * the requested size is what has to be visible in the log next to the grant.
 * @param body - Raw request body.
 * @returns A small, loggable summary.
 */
export function summarizePageRequest(body: Buffer | string): Record<string, unknown> {
  const text = typeof body === 'string' ? body : body.toString('utf8')
  try {
    const parsed = asRecord(JSON.parse(text)) ?? {}
    const request = asRecord(asRecord(asRecord(parsed.payload)?.args)?.request) ?? parsed
    const turnWindow = asRecord(request.turnWindow)
    return {
      keys: Object.keys(parsed),
      maxMessages: request.maxMessages ?? null,
      minMessages: turnWindow?.minMessages ?? null,
      minTurns: turnWindow?.minTurns ?? null,
    }
  } catch {
    return { unparsed: text.slice(0, 200) }
  }
}

/**
 * Append-only JSON-lines log.
 *
 * Writes are queued so concurrent gestures cannot interleave half-lines, and a
 * failed write is swallowed: telemetry may never break the surface it measures.
 */
export class TelemetryLog {
  private queue: Promise<void> = Promise.resolve()
  private written: number | undefined

  /**
   * @param file - Absolute path of the log file.
   * @param limit - Rotation threshold in bytes.
   */
  constructor(private readonly file: string = telemetryFile(), private readonly limit: number = MAX_TELEMETRY_FILE_BYTES) {}

  /**
   * Queue one entry.
   * @param entry - JSON-serialisable record; a circular one is dropped.
   */
  append(entry: unknown): void {
    let line: string
    try {
      line = `${JSON.stringify(entry)}\n`
    } catch {
      return
    }
    this.queue = this.queue.then(() => this.write(line)).catch(() => undefined)
  }

  /** Resolves once every queued entry has been written; used by tests. */
  async settled(): Promise<void> {
    await this.queue
  }

  private async write(line: string): Promise<void> {
    let written = this.written
    if (written === undefined) {
      await mkdir(dirname(this.file), { recursive: true })
      written = await stat(this.file).then((info) => info.size).catch(() => 0)
    }
    if (written > this.limit) {
      await rename(this.file, `${this.file}.1`).catch(() => undefined)
      written = 0
    }
    await appendFile(this.file, line)
    this.written = written + Buffer.byteLength(line)
  }
}
