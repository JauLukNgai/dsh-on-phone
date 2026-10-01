import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { rewriteMobileIndex, rewriteRemoteMobileIndex } from '../src/gateway.js'
import { MOBILE_LAYOUT_STYLES } from '../src/mobile-layout.js'
import { DSH_ON_PHONE_MODULE_ID } from '../src/version.js'

// The boot manifest entry id is the published package name. Reading it here
// keeps the fixtures below tied to reality: they used a stale `dsh-on-phone`
// literal for a whole release, which silently skipped the settings ordering.
const packageName = (createRequire(import.meta.url)('../package.json') as { name: string }).name

function index(entries: unknown[]): string {
  return `<!doctype html><html><head><script>window.__DSH_BOOT__ = ${JSON.stringify({ rev: 'stock', entries })};</script></head><body></body></html>`
}

function currentIndex(entries: unknown[]): string {
  return `<!doctype html><html><head><script>globalThis["__DSH_BOOT__"] = ${JSON.stringify({ rev: 'stock', entries })};</script></head><body></body></html>`
}

describe('dedicated mobile layout boot', () => {
  it('replaces only the stock layout bundle and marks the page as dedicated', () => {
    const output = rewriteMobileIndex(index([
      { id: '@deepseek-ai/dsh-client-runtime', url: '/runtime.js', rev: 'runtime' },
      {
        id: '@deepseek-ai/dsh-client-ui-layout',
        url: '/layout.js',
        rev: 'layout',
        inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-theme'],
      },
      { id: '@deepseek-ai/dsh-client-ui-conversation', url: '/conversation.js', rev: 'conversation' },
    ]))

    expect(output).toContain('window.__DSH_ON_PHONE_FRONTEND__="dedicated"')
    expect(output).toContain('window.fetch=(input,init)=>')
    expect(output).toContain('x-dsh-on-phone-csrf')
    expect(output.indexOf('window.fetch=(input,init)=>')).toBeLessThan(output.indexOf('window.__DSH_BOOT__'))
    expect(output).toContain('"url":"/mobile-access/mobile-layout.js"')
    expect(output).toContain('"inject":["@deepseek-ai/dsh-client-runtime","@deepseek-ai/dsh-client-ui-theme"]')
    expect(output).toContain('"url":"/conversation.js"')
    expect(output).not.toContain('"url":"/layout.js"')
    expect(output).toContain('viewport-fit=cover')
  })

  it('keeps the stock layout when the layout module declares a dependency the profile does not know', () => {
    // DSH 0.1.7 added `@deepseek-ai/dsh-client-shortcuts` to the stock layout
    // module and moved to `sidebar`/`main`/`rightbar`/`shell.leading` slots.
    // `mobile-layout.js` implements the older `conversation`/`details` contract,
    // so replacing the module here would serve a page whose conversation has no
    // slot to render into.
    const output = rewriteMobileIndex(currentIndex([
      {
        id: '@deepseek-ai/dsh-client-ui-layout',
        url: '/layout.js',
        rev: 'layout',
        inject: [
          '@deepseek-ai/dsh-client-locale',
          '@deepseek-ai/dsh-client-ui-renderer',
          '@deepseek-ai/dsh-client-ui-session',
          '@deepseek-ai/dsh-client-ui-theme',
          '@deepseek-ai/dsh-client-shortcuts',
        ],
      },
    ]))

    expect(output).toContain('"url":"/layout.js"')
    expect(output).not.toContain('/mobile-access/mobile-layout.js')
    expect(output).toContain('window.__DSH_ON_PHONE_FRONTEND__="dedicated"')
    expect(output).toContain('viewport-fit=cover')
  })

  it('orders the authenticated mobile client before settings without retaining the sidebar cycle', () => {
    const output = rewriteMobileIndex(index([
      { id: '@deepseek-ai/dsh-client-connection', url: '/connection.js', rev: 'connection', inject: [] },
      { id: '@deepseek-ai/dsh-client-runtime', url: '/runtime.js', rev: 'runtime', inject: ['@deepseek-ai/dsh-client-connection'] },
      {
        id: '@deepseek-ai/dsh-client-ui-layout',
        url: '/layout.js',
        rev: 'layout',
        inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-theme'],
      },
      {
        id: '@deepseek-ai/dsh-client-ui-settings',
        url: '/settings.js',
        rev: 'settings',
        // The DSH 0.1.2 settings module declares only the remotes namespace and
        // no longer depends on connection. Settings must still be ordered after
        // the mobile client, which reads-once trust hint it depends on.
        inject: ['@deepseek-ai/dsh-api-remotes'],
      },
      {
        id: packageName,
        url: '/dsh-on-phone.js',
        rev: 'mobile',
        inject: ['@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-ui-sidebar'],
        immediately: true,
      },
    ]))

    expect(output).toContain(`"id":"${packageName}","url":"/dsh-on-phone.js","rev":"mobile","inject":["@deepseek-ai/dsh-client-connection","@deepseek-ai/dsh-client-runtime"]`)
    expect(output).toContain(`"id":"@deepseek-ai/dsh-client-ui-settings","url":"/settings.js","rev":"settings","inject":["@deepseek-ai/dsh-api-remotes","${packageName}"]`)
    expect(output).not.toContain(`"inject":["@deepseek-ai/dsh-client-connection","@deepseek-ai/dsh-client-ui-sidebar"]`)
  })

  it('locates its own manifest entry by the published package name', () => {
    expect(DSH_ON_PHONE_MODULE_ID).toBe(packageName)
  })

  it('orders the API gateway after the mobile client on the remote-backed settings graph', () => {
    const output = rewriteMobileIndex(index([
      { id: '@deepseek-ai/dsh-client-connection', url: '/connection.js', rev: 'connection', inject: [] },
      { id: '@deepseek-ai/dsh-client-runtime', url: '/runtime.js', rev: 'runtime', inject: ['@deepseek-ai/dsh-client-connection'] },
      {
        id: '@deepseek-ai/dsh-client-ui-layout',
        url: '/layout.js',
        rev: 'layout',
        inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-theme'],
      },
      {
        id: '@deepseek-ai/dsh-api-gateway',
        url: '/gateway.js',
        rev: 'gw',
        inject: ['@deepseek-ai/dsh-client-connection'],
      },
      { id: '@deepseek-ai/dsh-api-remotes', url: '/remotes.js', rev: 'rem', inject: ['@deepseek-ai/dsh-api-gateway'] },
      { id: '@deepseek-ai/dsh-client-ui-settings', url: '/settings.js', rev: 'settings', inject: ['@deepseek-ai/dsh-api-remotes'] },
      {
        id: packageName,
        url: '/dsh-on-phone.js',
        rev: 'mobile',
        inject: ['@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-ui-sidebar'],
        immediately: true,
      },
    ]))

    // @deepseek-ai/dsh-api-gateway memoizes connection.isLoopback into cached
    // $host facts, so it must not activate before the mobile client installs
    // the trust. This is the edge the upstream plugin carries.
    expect(output).toContain(`"id":"@deepseek-ai/dsh-api-gateway"`)
    expect(output).toContain(`"inject":["@deepseek-ai/dsh-client-connection","${packageName}"]`)
    // The pre-boot override is the primary mechanism and must precede the manifest.
    expect(output).toContain('window.__DSH_TRANSPORT__')
    expect(output.indexOf('window.__DSH_TRANSPORT__')).toBeLessThan(output.indexOf('window.__DSH_BOOT__'))
  })

  it('does not demand the API gateway on an older connection-based settings graph', () => {
    // A DSH release with settings still depending on connection has no remote
    // settings graph: the extra ordering edge is skipped, not required.
    const output = rewriteMobileIndex(index([
      { id: '@deepseek-ai/dsh-client-connection', url: '/connection.js', rev: 'connection', inject: [] },
      { id: '@deepseek-ai/dsh-client-runtime', url: '/runtime.js', rev: 'runtime', inject: ['@deepseek-ai/dsh-client-connection'] },
      {
        id: '@deepseek-ai/dsh-client-ui-layout',
        url: '/layout.js',
        rev: 'layout',
        inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-theme'],
      },
      {
        id: '@deepseek-ai/dsh-client-ui-settings',
        url: '/settings.js',
        rev: 'settings',
        inject: ['@deepseek-ai/dsh-client-connection'],
      },
      {
        id: packageName,
        url: '/dsh-on-phone.js',
        rev: 'mobile',
        inject: ['@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-ui-sidebar'],
        immediately: true,
      },
    ]))

    expect(output).toContain(`"inject":["@deepseek-ai/dsh-client-connection","${packageName}"]`)
    // No remote-backed settings graph: upstream injects no transport override.
    expect(output).not.toContain('window.__DSH_TRANSPORT__')
  })

  it('rebuilds the DSH 0.1.2 application batch around the dedicated layout', () => {
    const entries = [
      { id: '@deepseek-ai/dsh-client-connection', url: '/plugins/connection.js?rev=connection', rev: 'connection', inject: [] },
      { id: '@deepseek-ai/dsh-client-ui-renderer', url: '/plugins/renderer.js?rev=renderer', rev: 'renderer', inject: [] },
      {
        id: '@deepseek-ai/dsh-client-ui-layout',
        url: '/plugins/layout.js?rev=layout',
        rev: 'layout',
        inject: [
          '@deepseek-ai/dsh-client-locale',
          '@deepseek-ai/dsh-client-ui-renderer',
          '@deepseek-ai/dsh-client-ui-session',
          '@deepseek-ai/dsh-client-ui-theme',
        ],
      },
      {
        id: '@deepseek-ai/dsh-client-ui-settings',
        url: '/plugins/settings.js?rev=settings',
        rev: 'settings',
        inject: ['@deepseek-ai/dsh-api-remotes'],
      },
      {
        id: packageName,
        url: '/plugins/dsh-on-phone.js?rev=mobile',
        rev: 'mobile',
        inject: ['@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-ui-sidebar'],
        immediately: true,
      },
    ]
    const source = `<!doctype html><html><head><script>globalThis["__DSH_BOOT__"] = ${JSON.stringify({
      rev: 'stock',
      entries,
      batches: [{ phase: 'application', url: '/plugins/application.js?rev=stock', rev: 'stock-batch', entries: entries.map(entry => entry.id) }],
    })};</script></head><body></body></html>`
    const output = rewriteMobileIndex(source)

    expect(output).toContain('"url":"/mobile-access/mobile-layout.js"')
    expect(output).toContain('"inject":["@deepseek-ai/dsh-client-connection","@deepseek-ai/dsh-client-ui-renderer"]')
    expect(output).toContain(`"inject":["@deepseek-ai/dsh-api-remotes","${packageName}"]`)
    expect(output).toMatch(/"url":"\/mobile-access\/mobile-boot\/[a-f\d]{64}\.js"/u)
    expect(output).not.toContain('/plugins/application.js?rev=stock')
    expect(output).toContain(`"entries":${JSON.stringify(entries.map(entry => entry.id))}`)
  })

  it('accepts the DSH 0.1.1 global injection syntax', () => {
    const output = rewriteMobileIndex(currentIndex([
      {
        id: '@deepseek-ai/dsh-client-ui-layout',
        url: '/layout.js',
        rev: 'layout',
        inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-theme'],
      },
    ]))

    expect(output).toContain('window.__DSH_ON_PHONE_FRONTEND__="dedicated"')
    expect(output).toContain('globalThis["__DSH_BOOT__"] = {')
    expect(output).toContain('"url":"/mobile-access/mobile-layout.js"')
  })

  it('adapts stable DSH question surfaces for touch screens', () => {
    expect(MOBILE_LAYOUT_STYLES).toContain('[data-question-key]')
    expect(MOBILE_LAYOUT_STYLES).toContain('[data-question-scroll]')
    expect(MOBILE_LAYOUT_STYLES).toContain('[data-plan-review-key]')
    expect(MOBILE_LAYOUT_STYLES).toContain('[data-plan-review-scroll]')
    expect(MOBILE_LAYOUT_STYLES).toContain('[data-plan-review-key]>section>div:last-child')
    expect(MOBILE_LAYOUT_STYLES).toContain('max-height:min(42dvh,360px)')
    expect(MOBILE_LAYOUT_STYLES).toContain('height:auto!important')
    expect(MOBILE_LAYOUT_STYLES).toContain('min-height:44px')
  })

  it('fails closed when the upstream page cannot identify one layout module', () => {
    expect(() => rewriteMobileIndex(index([]))).toThrow('no unique layout module')
    expect(() => rewriteMobileIndex('<html></html>')).toThrow('no boot manifest')
  })

  it('fails closed when the stock layout dependency contract changes', () => {
    expect(() => rewriteMobileIndex(index([
      { id: '@deepseek-ai/dsh-client-ui-layout', url: '/layout.js', rev: 'layout', inject: ['new-runtime'] },
    ]))).toThrow('unsupported dependencies')
  })
})

