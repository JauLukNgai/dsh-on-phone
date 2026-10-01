/**
 * Frame-level help for the two WebSocket proxies this plugin runs: the LAN
 * gateway (`gateway.ts`) and the Tailscale Serve passthrough
 * (`remote-proxy.ts`). Both complete the upstream handshake themselves and then
 * hand the socket pair to {@link relayUpgradedWebSocket}, which pipes
 * upstream→client bytes untouched and routes client→upstream bytes through
 * {@link ClientFrameRewriter}.
 *
 * Why rewrite at all: DSH's session controller asks the mux for
 * `session/follow` with `HISTORY_PAGE_OPTIONS = { maxMessages: 500, turnWindow:
 * { minMessages: 50, minTurns: 2 } }`. The host answers one atomic `<snapshot>`
 * frame, and the chat view renders nothing but "载入历史…" until that entire
 * frame has arrived. Measured on a live tool-heavy conversation (2026-09-27,
 * dsh 0.1.7-rc.2): 3,248,792 bytes / 741 records. The same session, requested
 * with a 20-message page, is 508,498 bytes / 116 records — 6.4x less to move
 * before the phone shows anything, and the client keeps loading older pages on
 * demand as the user scrolls up.
 *
 * The page size cannot be changed on the host, and it cannot be changed in the
 * page either: the option set lives inside the bundled session-controller
 * module, not on `window`. The mux payload is plain JSON in a masked text
 * frame, so rewriting it here is the narrowest place that works for the LAN
 * channel, the Tailscale channel, the Android app and a phone browser alike.
 */
import { randomBytes } from 'node:crypto'
import type { Socket } from 'node:net'
import { Transform, type TransformCallback } from 'node:stream'
import { deflateMessage, inflateMessage } from './websocket-deflate.js'

/**
 * Messages the phone is allowed to pull per history page. Deliberately small:
 * each page arrives as one atomic frame, so this number is the phone's
 * time-to-first-content. Older content still loads on demand (`prepend`).
 *
 * Re-measured on a tool-heavy session (2026-09-28) through the phone channel: a
 * 20-message page was 456 KB of JSON / 124 KB on the wire, a 60-message
 * continuation page was 0.9-1.8 MB / 0.2-0.5 MB, and the phone showed nothing
 * but the host's "载入历史…" placeholder until a whole payload had landed. So a
 * page is 12 messages: one tap now stays well under 100 KB on the wire.
 *
 * Measured again on the device's 242-turn session (2026-09-29), frame by frame:
 * a 12-message request still answered with 68-72 records / 184-297 KB, because
 * the host aligns to the turn window the client asked for (two turns) instead of
 * to the message cap. The opening request is therefore also cut to one turn; see
 * {@link clampHistoryRequest}.
 */
export const MOBILE_HISTORY_PAGE_MESSAGES = 12

/**
 * Floor for `turnWindow.minMessages` when this rewrite has to invent a turn
 * window, because the caller sent none. An existing window is instead capped at
 * the page size: the host rejects a request whose `turnWindow.minMessages`
 * exceeds `maxMessages` ("gateway/bad-request"), so every clamp below keeps the
 * two consistent.
 */
export const MOBILE_HISTORY_TURN_MIN_MESSAGES = 8

const OPCODE_TEXT = 0x1
const OPCODE_BINARY = 0x2
const OPCODE_CONTINUATION = 0x0
/** Client frames are small (open/cancel/uplink); anything larger stays raw. */
const MAX_REWRITE_PAYLOAD = 64 * 1024
/** Refuse to buffer an oversized frame header from a client. */
const MAX_CLIENT_FRAME_BYTES = 4 * 1024 * 1024
const SESSION_ENDPOINT_PREFIX = 'session/'

/**
 * Smallest upstream message worth compressing. Below this the deflate framing
 * costs more than it saves, and RFC 7692 lets a frame stay uncompressed with
 * RSV1 clear, so control chatter and tiny `item` deltas travel as they do
 * today. The snapshot item that dominates a phone's switch latency is hundreds
 * of KB; 1 KiB keeps every such frame in scope.
 */
