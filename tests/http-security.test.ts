import { describe, expect, it } from 'vitest'
import { WS_PATHS, isAllowedWebSocketPath } from '../src/http-security.js'

describe('websocket allowlist', () => {
  it('accepts the mux channel this DSH generation actually serves', () => {
    expect(isAllowedWebSocketPath('/api/remote.mux')).toBe(true)
  })

  it('accepts the legacy mux channels so an older host keeps working', () => {
    for (const path of WS_PATHS) expect(isAllowedWebSocketPath(path)).toBe(true)
  })

  it('accepts a renamed or newly added mux channel without a plugin release', () => {
    // The concrete names already changed once (`events.mux` -> `remote.mux`),
    // which is exactly what a name-pinned allowlist failed to survive.
    expect(isAllowedWebSocketPath('/api/events.mux.renamed')).toBe(false)
    expect(isAllowedWebSocketPath('/api/session.mux')).toBe(true)
    expect(isAllowedWebSocketPath('/api/anything-1_2.3.mux')).toBe(true)
  })

  it('still refuses an upgrade that is not a mux channel', () => {
    expect(isAllowedWebSocketPath('/api/events.unknown')).toBe(false)
    expect(isAllowedWebSocketPath('/api/mobile-access/lan/control')).toBe(false)
    expect(isAllowedWebSocketPath('/events.mux')).toBe(false)
    expect(isAllowedWebSocketPath('/api/.mux')).toBe(false)
    expect(isAllowedWebSocketPath('/api/sub/dir.mux')).toBe(false)
    expect(isAllowedWebSocketPath('/api/remote.mux/extra')).toBe(false)
  })
})
