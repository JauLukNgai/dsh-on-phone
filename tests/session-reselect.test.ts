import { describe, expect, it, vi } from 'vitest'

import { reselectSession } from '../src/session-reselect.js'

describe('reselectSession', () => {
  it('asks the app to open the session again, on the service itself', () => {
    const calls: Array<{ id: string; self: unknown }> = []
    const workspace = {
      openSession(this: unknown, sessionId: string): void {
        calls.push({ id: sessionId, self: this })
      },
    }
    expect(reselectSession(workspace, 'session-1')).toBe(true)
    expect(calls).toEqual([{ id: 'session-1', self: workspace }])
  })

  it('refuses, without throwing, for anything that is not the service', () => {
    for (const value of [undefined, null, 0, 'uiWorkspace', {}, { openSession: 5 }]) {
      expect(reselectSession(value, 'session-1')).toBe(false)
    }
    expect(reselectSession({ openSession: vi.fn() }, '')).toBe(false)
  })

  it('reports a refusal when the app throws instead of navigating', () => {
    const openSession = vi.fn(() => { throw new Error('no such session') })
    expect(reselectSession({ openSession }, 'session-1')).toBe(false)
    expect(openSession).toHaveBeenCalledWith('session-1')
  })

  it('reports a refusal when reading the method itself throws', () => {
    const workspace = Object.defineProperty({}, 'openSession', {
      get(): never { throw new Error('half-built service') },
    })
    expect(reselectSession(workspace, 'session-1')).toBe(false)
  })
})