export const SERVER_COMPRESS_MIN_BYTES = 1024

export interface HistoryClampRecord {
  readonly endpoint: string
  readonly sessionId: string | undefined
  readonly requested: number | undefined
  readonly maxMessages: number
  readonly turnMinMessages: number | undefined
  readonly turnMinTurns: number | undefined
}

export interface HistoryClampResult {
  readonly text: string
  readonly record: HistoryClampRecord
}

/** A frame we can measure but must not interpret; callers fall back to raw. */
export class WebSocketFrameError extends Error {}

export interface ParsedFrame {
  readonly fin: boolean
  readonly rsv1: boolean
  readonly opcode: number
  readonly masked: boolean
  readonly payload: Buffer
  readonly size: number
}

/**
 * Parse one frame from the front of `buffer`.
 * @returns the frame, or `undefined` when more bytes are needed.
 * @throws WebSocketFrameError when the header itself is unusable.
 */
export function parseFrame(buffer: Buffer): ParsedFrame | undefined {
  if (buffer.length < 2) return undefined
  const first = buffer[0] as number
  const second = buffer[1] as number
  const fin = (first & 0x80) !== 0
  const rsv1 = (first & 0x40) !== 0
  const opcode = first & 0x0f
  const masked = (second & 0x80) !== 0
  let length = second & 0x7f
  let offset = 2
  if (length === 126) {
    if (buffer.length < 4) return undefined
    length = buffer.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    if (buffer.length < 10) return undefined
    if (buffer.readUInt32BE(2) !== 0) throw new WebSocketFrameError('frame payload length exceeds the supported range')
    length = buffer.readUInt32BE(6)
    offset = 10
  }
  if (length > MAX_CLIENT_FRAME_BYTES) throw new WebSocketFrameError('frame payload is too large to inspect')
  let mask: Buffer | undefined
  if (masked) {
    if (buffer.length < offset + 4) return undefined
    mask = buffer.subarray(offset, offset + 4)
    offset += 4
  }
  if (buffer.length < offset + length) return undefined
  let payload = buffer.subarray(offset, offset + length)
  if (mask !== undefined) {
    const unmasked = Buffer.allocUnsafe(length)
    for (let index = 0; index < length; index += 1) {
      unmasked[index] = (payload[index] as number) ^ (mask[index & 3] as number)
    }
    payload = unmasked
  }
  return { fin, rsv1, opcode, masked, payload, size: offset + length }
}

/** Encode one masked, unfragmented client frame for any data opcode. */
function encodeMaskedFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length
  const header = length < 126 ? Buffer.allocUnsafe(6) : length < 65_536 ? Buffer.allocUnsafe(8) : Buffer.allocUnsafe(14)
  header[0] = 0x80 | (opcode & 0x0f)
  let maskOffset: number
  if (length < 126) {
    header[1] = 0x80 | length
    maskOffset = 2
  } else if (length < 65_536) {
    header[1] = 0x80 | 126
    header.writeUInt16BE(length, 2)
    maskOffset = 4
  } else {
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(length), 2)
    maskOffset = 10
  }
  const mask = randomBytes(4)
  mask.copy(header, maskOffset)
  const body = Buffer.allocUnsafe(length)
  for (let index = 0; index < length; index += 1) {
    body[index] = (payload[index] as number) ^ (mask[index & 3] as number)
  }
  return Buffer.concat([header, body])
}

/** Encode one masked, unfragmented text frame the way a client must send it. */
export function encodeMaskedTextFrame(text: string): Buffer {
  return encodeMaskedFrame(OPCODE_TEXT, Buffer.from(text, 'utf8'))
}

/**
 * Encode one unmasked server frame, optionally marking a compressed message
 * with RSV1. Server frames never carry a mask, and the snapshot payload that
 * motivates compression is hundreds of KB, so all three length forms matter.
 */
