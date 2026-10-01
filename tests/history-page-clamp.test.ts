import { describe, expect, it } from 'vitest'
import {
  clampHistoryPageBody,
  HISTORY_PAGE_PATH,
  HistoryPageBudget,
  MAX_TRACKED_HISTORY_SESSIONS,
  MOBILE_HISTORY_CONTINUATION_PAGE_MESSAGES,
} from '../src/history-page-clamp.js'
import { MOBILE_HISTORY_PAGE_MESSAGES, MOBILE_HISTORY_TURN_MIN_MESSAGES } from '../src/websocket-frames.js'

/** The body the stock client posts when the phone asks for another page. */
function pageBody(options: { sessionId?: string; maxMessages?: number; turnWindow?: unknown } = {}): Buffer {
  const request: Record<string, unknown> = {
    address: { kind: 'session', sessionId: options.sessionId ?? 'session-one' },
    throughSeq: 10985,
    beforeSeq: 9819,
  }
  if (options.maxMessages !== undefined) request.maxMessages = options.maxMessages
  if (options.turnWindow !== undefined) request.turnWindow = options.turnWindow
  return Buffer.from(JSON.stringify({
    type: 'client-request',
    rpcId: 'rpc-1',
    method: 'session/page',
    payload: { args: { request } },
  }))
}

function read(body: Buffer): Record<string, unknown> {
  return JSON.parse(body.toString('utf8')) as Record<string, unknown>
}

function requestOf(body: Buffer): Record<string, unknown> {
  const frame = read(body)
  const payload = frame.payload as { args: { request: Record<string, unknown> } }
  return payload.args.request
}

