import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { configuredRemoteProvider, JsonRemoteProviderStore, parseRemoteProviderState } from '../src/remote.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('remote provider selection', () => {
  it('accepts only one supported provider and no extra fields', () => {
    expect(parseRemoteProviderState({ version: 1, provider: 'tailscale' })).toEqual({ version: 1, provider: 'tailscale' })
    expect(() => parseRemoteProviderState({ version: 1, provider: 'cpolar' })).toThrow('unsupported format')
    expect(() => parseRemoteProviderState({ version: 1, provider: 'other' })).toThrow('unsupported format')
    expect(() => parseRemoteProviderState({ version: 1, provider: 'tailscale', token: 'secret' })).toThrow('unsupported format')
  })

  it('uses the environment only for the first-run default', async () => {
    expect(configuredRemoteProvider({})).toBe('tailscale')
    expect(() => configuredRemoteProvider({ DSH_ON_PHONE_REMOTE_PROVIDER: 'cpolar' })).toThrow('must be tailscale')
    expect(() => configuredRemoteProvider({ DSH_ON_PHONE_REMOTE_PROVIDER: 'invalid' })).toThrow('must be tailscale')
    // The pre-rename spelling still resolves, and the new one wins.
    expect(configuredRemoteProvider({ DSH_MOBILE_REMOTE_PROVIDER: 'tailscale' })).toBe('tailscale')
    expect(() => configuredRemoteProvider({ DSH_MOBILE_REMOTE_PROVIDER: 'cpolar' })).toThrow('DSH_MOBILE_REMOTE_PROVIDER must be tailscale')
    expect(configuredRemoteProvider({ DSH_ON_PHONE_REMOTE_PROVIDER: 'tailscale', DSH_MOBILE_REMOTE_PROVIDER: 'cpolar' })).toBe('tailscale')

    const directory = await mkdtemp(join(tmpdir(), 'dsh-on-phone-remote-provider-'))
    temporaryDirectories.push(directory)
    const file = join(directory, 'state', 'provider.json')
    const store = new JsonRemoteProviderStore(file, 'tailscale')
    expect(await store.load()).toEqual({ version: 1, provider: 'tailscale' })
    await expect(store.save({ version: 1, provider: 'cpolar' } as never)).rejects.toThrow('unsupported format')
      expect(await new JsonRemoteProviderStore(file, 'tailscale').load()).toEqual({ version: 1, provider: 'tailscale' })
  })
})