export function encodeServerFrame(opcode: number, payload: Buffer, rsv1 = false): Buffer {
  const length = payload.length
  const header = length < 126 ? Buffer.allocUnsafe(2) : length < 65_536 ? Buffer.allocUnsafe(4) : Buffer.allocUnsafe(10)
  header[0] = 0x80 | (rsv1 ? 0x40 : 0x00) | (opcode & 0x0f)
  if (length < 126) {
    header[1] = length
  } else if (length < 65_536) {
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  return Buffer.concat([header, payload])
}

function requestOf(payload: unknown): Record<string, unknown> | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const args = (payload as { args?: unknown }).args
  if (typeof args !== 'object' || args === null) return undefined
  const request = (args as { request?: unknown }).request
  if (typeof request !== 'object' || request === null || Array.isArray(request)) return undefined
  return request as Record<string, unknown>
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

function sessionIdOf(request: Record<string, unknown>): string | undefined {
  const address = request.address
  if (typeof address !== 'object' || address === null) return undefined
  const sessionId = (address as { sessionId?: unknown }).sessionId
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined
}

/**
 * Shrink the history page a mobile client asks for, in place.
 * @returns the rewritten frame text plus what changed, or `undefined` when the
 * text is not a history request this rewrite applies to.
 */
export function clampHistoryRequest(text: string): HistoryClampResult | undefined {
  let frame: unknown
  try {
    frame = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof frame !== 'object' || frame === null) return undefined
  const open = frame as { type?: unknown; endpoint?: unknown; payload?: unknown }
  if (open.type !== 'open' || typeof open.endpoint !== 'string' || !open.endpoint.startsWith(SESSION_ENDPOINT_PREFIX)) {
    return undefined
  }
  const request = requestOf(open.payload)
  if (request === undefined) return undefined
  const requested = positiveInteger(request.maxMessages)
  const paged = open.endpoint === 'session/follow' || open.endpoint === 'session/page'
  if (requested === undefined && !paged) return undefined
  const maxMessages = requested === undefined ? MOBILE_HISTORY_PAGE_MESSAGES : Math.min(requested, MOBILE_HISTORY_PAGE_MESSAGES)
  const turnWindow = request.turnWindow
  const turnMinMessages = typeof turnWindow === 'object' && turnWindow !== null && !Array.isArray(turnWindow)
    ? positiveInteger((turnWindow as { minMessages?: unknown }).minMessages)
    : undefined
  let nextTurnWindow: Record<string, unknown> | undefined
  // The opening frame of a session is the phone's whole time-to-first-content,
  // and the turn window is what actually sizes it: the app asks for two turns,
  // and two turns of this conversation measured 184-297 KB however hard
  // `maxMessages` was clamped (68-72 records answered a 12-message request).
  // The follow request is therefore cut to one turn. Continuation pages keep
  // the app's own two: they land while the user is already reading.
  const opening = open.endpoint === 'session/follow'
  const turnMinTurns = typeof turnWindow === 'object' && turnWindow !== null && !Array.isArray(turnWindow)
    ? positiveInteger((turnWindow as { minTurns?: unknown }).minTurns)
    : undefined
  if (turnMinMessages !== undefined) {
    nextTurnWindow = {
      ...(turnWindow as Record<string, unknown>),
      minMessages: Math.max(1, Math.min(turnMinMessages, maxMessages)),
      ...(opening ? { minTurns: 1 } : {}),
    }
  } else if (turnWindow === undefined) {
    nextTurnWindow = { minMessages: Math.min(MOBILE_HISTORY_TURN_MIN_MESSAGES, maxMessages), minTurns: opening ? 1 : 2 }
  } else {
    return undefined
  }
  if (maxMessages === requested && nextTurnWindow.minMessages === turnMinMessages
    && nextTurnWindow.minTurns === turnMinTurns) {
    return undefined
  }
  const args = (open.payload as { args: Record<string, unknown> }).args
  const next = {
    ...(frame as Record<string, unknown>),
    payload: { ...(open.payload as Record<string, unknown>), args: { ...args, request: { ...request, maxMessages, turnWindow: nextTurnWindow } } },
  }
  return {
    text: JSON.stringify(next),
    record: {
      endpoint: open.endpoint,
      sessionId: sessionIdOf(request),
      requested,
      maxMessages,
      turnMinMessages: positiveInteger(nextTurnWindow.minMessages),
      turnMinTurns: positiveInteger(nextTurnWindow.minTurns),
    },
  }
}

function isDataOpcode(opcode: number): boolean {
  return opcode === OPCODE_TEXT || opcode === OPCODE_BINARY
}

function isControlOpcode(opcode: number): boolean {
  return (opcode & 0x08) !== 0
}

/** One frame of a compressed client message being reassembled. */
interface Fragment {
  /** The frame exactly as it arrived, for the raw-passthrough fallback. */
  readonly raw: Buffer
  /** Its unmasked payload, for the inflate. */
  readonly payload: Buffer
}

/**
 * Rewrites client→upstream frames. Anything it cannot safely parse is passed
 * through verbatim for the rest of the connection: a mis-parse must degrade to
 * today's raw pipe, never to a corrupted mux stream.
 *
 * With `deflate` on — the client negotiated permessage-deflate and upstream
 * frames from this client may carry RSV1 — a compressed message (an RSV1 first
 * frame plus RSV1-clear continuations) is inflated and re-emitted as one plain
 * masked frame. Compressed bytes cannot be forwarded verbatim: the upstream mux
 * declined the extension, so it would read deflate output as JSON and corrupt
 * the connection. A failed inflate, an oversized buffer or an unexpected frame
 * mid-message therefore falls back to the class's raw passthrough (see
 * {@link ClientFrameRewriter.bypass}) — the connection is already lost at that
 * point, but nothing we emit claims to be a message it is not.
 */
export class ClientFrameRewriter extends Transform {
  private buffer: Buffer = Buffer.alloc(0)
  private bypassed = false
  private fragments: Fragment[] | undefined
  private fragmentOpcode: number = OPCODE_TEXT
  private fragmentLength = 0

  constructor(
    private readonly onClamp?: (record: HistoryClampRecord) => void,
    private readonly deflate = false,
  ) {
    super()
  }

  /** True once the rewriter gave up and became a passthrough. */
  get bypass(): boolean {
    return this.bypassed
  }

  /** Consume a chunk and return the bytes to forward, in order. */
  pushChunk(chunk: Buffer): Buffer[] {
    if (this.bypassed) return chunk.length === 0 ? [] : [chunk]
    if (chunk.length === 0) return []
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const output: Buffer[] = []
    while (this.buffer.length > 0) {
      let frame: ParsedFrame | undefined
      try {
        frame = parseFrame(this.buffer)
      } catch {
        this.bypassed = true
        output.push(this.buffer)
        this.buffer = Buffer.alloc(0)
        return output
      }
      if (frame === undefined) break
      const consumed = this.buffer.subarray(0, frame.size)
      this.buffer = this.buffer.subarray(frame.size)
      const rewritten = this.rewrite(frame, consumed)
      if (rewritten !== undefined) output.push(rewritten)
      if (this.bypassed) {
        // A failed inflate cannot be repaired frame by frame; the rest of the
        // buffered stream is handed on verbatim, exactly like a parse failure.
        if (this.buffer.length > 0) {
          output.push(this.buffer)
          this.buffer = Buffer.alloc(0)
        }
        return output
      }
    }
    return output
  }

  /** @inheritdoc */
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    for (const frame of this.pushChunk(chunk)) this.push(frame)
    callback()
  }

  private rewrite(frame: ParsedFrame, consumed: Buffer): Buffer | undefined {
    if (this.fragments !== undefined) return this.continueMessage(frame, consumed)
    // RFC 6455 requires client frames to be masked; an unmasked RSV1 frame is
    // not something to guess about, so it keeps the old verbatim path.
    if (this.deflate && frame.rsv1 && frame.masked && isDataOpcode(frame.opcode)) {
      this.fragments = [{ raw: consumed, payload: frame.payload }]
      this.fragmentOpcode = frame.opcode
      this.fragmentLength = frame.payload.length
      if (this.fragmentLength > MAX_REWRITE_PAYLOAD) return this.abandonMessage()
      return frame.fin ? this.finishMessage() : undefined
    }
    return this.rewriteText(frame, consumed)
  }

  /** Accumulate the fragments of one compressed message. */
  private continueMessage(frame: ParsedFrame, consumed: Buffer): Buffer | undefined {
    const fragments = this.fragments as Fragment[]
    // A control frame may legally sit between fragments and keeps its place.
    if (isControlOpcode(frame.opcode)) return consumed
    fragments.push({ raw: consumed, payload: frame.payload })
    if (frame.opcode !== OPCODE_CONTINUATION || frame.rsv1 || !frame.masked) return this.abandonMessage()
    this.fragmentLength += frame.payload.length
    if (this.fragmentLength > MAX_REWRITE_PAYLOAD) return this.abandonMessage()
    return frame.fin ? this.finishMessage() : undefined
  }

  /** Inflate a completed message and re-emit it as one plain masked frame. */
  private finishMessage(): Buffer {
    const fragments = this.fragments as Fragment[]
    const opcode = this.fragmentOpcode
    const compressed = fragments.length === 1
      ? (fragments[0] as Fragment).payload
      : Buffer.concat(fragments.map(fragment => fragment.payload))
    let payload: Buffer
    try {
      // The upstream mux frame cap bounds the inflate, so a few KB of deflate
      // cannot be expanded into an unbounded allocation.
      payload = inflateMessage(compressed, MAX_CLIENT_FRAME_BYTES)
    } catch {
      return this.abandonMessage()
    }
    this.fragments = undefined
    this.fragmentOpcode = OPCODE_TEXT
    this.fragmentLength = 0
    // A compressed request is still a request: the history clamp applies to
    // what was inflated, exactly as it does to a plain text frame.
    const clamped = opcode === OPCODE_TEXT ? clampHistoryRequest(payload.toString('utf8')) : undefined
    if (clamped !== undefined) {
      this.onClamp?.(clamped.record)
      return encodeMaskedTextFrame(clamped.text)
    }
    return encodeMaskedFrame(opcode, payload)
  }

  /**
   * Give up on a compressed message and stop interpreting the stream.
   *
   * The frames themselves go on unchanged, RSV1 and all. That does end the
   * connection — the mux never agreed to permessage-deflate, so it reads an
   * RSV1 frame as a protocol error — and that is the point: a message we could
   * not inflate cannot be turned back into a message, and the alternatives are
   * worse. Re-emitting the compressed bytes as a plain frame would hand the mux
   * deflate output to parse as JSON, and dropping them would silently lose an
   * uplink frame. Nothing downstream is interpreted from here on; the caller
   * hands the rest of the buffered stream straight through.
   */
  private abandonMessage(): Buffer {
    const fragments = this.fragments ?? []
    this.fragments = undefined
    this.fragmentOpcode = OPCODE_TEXT
    this.fragmentLength = 0
    this.bypassed = true
    return Buffer.concat(fragments.map(fragment => fragment.raw))
  }

  private rewriteText(frame: ParsedFrame, consumed: Buffer): Buffer {
    // Only whole, unmasked-by-us, uncompressed text frames are worth reading,
    // and only when the client actually masked them (RFC 6455 requires it).
    if (!frame.fin || frame.rsv1 || frame.opcode !== OPCODE_TEXT || !frame.masked
      || frame.payload.length === 0 || frame.payload.length > MAX_REWRITE_PAYLOAD) {
      return consumed
    }
    const clamped = clampHistoryRequest(frame.payload.toString('utf8'))
    if (clamped === undefined) return consumed
    this.onClamp?.(clamped.record)
    return encodeMaskedTextFrame(clamped.text)
  }
}

