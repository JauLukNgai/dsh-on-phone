import { describe, expect, it } from 'vitest'
import { resolveTailscaleBinary, tailscaleBinaryCandidates } from '../src/tailscale-serve.js'

const HOME = '/Users/tester'

const resolve = (options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; present?: string[] } = {}): string =>
  resolveTailscaleBinary({
    platform: options.platform ?? 'darwin',
    env: options.env ?? {},
    home: HOME,
    exists: (path) => (options.present ?? []).includes(path),
  })

describe('tailscale binary resolution', () => {
  it('finds the CLI where the macOS installer puts it', () => {
    // The desktop app is launched by launchd, so the host process PATH is
    // /usr/bin:/bin:/usr/sbin:/sbin and a bare "tailscale" lookup fails with
    // ENOENT even though the CLI is installed.
    expect(resolve({ present: ['/usr/local/bin/tailscale'] })).toBe('/usr/local/bin/tailscale')
    expect(resolve({ present: ['/opt/homebrew/bin/tailscale'] })).toBe('/opt/homebrew/bin/tailscale')
    expect(resolve({ present: ['/Applications/Tailscale.app/Contents/MacOS/Tailscale'] }))
      .toBe('/Applications/Tailscale.app/Contents/MacOS/Tailscale')
    expect(resolve({ present: [`${HOME}/Applications/Tailscale.app/Contents/MacOS/Tailscale`] }))
      .toBe(`${HOME}/Applications/Tailscale.app/Contents/MacOS/Tailscale`)
  })

  it('prefers the installer location over Homebrew and the app bundle', () => {
    const present = [
      '/usr/local/bin/tailscale',
      '/opt/homebrew/bin/tailscale',
      '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    ]
    expect(resolve({ present })).toBe('/usr/local/bin/tailscale')
  })

  it('falls back to the bare name so PATH-resolved installs and the tailscale_missing diagnostic still work', () => {
    expect(resolve()).toBe('tailscale')
  })

  it('honours the environment override even when nothing is on disk', () => {
    expect(resolve({ env: { DSH_ON_PHONE_TAILSCALE_BIN: '/custom/tailscale' } })).toBe('/custom/tailscale')
    expect(resolve({ env: { DSH_ON_PHONE_TAILSCALE_BIN: '  ' } })).toBe('tailscale')
    // The pre-rename spelling still resolves, and the new one wins.
    expect(resolve({ env: { DSH_MOBILE_TAILSCALE_BIN: '/legacy/tailscale' } })).toBe('/legacy/tailscale')
    expect(resolve({ env: { DSH_ON_PHONE_TAILSCALE_BIN: '/new', DSH_MOBILE_TAILSCALE_BIN: '/legacy' } })).toBe('/new')
  })

  it('covers the Windows and Linux install locations', () => {
    const windows = tailscaleBinaryCandidates('win32', { ProgramFiles: 'C:\\Program Files' }, HOME)
    expect(windows).toContain('C:\\Program Files\\Tailscale\\tailscale.exe')
    const windowsLocal = tailscaleBinaryCandidates('win32', { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' }, HOME)
    expect(windowsLocal).toContain('C:\\Users\\tester\\AppData\\Local\\Tailscale\\tailscale.exe')
    const linux = tailscaleBinaryCandidates('linux', {}, HOME)
    expect(linux).toContain('/usr/bin/tailscale')
    expect(linux).toContain('/snap/bin/tailscale')
  })

  it('resolves on Linux only to locations that exist', () => {
    expect(resolve({ platform: 'linux', present: ['/usr/sbin/tailscale'] })).toBe('/usr/sbin/tailscale')
    expect(resolve({ platform: 'linux' })).toBe('tailscale')
  })
})
