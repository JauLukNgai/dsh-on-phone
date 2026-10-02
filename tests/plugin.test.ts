import { Context } from '@deepseek-ai/cordis'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import { createServer, request as requestHttp } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Config } from '../src/config.js'
import { apply, inject } from '../src/plugin.js'
import { DSH_ON_PHONE_VERSION, MINIMUM_ANDROID_APP_VERSION } from '../src/version.js'

const contexts: Context[] = []
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function invoke(route: WebRoute, method: 'GET' | 'POST', path: string, body = ''): Promise<{ status: number; body: string }> {
  const server = createServer((request, response) => { void route.handler(request, response) })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port
  try {
    return await new Promise((resolve, reject) => {
      const request = requestHttp({
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          host: `127.0.0.1:${String(port)}`,
          ...(method === 'POST' ? {
            origin: `http://127.0.0.1:${String(port)}`,
            'sec-fetch-site': 'same-origin',
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
          } : {}),
        },
      }, (response) => {
        const chunks: Buffer[] = []
        response.on('data', chunk => chunks.push(Buffer.from(chunk)))
        response.on('end', () => resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        }))
      })
      request.once('error', reject)
      if (body !== '') request.write(body)
      request.end()
    })
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()) })
  }
}

async function mount(initiallyEnabled = false): Promise<{ context: Context; route: WebRoute; command: CommandDefinition }> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-on-phone-plugin-'))
  temporaryDirectories.push(directory)
  const routes: WebRoute[] = []
  let command: CommandDefinition | undefined
  const context = new Context()
  contexts.push(context)
  context.provide('webServer', {
    register(candidate: WebRoute) {
      routes.push(candidate)
      return () => {
        const index = routes.indexOf(candidate)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  } as WebServer)
  context.provide('commands', {
    register(definition: CommandDefinition) {
      command = definition
      return () => { if (command === definition) command = undefined }
    },
  } as never)
  context.provide('connection', {
    authenticatedUrl(baseUrl: string) {
      return `${baseUrl}/?token=test-launch-token`
    },
  } as never)
  await context.plugin({ Config, inject, apply }, {
    listenPort: 38083,
    stateFile: join(directory, 'devices.json'),
    controlFile: join(directory, 'control.json'),
    customCssFile: join(directory, 'mobile.css'),
    customScriptFile: join(directory, 'mobile.js'),
    initiallyEnabled,
    tls: { mode: 'disabled' },
  })
  const route = routes.find(candidate => candidate.kind === 'prefix' && candidate.path === '/api/mobile-access')
  if (route === undefined) throw new Error('plugin did not register its control route')
  if (command === undefined) throw new Error('plugin did not register its /mobile command')
  return { context, route, command }
}

describe('stock DSH lifecycle', () => {
  it('requires the WebServer, commands, and Connection services', () => {
    expect(inject).toEqual(['webServer', 'commands', 'connection'])
  })

  it('keeps a loopback control route available while the LAN listener is stopped', async () => {
    const mounted = await mount()
    expect(mounted.route).toMatchObject({ kind: 'prefix', path: '/api/mobile-access' })
    const status = await invoke(mounted.route, 'GET', '/api/mobile-access/control')
    expect(status.status).toBe(200)
    expect(JSON.parse(status.body)).toEqual({ running: false })
    const remote = await invoke(mounted.route, 'GET', '/api/mobile-access/remote/control')
    expect(remote.status).toBe(200)
    expect(JSON.parse(remote.body)).toMatchObject({
      provider: 'tailscale',
      running: false,
      state: 'off',
    })
    const diagnostics = await invoke(mounted.route, 'GET', '/api/mobile-access/diagnostics')
    expect(diagnostics.status).toBe(200)
    expect(JSON.parse(diagnostics.body)).toMatchObject({
      version: 1,
      overall: expect.stringMatching(/^(?:ok|attention|error)$/),
      versions: { plugin: DSH_ON_PHONE_VERSION, minimumAndroidApp: MINIMUM_ANDROID_APP_VERSION },
      checks: expect.any(Array),
      report: expect.stringContaining('DSH Mobile 诊断报告'),
    })
  })

  it('starts and stops the gateway through the local control route', async () => {
    const mounted = await mount()
    const started = await invoke(mounted.route, 'POST', '/api/mobile-access/control', JSON.stringify({ running: true }))
    expect(started.status).toBe(200)
    expect(JSON.parse(started.body)).toMatchObject({ running: true })
    const stopped = await invoke(mounted.route, 'POST', '/api/mobile-access/control', JSON.stringify({ running: false }))
    expect(stopped.status).toBe(200)
    expect(JSON.parse(stopped.body)).toEqual({ running: false })
  })

  it('registers a /mobile command that steers the agent with the customization guide', async () => {
    const mounted = await mount()
    expect(mounted.command).toMatchObject({
      name: 'mobile',
      description: expect.any(String),
      input: { hint: expect.any(String) },
    })
    const steered: { text: string; source: unknown }[] = []
    const agent = {
      steer: (message: { content: readonly { readonly text?: string }[]; source: unknown }) => {
        steered.push({ text: message.content[0]?.text ?? '', source: message.source })
      },
      whenIdle: async (): Promise<void> => undefined,
    }
    const invoke = (rawInput: string) => mounted.command.handler({
      agent,
      commandId: 'id' as never,
      signal: new AbortController().signal,
      rawInput,
    } as never)
    const empty = invoke('  ')
    expect(empty).toMatchObject({ kind: 'error' })
    expect(steered).toEqual([])
    const result = invoke('make the phone UI dark')
    expect(result).toMatchObject({ kind: 'success' })
    expect(steered.length).toBe(1)
    const [steeredMessage] = steered
    expect(steeredMessage).toBeDefined()
    expect(steeredMessage!.text).toContain('mobile-access')
    expect(steeredMessage!.text).toContain('make the phone UI dark')
    // The guide rides as a plugin-source context injection, not a user bubble.
    expect(steeredMessage!.source).toMatchObject({
      kind: 'dsh-on-phone',
      form: 'notice',
    })
  })
})
