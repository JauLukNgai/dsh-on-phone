import { once } from 'node:events'
import { mkdtemp, readFile } from 'node:fs/promises'
import {
  createServer as createHttpServer,
  request as requestHttp,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http'
import { createRequire } from 'node:module'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MOBILE_HISTORY_CONTINUATION_PAGE_MESSAGES } from '../src/history-page-clamp.js'
import { RemotePassthroughProxy } from '../src/remote-proxy.js'
import { DEFLATE_EXTENSION, deflateMessage, inflateMessage } from '../src/websocket-deflate.js'
import { MOBILE_HISTORY_PAGE_MESSAGES, encodeServerFrame, parseFrame, type ParsedFrame } from '../src/websocket-frames.js'
import { websocketAccept } from '../src/gateway.js'
import { resolveLiveUpstream } from '../src/upstream.js'

const packageName = (createRequire(import.meta.url)('../package.json') as { name: string }).name

/** A DSH-shaped document whose settings module declares only the remotes namespace. */
function bootDocument(): string {
  const entries = [
    { id: '@deepseek-ai/dsh-client-connection', url: '/plugins/connection.js', rev: 'c', inject: [] },
    { id: '@deepseek-ai/dsh-client-ui-renderer', url: '/plugins/renderer.js', rev: 'r', inject: [] },
    {
      id: '@deepseek-ai/dsh-client-ui-layout',
      url: '/plugins/layout.js',
      rev: 'l',
      inject: [
        '@deepseek-ai/dsh-client-locale',
        '@deepseek-ai/dsh-client-ui-renderer',
        '@deepseek-ai/dsh-client-ui-session',
        '@deepseek-ai/dsh-client-ui-theme',
      ],
    },
    { id: '@deepseek-ai/dsh-client-ui-settings', url: '/plugins/settings.js', rev: 's', inject: ['@deepseek-ai/dsh-api-remotes'] },
    {
      id: packageName,
      url: '/plugins/mobile.js',
      rev: 'm',
      inject: ['@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-ui-sidebar'],
      immediately: true,
    },
  ]
  return `<!doctype html><html><head><script>globalThis["__DSH_BOOT__"] = ${JSON.stringify({ rev: 'stock', entries })};</script></head><body>app</body></html>`
}

const proxies: RemotePassthroughProxy[] = []
const servers: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  await Promise.all(proxies.splice(0).map(proxy => proxy.close()))
  await Promise.all(servers.splice(0).map(server => server.close()))
  vi.unstubAllEnvs()
})

async function listen(server: HttpServer, host = '127.0.0.1'): Promise<number> {
  server.listen({ host, port: 0 })
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no listener port')
  return address.port
}

function trackServer(server: HttpServer): { close: () => Promise<void> } {
  const handle = { close: async () => { await new Promise<void>((resolve) => server.close(() => resolve())) } }
  servers.push(handle)
  return handle
}

interface SocketReader {
  /** Reads up to and including `marker`, leaving everything after it for the next read. */
  readonly until: (marker: string) => Promise<string>
  /** Reads exactly one WebSocket frame, buffering whatever else arrived with it. */
  readonly frame: () => Promise<ParsedFrame>
}

/**
 * One async iterator per socket, shared by every read: mixing `for await` with
 * `once('data')` on the same socket drops whatever the iterator already
 * buffered.
 */
function reader(socket: Socket): SocketReader {
  const iterator = socket[Symbol.asyncIterator]()
  let buffer = Buffer.alloc(0)
  const fill = async (): Promise<void> => {
    const next = await iterator.next()
    if (next.done === true) throw new Error('socket closed while waiting for data')
    buffer = Buffer.concat([buffer, next.value as Buffer])
  }
  return {
    async until(marker: string): Promise<string> {
      for (;;) {
        const end = buffer.indexOf(marker)
        if (end !== -1) {
          const text = buffer.subarray(0, end + marker.length).toString('latin1')
          buffer = buffer.subarray(end + marker.length)
          return text
        }
        await fill()
      }
    },
    async frame(): Promise<ParsedFrame> {
      for (;;) {
        const frame = parseFrame(buffer)
        if (frame !== undefined) {
          buffer = buffer.subarray(frame.size)
          return frame
        }
        await fill()
      }
    },
  }
}

