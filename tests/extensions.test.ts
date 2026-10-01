import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MobileAccessService, MobileExtensionError, parseExtensionManifest } from '../src/extensions.js'

const contexts: Context[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('mobile extension registry', () => {
  it('validates manifests and rejects duplicate ids', () => {
    expect(parseExtensionManifest({ schemaVersion: 1, id: 'hello-world', name: 'Hello', version: '1.0.0' })).toMatchObject({ id: 'hello-world' })
    expect(() => parseExtensionManifest({ schemaVersion: 1, id: '../escape', name: 'bad', version: '1' })).toThrow(MobileExtensionError)
    const context = new Context(); contexts.push(context)
    const service = new MobileAccessService(context)
    const definition = { schemaVersion: 1 as const, id: 'sample', name: 'Sample', version: '1.0.0', actions: { ping: { run: async () => ({ ok: true }) } } }
    const dispose = service.registerExtension(definition)
    expect(() => service.registerExtension(definition)).toThrow(/already registered/)
    expect(service.manifest()).toEqual([{ schemaVersion: 1, id: 'sample', name: 'Sample', version: '1.0.0' }])
    dispose()
    expect(service.manifest()).toEqual([])
  })

  it('loads local host actions and swaps generations without exposing traversal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-on-phone-extensions-')); directories.push(root)
    const directory = join(root, 'demo')
    await (await import('node:fs/promises')).mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'extension.json'), JSON.stringify({ schemaVersion: 1, id: 'demo', name: 'Demo', version: '1.0.0' }))
    await writeFile(join(directory, 'mobile.js'), 'window.dshMobile.define({ apiVersion: 1, id: "demo", activate() {} })')
    await writeFile(join(directory, 'host.mjs'), 'export default async api => api.action("ping", { async run() { return { version: 1 } } })')
    const context = new Context(); contexts.push(context)
    const service = new MobileAccessService(context)
    await service.startLocal(root, context)
    expect(service.manifest()).toMatchObject([{ id: 'demo', scriptUrl: '/mobile-access/extensions/demo/mobile.js' }])
    await expect(service.invoke('demo', 'ping', {}, { deviceId: 'device', signal: new AbortController().signal })).resolves.toEqual({ version: 1 })
    const revoked = new AbortController()
    revoked.abort(new Error('device_revoked'))
    await expect(service.readClientFile('demo', 'script', revoked.signal)).rejects.toThrow('device_revoked')
    await expect(service.readAsset('demo', '../secret')).rejects.toThrow()
    await writeFile(join(directory, 'host.mjs'), 'export default async api => api.action("ping", { async run() { return { version: 2 } } })')
    await service.refreshLocal()
    await expect(service.invoke('demo', 'ping', {}, { deviceId: 'device', signal: new AbortController().signal })).resolves.toEqual({ version: 2 })
    await service.stopLocal()
    expect(service.manifest()).toEqual([])
  })
})
