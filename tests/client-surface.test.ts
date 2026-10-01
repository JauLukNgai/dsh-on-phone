import { describe, expect, it } from 'vitest'
import { resolveClientSurface } from '../src/client.js'

const surface = (input: Partial<Parameters<typeof resolveClientSurface>[0]>): string =>
  resolveClientSurface({ protocol: 'http:', hostname: '127.0.0.1', search: '', trustedGateway: false, dedicatedFrontend: undefined, ...input })

describe('client surface selection', () => {
  it('keeps the DSH desktop window on the desktop surface', () => {
    // The official desktop app serves the frontend from its privileged
    // dsh-app://app/ scheme, where the hostname is "app". Deciding by hostname
    // installed the phone DOM layer inside the desktop window.
    expect(surface({ protocol: 'dsh-app:', hostname: 'app' })).toBe('desktop')
  })

  it('keeps the host page on the desktop surface for every loopback spelling', () => {
    expect(surface({ hostname: '127.0.0.1' })).toBe('desktop')
    expect(surface({ hostname: 'localhost' })).toBe('desktop')
    expect(surface({ hostname: '::1' })).toBe('desktop')
    expect(surface({ hostname: '[::1]' })).toBe('desktop')
  })

  it('installs the phone surface on the gateway and remote channels', () => {
    expect(surface({ hostname: '192.168.1.20', trustedGateway: true })).toBe('mobile')
    expect(surface({ hostname: 'phone.tailnet.ts.net', trustedGateway: true })).toBe('mobile')
    // The LAN gateway stamps the frontend marker even where the hostname is odd.
    expect(surface({ protocol: 'dsh-app:', hostname: 'app', dedicatedFrontend: 'dedicated' })).toBe('mobile')
  })

  it('still adapts a page served from some other non-loopback origin', () => {
    expect(surface({ hostname: '192.168.1.20' })).toBe('mobile')
    expect(surface({ hostname: 'phone.tailnet.ts.net' })).toBe('mobile')
  })

  it('honours both explicit markers ahead of the desktop scheme', () => {
    expect(surface({ protocol: 'dsh-app:', hostname: 'app', trustedGateway: true })).toBe('mobile')
    expect(surface({ protocol: 'dsh-app:', hostname: 'app', dedicatedFrontend: 'dedicated' })).toBe('mobile')
  })

  it('keeps ?dsh-on-phone-preview as a phone preview inside the host page', () => {
    expect(surface({ protocol: 'dsh-app:', hostname: 'app', search: '?dsh-on-phone-preview' })).toBe('mobile')
    expect(surface({ search: '?foo=1&dsh-on-phone-preview=1' })).toBe('mobile')
    // The pre-rename spelling still opens the phone preview.
    expect(surface({ protocol: 'dsh-app:', hostname: 'app', search: '?dsh-mobile-preview' })).toBe('mobile')
  })

  it('does not treat an unrelated marker value as the gateway frontend', () => {
    expect(surface({ protocol: 'dsh-app:', hostname: 'app', dedicatedFrontend: 'stock' })).toBe('desktop')
  })
})