/** A masked client frame that carries a compressed (RSV1) message. */
function compressedClientFrame(payload: Buffer): Buffer {
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44])
  const header = payload.length < 65_536 ? Buffer.allocUnsafe(4) : Buffer.allocUnsafe(10)
  header[0] = 0x80 | 0x40 | 0x1
  if (payload.length < 65_536) {
    header[1] = 0x80 | 126
    header.writeUInt16BE(payload.length, 2)
  } else {
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  const masked = Buffer.from(payload)
  for (let index = 0; index < masked.length; index += 1) {
    masked[index] = (masked[index] as number) ^ (mask[index & 3] as number)
  }
  return Buffer.concat([header, mask, masked])
}

interface RecordedRequest {
  readonly method: string
  readonly path: string
  readonly headers: IncomingMessage['headers']
  body: string
}

async function startUpstream(
  onRequest: (record: RecordedRequest, response: ServerResponse) => void,
): Promise<{ origin: string; recorded: RecordedRequest[] }> {
  const recorded: RecordedRequest[] = []
  const server = createHttpServer((request, response) => {
    const record: RecordedRequest = {
      method: request.method ?? 'GET',
      path: request.url ?? '/',
      headers: request.headers,
      body: '',
    }
    recorded.push(record)
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => { record.body = Buffer.concat(chunks).toString('utf8') })
    onRequest(record, response)
  })
  const port = await listen(server)
  trackServer(server)
  return { origin: `http://127.0.0.1:${port}`, recorded }
}

