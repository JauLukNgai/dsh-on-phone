/** DeepSeek Harness prereleases verified by this plugin release. */
export const SUPPORTED_DSH_VERSIONS = Object.freeze([
  '0.1.0-rc.5',
  '0.1.0-rc.6',
  '0.1.0-rc.7',
  '0.1.1-rc.2',
  '0.1.2-alpha.1',
  '0.1.2-rc.1',
  '0.1.7-rc.2',
  '0.2.0-rc.2',
] as const)

/**
 * Whether a reported Host version is in the verified set.
 *
 * An unresolvable version reports `'unknown'`, which is not a mismatch: the
 * packaged desktop app bundles the Host WebServer inside its archive, so the
 * version is legitimately unreadable there. Only a *known* version can be
 * judged.
 * @param version - Version reported by the installed DSH WebServer package.
 */
export function isSupportedDshVersion(version: unknown): boolean {
  if (typeof version !== 'string' || version === 'unknown') return true
  return SUPPORTED_DSH_VERSIONS.some(candidate => candidate === version)
}

/**
 * Strict gate for callers that must refuse an unverified Host outright.
 * @param version - Version reported by the installed DSH WebServer package.
 */
export function assertSupportedDshVersion(version: unknown): void {
  if (isSupportedDshVersion(version)) return
  throw new Error(`unsupported DeepSeek Harness version ${String(version)}; supported versions: ${SUPPORTED_DSH_VERSIONS.join(', ')}`)
}

/**
 * Activation-time gate: an unverified Host version is reported as a warning and
 * activation continues.
 *
 * This must never throw. Throwing while applying fails the loader entry, and the
 * plugin loader treats a failed entry as a failed plugin tree, so the whole Host
 * entry fails to boot and DSH Desktop falls back to its safe-mode profile with
 * every third-party plugin disabled. One plugin's unverified version string must
 * not take the user's entire harness down; the version is an advisory signal,
 * while the contract that actually matters (the frontend boot manifest and the
 * injected Host services) is validated where it is used, and fails closed there.
 * @param version - Version reported by the installed DSH WebServer package.
 * @returns Whether the version was unverified, and therefore warned about.
 */
export function warnUnsupportedDshVersion(version: unknown): boolean {
  if (isSupportedDshVersion(version)) return false
  process.emitWarning(
    `dsh-on-phone was not verified against DeepSeek Harness ${String(version)}; `
    + `verified versions: ${SUPPORTED_DSH_VERSIONS.join(', ')}. `
    + 'Continuing; mobile access may misbehave, so upgrade the plugin if the mobile UI breaks.',
    { code: 'DSH_ON_PHONE_UNVERIFIED_DSH_VERSION' },
  )
  return true
}