/**
 * Compresses upstream→client messages once the phone negotiated
 * permessage-deflate. Only complete single-frame data messages of at least
 * {@link SERVER_COMPRESS_MIN_BYTES} are compressed: RFC 7692 lets any frame
 * stay uncompressed with RSV1 clear, so fragmented messages, control frames,
 * small deltas and anything this class cannot parse confidently pass through
 * byte for byte. Client→upstream never flows through here.
 */
export class ServerFrameCompressor extends Transform {
  private buffer: Buffer = Buffer.alloc(0)
  private bypassed = false

  /** True once the compressor gave up and became a passthrough. */
  get bypass(): boolean {
    return this.bypassed
  }

  /** Consume a chunk and return the bytes to forward, in order. */
  pushChunk(chunk: Buffer): Buffer[] {
    if (this.bypassed) return chunk.length === 0 ? [] : [chunk]
    if (chunk.length === 0) return []
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const output: Buffer[] = []
    while (this.buffer.length > 0) {
      let frame: ParsedFrame | undefined
      try {
        frame = parseFrame(this.buffer)
      } catch {
        // An upstream frame this parser refuses (today: larger than the 4 MiB
        // inspect cap) stays uncompressed; the client reads it fine, because a
        // frame without RSV1 is an ordinary message under the extension too.
        this.bypassed = true
        output.push(this.buffer)
        this.buffer = Buffer.alloc(0)
        return output
      }
      if (frame === undefined) break
      const consumed = this.buffer.subarray(0, frame.size)
      this.buffer = this.buffer.subarray(frame.size)
      output.push(this.compress(frame, consumed))
    }
    return output
  }

