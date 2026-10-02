import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MobileAccessControlStore } from '../src/control.js'
import type { RemotePassthroughProxy } from '../src/remote-proxy.js'
import { TailscaleServeController, normalizeServeOrigin, serveEntryTargetsProxy } from '../src/tailscale-serve.js'

/**
 * Write a fake the controller can spawn on this host.
 *
 * `execFile` on Windows refuses a `.cmd` shim without a shell, and a `#!/bin/sh`
 * script cannot run there at all, so the fake is written twice: a POSIX script
 * that carries the shebang, and a plain Node script that the Windows run drives
 * by putting the interpreter in front of it. Both take the same arguments and
 * print the same lines on stdout.
 * @param directory - Directory that owns the fake.
 * @param body - The fake in two dialects: `sh` is a POSIX script body, `node` is the same fake as a Node module body.
 * @returns What to pass to the controller as `bin`: a path, or an interpreter plus a path.
 */
async function writeFakeExecutable(
  directory: string,
  body: { readonly sh: readonly string[]; readonly node: readonly string[] },
): Promise<string | readonly string[]> {
  const posixBin = join(directory, 'tailscale')
  await writeFile(posixBin, [...body.sh, ''].join('\n'), 'utf8')
  await chmod(posixBin, 0o755)
  const nodeBin = join(directory, 'tailscale-fake.mjs')
  await writeFile(nodeBin, [...body.node, ''].join('\n'), 'utf8')
  return process.platform === 'win32' ? [process.execPath, nodeBin] : posixBin
}

/**
 * Install a fake `tailscale` executable that records every invocation and keeps
 * a state file for `serve`, so the whole Serve lifecycle can be driven without
 * touching the real node.
 *
 * The fake is stateful because the controller now inspects the registered entry
 * before clearing it: `serve --bg … <target>` writes the same `Web[…].Handlers['/'].Proxy`
 * shape the real CLI reports, and `serve --https=443 off` empties it again.
 * @param statusJson - Body returned by `tailscale status --json`.
 * @param options - `serveStatus` seeds an existing entry; `failApply` makes `serve --bg` fail.
 * @returns The executable path, a reader for the invocations, and the serve state file.
 */
async function fakeTailscale(
  statusJson: unknown,
  options: { readonly serveStatus?: unknown; readonly failApply?: boolean } = {},
): Promise<{
  readonly bin: string | readonly string[]
  readonly calls: () => Promise<string[]>
  readonly serveState: string
  readonly writeServeStatus: (status: unknown) => Promise<void>
}> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-tailscale-'))
  const log = join(directory, 'calls.txt')
  const state = join(directory, 'serve.json')
  const bin = await writeFakeExecutable(directory, {
    sh: [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
      'case "$*" in',
      `  "serve status --json") cat ${JSON.stringify(state)} 2>/dev/null || printf '%s' '{}' ;;`,
      `  "serve --https=443 off") printf '%s' '{}' > ${JSON.stringify(state)} ;;`,
      `  "serve reset") printf '%s' '{}' > ${JSON.stringify(state)} ;;`,
      ...(options.failApply === true ? ['  "serve --bg "*) echo "Error: serve failed" >&2; exit 1 ;;'] : []),
      '  "serve --bg --yes --https=443 "*)',
      '    for last do :; done',
      `    printf '{"TCP":{"443":{"HTTPS":true}},"Web":{"node.tailnet.ts.net:443":{"Handlers":{"/":{"Proxy":"%s"}}}}}' "$last" > ${JSON.stringify(state)} ;;`,
      `  *"status --json"*) printf '%s' ${JSON.stringify(JSON.stringify(statusJson))} ;;`,
      'esac',
      'exit 0',
      '',
    ],
    node: [
      `import { readFileSync, writeFileSync } from 'node:fs'`,
      `const log = ${JSON.stringify(log)}`,
      `const state = ${JSON.stringify(state)}`,
      `const read = () => { try { return readFileSync(state, 'utf8') } catch { return '' } }`,
      `const args = process.argv.slice(2)`,
      `const line = args.join(' ')`,
      `const statusJson = ${JSON.stringify(JSON.stringify(statusJson))}`,
      `try { writeFileSync(log, line + '\\n', { flag: 'a' }) } catch {}`,
      `if (line === 'serve status --json') { process.stdout.write(read() || '{}') }`,
      `else if (line === 'serve --https=443 off' || line === 'serve reset') { writeFileSync(state, '{}') }`,
      `else if (${options.failApply === true ? "line.startsWith('serve --bg ')" : 'false'}) { process.stderr.write('Error: serve failed\\n'); process.exit(1) }`,
      `else if (line.startsWith('serve --bg --yes --https=443 ')) {`,
      `  writeFileSync(state, JSON.stringify({ TCP: { 443: { HTTPS: true } }, Web: { 'node.tailnet.ts.net:443': { Handlers: { '/': { Proxy: args.at(-1) } } } } }))`,
      `} else if (line.endsWith('status --json')) { process.stdout.write(statusJson) }`,
      '',
    ],
  })
  await writeFile(state, JSON.stringify(options.serveStatus ?? {}), 'utf8')
  return {
    bin,
    serveState: state,
    writeServeStatus: async (status: unknown) => {
      await writeFile(state, JSON.stringify(status), 'utf8')
    },
    calls: async () => {
      try {
        return (await readFile(log, 'utf8')).split('\n').filter(Boolean)
      } catch {
        return []
      }
    },
  }
}