describe('RemotePassthroughProxy', () => {
  it('rewrites Host and Origin to the upstream so the browser-trust fence passes', async () => {
    const upstream = await startUpstream((_record, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('ok')
    })
    const proxy = new RemotePassthroughProxy({
      resolveUpstream: () => new URL(upstream.origin),
    })
    proxies.push(proxy)
    await proxy.start()

    const response = await fetch(proxy.origin() + '/api/ping', {
      headers: {
        origin: 'https://desktop.tailnet.ts.net',
        'sec-fetch-site': 'cross-site',
      },
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('ok')
    expect(upstream.recorded).toHaveLength(1)
    const seen = upstream.recorded[0]!
    // The fence passes when the Host is loopback and Origin matches it.
    expect(seen.headers.host).toBe(new URL(upstream.origin).host)
    expect(seen.headers.origin).toBe(upstream.origin)
    expect(seen.headers['sec-fetch-site']).toBe('same-origin')
  })

  it('injects the upstream session cookie from the authenticated URL exchange', async () => {
    let exchanged = false
    const upstream = await startUpstream((record, response) => {
      if (record.path.startsWith('/?session=')) {
        exchanged = true
        response.writeHead(303, { 'set-cookie': 'dsh_session=abc123; Max-Age=3600; Path=/' })
        response.end()
        return
      }
      if (record.headers.cookie === 'dsh_session=abc123') {
        response.writeHead(200, { 'content-type': 'text/plain' })
        response.end('authed')
        return
      }
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('guest')
    })
    const proxy = new RemotePassthroughProxy({
      resolveUpstream: () => new URL(upstream.origin),
      resolveAuthenticatedUrl: (origin) => origin.origin === upstream.origin ? `${upstream.origin}/?session=tok123` : undefined,
    })
    proxies.push(proxy)
    await proxy.start()

    const response = await fetch(proxy.origin() + '/api/session')
    expect(await response.text()).toBe('authed')
    expect(exchanged).toBe(true)
  })

  it('follows a live upstream change between requests', async () => {
    const upstreamA = await startUpstream((_record, response) => {
      response.writeHead(200)
      response.end('A')
    })
    const upstreamB = await startUpstream((_record, response) => {
      response.writeHead(200)
      response.end('B')
    })
    let current = new URL(upstreamA.origin)
    const proxy = new RemotePassthroughProxy({ resolveUpstream: () => current })
    proxies.push(proxy)
    await proxy.start()

    expect(await (await fetch(proxy.origin() + '/')).text()).toBe('A')
    current = new URL(upstreamB.origin)
    expect(await (await fetch(proxy.origin() + '/')).text()).toBe('B')
  })

  it('orders the mobile client before settings in the remote document', async () => {
    // DSH answers the document with Transfer-Encoding: chunked and no
    // Content-Length, so the rewrite must not be gated on a declared length.
    const upstream = await startUpstream((_record, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.write(bootDocument())
      response.end()
    })
    const proxy = new RemotePassthroughProxy({ resolveUpstream: () => new URL(upstream.origin) })
    proxies.push(proxy)
    await proxy.start()

    const response = await fetch(proxy.origin() + '/')
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(upstream.recorded[0]?.headers['content-length']).toBeUndefined()
    expect(body).toContain('window.__DSH_ON_PHONE_TRUSTED_GATEWAY__=true')
    expect(body).toContain(`"inject":["@deepseek-ai/dsh-api-remotes","${packageName}"]`)
    // The remote channel keeps DSH's own layout.
    expect(body).toContain('"/plugins/layout.js"')
    // The document has to arrive uncompressed for the rewrite to apply.
    expect(upstream.recorded[0]?.headers['accept-encoding']).toBe('identity')
  })

  it('passes a non-document response through untouched', async () => {
    const upstream = await startUpstream((_record, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('plain')
    })
    const proxy = new RemotePassthroughProxy({ resolveUpstream: () => new URL(upstream.origin) })
    proxies.push(proxy)
    await proxy.start()

    expect(await (await fetch(proxy.origin() + '/')).text()).toBe('plain')
  })

  it('shrinks the history page a phone asks for before the host ever sees it', async () => {
    // The stock client posts `maxMessages: 500`, and the host answers with
    // megabytes the phone must transfer and parse before it can paint.
    const upstream = await startUpstream((_record, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"ok":true}')
    })
    const proxy = new RemotePassthroughProxy({ resolveUpstream: () => new URL(upstream.origin) })
    proxies.push(proxy)
    await proxy.start()

    const pageBody = (maxMessages: number): string => JSON.stringify({
      type: 'client-request',
      rpcId: 'rpc-1',
      method: 'session/page',
      payload: { args: { request: { address: { kind: 'session', sessionId: 'session-a' }, throughSeq: 9, maxMessages, turnWindow: { minMessages: 50, minTurns: 2 } } } },
    })
    const post = async (path: string, body: string): Promise<void> => {
      await fetch(proxy.origin() + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    }

    await post('/api/session/page', pageBody(500))
    await post('/api/session/page', pageBody(500))
    await post('/api/session/other', pageBody(500))

    const first = JSON.parse(upstream.recorded[0]!.body) as { payload: { args: { request: Record<string, unknown> } } }
    expect(first.payload.args.request.maxMessages).toBe(MOBILE_HISTORY_PAGE_MESSAGES)
    // The host rejects a request whose `turnWindow.minMessages` exceeds it.
    expect(first.payload.args.request.turnWindow).toEqual({ minMessages: MOBILE_HISTORY_PAGE_MESSAGES, minTurns: 2 })
    expect(upstream.recorded[0]!.headers['content-length']).toBe(String(Buffer.byteLength(upstream.recorded[0]!.body)))

    // Later pages may be larger; every other route is left exactly as it came.
    const later = JSON.parse(upstream.recorded[1]!.body) as { payload: { args: { request: { maxMessages: number } } } }
    expect(later.payload.args.request.maxMessages).toBe(MOBILE_HISTORY_CONTINUATION_PAGE_MESSAGES)
    expect(upstream.recorded[2]!.body).toBe(pageBody(500))
  })

  it('gives every response a cache policy: forever when content-addressed, revalidate otherwise', async () => {
    // The upstream declares no-store; sanitizeResponseHeaders drops it either
    // way, and without the plugin putting a policy back the phone re-downloaded
    // every bundle on every load — and was free to cache the document
    // heuristically, keeping it pointed at an old bundle revision.
    const upstream = await startUpstream((_record, response) => {
      response.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' })
      response.end('export {}\n')
    })
    const proxy = new RemotePassthroughProxy({ resolveUpstream: () => new URL(upstream.origin) })
    proxies.push(proxy)
    await proxy.start()

    const revisioned = await fetch(`${proxy.origin()}/plugins/??connection.js,mobile.js&rev=e3183d63db4b`)
    expect(revisioned.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
    expect(await revisioned.text()).toBe('export {}\n')

    const hashed = await fetch(`${proxy.origin()}/assets/index-Q6zc2uHV.js`)
    expect(hashed.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')

    // An unversioned path must not inherit the immutable lifetime: it is
    // revalidated, and the upstream's own no-store is preserved verbatim.
    const unversioned = await fetch(`${proxy.origin()}/plugins/mobile.js`)
    expect(unversioned.headers.get('cache-control')).toBe('no-store')
  })

  it('makes an unversioned document revalidate so a client fix can reach the phone', async () => {
    const document = '<!doctype html><html><head></head><body>plain</body></html>'
    const upstream = await startUpstream((_record, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': String(Buffer.byteLength(document)), etag: '"shell-1"' })
      response.end(document)
    })
    const proxy = new RemotePassthroughProxy({ resolveUpstream: () => new URL(upstream.origin) })
    proxies.push(proxy)
    await proxy.start()

    const shell = await fetch(`${proxy.origin()}/`)
    expect(shell.headers.get('cache-control')).toBe('no-cache')
    // The validator has to survive, or `no-cache` would re-download the body.
    expect(shell.headers.get('etag')).toBe('"shell-1"')
  })

  it('serves the stock document when the upstream contract is unsupported', async () => {
    const unsupported = '<!doctype html><html><head><script>globalThis["__DSH_BOOT__"] = {"rev":"x","entries":[]};</script></head><body>stock</body></html>'
    const upstream = await startUpstream((_record, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': String(Buffer.byteLength(unsupported)) })
      response.end(unsupported)
    })
    const proxy = new RemotePassthroughProxy({ resolveUpstream: () => new URL(upstream.origin) })
    proxies.push(proxy)
    await proxy.start()

    const response = await fetch(proxy.origin() + '/')

    expect(response.status).toBe(200)
    expect(await response.text()).toBe(unsupported)
  })

  it('forwards WebSocket upgrades to any path (plugin channels like /sidebar/ws/*)', async () => {
    const recordedPaths: string[] = []
    const upstreamServer = createHttpServer()
    upstreamServer.on('upgrade', (request, socket) => {
      recordedPaths.push(request.url ?? '')
      socket.end([
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${websocketAccept(String(request.headers['sec-websocket-key']))}`,
        '',
        '',
      ].join('\r\n'))
    })
    const upstreamPort = await listen(upstreamServer)
    trackServer(upstreamServer)
    const upstreamOrigin = `http://127.0.0.1:${upstreamPort}`

    const proxy = new RemotePassthroughProxy({ resolveUpstream: () => new URL(upstreamOrigin) })
    proxies.push(proxy)
    await proxy.start()

    const key = 'dGhlIHNhbXBsZSBub25jZQ=='
    await new Promise<void>((resolve, reject) => {
      const proxyPort = Number(new URL(proxy.origin()).port)
      const client = requestHttp({
        host: '127.0.0.1',
        port: proxyPort,
        path: '/sidebar/ws/agent-opens?sessionId=abc',
        headers: {
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-key': key,
          'sec-websocket-version': '13',
        },
      })
      client.once('upgrade', (_response, socket) => {
        socket.destroy()
        resolve()
      })
      client.once('error', reject)
      client.end()
    })
    expect(recordedPaths).toEqual(['/sidebar/ws/agent-opens?sessionId=abc'])
  })

  it('forwards WebSocket upgrades with a rewritten handshake', async () => {
    const recordedHost: string[] = []
    const recordedOrigin: string[] = []
    const upstreamServer = createHttpServer()
    upstreamServer.on('upgrade', (request, socket) => {
      recordedHost.push(String(request.headers.host ?? ''))
      recordedOrigin.push(String(request.headers.origin ?? ''))
      socket.end([
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${websocketAccept(String(request.headers['sec-websocket-key']))}`,
        '',
        '',
      ].join('\r\n'))
    })
    const upstreamPort = await listen(upstreamServer)
    trackServer(upstreamServer)
    const upstreamOrigin = `http://127.0.0.1:${upstreamPort}`

    const proxy = new RemotePassthroughProxy({ resolveUpstream: () => new URL(upstreamOrigin) })
    proxies.push(proxy)
    await proxy.start()

    const key = 'dGhlIHNhbXBsZSBub25jZQ=='
    await new Promise<void>((resolve, reject) => {
      const proxyPort = Number(new URL(proxy.origin()).port)
      const client = requestHttp({
        host: '127.0.0.1',
        port: proxyPort,
        path: '/api/events.mux',
        headers: {
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-key': key,
          'sec-websocket-version': '13',
          origin: 'https://desktop.tailnet.ts.net',
        },
      })
      client.once('upgrade', (_response, socket) => {
        socket.destroy()
        resolve()
      })
      client.once('error', reject)
      client.end()
    })
    expect(recordedHost).toEqual([new URL(upstreamOrigin).host])
    expect(recordedOrigin).toEqual([upstreamOrigin])
  })

  it('accepts the phone\'s permessage-deflate offer itself, and relays compressed frames both ways', async () => {
    // Both ends here are raw sockets, because that is what the phone and the
    // mux are. (A `requestHttp` client calls `client.end()`, which half-closes
    // the connection, and a fake upstream with the default
    // `allowHalfOpen: false` turns that around into a close the phone sees as
    // `socket closed before a frame arrived`.)
    const recordedExtensions: Array<string | undefined> = []
    const upstreamServer = createHttpServer()
    let upstreamSocket: Socket | undefined
    upstreamServer.on('upgrade', (request, socket) => {
      recordedExtensions.push(request.headers['sec-websocket-extensions'] as string | undefined)
      upstreamSocket = socket as Socket
      socket.write([
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${websocketAccept(String(request.headers['sec-websocket-key']))}`,
        '',
        '',
      ].join('\r\n'))
    })
    const upstreamPort = await listen(upstreamServer)
    trackServer(upstreamServer)

    const home = await mkdtemp(join(tmpdir(), 'dsh-proxy-deflate-'))
    vi.stubEnv('DSH_HOME', home)
    const proxy = new RemotePassthroughProxy({ resolveUpstream: () => new URL(`http://127.0.0.1:${upstreamPort}`) })
    proxies.push(proxy)
    await proxy.start()

    const proxyPort = Number(new URL(proxy.origin()).port)
    const phone = connect(proxyPort, '127.0.0.1')
    try {
      const onPhone = reader(phone)
      await once(phone, 'connect')
      phone.write([
        'GET /api/events.mux HTTP/1.1',
        `Host: 127.0.0.1:${proxyPort}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits',
        'Origin: https://desktop.tailnet.ts.net',
        '',
        '',
      ].join('\r\n'))

      const head = await onPhone.until('\r\n\r\n')
      expect(head.split('\r\n')[0]).toContain('101')
      // The offer is answered here: the mux never sees it, and it would have
      // declined, taking the extension away from the phone that is about to use it.
      expect(recordedExtensions).toEqual([undefined])
      expect(head).toContain(`Sec-WebSocket-Extensions: ${DEFLATE_EXTENSION}`)

      const upstream = upstreamSocket as Socket
      const onUpstream = reader(upstream)

      // Mux → phone: one 4 KiB message arrives as a single compressed RSV1 frame.
      const snapshot = Buffer.from(JSON.stringify({ type: 'item', payload: 'x'.repeat(4096) }))
      upstream.write(encodeServerFrame(0x1, snapshot, false))
      const delivered = await onPhone.frame()
      expect(delivered.opcode).toBe(0x1)
      expect(delivered.rsv1).toBe(true)
      expect(inflateMessage(delivered.payload).equals(snapshot)).toBe(true)

      // Phone → mux: a compressed request arrives as plain JSON, still masked
      // because the client half of a WebSocket is required to mask.
      // (`job/list` keeps this judgement on the inflate alone; the history clamp
      // that reads the inflated request has its own unit coverage.)
      const request = Buffer.from(JSON.stringify({ type: 'open', streamId: 's-1', endpoint: 'job/list', payload: { args: {} } }))
      phone.write(compressedClientFrame(deflateMessage(request)))
      const forwarded = await onUpstream.frame()
      expect(forwarded.opcode).toBe(0x1)
      expect(forwarded.rsv1).toBe(false)
      expect(forwarded.masked).toBe(true)
      expect(forwarded.payload.equals(request)).toBe(true)
    } finally {
      // Tear both sockets down: a live connection keeps `server.close()` from
      // ever calling back, which shows up as a ten-second hook timeout.
      phone.destroy()
      upstreamSocket?.destroy()
    }

    // The row is written when the socket closes, and it is the only record of
    // what a real browser offered and what the link carried.
    const row = await readTelemetryKind(join(home, 'mobile-telemetry.jsonl'), 'ws-deflate')
    expect(row).toMatchObject({ path: '/api/events.mux', deflate: true })
    expect(String(row?.offered)).toContain('permessage-deflate')
    expect(Number(row?.downBytes)).toBeGreaterThan(0)
    expect(Number(row?.upBytes)).toBeGreaterThan(0)
  })

  it('refuses the loopback-only admin surface instead of forwarding it', async () => {
    // Verified against a live deployment before this guard existed: a plain
    // curl to POST /api/mobile-access/lan/pairing/open on the tailnet origin
    // answered 201 with a pairing token, and GET .../lan/status answered 200,
    // because the proxy makes tailnet requests arrive at the upstream looking
    // loopback-local and assertLocalAdminTrust keys off exactly that.
    const upstream = await startUpstream((_record, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"token":"must-never-be-reachable"}')
    })
    const proxy = new RemotePassthroughProxy({ resolveUpstream: () => new URL(upstream.origin) })
    proxies.push(proxy)
    await proxy.start()

    for (const path of [
      '/api/mobile-access/lan/pairing/open',
      '/api/mobile-access/lan/status',
      '/api/mobile-access/lan/devices/revoke',
      '/api/mobile-access/lan/devices/reset',
      '/api/mobile-access/remote/control',
      '/api/mobile-access',
    ]) {
      const response = await fetch(proxy.origin() + path, { method: 'POST' })
      expect(response.status, path).toBe(404)
      expect(await response.json(), path).toEqual({ error: 'not_found' })
    }
    // The guard runs before the forward, so nothing reached the upstream.
    expect(upstream.recorded).toHaveLength(0)

    // A neighbouring path that merely shares the prefix stays reachable.
    const neighbour = await fetch(proxy.origin() + '/api/mobile-accessibility')
    expect(neighbour.status).toBe(200)
    expect(upstream.recorded).toHaveLength(1)
  })

  it('keeps a device trace in the DSH home instead of forwarding it upstream', async () => {
    const upstream = await startUpstream((_record, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('upstream')
    })
    const home = await mkdtemp(join(tmpdir(), 'dsh-proxy-telemetry-'))
    vi.stubEnv('DSH_HOME', home)
    const proxy = new RemotePassthroughProxy({ resolveUpstream: () => new URL(upstream.origin) })
    proxies.push(proxy)
    await proxy.start()

    const trace = { kind: 'gesture', delta: { x: -170, y: 4 }, steps: [{ type: 'touchstart' }] }
    const response = await fetch(proxy.origin() + '/__dsh-on-phone/telemetry', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(trace),
    })
    expect(response.status).toBe(204)

    // The debug channel is answered locally: nothing reaches the app.
    expect(upstream.recorded).toHaveLength(0)
    const file = join(home, 'mobile-telemetry.jsonl')
    const entry = await readTelemetry(file)
    expect(entry).toMatchObject({ kind: 'device', payload: trace })
    expect(typeof entry.at).toBe('string')

    // Only POST is accepted, and a refusal is local too.
    const refused = await fetch(proxy.origin() + '/__dsh-on-phone/telemetry')
    expect(refused.status).toBe(405)
    expect(upstream.recorded).toHaveLength(0)
  })
})

/** Wait for the queued telemetry write and return the single logged record. */
async function readTelemetryKind(file: string, kind: string): Promise<Record<string, unknown> | undefined> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const text = await readFile(file, 'utf8').catch(() => '')
    const found = text.split('\n').filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry.kind === kind)
    if (found !== undefined) return found
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return undefined
}

async function readTelemetry(file: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const text = await readFile(file, 'utf8').catch(() => '')
    if (text.trim() !== '') return JSON.parse(text.trim().split('\n').at(-1) ?? '{}') as Record<string, unknown>
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`telemetry was never written to ${file}`)
}

describe('resolveLiveUpstream', () => {
  it('prefers a valid live origin, then DSH_WEB_URL, then the fallback', () => {
    vi.stubEnv('DSH_WEB_URL', 'http://127.0.0.1:51999')
    expect(resolveLiveUpstream('http://127.0.0.1:3080', 'http://127.0.0.1:52001').origin).toBe('http://127.0.0.1:52001')
    expect(resolveLiveUpstream('http://127.0.0.1:3080').origin).toBe('http://127.0.0.1:51999')

    vi.stubEnv('DSH_WEB_URL', 'https://evil.example/')
    expect(resolveLiveUpstream('http://127.0.0.1:3080', 'http://127.0.0.1:52002').origin).toBe('http://127.0.0.1:52002')
    expect(resolveLiveUpstream('http://127.0.0.1:3080').origin).toBe('http://127.0.0.1:3080')

    vi.stubEnv('DSH_WEB_URL', '')
    expect(resolveLiveUpstream('http://127.0.0.1:3080', 'not-an-origin').origin).toBe('http://127.0.0.1:3080')
  })
})