  /** @inheritdoc */
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    for (const frame of this.pushChunk(chunk)) this.push(frame)
    callback()
  }

  private compress(frame: ParsedFrame, consumed: Buffer): Buffer {
    if (!frame.fin || frame.rsv1 || !isDataOpcode(frame.opcode) || frame.payload.length < SERVER_COMPRESS_MIN_BYTES) {
      return consumed
    }
    return encodeServerFrame(frame.opcode, deflateMessage(frame.payload), true)
  }
}

/** Options for {@link relayUpgradedWebSocket}. */
export interface RelayOptions {
  /** Called for every history request the rewriter clamped. */
  readonly onClamp?: (record: HistoryClampRecord) => void
  /** True once permessage-deflate was negotiated with the client. */
  readonly deflate?: boolean
}

/**
 * Wire an upgraded socket pair: upstream→client goes straight to the client
 * (or through a {@link ServerFrameCompressor} when `deflate` is on), client→
 * upstream goes through {@link ClientFrameRewriter}.
 *
 * `head` is the data that arrived with the upgrade request, so it must be
 * forwarded through the same rewriter ahead of the piped bytes to keep frame
 * order intact.
 */
export function relayUpgradedWebSocket(
  client: Socket,
  upstream: Socket,
  head: Buffer,
  options?: RelayOptions,
): ClientFrameRewriter {
  const rewriter = new ClientFrameRewriter(options?.onClamp, options?.deflate === true)
  if (head.length > 0) {
    for (const chunk of rewriter.pushChunk(head)) upstream.write(chunk)
  }
  // A phone can spend minutes draining one snapshot over a slow link; no idle
  // timer on either socket may cut that short. The device-session timer owns
  // the connection's lifetime instead.
  client.setTimeout(0)
  upstream.setTimeout(0)
  if (options?.deflate === true) {
    upstream.pipe(new ServerFrameCompressor()).pipe(client)
  } else {
    upstream.pipe(client)
  }
  client.pipe(rewriter).pipe(upstream)
  client.resume()
  return rewriter
}
