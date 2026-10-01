import { createRequire } from 'node:module'

interface PackageManifest {
  readonly version?: unknown
  readonly name?: unknown
}

const manifest = createRequire(import.meta.url)('../package.json') as PackageManifest

/** Version of the installed DSH Mobile plugin package. */
export const DSH_ON_PHONE_VERSION = typeof manifest.version === 'string' ? manifest.version : 'unknown'

/**
 * Client module id this plugin registers in the DSH boot manifest.
 *
 * The module loader id in `tsdown.config.ts` and the boot manifest entry id are
 * both the package name, so it is derived from `package.json` rather than
 * repeated as a literal: the gateway locates its own entry in the manifest by
 * this id, and a stale copy silently skipped that work for a whole release.
 */
export const DSH_ON_PHONE_MODULE_ID = typeof manifest.name === 'string' ? manifest.name : 'dsh-on-phone'

/** Oldest Android App release supported by this plugin generation. */
export const MINIMUM_ANDROID_APP_VERSION = '0.2.2'

/** Public gateway metadata format understood by the Android App. */
export const MOBILE_METADATA_VERSION = 1
