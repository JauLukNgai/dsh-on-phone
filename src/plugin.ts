import type { Context } from '@deepseek-ai/cordis'
import { boundContextSummary, createUserMessage, type ContextFormed } from '@deepseek-ai/dsh-llm/message'
// Side-effect type import: activates dsh-commands' Context augmentation so
// `ctx.commands` and its handler types resolve without a runtime dependency.
import type {} from '@deepseek-ai/dsh-commands'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parseControlFile, parseGatewayConfig, type PluginConfig, type ResolvedGatewayConfig } from './config.js'
import { warnUnsupportedDshVersion } from './compatibility.js'
import { collectConnectionDiagnostics } from './diagnostics.js'
import { MOBILE_CUSTOMIZATION_GUIDE } from './mobile-guide.js'
import {
  FollowingMobileAccessRuntime,
  JsonMobileAccessControlStore,
  MobileAccessGatewayController,
  type MobileAccessRuntime,
} from './control.js'
import { MobileAccessGateway } from './gateway.js'
import { createMobileAccessService, type MobileAccessService } from './extensions.js'
import { listComputerImages, readComputerImage } from './computer-images.js'
import {
  AUTH_PREFIX,
  HttpError,
  LOCAL_ADMIN_PREFIX,
  assertLocalAdminTrust,
  parseRequestTarget,
  readJsonObject,
  sendFailure,
  sendJson,
} from './http-security.js'
import { JsonDeviceStore } from './storage.js'
import { configuredRemoteProvider, JsonRemoteProviderStore, type RemoteProvider } from './remote.js'
import { TailscaleServeController } from './tailscale-serve.js'
import { RemotePassthroughProxy } from './remote-proxy.js'
import { resolveLiveUpstream } from './upstream.js'
import {
  materializeManagedSetup,
  parseManagedSetup,
  selectLanNetwork,
  type ManagedSetup,
} from './managed-setup.js'

// The Host's message-source vocabulary is merge-extensible: every producer
// declares its own `kind` in its own module (upstream's webhook, schedule, and
// cordis-host-runner do exactly this). 0.2.0-rc.2 dropped the old shared
// `plugin` kind, so this plugin declares its own — which also labels the
// collapsed context row after the plugin instead of after a generic kind.
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** One `/mobile` request handed to the agent as plugin context, not as a user bubble. */
    'dsh-on-phone': { readonly kind: 'dsh-on-phone' } & ContextFormed
  }
}

/** Stable Cordis plugin name. */
export const name = 'dsh-on-phone'

/** The stock WebServer serves the control card; Connection authenticates the loopback DSH origin. */
export const inject = ['webServer', 'commands', 'connection']

interface BrowserAuthenticatedConnection {
  authenticatedUrl?: (baseUrl: string) => string
}

function upstreamAuthenticatedUrl(ctx: Context, upstreamOrigin: URL): string | undefined {
  const connection = (ctx as Context & { readonly connection?: BrowserAuthenticatedConnection }).connection
  return typeof connection?.authenticatedUrl === 'function'
    ? connection.authenticatedUrl(upstreamOrigin.origin)
    : undefined
}

/** The authoritative live loopback origin of this process's web server, when bound to loopback. */
function webServerOrigin(ctx: Context): string | undefined {
  const server = (ctx as Context & { readonly webServer?: { readonly host?: unknown; readonly port?: unknown } }).webServer
  if (server?.host !== '127.0.0.1') return undefined
  const port = server.port
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return undefined
  return `http://127.0.0.1:${port}`
}

function installedDshVersion(): string | undefined {
  try {
    const manifest = createRequire(import.meta.url)('@deepseek-ai/dsh-host-webserver/package.json') as unknown
    if (manifest === null || typeof manifest !== 'object') return undefined
    const version = (manifest as { readonly version?: unknown }).version
    return typeof version === 'string' ? version : undefined
  } catch {
    // The desktop app bundles the Host WebServer inside its archive, so it
    // may not resolve from this profile; an unknown version must not block boot.
    return undefined
  }
}

function mapAdminError(error: unknown): HttpError {
  if (error instanceof HttpError) return error
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'EADDRNOTAVAIL') return new HttpError(409, 'network_address_changed')
  if (code === 'EADDRINUSE') return new HttpError(409, 'listen_port_in_use')
  if (error instanceof Error && error.message.startsWith('saved LAN interface ')) {
    return new HttpError(409, 'network_interface_unavailable')
  }
  return new HttpError(500, 'internal_error')
}

const SETUP_KEYS = new Set([
  'version', 'publicOrigin', 'listenHost', 'listenPort', 'upstreamOrigin',
  'publicAuthorities', 'allowedCidrs', 'instanceId', 'pairingCaFile', 'tls',
])