describe('remote mobile index rewrite', () => {
  const remoteEntries = () => [
    { id: '@deepseek-ai/dsh-client-connection', url: '/plugins/connection.js?rev=c', rev: 'c', inject: [] },
    { id: '@deepseek-ai/dsh-client-ui-renderer', url: '/plugins/renderer.js?rev=r', rev: 'r', inject: [] },
    {
      id: '@deepseek-ai/dsh-client-ui-layout',
      url: '/plugins/layout.js?rev=l',
      rev: 'l',
      inject: [
        '@deepseek-ai/dsh-client-locale',
        '@deepseek-ai/dsh-client-ui-renderer',
        '@deepseek-ai/dsh-client-ui-session',
        '@deepseek-ai/dsh-client-ui-theme',
      ],
    },
    { id: '@deepseek-ai/dsh-client-ui-settings', url: '/plugins/settings.js?rev=s', rev: 's', inject: ['@deepseek-ai/dsh-api-remotes'] },
    {
      id: packageName,
      url: '/plugins/mobile.js?rev=m',
      rev: 'm',
      inject: ['@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-ui-sidebar'],
      immediately: true,
    },
  ]

  it('orders settings after the mobile client and marks the page as a trusted gateway page', () => {
    const output = rewriteRemoteMobileIndex(currentIndex(remoteEntries()))

    expect(output).toContain('window.__DSH_ON_PHONE_TRUSTED_GATEWAY__=true')
    expect(output).toContain(`"inject":["@deepseek-ai/dsh-api-remotes","${packageName}"]`)
    expect(output).toContain('viewport-fit=cover')
    // The remote channel keeps DSH's own layout and its boot batch.
    expect(output).toContain('"url":"/plugins/layout.js?rev=l"')
    expect(output).not.toContain('/mobile-access/mobile-layout.js')
    expect(output).not.toContain('__DSH_ON_PHONE_FRONTEND__')
  })

  it('leaves the stock boot batch untouched so no plugin batch endpoint is required', () => {
    const entries = remoteEntries()
    const source = `<!doctype html><html><head><script>globalThis["__DSH_BOOT__"] = ${JSON.stringify({
      rev: 'stock',
      entries,
      batches: [{ phase: 'application', url: '/plugins/application.js?rev=stock', rev: 'stock', entries: entries.map(entry => entry.id) }],
    })};</script></head><body></body></html>`

    const output = rewriteRemoteMobileIndex(source)

    expect(output).toContain('/plugins/application.js?rev=stock')
    expect(output).not.toContain('/mobile-access/mobile-boot/')
  })

  it('fails closed on an unsupported layout contract so the caller can serve the stock page', () => {
    expect(() => rewriteRemoteMobileIndex(currentIndex([
      { id: '@deepseek-ai/dsh-client-ui-layout', url: '/layout.js', rev: 'layout', inject: ['new-runtime'] },
    ]))).toThrow('unsupported dependencies')
  })

  it('declares the transport override before the boot manifest is evaluated', () => {
    const output = rewriteRemoteMobileIndex(currentIndex(remoteEntries()))

    expect(output).toContain('window.__DSH_TRANSPORT__')
    expect(output).toContain('ownsHost:true')
    // Order matters: @deepseek-ai/dsh-client-connection reads
    // globalThis.__DSH_TRANSPORT__ while building its handle, and
    // @deepseek-ai/dsh-api-gateway memoizes isLoopback into cached host facts.
    // Anything after the manifest assignment is too late to matter.
    const transport = output.indexOf('window.__DSH_TRANSPORT__')
    const manifest = output.indexOf('__DSH_BOOT__')
    expect(transport).toBeGreaterThan(-1)
    expect(manifest).toBeGreaterThan(-1)
    expect(transport).toBeLessThan(manifest)
  })

  it('leaves an existing transport override alone instead of blanking the page', () => {
    const output = rewriteRemoteMobileIndex(currentIndex(remoteEntries()))

    // The override statement shares a script block with the manifest assignment,
    // so it must never throw: a throw would take the mobile page down entirely.
    expect(output).not.toContain('throw new Error')
  })
})
