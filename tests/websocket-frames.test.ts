import { randomBytes } from 'node:crypto'
import { connect, createServer, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { deflateMessage, inflateMessage } from '../src/websocket-deflate.js'
import {
  ClientFrameRewriter,
  MOBILE_HISTORY_PAGE_MESSAGES,
  MOBILE_HISTORY_TURN_MIN_MESSAGES,
  SERVER_COMPRESS_MIN_BYTES,
  ServerFrameCompressor,
  clampHistoryRequest,
  encodeMaskedTextFrame,
  encodeServerFrame,
  parseFrame,
  relayUpgradedWebSocket,
} from '../src/websocket-frames.js'

const followFrame = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
  type: 'open',
  streamId: 'a1b2c3d4-0000-4000-8000-000000000000',
  endpoint: 'session/follow',
  payload: {
    args: {
      request: {
        address: { kind: 'session', sessionId: 'session-2d63b0f1-6033-4229-9f97-d8fdbf6d8be8' },
        assistantStream: true,
        maxMessages: 500,
        turnWindow: { minMessages: 50, minTurns: 2 },
        ...overrides,
      },
    },
  },
})

const requestOf = (text: string): Record<string, unknown> => {
  const frame = JSON.parse(text) as { payload: { args: { request: Record<string, unknown> } } }
  return frame.payload.args.request
}

interface FrameShape {
  readonly fin?: boolean
  readonly rsv1?: boolean
  readonly mask?: boolean
}

