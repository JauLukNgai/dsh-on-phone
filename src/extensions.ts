import { createHash } from 'node:crypto'
import { lstat, mkdir, opendir, readFile, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Readable } from 'node:stream'

/** Maximum sizes enforced at the local-extension filesystem boundary. */
export const EXTENSION_LIMITS = Object.freeze({
  manifest: 64 * 1024,
  script: 1024 * 1024,
  css: 512 * 1024,
  asset: 8 * 1024 * 1024,
})

/** A misbehaving host activation must not wedge the local watcher forever. */
const HOST_ACTIVATION_TIMEOUT_MS = 5_000

async function withActivationTimeout<T>(promise: Promise<T>, id: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new MobileExtensionError('host_load_timeout', `extension ${id} activation timed out`, 500)), HOST_ACTIVATION_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** A controlled business failure returned by an extension action or route. */
export class MobileExtensionError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message)
    this.name = 'MobileExtensionError'
  }
}

/** One host-side action exposed by an extension. */
export interface MobileHostAction {
  readonly input?: { parse(value: unknown): unknown }
  readonly run: (context: MobileActionContext, input: unknown) => unknown | Promise<unknown>
}

/** Context supplied to a host action. */
export interface MobileActionContext {
  readonly signal: AbortSignal
  readonly deviceId: string
}

/** Safe request values supplied to a host route. */
export interface MobileRouteRequest {
  readonly method: string
  readonly pathname: string
  readonly query: Readonly<URLSearchParams>
  readonly headers: Readonly<Record<string, string>>
  readonly body: Uint8Array
  readonly signal: AbortSignal
  readonly deviceId: string
}

/** Values an extension route may return. */
export interface MobileRouteResponse {
  readonly status?: number
  readonly contentType?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly body: string | Uint8Array | Readable
}

/** One host-side route exposed by an extension. */
export interface MobileHostRoute {
  readonly method: string
  readonly path: string
  readonly kind?: 'exact' | 'prefix'
  readonly handle: (request: MobileRouteRequest) => MobileRouteResponse | Promise<MobileRouteResponse>
}

/** Metadata shared by local and npm-provided extensions. */
export interface MobileExtensionManifest {
  readonly schemaVersion: 1
  readonly id: string
  readonly name: string
  readonly version: string
  readonly description?: string
}

/** Definition registered by a normal Cordis plugin. */
export interface MobileExtensionDefinition extends MobileExtensionManifest {
  readonly actions?: Readonly<Record<string, MobileHostAction>>
  readonly routes?: readonly MobileHostRoute[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    mobileAccess: MobileAccessService
  }
}

/** A local extension manifest read from extension.json. */
export interface LocalExtensionManifest extends MobileExtensionManifest {}

/** Public snapshot sent to the mobile browser. */
export interface MobileExtensionClientEntry extends MobileExtensionManifest {
  readonly scriptUrl?: string
  readonly styleUrl?: string
  readonly assetsUrl?: string
}

/** Small status summary used by the desktop mobile-access card. */
export interface MobileExtensionStatus {
  readonly loaded: number
  readonly failed: number
}

interface ActiveLocalExtension {
  readonly manifest: LocalExtensionManifest
  readonly directory: string
  readonly scriptFile?: string
  readonly styleFile?: string
  readonly host: MobileExtensionDefinition
  readonly controller: AbortController
  readonly cleanups: readonly (() => void | Promise<void>)[]
  readonly digest: string
}

interface RegisteredExtension {
  readonly definition: MobileExtensionDefinition
  readonly dispose: () => void
}

type HostApi = {
  readonly manifest: LocalExtensionManifest
  readonly context: Context
  readonly schema: typeof z
  readonly signal: AbortSignal
  action(name: string, spec: MobileHostAction): void
  route(spec: MobileHostRoute): void
  effect(setup: () => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>): void
}

type LocalHostModule = { readonly default?: (api: HostApi) => void | Promise<void> }

/** Validate user-facing extension text without allowing control characters. */
function text(value: unknown, field: string, maximum: number, required: boolean): string | undefined {
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string' || (required && value.length === 0) || value.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)) throw new MobileExtensionError('invalid_manifest', `${field} is invalid`)
  return value
}

