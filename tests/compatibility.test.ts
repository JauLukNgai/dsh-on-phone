import { describe, expect, it, vi } from 'vitest'
import {
  assertSupportedDshVersion,
  isSupportedDshVersion,
  SUPPORTED_DSH_VERSIONS,
  warnUnsupportedDshVersion,
} from '../src/compatibility.js'

describe('DeepSeek Harness compatibility', () => {
  it.each(SUPPORTED_DSH_VERSIONS)('accepts verified release %s', version => {
    expect(() => { assertSupportedDshVersion(version) }).not.toThrow()
  })

  it.each(['0.1.0-rc.4', '0.1.0-rc.8', '0.1.1-rc.1', '0.1.1', '0.1.2'])('rejects unverified release %s', version => {
    expect(() => { assertSupportedDshVersion(version) }).toThrow(/unsupported DeepSeek Harness version/u)
  })

  it('allows an unresolvable version (desktop bundles the host internally)', () => {
    expect(() => { assertSupportedDshVersion('unknown') }).not.toThrow()
    expect(() => { assertSupportedDshVersion(undefined) }).not.toThrow()
  })

  // The desktop app ships a later prerelease of an already-verified line; the
  // plugin must accept it rather than refuse to activate.
  it('accepts the verified 0.1.2 release candidate', () => {
    expect(SUPPORTED_DSH_VERSIONS).toContain('0.1.2-rc.1')
    expect(warnUnsupportedDshVersion('0.1.2-rc.1')).toBe(false)
  })

  it('warns about an unverified version instead of aborting activation', () => {
    // A throwing activation gate fails the loader entry, which fails the whole
    // plugin tree and drops DSH Desktop into safe mode with every third-party
    // plugin disabled, so this path must never throw.
    const emitWarning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    let warned: boolean | undefined
    try {
      expect(() => { warned = warnUnsupportedDshVersion('0.1.2') }).not.toThrow()
      expect(warned).toBe(true)
      expect(warnUnsupportedDshVersion('unknown')).toBe(false)
      expect(warnUnsupportedDshVersion(undefined)).toBe(false)
      expect(emitWarning).toHaveBeenCalledTimes(1)
      const [message, options] = emitWarning.mock.calls[0] as [string, { code?: string }]
      expect(message).toContain('0.1.2')
      expect(options.code).toBe('DSH_ON_PHONE_UNVERIFIED_DSH_VERSION')
    } finally {
      emitWarning.mockRestore()
    }
  })

  it('treats only a known version outside the verified set as unsupported', () => {
    expect(isSupportedDshVersion('unknown')).toBe(true)
    expect(isSupportedDshVersion(undefined)).toBe(true)
    expect(isSupportedDshVersion('0.1.2-rc.1')).toBe(true)
    expect(isSupportedDshVersion('0.1.2')).toBe(false)
    expect(isSupportedDshVersion(123)).toBe(true)
  })
})