/** A WebSocket frame the real encoders cannot express (RSV1, fragmentation). */
function buildFrame(opcode: number, payload: Buffer, shape: FrameShape = {}): Buffer {
  const fin = shape.fin ?? true
  const rsv1 = shape.rsv1 ?? false
  const masked = shape.mask ?? false
  const length = payload.length
  const headerLength = length < 126 ? 2 : length < 65_536 ? 4 : 10
  const header = Buffer.allocUnsafe(headerLength + (masked ? 4 : 0))
  header[0] = (fin ? 0x80 : 0) | (rsv1 ? 0x40 : 0) | (opcode & 0x0f)
  if (length < 126) {
    header[1] = (masked ? 0x80 : 0) | length
  } else if (length < 65_536) {
    header[1] = (masked ? 0x80 : 0) | 126
    header.writeUInt16BE(length, 2)
  } else {
    header[1] = (masked ? 0x80 : 0) | 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  if (!masked) return Buffer.concat([header, payload])
  const mask = randomBytes(4)
  mask.copy(header, headerLength)
  const body = Buffer.allocUnsafe(length)
  for (let index = 0; index < length; index += 1) {
    body[index] = (payload[index] as number) ^ (mask[index & 3] as number)
  }
  return Buffer.concat([header, body])
}

describe('history page clamp', () => {
  it('shrinks the page the shipped client asks for on open', () => {
    const result = clampHistoryRequest(followFrame())
    expect(result).toBeDefined()
    const request = requestOf(result?.text ?? '')
    expect(request.maxMessages).toBe(MOBILE_HISTORY_PAGE_MESSAGES)
    // The client asked for turns of at least 50 messages; the host rejects a
    // window wider than the page, so it comes down to the page size itself.
    expect(request.turnWindow).toEqual({ minMessages: MOBILE_HISTORY_PAGE_MESSAGES, minTurns: 1 })
    expect(result?.record).toEqual({
      endpoint: 'session/follow',
      sessionId: 'session-2d63b0f1-6033-4229-9f97-d8fdbf6d8be8',
      requested: 500,
      maxMessages: MOBILE_HISTORY_PAGE_MESSAGES,
      turnMinMessages: MOBILE_HISTORY_PAGE_MESSAGES,
      turnMinTurns: 1,
    })
  })

  it('cuts the opening request to one turn and leaves continuation pages two', () => {
    // The opening frame is the phone's time-to-first-content, and two turns of
    // the device's session are 184-297 KB whatever the message cap says; a page
    // fetched while the reader is already looking at history keeps two.
    const opening = requestOf(clampHistoryRequest(followFrame())?.text ?? '')
    expect(opening.turnWindow).toEqual({ minMessages: MOBILE_HISTORY_PAGE_MESSAGES, minTurns: 1 })
    const page = requestOf(clampHistoryRequest(followFrame().replace('"session/follow"', '"session/page"'))?.text ?? '')
    expect(page.turnWindow).toEqual({ minMessages: MOBILE_HISTORY_PAGE_MESSAGES, minTurns: 2 })
  })

  it('never leaves turnWindow.minMessages above maxMessages, which the host rejects', () => {
    // The jump-to-message option set raises minMessages to 200 while keeping
    // the 500-message page, so the clamp has to carry it down too.
    const result = clampHistoryRequest(JSON.stringify({
      type: 'open',
      streamId: 'jump',
      endpoint: 'session/page',
      payload: { args: { throughSeq: 42, request: { address: { kind: 'session', sessionId: 'session-x' }, maxMessages: 500, turnWindow: { minMessages: 200, minTurns: 2 } } } },
    }))
    const request = requestOf(result?.text ?? '')
    expect(request.maxMessages).toBe(MOBILE_HISTORY_PAGE_MESSAGES)
    expect(request.turnWindow).toEqual({ minMessages: MOBILE_HISTORY_PAGE_MESSAGES, minTurns: 2 })
  })

  it('repairs a request whose window already exceeds its page instead of passing it on', () => {
    const result = clampHistoryRequest(followFrame({ maxMessages: 10, turnWindow: { minMessages: 50, minTurns: 2 } }))
    const request = requestOf(result?.text ?? '')
    expect(request.maxMessages).toBe(10)
    expect((request.turnWindow as { minMessages: number }).minMessages).toBe(10)
  })

  it('invents a page size only for the two paged session endpoints', () => {
    const bare = (endpoint: string): string => JSON.stringify({
      type: 'open',
      streamId: 'x',
      endpoint,
      payload: { args: { request: { address: { kind: 'session', sessionId: 'session-x' } } } },
    })
    const follow = clampHistoryRequest(bare('session/follow'))
    expect(requestOf(follow?.text ?? '').maxMessages).toBe(MOBILE_HISTORY_PAGE_MESSAGES)
    expect(requestOf(follow?.text ?? '').turnWindow).toEqual({ minMessages: MOBILE_HISTORY_TURN_MIN_MESSAGES, minTurns: 1 })
    expect(clampHistoryRequest(bare('session/page'))).toBeDefined()
    expect(clampHistoryRequest(bare('session/control'))).toBeUndefined()
  })

  it('leaves requests it cannot reason about exactly as they were', () => {
    // Already inside the budget: nothing to say.
    expect(clampHistoryRequest(followFrame({ maxMessages: MOBILE_HISTORY_PAGE_MESSAGES, turnWindow: { minMessages: MOBILE_HISTORY_TURN_MIN_MESSAGES, minTurns: 1 } }))).toBeUndefined()
    // A turn window it cannot read is a signal to stay out of the way: the
    // host owns the validation, and guessing would change size or fail.
    expect(clampHistoryRequest(followFrame({ turnWindow: { minTurns: 2 } }))).toBeUndefined()
    // Not a history request at all.
    expect(clampHistoryRequest('{"type":"cancel","streamId":"x"}')).toBeUndefined()
    expect(clampHistoryRequest(JSON.stringify({ type: 'open', endpoint: 'workspace/follow', payload: { args: { request: { maxMessages: 500 } } } }))).toBeUndefined()
    expect(clampHistoryRequest(JSON.stringify({ type: 'open', endpoint: 'session/follow', payload: {} }))).toBeUndefined()
    expect(clampHistoryRequest('not json')).toBeUndefined()
  })

  it('keeps every other field of the request intact', () => {
    const before = JSON.parse(followFrame()) as Record<string, unknown>
    const after = JSON.parse(clampHistoryRequest(followFrame())?.text ?? '') as Record<string, unknown>
    expect(after.streamId).toBe(before.streamId)
    expect(after.endpoint).toBe(before.endpoint)
    const request = requestOf(JSON.stringify(after))
    expect(request.address).toEqual({ kind: 'session', sessionId: 'session-2d63b0f1-6033-4229-9f97-d8fdbf6d8be8' })
    expect(request.assistantStream).toBe(true)
  })
})

describe('frame codec', () => {
  it('round-trips a masked text frame, including the extended length forms', () => {
    for (const text of ['{"a":1}', 'x'.repeat(126), 'y'.repeat(70_000)]) {
      const frame = parseFrame(encodeMaskedTextFrame(text))
      expect(frame?.masked).toBe(true)
      expect(frame?.fin).toBe(true)
      expect(frame?.opcode).toBe(0x1)
      expect(frame?.payload.toString('utf8')).toBe(text)
    }
  })

  it('encodes unmasked server frames with all length forms and an optional RSV1', () => {
    for (const payload of [Buffer.from('{}'), Buffer.alloc(200, 0x61), Buffer.alloc(70_000, 0x62)]) {
      const plain = parseFrame(encodeServerFrame(0x1, payload))
      expect(plain?.masked).toBe(false)
      expect(plain?.fin).toBe(true)
      expect(plain?.rsv1).toBe(false)
      expect(plain?.opcode).toBe(0x1)
      expect(plain?.payload).toEqual(payload)
      const compressed = parseFrame(encodeServerFrame(0x2, payload, true))
      expect(compressed?.rsv1).toBe(true)
      expect(compressed?.opcode).toBe(0x2)
      expect(compressed?.payload).toEqual(payload)
    }
  })

  it('asks for more bytes when a frame is still incomplete', () => {
    const encoded = encodeMaskedTextFrame('hello world')
    for (let length = 0; length < encoded.length; length += 1) {
      expect(parseFrame(encoded.subarray(0, length))).toBeUndefined()
    }
    expect(parseFrame(encoded)?.payload.toString('utf8')).toBe('hello world')
  })

  it('refuses a payload length it will not buffer', () => {
    const header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(0x0000_0000_ffff_ffffn, 2)
    expect(() => parseFrame(header)).toThrow(/too large/)
  })
})

describe('client frame rewriter', () => {
  it('reassembles frames that arrive across chunk boundaries', () => {
    const rewriter = new ClientFrameRewriter()
    const encoded = encodeMaskedTextFrame(followFrame())
    const output: Buffer[] = []
    for (let index = 0; index < encoded.length; index += 7) {
      output.push(...rewriter.pushChunk(encoded.subarray(index, index + 7)))
    }
    expect(output).toHaveLength(1)
    const parsed = parseFrame(output[0] as Buffer)
    expect(requestOf(parsed?.payload.toString('utf8') ?? '').maxMessages).toBe(MOBILE_HISTORY_PAGE_MESSAGES)
  })

  it('reports each clamp it performs', () => {
    const records: unknown[] = []
    const rewriter = new ClientFrameRewriter((record) => records.push(record))
    rewriter.pushChunk(encodeMaskedTextFrame(followFrame()))
    rewriter.pushChunk(encodeMaskedTextFrame(JSON.stringify({ type: 'cancel', streamId: 'x' })))
    expect(records).toHaveLength(1)
    expect((records[0] as { endpoint: string }).endpoint).toBe('session/follow')
  })

  it('forwards anything it cannot parse verbatim and stays a passthrough afterwards', () => {
    const rewriter = new ClientFrameRewriter()
    const garbage = Buffer.alloc(10)
    garbage[0] = 0x81
    garbage[1] = 0x80 | 127
    garbage.writeBigUInt64BE(0x0000_0000_ffff_ffffn, 2)
    expect(rewriter.pushChunk(garbage)).toEqual([garbage])
    expect(rewriter.bypass).toBe(true)
    // A later frame is no longer interpreted at all.
    expect(rewriter.pushChunk(encodeMaskedTextFrame(followFrame()))).toHaveLength(1)
  })

  it('passes control and binary frames through byte for byte', () => {
    const rewriter = new ClientFrameRewriter()
    const ping = Buffer.from([0x89, 0x84, 1, 2, 3, 4, 0, 0, 0, 0])
    const binary = Buffer.from([0x82, 0x83, 5, 6, 7, 8, 9, 9, 9])
    expect(rewriter.pushChunk(ping)).toEqual([ping])
    expect(rewriter.pushChunk(binary)).toEqual([binary])
  })
})

describe('compressed client messages', () => {
  it('inflates a masked RSV1 message into one plain masked frame', () => {
    const rewriter = new ClientFrameRewriter(undefined, true)
    const compressed = deflateMessage(Buffer.from(followFrame(), 'utf8'))
    const output = rewriter.pushChunk(buildFrame(0x1, compressed, { rsv1: true, mask: true }))
    expect(output).toHaveLength(1)
    const parsed = parseFrame(output[0] as Buffer)
    expect(parsed?.masked).toBe(true)
    expect(parsed?.rsv1).toBe(false)
    expect(parsed?.fin).toBe(true)
    expect(parsed?.opcode).toBe(0x1)
    // The inflated request still goes through the history clamp.
    expect(requestOf(parsed?.payload.toString('utf8') ?? '').maxMessages).toBe(MOBILE_HISTORY_PAGE_MESSAGES)
  })

  it('reassembles a two-fragment compressed message into one frame', () => {
    const rewriter = new ClientFrameRewriter(undefined, true)
    const compressed = deflateMessage(Buffer.from(followFrame(), 'utf8'))
    const half = Math.floor(compressed.length / 2)
    expect(rewriter.pushChunk(buildFrame(0x1, compressed.subarray(0, half), { rsv1: true, mask: true, fin: false }))).toHaveLength(0)
    const output = rewriter.pushChunk(buildFrame(0x0, compressed.subarray(half), { mask: true, fin: true }))
    expect(output).toHaveLength(1)
    const parsed = parseFrame(output[0] as Buffer)
    expect(parsed?.rsv1).toBe(false)
    expect(parsed?.fin).toBe(true)
    expect(requestOf(parsed?.payload.toString('utf8') ?? '').maxMessages).toBe(MOBILE_HISTORY_PAGE_MESSAGES)
  })

  it('lets a control frame between fragments take its place in the stream', () => {
    const rewriter = new ClientFrameRewriter(undefined, true)
    const text = JSON.stringify({ type: 'cancel', streamId: 'x' })
    const compressed = deflateMessage(Buffer.from(text, 'utf8'))
    const half = Math.floor(compressed.length / 2)
    const ping = buildFrame(0x9, Buffer.from('p'), { mask: true })
    expect(rewriter.pushChunk(buildFrame(0x1, compressed.subarray(0, half), { rsv1: true, mask: true, fin: false }))).toHaveLength(0)
    expect(rewriter.pushChunk(ping)).toEqual([ping])
    const output = rewriter.pushChunk(buildFrame(0x0, compressed.subarray(half), { mask: true, fin: true }))
    expect(output).toHaveLength(1)
    expect(parseFrame(output[0] as Buffer)?.payload.toString('utf8')).toBe(text)
  })

  it('carries a binary message through with its opcode intact', () => {
    const rewriter = new ClientFrameRewriter(undefined, true)
    const payload = randomBytes(4096)
    const output = rewriter.pushChunk(buildFrame(0x2, deflateMessage(payload), { rsv1: true, mask: true }))
    const parsed = parseFrame(output[0] as Buffer)
    expect(parsed?.opcode).toBe(0x2)
    expect(parsed?.rsv1).toBe(false)
    expect(parsed?.payload).toEqual(payload)
  })

  it('falls back to raw passthrough when an inflate fails', () => {
    const rewriter = new ClientFrameRewriter(undefined, true)
    const garbage = buildFrame(0x1, Buffer.from([0xde, 0xad, 0xbe, 0xef]), { rsv1: true, mask: true })
    expect(rewriter.pushChunk(garbage)).toEqual([garbage])
    expect(rewriter.bypass).toBe(true)
    // Later frames are no longer interpreted at all.
    const later = encodeMaskedTextFrame('{"type":"cancel"}')
    expect(rewriter.pushChunk(later)).toEqual([later])
  })

  it('leaves compressed frames alone when the option is absent', () => {
    const rewriter = new ClientFrameRewriter()
    const compressed = buildFrame(0x1, deflateMessage(Buffer.from(followFrame(), 'utf8')), { rsv1: true, mask: true })
    expect(rewriter.pushChunk(compressed)).toEqual([compressed])
    expect(rewriter.bypass).toBe(false)
  })
})

describe('server frame compressor', () => {
  it('compresses a large server message and restores it exactly', () => {
    const compressor = new ServerFrameCompressor()
    const payload = Buffer.from(JSON.stringify({ type: 'item', value: 'z'.repeat(200 * 1024) }), 'utf8')
    const output = compressor.pushChunk(encodeServerFrame(0x1, payload))
    expect(output).toHaveLength(1)
    const frame = output[0] as Buffer
    expect(frame.length).toBeLessThan(encodeServerFrame(0x1, payload).length)
    const parsed = parseFrame(frame)
    expect(parsed?.rsv1).toBe(true)
    expect(parsed?.opcode).toBe(0x1)
    expect(inflateMessage(parsed?.payload as Buffer)).toEqual(payload)
  })

  it('passes small, fragmented and control frames through byte for byte', () => {
    const compressor = new ServerFrameCompressor()
    const small = encodeServerFrame(0x1, Buffer.alloc(SERVER_COMPRESS_MIN_BYTES - 1, 0x61))
    const ping = encodeServerFrame(0x9, Buffer.alloc(64, 0x62))
    const fragmentOne = buildFrame(0x1, Buffer.alloc(4096, 0x63), { fin: false })
    const fragmentTwo = buildFrame(0x0, Buffer.alloc(4096, 0x64), { fin: true })
    for (const bytes of [small, ping, fragmentOne, fragmentTwo]) {
      expect(compressor.pushChunk(bytes)).toEqual([bytes])
    }
    expect(compressor.bypass).toBe(false)
  })

  it('reassembles a frame split across chunk boundaries before compressing', () => {
    const compressor = new ServerFrameCompressor()
    const payload = Buffer.from(JSON.stringify({ type: 'item', value: 'z'.repeat(50 * 1024) }), 'utf8')
    const encoded = encodeServerFrame(0x1, payload)
    const output: Buffer[] = []
    for (let index = 0; index < encoded.length; index += 1000) {
      output.push(...compressor.pushChunk(encoded.subarray(index, index + 1000)))
    }
    expect(output).toHaveLength(1)
    const parsed = parseFrame(output[0] as Buffer)
    expect(parsed?.rsv1).toBe(true)
    expect(inflateMessage(parsed?.payload as Buffer)).toEqual(payload)
  })
})

interface Harness {
  /** Hand the pair to the code under test; the phone/origin ends stay ours. */
  readonly relay: (head: Buffer) => void
  readonly phoneSends: (bytes: Buffer) => void
  readonly originSends: (bytes: Buffer) => void
  /** The next frame the relay forwarded to the origin. */
  readonly originFrame: () => Promise<Buffer>
  /** The next frame the relay forwarded to the phone. */
  readonly phoneFrame: () => Promise<Buffer>
  readonly close: () => void
}

const sockets: Socket[] = []
const servers: ReturnType<typeof createServer>[] = []

afterEach(() => {
  while (sockets.length > 0) sockets.pop()?.destroy()
  while (servers.length > 0) servers.pop()?.close()
})

/** One end of a real TCP connection, with its peer end. */
async function tcpPair(): Promise<{ near: Socket; far: Socket }> {
  const server = createServer()
  servers.push(server)
  const accepted = new Promise<Socket>((resolve) => { server.once('connection', resolve) })
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
  })
  const near = connect(port, '127.0.0.1')
  sockets.push(near)
  const far = await accepted
  sockets.push(far)
  return { near, far }
}

