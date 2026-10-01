import { describe, expect, it } from 'vitest'
import {
  PAGE_FETCH_ATTEMPTS,
  installPageFetchGuard,
  isHistoryPageRequest,
  pageFetchStats,
  requestPathOf,
  type FetchHost,
  type PageFetchRecord,
} from '../src/page-fetch-guard.js'

const PAGE = '/api/session/page'

/** An abortable hang, the way the transport behaves. */
function hang(init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(new DOMException('The operation was aborted.', 'AbortError'))
    }, { once: true })
  })
}

/** A response whose headers arrive and whose body then stops. */
function stalledBody(init?: RequestInit): Promise<Response> {
  return Promise.resolve({
    status: 200,
    statusText: 'OK',
    ok: true,
    headers: new Headers({ 'content-type': 'application/json' }),
    arrayBuffer: (): Promise<ArrayBuffer> => new Promise<ArrayBuffer>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'))
      }, { once: true })
    }),
  } as unknown as Response)
}

/** A successful JSON answer. */
function answer(payload: string, status = 200): Promise<Response> {
  return Promise.resolve(new Response(payload, {
    status,
    headers: { 'content-type': 'application/json' },
  }))
}

/**
 * A fetch host that answers from a script, recording every call.
 * @param answers - One answer per call; the last one repeats.
 * @returns The host, with its call log.
 */
function scripted(answers: Array<(init?: RequestInit) => Promise<Response>>): FetchHost & { calls: RequestInit[] } {
  const calls: RequestInit[] = []
  let index = 0
  return {
    calls,
    fetch: ((_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push(init ?? {})
      const answerAt = answers[Math.min(index, answers.length - 1)]
      index += 1
      return answerAt === undefined ? Promise.reject(new Error('no answer scripted')) : answerAt(init)
    }) as typeof globalThis.fetch,
  }
}

/** Records sent through the guard's telemetry sink. */
function sink(): { readonly records: PageFetchRecord[] } & ((endpoint: string, body: string) => void) {
  const records: PageFetchRecord[] = []
  const send = (endpoint: string, body: string): void => {
    expect(endpoint).toBe('/__dsh-on-phone/telemetry')
    records.push(JSON.parse(body) as PageFetchRecord)
  }
  return Object.assign(send, { records })
}

const page = (body = '{"type":"client-request"}'): RequestInit => ({ method: 'POST', body })

describe('requestPathOf', () => {
  it('reads strings, URLs, and Requests', () => {
    expect(requestPathOf(`${PAGE}?x=1`, 'https://phone.example/')).toBe(PAGE)
    expect(requestPathOf(new URL(`https://phone.example${PAGE}`))).toBe(PAGE)
    expect(requestPathOf(new Request(`https://phone.example${PAGE}`))).toBe(PAGE)
  })

  it('resolves a relative target against the given origin', () => {
    expect(requestPathOf('api/session/page', 'https://phone.example/')).toBe(PAGE)
  })

  it('reports nothing for a target it cannot read', () => {
    expect(requestPathOf(undefined)).toBeUndefined()
    expect(requestPathOf(42)).toBeUndefined()
  })
})

describe('isHistoryPageRequest', () => {
  it('matches only the POST to the page endpoint', () => {
    expect(isHistoryPageRequest(`${PAGE}`, { method: 'POST' })).toBe(true)
    expect(isHistoryPageRequest(`${PAGE}`, { method: 'post' })).toBe(true)
    expect(isHistoryPageRequest(`${PAGE}`, { method: 'GET' })).toBe(false)
    expect(isHistoryPageRequest(`${PAGE}`)).toBe(false)
    expect(isHistoryPageRequest('/api/session/other', { method: 'POST' })).toBe(false)
    expect(isHistoryPageRequest(undefined, { method: 'POST' })).toBe(false)
  })
})