/** Validate a stable extension id. */
export function assertExtensionId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(value)) {
    throw new MobileExtensionError('invalid_manifest', 'extension id is invalid')
  }
  return value
}

/** Validate a manifest from JSON or a plugin definition. */
export function parseExtensionManifest(value: unknown): LocalExtensionManifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new MobileExtensionError('invalid_manifest', 'extension.json must be an object')
  }
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== 1) throw new MobileExtensionError('invalid_manifest', 'unsupported extension schema')
  const id = assertExtensionId(record.id)
  const name = text(record.name, 'name', 120, true) as string
  const version = text(record.version, 'version', 64, true) as string
  const description = text(record.description, 'description', 500, false)
  for (const key of Reflect.ownKeys(record)) {
    if (!['schemaVersion', 'id', 'name', 'version', 'description'].includes(String(key))) {
      throw new MobileExtensionError('invalid_manifest', 'extension.json has unknown fields')
    }
  }
  return Object.freeze({ schemaVersion: 1, id, name, version, ...(description === undefined ? {} : { description }) })
}

function normalizeRelativePath(value: string, field: string): string {
  if (value.length === 0 || value.includes('\0') || isAbsolute(value)) throw new MobileExtensionError('invalid_extension_path', `${field} is invalid`)
  const normalized = value.replaceAll('\\', '/')
  if (normalized.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new MobileExtensionError('invalid_extension_path', `${field} escapes extension directory`)
  }
  return normalized
}

async function regularFile(path: string, maximum: number, field: string): Promise<{ readonly path: string; readonly size: number }> {
  let info
  try { info = await lstat(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new MobileExtensionError('invalid_extension', `${field} is missing`)
    throw error
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) {
    throw new MobileExtensionError('invalid_extension', `${field} must be a regular file within its size limit`)
  }
  return { path, size: info.size }
}

async function containedPath(root: string, relativePath: string, maximum: number, field: string): Promise<{ readonly path: string; readonly size: number }> {
  const normalized = normalizeRelativePath(relativePath, field)
  const target = resolve(root, normalized)
  const rootReal = await realpath(root)
  const targetReal = await realpath(target)
  const relation = relative(rootReal, targetReal)
  if (relation === '' || relation.startsWith('..') || isAbsolute(relation)) throw new MobileExtensionError('invalid_extension_path', `${field} escapes extension directory`)
  return regularFile(targetReal, maximum, field)
}

async function optionalFile(root: string, name: string, maximum: number, field: string): Promise<string | undefined> {
  try {
    return (await containedPath(root, name, maximum, field)).path
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    if (error instanceof MobileExtensionError && error.message.includes('is missing')) return undefined
    throw error
  }
}

async function optionalBytes(root: string, name: string, maximum: number, field: string): Promise<Buffer> {
  const path = await optionalFile(root, name, maximum, field)
  return path === undefined ? Buffer.alloc(0) : readFile(path)
}

async function extensionFingerprint(directory: string): Promise<{ readonly manifest: LocalExtensionManifest; readonly digest: string }> {
  const manifestFile = await regularFile(join(directory, 'extension.json'), EXTENSION_LIMITS.manifest, 'extension.json')
  const manifestBody = await readFile(manifestFile.path)
  const manifest = parseExtensionManifest(JSON.parse(manifestBody.toString('utf8')) as unknown)
  if (manifest.id !== basename(resolve(directory))) throw new MobileExtensionError('invalid_manifest', 'extension id must match its directory name')
  const [host, script, style] = await Promise.all([
    optionalBytes(directory, 'host.mjs', EXTENSION_LIMITS.script, 'host.mjs'),
    optionalBytes(directory, 'mobile.js', EXTENSION_LIMITS.script, 'mobile.js'),
    optionalBytes(directory, 'mobile.css', EXTENSION_LIMITS.css, 'mobile.css'),
  ])
  return { manifest, digest: createHash('sha256').update(manifestBody).update(host).update(script).update(style).digest('hex') }
}

function routeKey(route: MobileHostRoute): string {
  const method = route.method.toUpperCase()
  const path = normalizeRoutePath(route.path)
  return `${method} ${route.kind ?? 'exact'} ${path}`
}

function normalizeRoutePath(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256
    || value.includes('?') || value.includes('#') || value.includes('\\') || value.includes('\0')
    || /[\u0000-\u001f\u007f]/u.test(value)) throw new MobileExtensionError('invalid_route', 'extension route path is invalid')
  const normalizedInput = value.startsWith('/') ? value : `/${value}`
  const parts = normalizedInput.split('/')
  if (parts.some(part => part === '..' || part === '.')) throw new MobileExtensionError('invalid_route', 'extension route path is invalid')
  return normalizedInput === '/' ? '/' : normalizedInput.replace(/\/+$/u, '')
}