type Reader = { buffer: Buffer; wake: (() => void)[] }

function collector(socket: Socket): Reader {
  const entry: Reader = { buffer: Buffer.alloc(0), wake: [] }
  socket.on('data', (chunk: Buffer) => {
    entry.buffer = Buffer.concat([entry.buffer, chunk])
    while (entry.wake.length > 0) (entry.wake.shift() as () => void)()
  })
  return entry
}

/** Wait until at least one whole frame has arrived, and hand back its bytes. */
async function nextFrame(entry: Reader): Promise<Buffer> {
  const deadline = Date.now() + 5_000
  for (;;) {
    const frame = parseFrame(entry.buffer)
    if (frame !== undefined) {
      const bytes = entry.buffer.subarray(0, frame.size)
      entry.buffer = entry.buffer.subarray(frame.size)
      return bytes
    }
    if (Date.now() > deadline) throw new Error('timed out waiting for a frame')
    await new Promise<void>((resolve) => { entry.wake.push(resolve) })
  }
}

/**
 * Two socket pairs: the relay's `client` socket is wired to a phone we drive,
 * its `upstream` socket to an origin we drive and observe.
 */
async function harness(options?: { deflate?: boolean }): Promise<Harness> {
  const phoneLink = await tcpPair()
  const originLink = await tcpPair()
  const phoneReads = collector(phoneLink.near)
  const originReads = collector(originLink.near)
  return {
    relay: (head: Buffer) => { relayUpgradedWebSocket(phoneLink.far, originLink.far, head, options) },
    phoneSends: (bytes: Buffer) => { phoneLink.near.write(bytes) },
    originSends: (bytes: Buffer) => { originLink.near.write(bytes) },
    originFrame: () => nextFrame(originReads),
    phoneFrame: () => nextFrame(phoneReads),
    close: () => {
      phoneLink.near.destroy()
      phoneLink.far.destroy()
      originLink.near.destroy()
      originLink.far.destroy()
    },
  }
}

