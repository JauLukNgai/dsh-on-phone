import { randomBytes } from 'node:crypto'
import { deflateRawSync, Z_SYNC_FLUSH } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  DEFLATE_EXTENSION,
  deflateMessage,
  inflateMessage,
  offersPerMessageDeflate,
} from '../src/websocket-deflate.js'

describe('permessage-deflate negotiation', () => {
  it('advertises independent messages with no context takeover', () => {
    // The rewriters inflate/deflate one message at a time and can drop into raw
    // passthrough, so neither side may rely on a sliding window.
    expect(DEFLATE_EXTENSION).toBe('permessage-deflate; server_no_context_takeover; client_no_context_takeover')
  })

  it('accepts a single offer, with or without parameters', () => {
    expect(offersPerMessageDeflate('permessage-deflate')).toBe(true)
    expect(offersPerMessageDeflate('permessage-deflate; client_max_window_bits')).toBe(true)
    expect(offersPerMessageDeflate('  PerMessage-Deflate  ')).toBe(true)
  })

  it('finds the token inside a comma-separated offer list', () => {
    expect(offersPerMessageDeflate('x-webkit-deflate-frame, permessage-deflate; client_max_window_bits')).toBe(true)
    expect(offersPerMessageDeflate('x-webkit-deflate-frame, permessage-deflate')).toBe(true)
  })

  it('refuses anything that is not the extension', () => {
    expect(offersPerMessageDeflate(undefined)).toBe(false)
    expect(offersPerMessageDeflate('')).toBe(false)
    expect(offersPerMessageDeflate('x-webkit-deflate-frame')).toBe(false)
    // A parameter that merely names the token is not an offer.
    expect(offersPerMessageDeflate('x-custom; permessage-deflate')).toBe(false)
  })

  it('accepts a repeated header delivered as an array', () => {
    expect(offersPerMessageDeflate(['x-webkit-deflate-frame', 'permessage-deflate'])).toBe(true)
    expect(offersPerMessageDeflate(['x-webkit-deflate-frame'])).toBe(false)
  })
})

describe('permessage-deflate codec', () => {
  it('round-trips an empty payload', () => {
    expect(inflateMessage(deflateMessage(Buffer.alloc(0)))).toEqual(Buffer.alloc(0))
  })

  it('round-trips a 300 KB text payload', () => {
    const payload = Buffer.from(`{"type":"item","value":"${'z'.repeat(300 * 1024)}"}`, 'utf8')
    const compressed = deflateMessage(payload)
    expect(compressed.length).toBeLessThan(payload.length)
    expect(inflateMessage(compressed)).toEqual(payload)
  })

  it('round-trips random binary that does not compress', () => {
    const payload = randomBytes(300 * 1024)
    expect(inflateMessage(deflateMessage(payload))).toEqual(payload)
  })

  it('strips exactly the tail the peer re-appends', () => {
    const payload = Buffer.from('hello'.repeat(1000))
    const withTail = deflateRawSync(payload, { flush: Z_SYNC_FLUSH, finishFlush: Z_SYNC_FLUSH })
    expect(withTail.subarray(withTail.length - 4)).toEqual(Buffer.from([0x00, 0x00, 0xff, 0xff]))
    expect(deflateMessage(payload)).toEqual(withTail.subarray(0, withTail.length - 4))
  })

  it('refuses to inflate past a caller bound', () => {
    // A few KB of deflate can expand ~1000x, so the rewriter bounds the output.
    const compressed = deflateMessage(Buffer.alloc(64 * 1024, 0x41))
    expect(() => inflateMessage(compressed, 128)).toThrow()
  })
})
