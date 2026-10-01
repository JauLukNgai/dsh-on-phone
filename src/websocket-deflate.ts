/**
 * RFC 7692 `permessage-deflate` between the phone and this plugin's two
 * WebSocket proxies. The mux socket is where a phone's switch latency lives:
 * the frame that opens a session (`session/follow`) arrives as one atomic
 * `snapshot` item, measured at 118-297 KB on the wire (2026-09-29, dsh
 * 0.1.7-rc.2), while the same server's HTTP responses are gzipped — a
 * 157,869-byte page body arrived as 32,086 bytes. JSON that compressible means
 * the phone waits several times longer than it must before the chat view shows
 * anything.
 *
 * The upstream DSH mux stays plain. It declines the extension today (its 101
 * carries `Sec-WebSocket-Extensions: ""`), so the proxies accept the client's
 * offer on the proxy's own behalf and never forward the offer upstream; see the
 * upgrade handlers in `gateway.ts` and `remote-proxy.ts`.
 *
 * `Z_SYNC_FLUSH` is read off `constants` rather than imported by name: Node's
 * ESM facade for `node:zlib` exports the functions and `constants` but *not*
 * the bare constants, so `import { Z_SYNC_FLUSH } from 'node:zlib'` is a
 * module-load `SyntaxError` in the built `lib/index.mjs` — and a test runner
 * that resolves the builtin through its own interop reports `undefined`
 * instead, which no unit test can see.
 * @module dsh-on-phone/websocket-deflate
 */
import { constants, deflateRawSync, inflateRawSync } from 'node:zlib'

/**
 * The extension token the proxies put in the 101 response when they accept the
 * client's offer. Both context-takeover flags are off: every message is
 * independently inflatable/deflatable, so the frame-level rewriters never have
 * to keep a sliding window across messages, and a rewriter that drops into raw
 * passthrough cannot silently depend on state it no longer tracks.
 */
export const DEFLATE_EXTENSION = 'permessage-deflate; server_no_context_takeover; client_no_context_takeover'

/**
 * The empty stored block RFC 7692 strips from a deflate stream to turn it into
 * an extension message, and the peer appends again before inflating:
 * `0x00 0x00 0xff 0xff`.
 */
const DEFLATE_TAIL = Buffer.from([0x00, 0x00, 0xff, 0xff])

/**
 * Whether a `Sec-WebSocket-Extensions` header value offers `permessage-deflate`.
 * Header values are a comma-separated list of extension tokens, each optionally
 * followed by `;`-separated parameters (`permessage-deflate;
 * client_max_window_bits`), and a repeated header arrives as an array.
 * @param value - Raw header value, already case-folded by Node into an array
 * when the client sent the header more than once.
 * @returns Whether any offered extension token is `permessage-deflate`.
 */
export function offersPerMessageDeflate(value: string | string[] | undefined): boolean {
  if (value === undefined) return false
  const entries = Array.isArray(value) ? value : [value]
  return entries.some(entry => entry.split(',').some(token => token.split(';')[0]?.trim().toLowerCase() === 'permessage-deflate'))
}

/**
 * Turn one WebSocket message payload into an RFC 7692 deflate message: raw
 * deflate, sync-flushed, with the trailing empty block stripped.
 * @param payload - Uncompressed message payload.
 * @returns The compressed message, without the `00 00 ff ff` tail.
 */
export function deflateMessage(payload: Buffer): Buffer {
  const compressed = deflateRawSync(payload, { flush: constants.Z_SYNC_FLUSH, finishFlush: constants.Z_SYNC_FLUSH })
  if (compressed.length >= 4 && compressed.readUInt32BE(compressed.length - 4) === 0x0000_ffff) {
    return compressed.subarray(0, compressed.length - 4)
  }
  return compressed
}

/**
 * Invert {@link deflateMessage}.
 * @param payload - A deflate message, without the `00 00 ff ff` tail.
 * @param maxOutputLength - Refuse to materialize more than this many bytes. A
 * few KB of deflate can expand ~1000x, so the frame rewriter passes the
 * upstream frame cap here rather than letting a hostile peer allocate without
 * bound. Omitted by callers that already bounded the input.
 * @returns The original uncompressed payload.
 */
export function inflateMessage(payload: Buffer, maxOutputLength?: number): Buffer {
  return inflateRawSync(
    Buffer.concat([payload, DEFLATE_TAIL]),
    maxOutputLength === undefined ? { finishFlush: constants.Z_SYNC_FLUSH } : { finishFlush: constants.Z_SYNC_FLUSH, maxOutputLength },
  )
}