describe('clampHistoryPageBody', () => {
  it('shrinks the first page of a session to the snapshot size', () => {
    const result = clampHistoryPageBody(pageBody({ maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } }), new HistoryPageBudget())
    expect(result).toBeDefined()
    const request = requestOf(result!.body)
    expect(request.maxMessages).toBe(MOBILE_HISTORY_PAGE_MESSAGES)
    // The host rejects `turnWindow.minMessages` above `maxMessages`.
    expect(request.turnWindow).toEqual({ minMessages: MOBILE_HISTORY_PAGE_MESSAGES, minTurns: 2 })
    expect(result!.record).toEqual({
      sessionId: 'session-one',
      first: true,
      requested: 500,
      maxMessages: MOBILE_HISTORY_PAGE_MESSAGES,
      turnMinMessages: MOBILE_HISTORY_PAGE_MESSAGES,
    })
  })

  it('leaves every field it does not own alone', () => {
    const result = clampHistoryPageBody(pageBody({ maxMessages: 500 }), new HistoryPageBudget())
    const frame = read(result!.body)
    expect(frame.type).toBe('client-request')
    expect(frame.rpcId).toBe('rpc-1')
    expect(frame.method).toBe('session/page')
    const request = requestOf(result!.body)
    expect(request.throughSeq).toBe(10985)
    expect(request.beforeSeq).toBe(9819)
    expect(request.address).toEqual({ kind: 'session', sessionId: 'session-one' })
  })

  it('grants a larger page once the session has opened', () => {
    const budget = new HistoryPageBudget()
    expect(clampHistoryPageBody(pageBody({ maxMessages: 500 }), budget)!.record.maxMessages).toBe(MOBILE_HISTORY_PAGE_MESSAGES)
    const later = clampHistoryPageBody(pageBody({ maxMessages: 500 }), budget)
    expect(later!.record).toMatchObject({ first: false, maxMessages: MOBILE_HISTORY_CONTINUATION_PAGE_MESSAGES })
    expect(requestOf(later!.body).maxMessages).toBe(MOBILE_HISTORY_CONTINUATION_PAGE_MESSAGES)
  })

  it('treats a different session as a fresh first page', () => {
    const budget = new HistoryPageBudget()
    clampHistoryPageBody(pageBody({ sessionId: 'session-one', maxMessages: 500 }), budget)
    expect(clampHistoryPageBody(pageBody({ sessionId: 'session-two', maxMessages: 500 }), budget)!.record.first).toBe(true)
  })

  it('makes every session a first page again after a new document', () => {
    const budget = new HistoryPageBudget()
    clampHistoryPageBody(pageBody({ maxMessages: 500 }), budget)
    budget.reset()
    expect(clampHistoryPageBody(pageBody({ maxMessages: 500 }), budget)!.record.first).toBe(true)
  })

  it('invents a turn window when the request carries none', () => {
    const result = clampHistoryPageBody(pageBody({ maxMessages: 500 }), new HistoryPageBudget())
    expect(requestOf(result!.body).turnWindow).toEqual({ minMessages: MOBILE_HISTORY_TURN_MIN_MESSAGES, minTurns: 2 })
  })

  it('always writes a page size when the request asks for none', () => {
    const result = clampHistoryPageBody(pageBody(), new HistoryPageBudget())
    expect(requestOf(result!.body).maxMessages).toBe(MOBILE_HISTORY_PAGE_MESSAGES)
    expect(result!.record.requested).toBeUndefined()
  })

  it('leaves a request that already fits exactly as it found it', () => {
    const body = pageBody({ maxMessages: 8, turnWindow: { minMessages: 4, minTurns: 2 } })
    expect(clampHistoryPageBody(body, new HistoryPageBudget())).toBeUndefined()
  })

  it('keeps a turn window consistent with a small page size', () => {
    const result = clampHistoryPageBody(pageBody({ maxMessages: 5, turnWindow: { minMessages: 50, minTurns: 2 } }), new HistoryPageBudget())
    const request = requestOf(result!.body)
    expect(request.maxMessages).toBe(5)
    expect((request.turnWindow as { minMessages: number }).minMessages).toBe(5)
  })

  it('ignores bodies that are not page requests', () => {
    const budget = new HistoryPageBudget()
    expect(clampHistoryPageBody(Buffer.from('not json'), budget)).toBeUndefined()
    expect(clampHistoryPageBody(Buffer.from('null'), budget)).toBeUndefined()
    expect(clampHistoryPageBody(Buffer.from('[]'), budget)).toBeUndefined()
    expect(clampHistoryPageBody(Buffer.from(JSON.stringify({ method: 'session/list', payload: {} })), budget)).toBeUndefined()
    expect(clampHistoryPageBody(Buffer.from(JSON.stringify({ method: 'session/page', payload: {} })), budget)).toBeUndefined()
    expect(clampHistoryPageBody(Buffer.from(JSON.stringify({ method: 'session/page', payload: { args: { request: { maxMessages: 500, turnWindow: 'nope' } } } })), budget)).toBeUndefined()
    // A body this rewrite refuses must not consume the session's first page.
    expect(clampHistoryPageBody(pageBody({ maxMessages: 500 }), budget)!.record.first).toBe(true)
  })

  it('bounds the sessions it remembers', () => {
    const budget = new HistoryPageBudget()
    for (let index = 0; index < MAX_TRACKED_HISTORY_SESSIONS + 4; index += 1) {
      clampHistoryPageBody(pageBody({ sessionId: `session-${index}`, maxMessages: 500 }), budget)
    }
    // The oldest ids fell out, so they open small again.
    expect(clampHistoryPageBody(pageBody({ sessionId: 'session-0', maxMessages: 500 }), budget)!.record.first).toBe(true)
    expect(clampHistoryPageBody(pageBody({ sessionId: `session-${MAX_TRACKED_HISTORY_SESSIONS + 3}`, maxMessages: 500 }), budget)!.record.first).toBe(false)
  })

  it('accepts a page request without a session address', () => {
    const body = Buffer.from(JSON.stringify({
      method: 'session/page',
      payload: { args: { request: { address: { kind: 'workspace' }, maxMessages: 500 } } },
    }))
    const result = clampHistoryPageBody(body, new HistoryPageBudget())
    expect(result!.record).toMatchObject({ sessionId: undefined, first: true, maxMessages: MOBILE_HISTORY_PAGE_MESSAGES })
  })
})

describe('HISTORY_PAGE_PATH', () => {
  it('names the route the app posts history pages to', () => {
    expect(HISTORY_PAGE_PATH).toBe('/api/session/page')
  })
})