describe('installPageFetchGuard', () => {
  it('replays a page request whose headers never arrive', async () => {
    const host = scripted([(init) => hang(init), () => answer('{"ok":true}')])
    const records = sink()
    const remove = installPageFetchGuard({ host, headersTimeoutMs: 10, retryDelayMs: 1, send: records })
    try {
      const response = await host.fetch?.(PAGE, page())
      expect(response?.status).toBe(200)
      await expect(response?.json()).resolves.toEqual({ ok: true })
      expect(host.calls.length).toBe(2)
      expect(records.records.length).toBe(1)
      const record = records.records[0]
      expect(record?.kind).toBe('page-fetch')
      expect(record?.attempts).toBe(2)
      expect(record?.outcome).toBe('ok')
      expect(record?.path).toBe(PAGE)
      expect(record?.requestBytes).toBe(25)
      expect(record?.responseBytes).toBe(11)
      expect(record?.error).toBeNull()
    } finally {
      remove()
    }
  })

  it('replays a page request whose body stops after the headers', async () => {
    const host = scripted([(init) => stalledBody(init), () => answer('{"ok":true}')])
    const records = sink()
    const remove = installPageFetchGuard({ host, bodyTimeoutMs: 10, retryDelayMs: 1, send: records })
    try {
      await expect(host.fetch?.(PAGE, page())).resolves.toMatchObject({ status: 200 })
      expect(host.calls.length).toBe(2)
      expect(records.records[0]?.attempts).toBe(2)
      expect(records.records[0]?.outcome).toBe('ok')
    } finally {
      remove()
    }
  })

  it('replays a request that fails outright', async () => {
    const host = scripted([() => Promise.reject(new TypeError('Load failed')), () => answer('{"ok":true}')])
    const records = sink()
    const remove = installPageFetchGuard({ host, retryDelayMs: 1, send: records })
    try {
      await expect(host.fetch?.(PAGE, page())).resolves.toMatchObject({ status: 200 })
      expect(host.calls.length).toBe(2)
      expect(records.records[0]?.outcome).toBe('ok')
    } finally {
      remove()
    }
  })

  it('keeps the original status, headers, and body of the answer', async () => {
    const host = scripted([() => Promise.reject(new TypeError('Load failed')), () => answer('{"a":1}', 201)])
    const remove = installPageFetchGuard({ host, retryDelayMs: 1, send: () => undefined })
    try {
      const response = await host.fetch?.(PAGE, page())
      expect(response?.status).toBe(201)
      expect(response?.ok).toBe(true)
      expect(response?.headers.get('content-type')).toBe('application/json')
      await expect(response?.json()).resolves.toEqual({ a: 1 })
    } finally {
      remove()
    }
  })

  it('gives up after the last attempt and rethrows', async () => {
    const host = scripted([() => Promise.reject(new TypeError('Load failed'))])
    const records = sink()
    const remove = installPageFetchGuard({ host, attempts: 2, retryDelayMs: 1, send: records })
    try {
      await expect(host.fetch?.(PAGE, page())).rejects.toThrow('Load failed')
      expect(host.calls.length).toBe(2)
      expect(records.records.length).toBe(1)
      expect(records.records[0]?.attempts).toBe(2)
      expect(records.records[0]?.outcome).toBe('error')
      expect(records.records[0]?.error).toContain('Load failed')
    } finally {
      remove()
    }
  })

  it('never replays once the app has cancelled the call', async () => {
    const host = scripted([(init) => hang(init)])
    const records = sink()
    const remove = installPageFetchGuard({ host, retryDelayMs: 1, send: records })
    try {
      const controller = new AbortController()
      const pending = host.fetch?.(PAGE, { ...page(), signal: controller.signal })
      controller.abort()
      await expect(pending).rejects.toThrow()
      expect(host.calls.length).toBe(1)
      expect(records.records[0]?.outcome).toBe('aborted')
      expect(records.records[0]?.attempts).toBe(1)
    } finally {
      remove()
    }
  })

  it('passes everything that is not a replayable page request straight through', async () => {
    const host = scripted([() => answer('{"ok":true}')])
    const records = sink()
    const remove = installPageFetchGuard({ host, retryDelayMs: 1, send: records })
    try {
      const other = await host.fetch?.('/api/costMeter/getSessionCost', page())
      expect(other?.status).toBe(200)
      const get = await host.fetch?.(PAGE, { method: 'GET' })
      expect(get?.status).toBe(200)
      const streamed = await host.fetch?.(PAGE, { method: 'POST', body: new Uint8Array([1, 2]) })
      expect(streamed?.status).toBe(200)
      expect(host.calls.length).toBe(3)
      expect(records.records.length).toBe(0)
    } finally {
      remove()
    }
  })

  it('stays quiet when the first attempt succeeds', async () => {
    const host = scripted([() => answer('{"ok":true}')])
    const records = sink()
    const remove = installPageFetchGuard({ host, send: records })
    try {
      await host.fetch?.(PAGE, page())
      expect(host.calls.length).toBe(1)
      expect(records.records.length).toBe(0)
    } finally {
      remove()
    }
  })

  it('records the context the phone was in', async () => {
    const host = scripted([(init) => hang(init), () => answer('{"ok":true}')])
    const records = sink()
    const remove = installPageFetchGuard({
      host,
      headersTimeoutMs: 10,
      retryDelayMs: 1,
      send: records,
      hidden: () => true,
      online: () => false,
    })
    try {
      await host.fetch?.(PAGE, page())
      expect(records.records[0]?.hidden).toBe(true)
      expect(records.records[0]?.online).toBe(false)
    } finally {
      remove()
    }
  })

  it('uses the default attempt budget', async () => {
    const host = scripted([() => Promise.reject(new TypeError('Load failed'))])
    const remove = installPageFetchGuard({ host, retryDelayMs: 1, send: () => undefined })
    try {
      await expect(host.fetch?.(PAGE, page())).rejects.toThrow('Load failed')
      expect(host.calls.length).toBe(PAGE_FETCH_ATTEMPTS)
    } finally {
      remove()
    }
  })

  it('puts the original fetch back on cleanup only while it is still ours', async () => {
    const host = scripted([() => answer('{"ok":true}')])
    const original = host.fetch
    const remove = installPageFetchGuard({ host, send: () => undefined })
    expect(host.fetch).not.toBe(original)
    remove()
    expect(host.fetch).toBe(original)

    const records = sink()
    const removeAgain = installPageFetchGuard({ host, send: records })
    const replacement = (): Promise<Response> => answer('{"replaced":true}')
    host.fetch = replacement as typeof globalThis.fetch
    removeAgain()
    expect(host.fetch).toBe(replacement)
  })

  it('does nothing when the environment has no fetch', () => {
    const remove = installPageFetchGuard({ host: {} })
    expect(remove).toBeTypeOf('function')
    expect(() => remove()).not.toThrow()
  })
})