function validateDefinition(definition: MobileExtensionDefinition): MobileExtensionDefinition {
  const manifest = parseExtensionManifest({
    schemaVersion: definition.schemaVersion,
    id: definition.id,
    name: definition.name,
    version: definition.version,
    ...(definition.description === undefined ? {} : { description: definition.description }),
  })
  const actionNames = new Set<string>()
  for (const [name, action] of Object.entries(definition.actions ?? {})) {
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(name) || action === null || typeof action !== 'object' || typeof action.run !== 'function' || actionNames.has(name)) {
      throw new MobileExtensionError('invalid_action', `invalid action ${name}`)
    }
    actionNames.add(name)
  }
  const routeNames = new Set<string>()
  const routes = (definition.routes ?? []).map(route => {
    if (route === null || typeof route !== 'object' || typeof route.handle !== 'function') throw new MobileExtensionError('invalid_route', 'invalid extension route')
    const method = route.method.toUpperCase()
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new MobileExtensionError('invalid_route', 'unsupported extension route method')
    const normalized: MobileHostRoute = { ...route, method, path: normalizeRoutePath(route.path) }
    const key = routeKey(normalized)
    if (routeNames.has(key)) throw new MobileExtensionError('duplicate_route', `duplicate route ${key}`)
    routeNames.add(key)
    return normalized
  })
  return Object.freeze({ ...manifest, ...(definition.actions === undefined ? {} : { actions: Object.freeze({ ...definition.actions }) }), ...(routes.length === 0 ? {} : { routes: Object.freeze(routes) }) })
}

function combineSignals(first: AbortSignal, second: AbortSignal): AbortSignal {
  if (first.aborted || second.aborted) return AbortSignal.abort(first.aborted ? first.reason : second.reason)
  return AbortSignal.any([first, second])
}

/** Host registry and service consumed by both npm plugins and local extensions. */
export class MobileAccessService extends Service {
  private readonly registered = new Map<string, RegisteredExtension>()
  private readonly local = new Map<string, ActiveLocalExtension>()
  private readonly failures = new Map<string, string>()
  private contentHash = ''
  private localRoot: string | undefined
  private localContext: Context | undefined
  private localTimer: NodeJS.Timeout | undefined
  private localRefreshing: Promise<void> | undefined
  private localClosed = true

  constructor(ctx: Context) { super(ctx, 'mobileAccess') }

  /** Register a normal Cordis extension and return an idempotent disposer. */
  registerExtension(definition: MobileExtensionDefinition): () => void {
    const validated = validateDefinition(definition)
    if (this.registered.has(validated.id) || this.local.has(validated.id)) throw new Error(`mobile extension id already registered: ${validated.id}`)
    const dispose = (): void => {
      const current = this.registered.get(validated.id)
      if (current?.dispose === dispose) {
        this.registered.delete(validated.id)
        this.updateContentHash()
      }
    }
    this.registered.set(validated.id, { definition: validated, dispose })
    this.updateContentHash()
    return dispose
  }

  /** Aggregate digest covering every registered and active local extension. */
  contentDigest(): string {
    return this.contentHash
  }

  private updateContentHash(): void {
    const parts = [
      ...[...this.registered.values()].map(entry => entry.definition.id),
      ...[...this.local.values()].map(active => `${active.manifest.id}:${active.digest}`),
    ]
    this.contentHash = createHash('sha256').update(parts.sort().join('|')).digest('hex')
  }

