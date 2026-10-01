import { randomBytes } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { restrictPrivateFile } from './private-file.js'

/** Remote transports supported by the desktop plugin and Android client. */
export type RemoteProvider = 'tailscale'

/** Durable selection for the single active remote transport. */
export interface RemoteProviderState {
  readonly version: 1
  readonly provider: RemoteProvider
}

/** Validate the provider selection loaded across the filesystem boundary. */
export function parseRemoteProviderState(value: unknown): RemoteProviderState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('remote provider state must be an object')
  }
  const record = value as Record<string, unknown>
  if (record.version !== 1 || record.provider !== 'tailscale'
    || Reflect.ownKeys(record).some(key => key !== 'version' && key !== 'provider')) {
    throw new Error('remote provider state has an unsupported format')
  }
  return Object.freeze({ version: 1, provider: record.provider })
}

/** Atomic selection store whose absent-file state uses the configured default. */
export class JsonRemoteProviderStore {
  constructor(private readonly file: string, private readonly defaultProvider: RemoteProvider) {}

  async load(): Promise<RemoteProviderState> {
    let stat
    try {
      stat = await lstat(this.file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return Object.freeze({ version: 1, provider: this.defaultProvider })
      }
      throw error
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) {
      throw new Error('remote provider state must be a regular file no larger than 4 KiB')
    }
    await restrictPrivateFile(this.file)
    let parsed: unknown
    try { parsed = JSON.parse(await readFile(this.file, 'utf8')) as unknown } catch (error) {
      throw new Error('remote provider state is not valid JSON', { cause: error })
    }
    return parseRemoteProviderState(parsed)
  }

  async save(state: RemoteProviderState): Promise<void> {
    const validated = parseRemoteProviderState(state)
    const directory = dirname(this.file)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    try {
      const current = await lstat(this.file)
      if (!current.isFile() || current.isSymbolicLink()) {
        throw new Error('remote provider state target must remain a regular file')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const temporary = join(directory, `.${basename(this.file)}.${randomBytes(12).toString('hex')}.tmp`)
    try {
      await writeFile(temporary, `${JSON.stringify(validated)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      await rename(temporary, this.file)
      await restrictPrivateFile(this.file)
    } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }
  }
}

/** Resolve the first-run provider without letting environment values bypass validation. */
export function configuredRemoteProvider(environment: NodeJS.ProcessEnv): RemoteProvider {
  // The pre-rename spelling still resolves, so an existing profile keeps working.
  const name = environment.DSH_ON_PHONE_REMOTE_PROVIDER !== undefined
    ? 'DSH_ON_PHONE_REMOTE_PROVIDER'
    : 'DSH_MOBILE_REMOTE_PROVIDER'
  const value = environment[name] ?? 'tailscale'
  if (value !== 'tailscale') {
    throw new Error(`${name} must be tailscale`)
  }
  return value
}