type LoadedSetup = {
  readonly kind: 'fixed'
  readonly config: PluginConfig
} | {
  readonly kind: 'managed'
  readonly config: PluginConfig
  readonly setup: ManagedSetup
}

function withoutSetupKeys(config: PluginConfig): PluginConfig {
  const merged = { ...config } as Record<string, unknown>
  for (const key of SETUP_KEYS) if (key !== 'version') delete merged[key]
  return merged as unknown as PluginConfig
}

async function loadSetup(config: PluginConfig): Promise<LoadedSetup> {
  if (config.setupFile === undefined) return { kind: 'fixed', config }
  if (!isAbsolute(config.setupFile)) throw new Error('setupFile must be an absolute file path')
  let source: string
  try {
    source = await readFile(resolve(config.setupFile), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'fixed', config }
    throw error
  }
  let parsed: unknown
  try { parsed = JSON.parse(source) as unknown }
  catch (error) { throw new Error('mobile setup file is not valid JSON', { cause: error }) }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('mobile setup file must be an object')
  }
  const record = parsed as Record<string, unknown>
  if (record.version === 2) {
    return { kind: 'managed', config: withoutSetupKeys(config), setup: parseManagedSetup(record) }
  }
  if (record.version !== 1 || Reflect.ownKeys(record).some(key => typeof key !== 'string' || !SETUP_KEYS.has(key))) {
    throw new Error('mobile setup file has an unsupported format')
  }
  const { version: _version, ...setup } = record
  return {
    kind: 'fixed',
    config: { ...withoutSetupKeys(config), ...setup } as unknown as PluginConfig,
  }
}

function loopbackTemplate(loaded: LoadedSetup): ResolvedGatewayConfig {
  const base = withoutSetupKeys(loaded.config)
  return parseGatewayConfig({
    ...base,
    ...(loaded.kind === 'managed'
      ? { upstreamOrigin: loaded.setup.upstreamOrigin }
      : loaded.config.upstreamOrigin === undefined ? {} : { upstreamOrigin: loaded.config.upstreamOrigin }),
    listenHost: '127.0.0.1',
    listenPort: 0,
    publicAuthorities: ['127.0.0.1'],
    allowedCidrs: ['127.0.0.0/8'],
    tls: { mode: 'disabled' },
  })
}

interface RemoteStatus {
  readonly enabled: boolean
  readonly state: string
  readonly origin?: string
  readonly loginUrl?: string
  readonly setupUrl?: string
  readonly errorCode?: string
}

function remoteControlPayload(
  provider: RemoteProvider,
  status: RemoteStatus,
): Record<string, unknown> {
  return {
    provider,
    running: status.enabled,
    state: status.state,
    ...(status.origin === undefined ? {} : { origin: status.origin }),
    ...(status.loginUrl === undefined ? {} : { loginUrl: status.loginUrl }),
    ...(status.setupUrl === undefined ? {} : { setupUrl: status.setupUrl }),
    ...(status.errorCode === undefined ? {} : { errorCode: status.errorCode }),
  }
}

