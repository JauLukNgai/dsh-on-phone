import { describe, expect, it } from 'vitest'

import { SESSION_RETENTION_SOURCE, hasOtherHolder, holdSessionOpen } from '../src/session-hold.js'

interface FakeReference {
  release: () => void
  ready: Promise<unknown>
}

/** A session controller that records retains and publishes a retention row. */
function fakeSessions(initial: Record<string, number> = { mainView: 1 }): {
  service: {
    retain: (target: string, options: { source: string }) => FakeReference
    retentionSnapshot: (sessionId: string) => { referenceCount: number; retainedBy: Record<string, number> } | undefined
  }
  retains: Array<{ id: string; source: string }>
  releases: number[]
  by: Record<string, number>
} {
  const retains: Array<{ id: string; source: string }> = []
  const releases: number[] = []
  const by = { ...initial }
  const service = {
    retain(target: string, options: { source: string }): FakeReference {
      retains.push({ id: target, source: options.source })
      by[options.source] = (by[options.source] ?? 0) + 1
      return {
        ready: Promise.resolve(),
        release: (): void => {
          releases.push(releases.length)
          by[options.source] = (by[options.source] ?? 1) - 1
        },
      }
    },
    retentionSnapshot(sessionId: string): { referenceCount: number; retainedBy: Record<string, number> } | undefined {
      if (sessionId === 'unknown') return undefined
      let referenceCount = 0
      for (const count of Object.values(by)) referenceCount += count
      return { referenceCount, retainedBy: { ...by } }
    },
  }
  return { service, retains, releases, by }
}

describe('hasOtherHolder', () => {
  it('ignores this plugin\'s own source and reports the app\'s', () => {
    const { service } = fakeSessions({ mainView: 1 })
    expect(hasOtherHolder(service, 'session-1')).toBe(true)
    expect(hasOtherHolder(service, 'unknown')).toBe(true)
  })

  it('reports no other holder when only this plugin holds the session', () => {
    const { service } = fakeSessions({})
    expect(hasOtherHolder(service, 'session-1')).toBe(false)
  })

  it('reads an app without retention rows as still holding', () => {
    expect(hasOtherHolder(undefined, 'session-1')).toBe(true)
    expect(hasOtherHolder({}, 'session-1')).toBe(true)
    const throwing = {
      retentionSnapshot(): never {
        throw new Error('half-built service')
      },
    }
    expect(hasOtherHolder(throwing, 'session-1')).toBe(true)
  })
})

describe('holdSessionOpen', () => {
  it('retains under this plugin\'s own source, and gives it back once', () => {
    const { service, retains, releases } = fakeSessions({ mainView: 1 })
    const handle = holdSessionOpen(service, 'session-1')
    expect(handle?.sessionId).toBe('session-1')
    expect(retains).toEqual([{ id: 'session-1', source: SESSION_RETENTION_SOURCE }])
    expect(handle?.soleHolder()).toBe(false)
    handle?.release('app')
    handle?.release('app')
    expect(releases).toHaveLength(1)
    expect(handle?.soleHolder()).toBe(false)
  })

  it('reports itself as the only holder while the app has dropped the session', () => {
    const { service, by } = fakeSessions({})
    const handle = holdSessionOpen(service, 'session-1')
    expect(handle?.soleHolder()).toBe(true)
    by.mainView = 1
    expect(handle?.soleHolder()).toBe(false)
  })

  it('refuses, without throwing, when there is nothing to retain with', () => {
    expect(holdSessionOpen(undefined, 'session-1')).toBeUndefined()
    expect(holdSessionOpen({}, 'session-1')).toBeUndefined()
    expect(holdSessionOpen({ retain: 5 }, 'session-1')).toBeUndefined()
    expect(holdSessionOpen({ retain: (): unknown => undefined }, 'session-1')).toBeUndefined()
    const service = {
      retain(): never {
        throw new Error('unknown session')
      },
    }
    expect(holdSessionOpen(service, 'session-1')).toBeUndefined()
    const { service: held } = fakeSessions()
    expect(holdSessionOpen(held, '')).toBeUndefined()
  })

  it('swallows a reference whose open is abandoned', () => {
    const service = {
      retain: () => ({ ready: Promise.reject(new Error('released')), release: (): void => undefined }),
    }
    expect(() => holdSessionOpen(service, 'session-1')).not.toThrow()
  })
})
