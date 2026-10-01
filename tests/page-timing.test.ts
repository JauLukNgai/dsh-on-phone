import { describe, expect, it } from 'vitest'
import {
  PAINT_SAMPLE_DELAYS_MS,
  RESOURCE_BUFFER_SIZE,
  countTurns,
  describePage,
  installPageTiming,
  isHistoryPageUrl,
  reserveResourceBuffer,
  type ResourceTimingLike,
  type TurnSource,
} from '../src/page-timing.js'

/** A document stub whose rendered turn count is scripted. */
function turns(counts: number[]): TurnSource {
  let index = 0
  return {
    querySelectorAll: () => {
      const value = counts[Math.min(index, counts.length - 1)] ?? 0
      index += 1
      return { length: value }
    },
  }
}

/** A page entry as Chromium reports it: ms and bytes, same origin. */
function entry(overrides: Partial<{ [K in keyof ResourceTimingLike]: ResourceTimingLike[K] | undefined }> = {}): ResourceTimingLike {
  return {
    name: 'https://phone.example/api/session/page',
    startTime: 1000,
    duration: 900,
    initiatorType: 'fetch',
    requestStart: 1010,
    responseStart: 1500,
    responseEnd: 1900,
    transferSize: 510975,
    encodedBodySize: 498517,
    decodedBodySize: 1681025,
    ...overrides,
  } as ResourceTimingLike
}

describe('page timing', () => {
  it('recognises only the paged-history route', () => {
    expect(isHistoryPageUrl('https://phone.example/api/session/page')).toBe(true)
    expect(isHistoryPageUrl('/api/session/page')).toBe(true)
    expect(isHistoryPageUrl('/api/session/list')).toBe(false)
  })

  it('counts rendered turns and tolerates a missing document', () => {
    expect(countTurns(turns([7]))).toBe(7)
    expect(countTurns(undefined)).toBe(0)
    expect(countTurns({})).toBe(0)
  })

  it('records transfer time, sizes, and when the page actually appeared', async () => {
    const sent: string[] = []
    let clock = 1900
    const record = await describePage(entry(), 20, {
      now: () => clock,
      document: turns([20, 20, 138, 138]),
      endpoint: '/__dsh-on-phone/telemetry',
      send: (_endpoint, body) => sent.push(body),
      sleep: async (ms: number) => {
        clock += ms
      },
    })
    expect(record).toMatchObject({
      kind: 'page-timing',
      url: '/api/session/page',
      initiatorType: 'fetch',
      durationMs: 900,
      transferMs: 890,
      waitMs: 490,
      transferBytes: 510975,
      encodedBytes: 498517,
      decodedBytes: 1681025,
      baselineTurns: 20,
      turns: [20, 20, 138, 138],
      firstPaintMs: 1000,
    })
    // Samples are offsets from the last body byte, not from the page request.
    expect(record.samplesMs).toEqual([0, 250, 1000, 3000])
    expect(PAINT_SAMPLE_DELAYS_MS).toEqual([0, 250, 1000, 3000])
    expect(JSON.parse(sent[0] ?? '{}')).toMatchObject({ kind: 'page-timing', firstPaintMs: 1000 })
  })

  it('leaves firstPaintMs null when the page never renders more turns', async () => {
    const record = await describePage(entry({ duration: undefined }), 20, {
      now: () => 0,
      document: turns([20]),
      endpoint: '/x',
      send: () => undefined,
      sleep: async () => undefined,
    })
    expect(record.firstPaintMs).toBeNull()
    expect(record.durationMs).toBeNull()
  })

  it('reports every page request once and stops on cleanup', async () => {
    const sent: string[] = []
    const entries: ResourceTimingLike[] = [
      { name: 'https://phone.example/assets/app.js', startTime: 10 },
      entry(),
    ]
    let responded = 0
    const stop = installPageTiming({
      endpoint: '/__dsh-on-phone/telemetry',
      send: (_endpoint, body) => {
        responded += 1
        sent.push(body)
      },
      document: turns([12]),
      resources: () => entries,
      pollMs: 1,
      sleep: async () => undefined,
      now: () => 1900,
    })
    await new Promise((resolve) => setTimeout(resolve, 25))
    stop()
    entries.push(entry({ startTime: 2000 }))
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(responded).toBe(1)
    expect(JSON.parse(sent[0] ?? '{}')).toMatchObject({ kind: 'page-timing', baselineTurns: 12 })
  })

  it('keeps the resource timeline big enough and sweeps it when it fills', () => {
    const calls: string[] = []
    let size: number | undefined
    let sweep: (() => void) | undefined
    const stop = reserveResourceBuffer({
      setResourceTimingBufferSize: (value) => {
        size = value
      },
      clearResourceTimings: () => calls.push('clear'),
      addEventListener: (type, listener) => {
        calls.push(`on:${type}`)
        sweep = listener
      },
      removeEventListener: (type) => calls.push(`off:${type}`),
    })
    expect(size).toBe(RESOURCE_BUFFER_SIZE)
    expect(size).toBeGreaterThan(250)
    expect(calls).toEqual(['on:resourcetimingbufferfull'])
    sweep?.()
    expect(calls).toContain('clear')
    stop()
    expect(calls).toContain('off:resourcetimingbufferfull')
  })

  it('reserves the timeline on install and releases it on cleanup', async () => {
    let size: number | undefined
    const removed: string[] = []
    const stop = installPageTiming({
      endpoint: '/__dsh-on-phone/telemetry',
      send: () => undefined,
      document: turns([1]),
      resources: () => [],
      pollMs: 1000,
      sleep: async () => undefined,
      buffer: {
        setResourceTimingBufferSize: (value) => {
          size = value
        },
        addEventListener: () => undefined,
        removeEventListener: (type) => removed.push(type),
      },
    })
    expect(size).toBe(RESOURCE_BUFFER_SIZE)
    stop()
    expect(removed).toEqual(['resourcetimingbufferfull'])
  })
})