  /** Return the current client-facing manifest, deterministically sorted by id. */
  manifest(): readonly MobileExtensionClientEntry[] {
    const entries = new Map<string, MobileExtensionClientEntry>()
    for (const { definition } of this.registered.values()) entries.set(definition.id, {
      schemaVersion: 1, id: definition.id, name: definition.name, version: definition.version,
      ...(definition.description === undefined ? {} : { description: definition.description }),
    })
    for (const active of this.local.values()) entries.set(active.manifest.id, {
      ...active.manifest,
      ...(active.scriptFile === undefined ? {} : { scriptUrl: `/mobile-access/extensions/${active.manifest.id}/mobile.js` }),
      ...(active.styleFile === undefined ? {} : { styleUrl: `/mobile-access/extensions/${active.manifest.id}/mobile.css` }),
      assetsUrl: `/mobile-access/extensions/${active.manifest.id}/assets/`,
    })
    return [...entries.values()].sort((left, right) => left.id.localeCompare(right.id))
  }

  /** Return loaded and failed local extension counts without exposing host errors. */
  status(): MobileExtensionStatus {
    return Object.freeze({ loaded: this.registered.size + this.local.size, failed: this.failures.size })
  }

  /** Locate one active extension. */
  extension(id: string): MobileExtensionDefinition | ActiveLocalExtension | undefined {
    return this.local.get(id) ?? this.registered.get(id)?.definition
  }

  /** Return the active local generation signal for gateway cancellation wiring. */
  signal(id: string): AbortSignal | undefined {
    const extension = this.local.get(id)
    return extension?.controller.signal
  }

  /** Read a local client entry after validating that it remains inside its directory. */
  async readClientFile(id: string, kind: 'script' | 'style', signal?: AbortSignal): Promise<{ readonly body: Buffer; readonly digest: string }> {
    signal?.throwIfAborted()
    const active = this.local.get(id)
    if (active === undefined) throw new MobileExtensionError('extension_not_found', 'extension not found', 404)
    const path = kind === 'script' ? active.scriptFile : active.styleFile
    if (path === undefined) throw new MobileExtensionError('extension_asset_not_found', 'extension asset not found', 404)
    const maximum = kind === 'script' ? EXTENSION_LIMITS.script : EXTENSION_LIMITS.css
    const file = await regularFile(path, maximum, kind)
    const body = await readFile(file.path, { signal })
    return { body, digest: createHash('sha256').update(body).digest('hex') }
  }

  /** Read a local static asset after containment and size checks. */
  async readAsset(id: string, assetPath: string, signal?: AbortSignal): Promise<{ readonly body: Buffer; readonly digest: string; readonly name: string }> {
    signal?.throwIfAborted()
    const active = this.local.get(id)
    if (active === undefined) throw new MobileExtensionError('extension_not_found', 'extension not found', 404)
    let file
    try { file = await containedPath(join(active.directory, 'assets'), assetPath, EXTENSION_LIMITS.asset, 'asset') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new MobileExtensionError('extension_asset_not_found', 'extension asset not found', 404); throw error }
    const body = await readFile(file.path, { signal })
    return { body, digest: createHash('sha256').update(body).digest('hex'), name: basename(file.path) }
  }

  /** Invoke one action after parsing its input and binding the request lifetime. */
  async invoke(id: string, actionName: string, input: unknown, context: MobileActionContext): Promise<unknown> {
    const extension = this.extension(id)
    if (extension === undefined) throw new MobileExtensionError('extension_not_found', 'extension not found', 404)
    const definition = 'host' in extension ? extension.host : extension
    const action = definition.actions?.[actionName]
    if (action === undefined) throw new MobileExtensionError('action_not_found', 'action not found', 404)
    let parsed = input
    try { parsed = action.input?.parse(input) ?? input } catch { throw new MobileExtensionError('invalid_action_input', 'action input is invalid', 400) }
    const signal = 'host' in extension ? combineSignals(extension.controller.signal, context.signal) : context.signal
    try { return await action.run({ ...context, signal }, parsed) } catch (error) {
      if (error instanceof MobileExtensionError) throw error
      throw new MobileExtensionError('extension_failed', 'extension action failed', 500)
    }
  }

