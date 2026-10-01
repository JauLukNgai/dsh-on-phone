import { describe, expect, it } from 'vitest'
import { collectConnectionDiagnostics, remoteDiagnosticTimeoutMs, type DiagnosticSnapshot } from '../src/diagnostics.js'

const healthy: DiagnosticSnapshot = {
  dshVersion: '0.1.1-rc.2',
  lan: {
    running: true,
    origin: 'https://192.168.0.101:3443',
    configuredInterface: 'Wi-Fi',
    interfaceName: 'Wi-Fi',
    port: 3443,
  },
  remote: {
    provider: 'tailscale',
    running: true,
    state: 'ready',
    origin: 'https://desktop.tailnet.ts.net',
  },
}

describe('connection diagnostics', () => {
  it('allows known remote relays longer than direct endpoints', () => {
    expect(remoteDiagnosticTimeoutMs('https://desktop.tailnet.ts.net')).toBe(10_000)
    expect(remoteDiagnosticTimeoutMs('https://example.tail1234.ts.net')).toBe(10_000)
    expect(remoteDiagnosticTimeoutMs('https://example.com')).toBe(5_000)
  })

  it('summarizes healthy LAN and remote paths without copying exact addresses', async () => {
    const result = await collectConnectionDiagnostics(healthy, {
      firewall: async () => ({ state: 'ready' }),
      remote: async () => ({ state: 'ready', latencyMs: 86 }),
    })

    expect(result.overall).toBe('ok')
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'lan', status: 'ok' }),
      expect.objectContaining({ id: 'remote', status: 'ok', detail: expect.stringContaining('86 ms') }),
    ]))
    expect(result.report).toContain('https://192.168.0.x:3443')
    expect(result.report).toContain('endpoint=*.ts.net')
    expect(result.report).not.toContain('192.168.0.101')
    expect(result.report).not.toContain('private-name')
  })

  it('turns missing firewall rules and provider errors into shortest recovery actions', async () => {
    const result = await collectConnectionDiagnostics({
      ...healthy,
      remote: { provider: 'tailscale', running: true, state: 'error', errorCode: 'funnel_unavailable' },
    }, {
      firewall: async () => ({ state: 'missing' }),
      remote: async () => ({ state: 'not-applicable' }),
    })

    expect(result.overall).toBe('error')
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'firewall', status: 'warning', action: expect.stringContaining('setup') }),
      expect.objectContaining({ id: 'remote', status: 'error', action: 'Confirm Funnel is enabled in the Tailscale admin console, then retry.' }),
    ]))
  })

  it('reports observed provider throttling without claiming an account quota', async () => {
    const result = await collectConnectionDiagnostics(healthy, {
      firewall: async () => ({ state: 'ready' }),
      remote: async () => ({ state: 'rate-limited', latencyMs: 210 }),
    })

    expect(result.overall).toBe('attention')
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'remote', status: 'warning', detail: expect.stringContaining('观察到服务限流') }),
    ]))
  })

  it('explains a failed Tailscale Fake-IP path without blaming the computer certificate', async () => {
    const result = await collectConnectionDiagnostics({
      ...healthy,
      remote: { provider: 'tailscale', running: true, state: 'ready', origin: 'https://example.tail1234.ts.net' },
    }, {
      firewall: async () => ({ state: 'ready' }),
      remote: async () => ({ state: 'unreachable', fakeIp: true }),
    })

    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'remote',
        status: 'error',
        detail: expect.stringContaining('VPN 或 DNS 代理'),
        action: expect.stringContaining('Switch VPN node'),
      }),
    ]))
  })
})