describe('relay wiring', () => {
  it('clamps client frames on their way upstream and leaves the rest of the stream alone', async () => {
    const { relay, phoneSends, originFrame, close } = await harness()
    try {
      // The handshake is already complete by the time either proxy relays.
      relay(Buffer.alloc(0))

      const ping = Buffer.from([0x89, 0x84, 1, 2, 3, 4, 0, 0, 0, 0])
      const cancel = encodeMaskedTextFrame(JSON.stringify({ type: 'cancel', streamId: 'a1b2c3d4-0000-4000-8000-000000000000' }))
      phoneSends(encodeMaskedTextFrame(followFrame()))
      phoneSends(ping)
      phoneSends(cancel)

      const parsed = parseFrame(await originFrame())
      expect(parsed?.masked).toBe(true)
      expect(requestOf(parsed?.payload.toString('utf8') ?? '').maxMessages).toBe(MOBILE_HISTORY_PAGE_MESSAGES)
      // The two frames that needed no rewriting arrive exactly as sent.
      expect(await originFrame()).toEqual(ping)
      expect(await originFrame()).toEqual(cancel)
    } finally {
      close()
    }
  })

  it('leaves upstream bytes untouched when deflate is off', async () => {
    const { relay, originSends, phoneFrame, close } = await harness()
    try {
      relay(Buffer.alloc(0))
      const payload = Buffer.from(JSON.stringify({ type: 'item', streamId: 'x', value: 'z'.repeat(4096) }), 'utf8')
      const length = Buffer.alloc(2)
      length.writeUInt16BE(payload.length)
      const frame = Buffer.concat([Buffer.from([0x81, 126]), length, payload])
      originSends(frame)
      expect(await phoneFrame()).toEqual(frame)
    } finally {
      close()
    }
  })

  it('forwards head bytes through the rewriter before the pipe starts', async () => {
    const { relay, originFrame, close } = await harness()
    try {
      relay(encodeMaskedTextFrame(followFrame()))
      const parsed = parseFrame(await originFrame())
      expect(requestOf(parsed?.payload.toString('utf8') ?? '').maxMessages).toBe(MOBILE_HISTORY_PAGE_MESSAGES)
    } finally {
      close()
    }
  })

  it('relays a negotiated compressed session over real sockets in both directions', async () => {
    const { relay, phoneSends, originSends, originFrame, phoneFrame, close } = await harness({ deflate: true })
    try {
      relay(Buffer.alloc(0))

      // The phone compresses its `session/follow` request with permessage-deflate.
      phoneSends(buildFrame(0x1, deflateMessage(Buffer.from(followFrame(), 'utf8')), { rsv1: true, mask: true }))

      // The upstream still sees one plain masked frame, with the clamp applied.
      const rewritten = parseFrame(await originFrame())
      expect(rewritten?.masked).toBe(true)
      expect(rewritten?.rsv1).toBe(false)
      expect(rewritten?.fin).toBe(true)
      expect(requestOf(rewritten?.payload.toString('utf8') ?? '').maxMessages).toBe(MOBILE_HISTORY_PAGE_MESSAGES)

      // The 200 KB snapshot comes back compressed and inflates to the original.
      const snapshot = Buffer.from(JSON.stringify({ type: 'item', value: 'z'.repeat(200 * 1024) }), 'utf8')
      originSends(encodeServerFrame(0x1, snapshot))
      const returned = parseFrame(await phoneFrame())
      expect(returned?.rsv1).toBe(true)
      expect(returned?.opcode).toBe(0x1)
      expect(inflateMessage(returned?.payload as Buffer)).toEqual(snapshot)
    } finally {
      close()
    }
  })
})