/**
 * A transport that ignores the abort and never settles — the stall this guard
 * exists for. Aborting such a request releases nothing, so the deadline has to
 * settle the attempt by itself.
 * @returns A promise that never settles.
 */
function deafHang(): Promise<Response> {
  return new Promise<Response>(() => undefined)
}

/** A response whose headers arrive and whose body never settles, abort or not. */
function deafStalledBody(): Promise<Response> {
  return Promise.resolve({
    status: 200,
    statusText: 'OK',
    ok: true,
    headers: new Headers({ 'content-type': 'application/json' }),
    arrayBuffer: (): Promise<ArrayBuffer> => new Promise<ArrayBuffer>(() => undefined),
  } as unknown as Response)
}

describe('a transport that ignores the abort', () => {
  it('replays the page call once its deadline wins', async () => {
    const host = scripted([deafHang, () => answer('{"rpcId":1}')])
    const records = sink()
    const remove = installPageFetchGuard({ host, headersTimeoutMs: 20, retryDelayMs: 0, send: records })
    try {
      const response = await host.fetch?.(PAGE, page())
      expect(response?.status).toBe(200)
      expect(await response?.json()).toEqual({ rpcId: 1 })
      expect(host.calls.length).toBe(2)
      expect(records.records).toHaveLength(1)
      expect(records.records[0]?.outcome).toBe('ok')
      expect(records.records[0]?.attempts).toBe(2)
      expect(records.records[0]?.ms).toBeGreaterThanOrEqual(20)
    } finally {
      remove()
    }
  })

  it('replays when the body never arrives after the headers', async () => {
    const host = scripted([deafStalledBody, () => answer('{"rpcId":2}')])
    const records = sink()
    const remove = installPageFetchGuard({ host, bodyTimeoutMs: 20, retryDelayMs: 0, send: records })
    try {
      const response = await host.fetch?.(PAGE, page())
      expect(await response?.json()).toEqual({ rpcId: 2 })
      expect(host.calls.length).toBe(2)
      expect(records.records[0]?.outcome).toBe('ok')
    } finally {
      remove()
    }
  })

  it('gives up with a timeout record when no attempt ever answers', async () => {
    const host = scripted([deafHang])
    const records = sink()
    const remove = installPageFetchGuard({ host, headersTimeoutMs: 10, attempts: 2, retryDelayMs: 0, send: records })
    try {
      await expect(host.fetch?.(PAGE, page())).rejects.toThrow('no response within 10 ms')
      expect(host.calls.length).toBe(2)
      expect(records.records).toHaveLength(1)
      expect(records.records[0]?.outcome).toBe('timeout')
      expect(records.records[0]?.attempts).toBe(2)
      expect(records.records[0]?.error).toContain('TimeoutError')
    } finally {
      remove()
    }
  })

  it('still stops at once when the app itself cancels', async () => {
    const host = scripted([deafHang])
    const records = sink()
    const controller = new AbortController()
    const remove = installPageFetchGuard({ host, headersTimeoutMs: 5_000, send: records })
    try {
      const started = Date.now()
      const pending = host.fetch?.(PAGE, { ...page(), signal: controller.signal })
      setTimeout(() => controller.abort(), 20)
      await expect(pending).rejects.toThrow()
      expect(Date.now() - started).toBeLessThan(1_000)
      expect(host.calls.length).toBe(1)
      expect(records.records[0]?.outcome).toBe('aborted')
    } finally {
      remove()
    }
  })

  it('counts calls and exposes what the last one did', async () => {
    const before = pageFetchStats()
    expect(before.installed).toBe(false)
    const host = scripted([deafHang, () => answer('{"rpcId":3}')])
    const remove = installPageFetchGuard({ host, headersTimeoutMs: 10, retryDelayMs: 0, send: () => undefined })
    try {
      expect(pageFetchStats().installed).toBe(true)
      await host.fetch?.(PAGE, page())
      const after = pageFetchStats()
      expect(after.calls).toBe(before.calls + 1)
      expect(after.inFlight).toBe(0)
      expect(after.lastOutcome).toBe('ok')
      expect(after.lastAttempts).toBe(2)
      expect(after.lastMs).toBeGreaterThanOrEqual(10)
    } finally {
      remove()
    }
    expect(pageFetchStats().installed).toBe(false)
  })
})