/** Mount the resident control route and its optional authenticated LAN gateway. */
export async function apply(ctx: Context, config: PluginConfig): Promise<void> {
  const dshVersion = installedDshVersion() ?? 'unknown'
  // Advisory only: an unverified Host version must never abort activation, or
  // the failed loader entry takes the whole plugin tree — and therefore the
  // Host boot — down with it (DSH Desktop then falls back to its safe-mode
  // profile with every third-party plugin disabled).
  warnUnsupportedDshVersion(dshVersion)
  const loaded = await loadSetup(config)
  const mobileAccess: MobileAccessService = createMobileAccessService(ctx)
  const template = loopbackTemplate(loaded)
  const liveWebOrigin = webServerOrigin(ctx)
  const resolveUpstream = (): URL => resolveLiveUpstream(template.upstreamOrigin.origin, liveWebOrigin)
  const resolveAuthenticatedUrl = (upstream: URL): string | undefined => upstreamAuthenticatedUrl(ctx, upstream)
  const stateDirectory = dirname(template.stateFile)
  const remoteDirectory = join(stateDirectory, 'remote')
  const remoteProviderStore = new JsonRemoteProviderStore(
    join(remoteDirectory, 'provider.json'),
    configuredRemoteProvider(process.env),
  )
  let remoteProvider = (await remoteProviderStore.load()).provider
  const unregisterBuiltin = mobileAccess.registerExtension({
    schemaVersion: 1,
    id: 'computer-images',
    name: 'Computer images',
    version: '1.0.0',
    description: 'Authenticated computer-side image browser',
    routes: [
      {
        method: 'GET', path: 'list',
        async handle(request) {
          return { status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(await listComputerImages(request.query.get('path'))) }
        },
      },
      {
        method: 'GET', path: 'image',
        async handle(request) {
          const image = await readComputerImage(request.query.get('path'))
          return { status: 200, contentType: image.contentType, headers: { 'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(image.name)}` }, body: image.body }
        },
      },
    ],
  })
  let lanGateway: MobileAccessGateway | undefined
  const startGateway = async (candidateConfig: PluginConfig): Promise<MobileAccessRuntime> => {
    const upstream = resolveLiveUpstream(
      candidateConfig.upstreamOrigin ?? template.upstreamOrigin.origin,
      liveWebOrigin,
    )
    const resolved = parseGatewayConfig({
      ...candidateConfig,
      upstreamOrigin: upstream.origin,
    })
    const candidate = new MobileAccessGateway(
      resolved,
      new JsonDeviceStore(resolved.stateFile, resolved.maxDevices),
      mobileAccess,
      upstreamAuthenticatedUrl(ctx, upstream),
    )
    await candidate.start()
    lanGateway = candidate
    return {
      close: async () => {
        if (lanGateway === candidate) lanGateway = undefined
        await candidate.close()
      },
    }
  }
  const startRuntime = async (): Promise<MobileAccessRuntime> => {
    if (loaded.kind === 'fixed') return startGateway(loaded.config)
    const following = new FollowingMobileAccessRuntime(async () => {
      const network = selectLanNetwork(undefined, loaded.setup.networkInterface)
      return {
        key: `${network.name}\0${network.address}\0${network.cidr}`,
        start: async () => startGateway({
          ...loaded.config,
          ...await materializeManagedSetup(loaded.setup),
        }),
      }
    }, (error) => {
      process.emitWarning(`DSH Mobile could not follow the current LAN address: ${error instanceof Error ? error.message : String(error)}`, {
        code: 'DSH_ON_PHONE_NETWORK_REFRESH',
      })
    })
    await following.initialize(2_000)
    return following
  }
  const lanController = new MobileAccessGatewayController(
    new JsonMobileAccessControlStore(parseControlFile(config.controlFile), config.initiallyEnabled),
    startRuntime,
  )
  const tailscaleStore = new JsonMobileAccessControlStore(join(remoteDirectory, 'control.json'), false)
  const remoteProxy = new RemotePassthroughProxy({
    resolveUpstream,
    resolveAuthenticatedUrl,
    upstreamTimeoutMs: template.upstreamTimeoutMs,
    maxBodyBytes: template.maxBodyBytes,
    maxWebSockets: template.maxWebSockets,
  })
  const remoteControllers = {
    tailscale: new TailscaleServeController({
      store: tailscaleStore,
      proxy: remoteProxy,
    }),
  }
  const remoteController = () => remoteControllers[remoteProvider]
  const remotePayload = (): Record<string, unknown> => remoteControlPayload(
    remoteProvider,
    remoteController().status(),
  )
  const lanPayload = (): Record<string, unknown> => ({
    running: lanController.isRunning(),
    origin: lanGateway?.address().origin,
    ...(lanGateway === undefined ? {} : { extensions: lanGateway.extensionStatus() }),
  })
  const diagnosticsPayload = async (): Promise<Record<string, unknown>> => {
    let interfaceName: string | undefined
    let networkError: string | undefined
    if (loaded.kind === 'managed') {
      try { interfaceName = selectLanNetwork(undefined, loaded.setup.networkInterface).name }
      catch { networkError = 'network_interface_unavailable' }
    }
    const remote = remoteController().status()
    return collectConnectionDiagnostics({
      dshVersion,
      lan: {
        running: lanController.isRunning(),
        ...(lanGateway === undefined ? {} : { origin: lanGateway.address().origin, port: lanGateway.address().port }),
        ...(loaded.kind === 'managed' ? { configuredInterface: loaded.setup.networkInterface, port: loaded.setup.listenPort } : {}),
        ...(interfaceName === undefined ? {} : { interfaceName }),
        ...(networkError === undefined ? {} : { networkError }),
      },
      remote: {
        provider: remoteProvider,
        running: remote.enabled,
        state: remote.state,
        ...(remote.origin === undefined ? {} : { origin: remote.origin }),
        ...(remote.errorCode === undefined ? {} : { errorCode: remote.errorCode }),
      },
    }) as unknown as Record<string, unknown>
  }

  const adminRoute: WebRoute = {
    kind: 'prefix',
    path: LOCAL_ADMIN_PREFIX,
    handler: async (request, response) => {
      try {
        const target = parseRequestTarget(request.url)
        assertLocalAdminTrust(request, request.method === 'POST')
        if (target.search !== '') throw new HttpError(400, 'bad_request')
        const lanControl = target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/control`
          || target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/lan/control`
        if (request.method === 'GET' && lanControl) {
          sendJson(response, 200, lanPayload(), false)
          return
        }
        if (request.method === 'GET' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/diagnostics`) {
          sendJson(response, 200, await diagnosticsPayload(), false)
          return
        }
        if (request.method === 'POST' && lanControl) {
          const body = await readJsonObject(request, 4096)
          if (typeof body.running !== 'boolean') throw new HttpError(400, 'bad_request')
          await lanController.setRunning(body.running)
          sendJson(response, 200, lanPayload(), false)
          return
        }
        if (request.method === 'GET' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/remote/control`) {
          sendJson(response, 200, remotePayload(), false)
          return
        }
        if (request.method === 'POST' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/remote/control`) {
          const body = await readJsonObject(request, 4096)
          if (typeof body.running !== 'boolean') throw new HttpError(400, 'bad_request')
          await remoteController().setEnabled(body.running)
          sendJson(response, 200, remotePayload(), false)
          return
        }
        if (request.method === 'POST' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/remote/reconnect`) {
          await readJsonObject(request, 4096)
          await remoteController().reconnect()
          sendJson(response, 200, remotePayload(), false)
          return
        }
        if (request.method === 'POST' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/remote/reset`) {
          const body = await readJsonObject(request, 4096)
          if (body.confirm !== true) throw new HttpError(400, 'bad_request')
          await remoteController().reset()
          sendJson(response, 200, remotePayload(), false)
          return
        }
        if (target.decodedPathname.startsWith(`${LOCAL_ADMIN_PREFIX}/lan/`)) {
          const active = lanGateway
          if (active === undefined) throw new HttpError(409, 'gateway_stopped')
          await active.localAdminRoute(`${LOCAL_ADMIN_PREFIX}/lan`).handler(request, response)
          return
        }
        const active = lanGateway
        if (active === undefined) throw new HttpError(409, 'gateway_stopped')
        await active.localAdminRoute().handler(request, response)
      } catch (error) {
        const mapped = mapAdminError(error)
        if (response.headersSent) response.destroy()
        else sendFailure(response, mapped.status, mapped.code, false)
      }
    },
  }

  // Pairing-free mobile-frontend assets for the remote (Tailscale Serve)
  // channel: the LAN gateway serves them behind device pairing on its own
  // listener, so the DSH WebServer mirrors them for the phone reachable via
  // the passthrough proxy (tailnet membership is the access control there).
  const mobileFrontendRoute: WebRoute = {
    kind: 'prefix',
    path: AUTH_PREFIX,
    handler: async (request, response) => {
      const active = lanGateway
      if (active === undefined) throw new HttpError(409, 'gateway_stopped')
      await active.mobileFrontendRoute().handler(request, response)
    },
  }

  await ctx.effect(async () => {
    const unregister = ctx.webServer.register(adminRoute)
    const unregisterFrontend = ctx.webServer.register(mobileFrontendRoute)
    const disposeMobileCommand = ctx.commands.register({
      name: 'mobile',
      description: '按需求修改 DSH Mobile 的手机端界面或添加电脑端能力',
      input: { hint: '<要做什么>' },
      handler: ({ agent, rawInput }) => {
        const task = rawInput.trim()
        if (task === '') return { kind: 'error', text: '请带上需求，例如：/mobile 把手机端改成深色主题' }
        // A plugin-source message renders as a collapsed context-injection row
        // (label "dsh-on-phone", one-line notice summary) instead of a user bubble,
        // while steering still wakes the agent with the full guide as input.
        agent.steer(createUserMessage({
          content: [{ type: 'text', text: `${MOBILE_CUSTOMIZATION_GUIDE}\n\n用户需求：${task}` }],
          source: {
            kind: 'dsh-on-phone',
            form: 'notice',
            summary: boundContextSummary(`/mobile ${task}`),
          },
        }))
        return { kind: 'success', text: '已把需求交给 DSH 处理，改动会在手机端几秒内生效。' }
      },
    })
    try {
      await mobileAccess.startLocal(template.extensionsDir, ctx)
      await lanController.initialize()
      await remoteControllers.tailscale.initialize()
    } catch (error) {
      unregister()
      unregisterFrontend()
      disposeMobileCommand()
      await remoteControllers.tailscale.close()
      await lanController.close()
      await mobileAccess.stopLocal()
      unregisterBuiltin()
      throw error
    }
    return async () => {
      unregister()
      unregisterFrontend()
      disposeMobileCommand()
      await remoteControllers.tailscale.close()
      await lanController.close()
      await mobileAccess.stopLocal()
      unregisterBuiltin()
    }
  }, 'dsh-on-phone: independent LAN and selectable remote access with /mobile command')
}
