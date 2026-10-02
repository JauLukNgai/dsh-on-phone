import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MAX_TELEMETRY_BODY_BYTES,
  MAX_TELEMETRY_FILE_BYTES,
  TelemetryLog,
  TELEMETRY_PATH,
  summarizePageRequest,
  telemetryFile,
} from '../src/mobile-telemetry.js'

const scratch = async (): Promise<string> => await mkdtemp(join(tmpdir(), 'dsh-telemetry-'))

describe('mobile telemetry destination', () => {
  it('lives inside the DSH home', () => {
    expect(telemetryFile({ DSH_HOME: '/data/dsh' }, '/home/phone')).toBe(join('/data/dsh', 'mobile-telemetry.jsonl'))
    expect(telemetryFile({ DSH_HOME: '' }, '/home/phone')).toBe(join('/home/phone', '.dsh', 'mobile-telemetry.jsonl'))
  })

  it('is a path the remote proxy can claim without shadowing the admin surface', () => {
    expect(TELEMETRY_PATH.startsWith('/__dsh-on-phone/')).toBe(true)
    expect(TELEMETRY_PATH.startsWith('/api/mobile-access')).toBe(false)
    // The phone's trace has to fit far inside the request bound.
    expect(MAX_TELEMETRY_BODY_BYTES).toBeLessThan(MAX_TELEMETRY_FILE_BYTES)
  })
})

describe('history page request summary', () => {
  it('reads the budget the phone asked for out of the frame nesting', () => {
    const body = JSON.stringify({
      type: 'request',
      payload: { args: { request: { address: { sessionId: 's-1' }, maxMessages: 500, turnWindow: { minMessages: 20, minTurns: 4 } } } },
    })
    expect(summarizePageRequest(body)).toEqual({
      keys: ['type', 'payload'],
      maxMessages: 500,
      minMessages: 20,
      minTurns: 4,
    })
  })

  it('falls back to a top-level request and never throws on a broken body', () => {
    expect(summarizePageRequest('{"maxMessages":60}').maxMessages).toBe(60)
    expect(summarizePageRequest('not json at all').unparsed).toBe('not json at all')
  })
})

describe('telemetry log', () => {
  it('appends one JSON record per line, in order', async () => {
    const file = join(await scratch(), 'mobile-telemetry.jsonl')
    const log = new TelemetryLog(file)
    log.append({ kind: 'device', n: 1 })
    log.append({ kind: 'history-page', n: 2 })
    await log.settled()
    const lines = (await readFile(file, 'utf8')).trimEnd().split('\n')
    expect(lines.map((line) => (JSON.parse(line) as { n: number }).n)).toEqual([1, 2])
  })

  it('rotates instead of growing without bound', async () => {
    const dir = await scratch()
    const file = join(dir, 'mobile-telemetry.jsonl')
    await writeFile(file, 'stale\n')
    const log = new TelemetryLog(file, 2)
    log.append({ kind: 'device' })
    await log.settled()
    expect(await readFile(`${file}.1`, 'utf8')).toBe('stale\n')
    expect(JSON.parse((await readFile(file, 'utf8')).trim())).toEqual({ kind: 'device' })
  })

  it('swallows what it cannot write, so telemetry cannot break the page', async () => {
    const dir = await scratch()
    // The log path is a directory, so every append fails with EISDIR.
    const log = new TelemetryLog(dir)
    log.append({ kind: 'device' })
    await log.settled()
    expect(await readdir(dir)).toEqual([])
    const circular: Record<string, unknown> = {}
    circular.self = circular
    log.append(circular)
    await log.settled()
    expect(await readdir(dir)).toEqual([])
  })
})
