/**
 * Authenticated LAN gateway for the existing DSH Web application. The ordinary
 * Web listener remains loopback-only; this package owns pairing and the only
 * listener intended for phones.
 */
export { AccessController, AccessError, BoundedRateLimiter } from './access.js'
export type {
  AccessControllerOptions,
  DeviceSummary,
  PairingResult,
  RenewalResult,
  SessionAuthorization,
} from './access.js'
export { Config, parseControlFile, parseGatewayConfig } from './config.js'
export {
  assertSupportedDshVersion,
  isSupportedDshVersion,
  SUPPORTED_DSH_VERSIONS,
  warnUnsupportedDshVersion,
} from './compatibility.js'
export type {
  DisabledTlsConfig,
  PluginConfig,
  ProvidedTlsConfig,
  ResolvedGatewayConfig,
  TlsConfig,
} from './config.js'
export {
  JsonMobileAccessControlStore,
  MobileAccessGatewayController,
  parseMobileAccessControlState,
} from './control.js'
export type {
  MobileAccessControlState,
  MobileAccessControlStore,
  MobileAccessRuntime,
} from './control.js'
export { MobileAccessGateway, rewriteMobileIndex, rewriteRemoteMobileIndex } from './gateway.js'
export {
  EXTENSION_LIMITS,
  MobileAccessService,
  MobileExtensionError,
  assertExtensionId,
  createMobileAccessService,
  parseExtensionManifest,
} from './extensions.js'
export type {
  LocalExtensionManifest,
  MobileAccessService as MobileAccessRegistry,
  MobileActionContext,
  MobileExtensionClientEntry,
  MobileExtensionDefinition,
  MobileExtensionManifest,
  MobileExtensionStatus,
  MobileHostAction,
  MobileHostRoute,
  MobileRouteRequest,
  MobileRouteResponse,
} from './extensions.js'
export {
  AUTH_PREFIX,
  CSRF_COOKIE,
  CSRF_HEADER,
  DEVICE_COOKIE,
  isAllowedWebSocketPath,
  LOCAL_ADMIN_PREFIX,
  SESSION_COOKIE,
  WS_PATHS,
} from './http-security.js'
export {
  addressAllowed,
  isLoopbackAddress,
  parseAuthority,
  parseCidr,
  RequestTrustPolicy,
  resolveAuthority,
} from './network.js'
export type { AuthoritySpec, ParsedCidr } from './network.js'
export {
  JsonDeviceStore,
  MemoryDeviceStore,
  parseDeviceSnapshot,
} from './storage.js'
export type { DeviceSnapshot, DeviceStore, StoredDevice } from './storage.js'
export { apply, inject, name } from './plugin.js'