  /** Match one route and invoke it with a generation-bound abort signal. */
  async route(id: string, method: string, pathname: string, request: MobileRouteRequest): Promise<MobileRouteResponse> {
    const extension = this.extension(id)
    if (extension === undefined) throw new MobileExtensionError('extension_not_found', 'extension not found', 404)
    const definition = 'host' in extension ? extension.host : extension
    const route = definition.routes?.find((candidate: MobileHostRoute) => {
      if (candidate.method !== method) return false
      return (candidate.kind ?? 'exact') === 'exact'
        ? candidate.path === pathname
        : pathname === candidate.path || pathname.startsWith(`${candidate.path}/`)
    })
    if (route === undefined) throw new MobileExtensionError('route_not_found', 'route not found', 404)
    try {
      const routeRequest = 'host' in extension
        ? { ...request, signal: combineSignals(extension.controller.signal, request.signal) }
        : request
      const result = await route.handle(routeRequest)
      if (result === null || typeof result !== 'object' || typeof result.body !== 'string' && !(result.body instanceof Uint8Array) && !isReadable(result.body)) {
        throw new MobileExtensionError('invalid_route_response', 'extension returned an invalid response', 500)
      }
      return result
    } catch (error) {
      if (error instanceof MobileExtensionError) throw error
      throw new MobileExtensionError('extension_failed', 'extension route failed', 500)
    }
  }

  /** Start the local directory watcher; an absent directory is intentionally inert. */
  async startLocal(root: string, context: Context): Promise<void> {
    if (this.localRoot !== undefined && resolve(this.localRoot) !== resolve(root)) await this.stopLocal()
    if (this.localTimer !== undefined) clearInterval(this.localTimer)
    this.localRoot = resolve(root); this.localContext = context; this.localClosed = false
    await mkdir(this.localRoot, { recursive: true })
    await this.refreshLocal()
    this.localTimer = setInterval(() => { void this.refreshLocal() }, 2_000)
    this.localTimer.unref()
  }

  /** Stop the watcher and abort every local host generation. */
  async stopLocal(): Promise<void> {
    this.localClosed = true
    if (this.localTimer !== undefined) clearInterval(this.localTimer)
    this.localTimer = undefined
    const previous = [...this.local.values()]
    this.local.clear()
    this.failures.clear()
    await disposeLocal(previous)
  }

  /** Refresh all local extensions atomically; failures keep the previous snapshot. */
  refreshLocal(): Promise<void> {
    if (this.localRefreshing !== undefined) return this.localRefreshing
    this.localRefreshing = this.stageAndCommit().finally(() => { this.localRefreshing = undefined })
    return this.localRefreshing
  }

  private async stageAndCommit(): Promise<void> {
    if (this.localClosed || this.localRoot === undefined || this.localContext === undefined) return
    let names: string[] = []
    try {
      const directory = await opendir(this.localRoot)
      try { for await (const entry of directory) if (entry.isDirectory() && !entry.isSymbolicLink()) names.push(entry.name) }
      finally { await directory.close().catch(() => undefined) }
    } catch { return }
    names.sort()
    const staged: ActiveLocalExtension[] = []
    const stagedFresh: ActiveLocalExtension[] = []
    let failingName = 'local'
    try {
      for (const name of names) {
        failingName = name
        const directory = join(this.localRoot, name)
        const fingerprint = await extensionFingerprint(directory)
        const previous = this.local.get(fingerprint.manifest.id)
        if (previous?.directory === resolve(directory) && previous.digest === fingerprint.digest) staged.push(previous)
        else {
          const fresh = await loadLocalExtension(directory, this.localContext, fingerprint)
          staged.push(fresh); stagedFresh.push(fresh)
        }
      }
      if (this.localClosed || this.localRoot === undefined || this.localContext === undefined) {
        await disposeLocal(stagedFresh)
        return
      }
      const duplicate = new Set<string>()
      for (const entry of staged) {
        if (duplicate.has(entry.manifest.id) || this.registered.has(entry.manifest.id)) throw new MobileExtensionError('duplicate_extension', `duplicate extension id ${entry.manifest.id}`)
        duplicate.add(entry.manifest.id)
      }
      const previous = [...this.local.values()]
      this.local.clear()
      for (const entry of staged) this.local.set(entry.manifest.id, entry)
      for (const entry of staged) this.failures.delete(entry.manifest.id)
      for (const name of names) this.failures.delete(name)
      for (const failure of this.failures.keys()) {
        if (failure !== 'local' && !names.includes(failure)) this.failures.delete(failure)
      }
      this.failures.delete('local')
      await disposeLocal(previous.filter(entry => !staged.includes(entry)))
      this.updateContentHash()
    } catch (error) {
      await disposeLocal(stagedFresh)
      const message = error instanceof Error ? error.message : String(error)
      this.failures.set(failingName, message)
      if (!(error instanceof MobileExtensionError)) this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
    }
  }
}