/** A control store fixed to one persisted switch value. */
function store(enabled: boolean): MobileAccessControlStore {
  return {
    load: async () => ({ version: 1 as const, enabled }),
    save: async () => undefined,
  }
}

/** A proxy stand-in that records how often it was started and closed. */
function fakeProxy(): {
  readonly proxy: RemotePassthroughProxy
  readonly starts: () => number
  readonly closes: () => number
} {
  let starts = 0
  let closes = 0
  const proxy = {
    start: async () => { starts += 1 },
    origin: () => 'http://127.0.0.1:54321',
    close: async () => { closes += 1 },
  } as unknown as RemotePassthroughProxy
  return { proxy, starts: () => starts, closes: () => closes }
}

const HEALTHY_NODE = { Self: { DNSName: 'node.tailnet.ts.net.' } }

describe('Tailscale Serve lifecycle', () => {
  it('does not touch serve when the switch is restored as disabled', async () => {
    const { bin, calls } = await fakeTailscale(HEALTHY_NODE)
    const { proxy, starts } = fakeProxy()
    const controller = new TailscaleServeController({ store: store(false), proxy, bin })

    await controller.initialize()

    // A fresh install persists enabled: false. Running `serve --https=443 off`
    // here would tear down an unrelated 443 entry the user configured, on every
    // boot, for a plugin that never owned it. Nothing of ours was started
    // either, so no proxy is left behind.
    expect(await calls()).toEqual([])
    expect(starts()).toBe(0)
    expect(controller.status()).toEqual({ enabled: false, state: 'off' })
  })

  it('registers serve on enable and clears it on an explicit disable', async () => {
    const { bin, calls } = await fakeTailscale(HEALTHY_NODE)
    const { proxy, closes } = fakeProxy()
    const controller = new TailscaleServeController({ store: store(true), proxy, bin })

    await controller.initialize()
    expect(controller.status()).toMatchObject({ state: 'ready', origin: 'https://node.tailnet.ts.net/' })
    expect((await calls()).some((call) => call.startsWith('serve --bg --yes --https=443 ')))
      .toBe(true)

    await controller.setEnabled(false)

    expect(await calls()).toContain('serve --https=443 off')
    expect(closes()).toBeGreaterThan(0)
    expect(controller.status()).toEqual({ enabled: false, state: 'off' })
  })

  it('removes the entry it just created when the run fails afterwards', async () => {
    // `status --json` without a MagicDNS name makes resolveOrigin throw *after*
    // the 443 entry has been registered. Previously the catch only closed the
    // proxy, leaving serve pointing at a dead loopback port.
    const { bin, calls } = await fakeTailscale({ Self: {} })
    const { proxy, closes } = fakeProxy()
    const controller = new TailscaleServeController({ store: store(true), proxy, bin })

    await controller.initialize()

    expect(controller.status().state).toBe('error')
    expect(await calls()).toContain('serve --https=443 off')
    expect(closes()).toBeGreaterThan(0)
  })

  it('reports a port conflict as serve_port_conflict, not the generic serve_failed', async () => {
    // The recovery path raises these errors itself, and their wording matched
    // none of the message patterns the classifier looks for, so the panel used
    // to lose the actionable hint and show the generic code.
    const directory = await mkdtemp(join(tmpdir(), 'dsh-tailscale-conflict-'))
    const bin = await writeFakeExecutable(directory, {
      sh: [
        '#!/bin/sh',
        'case "$*" in',
        // 443 is occupied, and not as the sole entry, so the recovery path
        // refuses to reset the config and raises its own diagnostic.
        '  *"serve --bg"*) echo "Error: already serving TCP on port 443" >&2; exit 1 ;;',
        '  *"serve status --json"*) printf \'%s\' \'{"TCP":{"443":{},"8443":{}}}\' ;;',
        'esac',
        'exit 0',
        '',
      ],
      node: [
        `const line = process.argv.slice(2).join(' ')`,
        `if (line.includes('serve --bg')) { process.stderr.write('Error: already serving TCP on port 443\\n'); process.exit(1) }`,
        `if (line.includes('serve status --json')) { process.stdout.write('{"TCP":{"443":{},"8443":{}}}') }`,
        '',
      ],
    })

    const { proxy } = await fakeProxy()
    const controller = new TailscaleServeController({ store: store(true), proxy, bin })

    await controller.initialize()

    expect(controller.status()).toMatchObject({ state: 'error', errorCode: 'serve_port_conflict' })
  })

  it('does not clear an unrelated 443 entry it never registered', async () => {
    // 443 belongs to the user's own serve. Registration fails here, so this
    // controller owns nothing; clearing the entry would take their origin down.
    const foreign = {
      TCP: { 443: { HTTPS: true } },
      Web: { 'other.tailnet.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } },
    }
    const { bin, calls, serveState } = await fakeTailscale(HEALTHY_NODE, { serveStatus: foreign, failApply: true })
    const { proxy } = await fakeProxy()
    const controller = new TailscaleServeController({ store: store(true), proxy, bin })

    await controller.initialize()

    expect(controller.status().state).toBe('error')
    expect(await calls()).not.toContain('serve --https=443 off')
    expect(JSON.parse(await readFile(serveState, 'utf8'))).toEqual(foreign)
  })

  it('restores the entry when it disappears while the switch is on', async () => {
    // The daemon can drop the config after a re-authentication, and an older
    // controller for the same loopback port can clear it after a newer one
    // registered. Neither changes the persisted switch, so the panel kept
    // reporting "ready" while every phone request got connection-refused.
    const { bin, calls, writeServeStatus } = await fakeTailscale(HEALTHY_NODE)
    const { proxy } = await fakeProxy()
    const controller = new TailscaleServeController({ store: store(true), proxy, bin })
    await controller.initialize()
    expect(await calls()).toEqual([
      'serve --bg --yes --https=443 http://127.0.0.1:54321',
      'status --json',
    ])

    await writeServeStatus({})
    await controller.reconcile()

    expect((await calls()).filter((call) => call.startsWith('serve --bg --yes --https=443 '))).toHaveLength(2)
    expect(controller.status()).toMatchObject({ state: 'ready', origin: 'https://node.tailnet.ts.net/' })
  })

  it('leaves a healthy entry alone when reconciling', async () => {
    const { bin, calls } = await fakeTailscale(HEALTHY_NODE)
    const { proxy } = await fakeProxy()
    const controller = new TailscaleServeController({ store: store(true), proxy, bin })
    await controller.initialize()

    await controller.reconcile()

    expect((await calls()).filter((call) => call.startsWith('serve --bg --yes --https=443 '))).toHaveLength(1)
  })
})

describe('serve entry inspection', () => {
  it('matches the proxy a handler forwards to, ignoring a trailing slash', () => {
    const status = {
      TCP: { 443: { HTTPS: true } },
      Web: { 'node.tailnet.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:54321' } } } },
    }
    expect(serveEntryTargetsProxy(status, 'http://127.0.0.1:54321')).toBe(true)
    expect(serveEntryTargetsProxy(status, 'http://127.0.0.1:54321/')).toBe(true)
    expect(serveEntryTargetsProxy(status, 'http://127.0.0.1:9999')).toBe(false)
  })

  it('reports false for an absent, empty or malformed configuration', () => {
    expect(serveEntryTargetsProxy({}, 'http://127.0.0.1:54321')).toBe(false)
    expect(serveEntryTargetsProxy(undefined, 'http://127.0.0.1:54321')).toBe(false)
    expect(serveEntryTargetsProxy({ Web: null }, 'http://127.0.0.1:54321')).toBe(false)
    expect(serveEntryTargetsProxy({ Web: { 'node:443': {} } }, 'http://127.0.0.1:54321')).toBe(false)
    expect(serveEntryTargetsProxy({ Web: { 'node:443': { Handlers: { '/': { Proxy: 7 } } } } }, 'http://127.0.0.1:54321'))
      .toBe(false)
  })

  it('normalizes origins for comparison', () => {
    expect(normalizeServeOrigin('  http://127.0.0.1:54321//  ')).toBe('http://127.0.0.1:54321')
    expect(normalizeServeOrigin('https://node.tailnet.ts.net/')).toBe('https://node.tailnet.ts.net')
  })
})