function isReadable(value: unknown): value is Readable {
  return value !== null && typeof value === 'object' && typeof (value as { pipe?: unknown }).pipe === 'function'
}

async function disposeLocal(entries: readonly ActiveLocalExtension[]): Promise<void> {
  for (const entry of entries) {
    entry.controller.abort()
    for (const cleanup of [...entry.cleanups].reverse()) {
      try { await cleanup() } catch { /* extension teardown cannot block the owner */ }
    }
  }
}

async function loadLocalExtension(directory: string, context: Context, known?: { readonly manifest: LocalExtensionManifest; readonly digest: string }): Promise<ActiveLocalExtension> {
  const root = resolve(directory)
  const rootStat = await lstat(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new MobileExtensionError('invalid_extension', 'extension directory must be real')
  const manifestFile = await regularFile(join(root, 'extension.json'), EXTENSION_LIMITS.manifest, 'extension.json')
  const manifest = known?.manifest ?? parseExtensionManifest(JSON.parse(await readFile(manifestFile.path, 'utf8')) as unknown)
  if (manifest.id !== basename(root)) throw new MobileExtensionError('invalid_manifest', 'extension id must match its directory name')
  const scriptFile = await optionalFile(root, 'mobile.js', EXTENSION_LIMITS.script, 'mobile.js')
  const styleFile = await optionalFile(root, 'mobile.css', EXTENSION_LIMITS.css, 'mobile.css')
  const hostFile = await optionalFile(root, 'host.mjs', EXTENSION_LIMITS.script, 'host.mjs')
  const controller = new AbortController()
  const actions: Record<string, MobileHostAction> = {}
  const routes: MobileHostRoute[] = []
  const cleanups: (() => void | Promise<void>)[] = []
  const pendingEffects: Promise<void>[] = []
  let activationOpen = true
  const api: HostApi = {
    manifest,
    context,
    schema: z,
    signal: controller.signal,
    action(name, spec) { if (actions[name] !== undefined) throw new MobileExtensionError('duplicate_action', `duplicate action ${name}`); actions[name] = spec },
    route(spec) { routes.push(spec) },
    effect(setup) {
      const result = setup()
      if (result instanceof Promise) {
        pendingEffects.push(result.then(async cleanup => {
          if (typeof cleanup !== 'function') return
          if (activationOpen) cleanups.push(cleanup)
          else await cleanup()
        }))
      } else if (typeof result === 'function') cleanups.push(result)
    },
  }
  try {
    const activate = async (): Promise<void> => {
      if (hostFile !== undefined) {
        const digest = createHash('sha256').update(await readFile(hostFile)).digest('hex')
        let imported: LocalHostModule
        try { imported = await import(`${pathToFileURL(hostFile).href}?dsh_generation=${digest}`) as LocalHostModule }
        catch { throw new MobileExtensionError('host_load_failed', `could not load ${manifest.id}/host.mjs`, 500) }
        if (imported.default !== undefined) await imported.default(api)
      }
      await Promise.all(pendingEffects)
    }
    await withActivationTimeout(activate(), manifest.id)
    const host = validateDefinition({ ...manifest, actions, routes })
    activationOpen = false
    const digest = known?.digest ?? createHash('sha256').update(manifest.id).digest('hex')
    return Object.freeze({ manifest, directory: root, ...(scriptFile === undefined ? {} : { scriptFile }), ...(styleFile === undefined ? {} : { styleFile }), host, controller, cleanups: Object.freeze(cleanups), digest })
  } catch (error) {
    activationOpen = false
    await withActivationTimeout(Promise.allSettled(pendingEffects), manifest.id).catch(() => undefined)
    controller.abort()
    for (const cleanup of [...cleanups].reverse()) {
      try { await cleanup() } catch { /* failed activation cannot retain an effect */ }
    }
    throw error
  }
}

/** Construct the service in a Cordis plugin without importing DSH internals. */
export function createMobileAccessService(ctx: Context): MobileAccessService {
  return new MobileAccessService(ctx)
}
