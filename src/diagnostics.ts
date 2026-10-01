import { execFile as execFileCallback } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { promisify } from 'node:util'
import { DSH_ON_PHONE_VERSION, MINIMUM_ANDROID_APP_VERSION } from './version.js'

const execFile = promisify(execFileCallback)

export type DiagnosticStatus = 'ok' | 'warning' | 'error' | 'info'

/** One user-facing diagnostic result with an optional shortest recovery action. */
export interface DiagnosticCheck {
  readonly id: string
  readonly status: DiagnosticStatus
  readonly label: string
  readonly detail: string
  readonly action?: string
}

/** Runtime facts available without exposing credentials or local file paths. */
export interface DiagnosticSnapshot {
  readonly dshVersion: string
  readonly lan: {
    readonly running: boolean
    readonly origin?: string
    readonly configuredInterface?: string
    readonly interfaceName?: string
    readonly networkError?: string
    readonly port?: number
  }
  readonly remote: {
    readonly provider: 'tailscale'
    readonly running: boolean
    readonly state: string
    readonly origin?: string
    readonly errorCode?: string
  }
}

interface FirewallObservation {
  readonly state: 'ready' | 'missing' | 'unknown' | 'not-applicable'
}

interface RemoteObservation {
  readonly state: 'ready' | 'rate-limited' | 'unreachable' | 'not-applicable'
  readonly latencyMs?: number
  readonly fakeIp?: boolean
}

/** Injectable probes keep diagnostics deterministic in tests. */
export interface DiagnosticProbes {
  readonly firewall?: (port: number | undefined) => Promise<FirewallObservation>
  readonly remote?: (origin: string | undefined) => Promise<RemoteObservation>
}

/** Sanitized diagnostic response copied by the desktop UI. */
export interface ConnectionDiagnostics {
  readonly version: 1
  readonly generatedAt: number
  readonly overall: 'ok' | 'attention' | 'error'
  readonly versions: {
    readonly plugin: string
    readonly dsh: string
    readonly minimumAndroidApp: string
  }
  readonly summary: string
  readonly checks: readonly DiagnosticCheck[]
  readonly report: string
}

const REMOTE_ERROR_GUIDANCE: Readonly<Record<string, string>> = Object.freeze({
  component_missing: 'Reinstall the complete plugin package.',
  tailscale_not_logged_in: 'Confirm Tailscale is logged in and on the same tailnet, then reconnect.',
  tailscale_missing: 'Install Tailscale, or set DSH_ON_PHONE_TAILSCALE_BIN to the full path of the tailscale CLI.',
  funnel_unavailable: 'Confirm Funnel is enabled in the Tailscale admin console, then retry.',
  permission_denied: 'Run DSH as administrator and retry.',
  serve_failed: 'Check the network, then click Reconnect.',
  gateway_start_failed: 'Confirm DSH is running, then reconnect.',
})

function check(
  id: string,
  status: DiagnosticStatus,
  label: string,
  detail: string,
  action?: string,
): DiagnosticCheck {
  return Object.freeze({ id, status, label, detail, ...(action === undefined ? {} : { action }) })
}

function maskLanOrigin(origin: string | undefined): string {
  if (origin === undefined) return '未分配'
  try {
    const url = new URL(origin)
    const octets = url.hostname.split('.')
    const host = octets.length === 4 ? `${octets[0]}.${octets[1]}.${octets[2]}.x` : '局域网地址'
    return `${url.protocol}//${host}${url.port === '' ? '' : `:${url.port}`}`
  } catch {
    return '地址格式无效'
  }
}

function remoteSuffix(origin: string | undefined): string {
  if (origin === undefined) return '未分配'
  try {
    const hostname = new URL(origin).hostname
    if (hostname.endsWith('.ts.net')) return '*.ts.net'
    return '公共 HTTPS 地址'
  } catch {
    return '地址格式无效'
  }
}

function defaultFirewallProbe(platform: NodeJS.Platform = process.platform): (port: number | undefined) => Promise<FirewallObservation> {
  return async (port) => {
    if (platform !== 'win32') return { state: 'not-applicable' }
    if (port === undefined) return { state: 'unknown' }
    const script = [
      "$specs = @(@{ Name = 'DSH Mobile HTTPS'; Protocol = 'TCP' }, @{ Name = 'DSH Mobile Discovery'; Protocol = 'UDP' })",
      '$ready = $true',
      '$specs | ForEach-Object {',
      '  $spec = $_',
      "  $rule = Get-NetFirewallRule -DisplayName $spec.Name -ErrorAction SilentlyContinue | Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' } | Select-Object -First 1",
      '  if ($null -eq $rule) { $ready = $false; return }',
      '  $filters = @($rule | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue)',
      `  $matching = @($filters | Where-Object { $_.Protocol -eq $spec.Protocol -and ($_.LocalPort -eq 'Any' -or $_.LocalPort -eq '${String(port)}') })`,
      '  if ($matching.Count -eq 0) { $ready = $false }',
      '}',
      "if ($ready) { 'ready' } else { 'missing' }",
    ].join('; ')
    try {
      const result = await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        timeout: 3_000,
        windowsHide: true,
      })
      return { state: result.stdout.trim() === 'ready' ? 'ready' : 'missing' }
    } catch {
      return { state: 'unknown' }
    }
  }
}

/** Allow remote relays enough time to answer without making diagnostics unbounded. */
export function remoteDiagnosticTimeoutMs(origin: string): number {
  const hostname = new URL(origin).hostname.toLowerCase()
  if (hostname.endsWith('.ts.net')) return 10_000
  return 5_000
}

async function defaultRemoteProbe(origin: string | undefined): Promise<RemoteObservation> {
  if (origin === undefined) return { state: 'not-applicable' }
  const hostname = new URL(origin).hostname
  const started = performance.now()
  try {
    const response = await fetch(new URL('/mobile-access/health', origin), {
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(remoteDiagnosticTimeoutMs(origin)),
    })
    const latencyMs = Math.max(0, Math.round(performance.now() - started))
    if (response.status === 429) return { state: 'rate-limited', latencyMs }
    return response.ok ? { state: 'ready', latencyMs } : { state: 'unreachable', latencyMs }
  } catch {
    let fakeIp = false
    try {
      const addresses = await lookup(hostname, { all: true })
      fakeIp = addresses.some(({ address }) => {
        const [first, second] = address.split('.').map(Number)
        return first === 198 && (second === 18 || second === 19)
      })
    } catch {
      // DNS lookup is supplementary; the failed HTTPS probe remains authoritative.
    }
    return { state: 'unreachable', ...(fakeIp ? { fakeIp: true } : {}) }
  }
}

function reportLine(entry: DiagnosticCheck): string {
  return `[${entry.status.toUpperCase()}] ${entry.label}: ${entry.detail}${entry.action === undefined ? '' : ` ${entry.action}`}`
}

/** Run bounded read-only checks and return a report safe to paste into an issue. */
export async function collectConnectionDiagnostics(
  snapshot: DiagnosticSnapshot,
  probes: DiagnosticProbes = {},
): Promise<ConnectionDiagnostics> {
  const checks: DiagnosticCheck[] = []
  const remoteProbe = snapshot.remote.running && snapshot.remote.state === 'ready' && snapshot.remote.origin !== undefined
    ? (probes.remote ?? defaultRemoteProbe)(snapshot.remote.origin)
    : Promise.resolve<RemoteObservation>({ state: 'not-applicable' })
  const [firewall, remoteObservation] = await Promise.all([
    (probes.firewall ?? defaultFirewallProbe())(snapshot.lan.port),
    remoteProbe,
  ])
  checks.push(check(
    'versions',
    'ok',
    '版本兼容',
    `插件 ${DSH_ON_PHONE_VERSION}，DSH ${snapshot.dshVersion}，Android App 最低 ${MINIMUM_ANDROID_APP_VERSION}。`,
  ))

  if (snapshot.lan.networkError !== undefined) {
    checks.push(check('network', 'error', '局域网网卡', '已保存的网卡当前不可用。', '重新运行 dsh-on-phone setup。'))
  } else if (snapshot.lan.configuredInterface !== undefined) {
    checks.push(check(
      'network',
      'ok',
      '局域网网卡',
      `正在跟随 ${snapshot.lan.interfaceName ?? snapshot.lan.configuredInterface}。`,
    ))
  } else {
    checks.push(check('network', 'info', '局域网网卡', '当前使用固定网络配置。'))
  }

  if (snapshot.lan.running && snapshot.lan.origin !== undefined) {
    checks.push(check('lan', 'ok', '局域网网关', `已监听 ${maskLanOrigin(snapshot.lan.origin)}，配对入口可用。`))
  } else {
    checks.push(check('lan', 'info', '局域网网关', '当前未开启。', '需要手机直连时开启局域网访问。'))
  }

  if (firewall.state === 'ready') {
    checks.push(check('firewall', 'ok', 'Windows 防火墙', '局域网 TCP 与发现规则已启用。'))
  } else if (firewall.state === 'missing') {
    checks.push(check('firewall', 'warning', 'Windows 防火墙', '未找到完整的局域网放行规则。', '以管理员身份重新运行 dsh-on-phone setup。'))
  } else if (firewall.state === 'unknown') {
    checks.push(check('firewall', 'info', 'Windows 防火墙', '系统未允许插件读取防火墙状态。', '若手机找不到电脑，以管理员身份重新运行 setup。'))
  }

  if (!snapshot.remote.running || snapshot.remote.state === 'off') {
    checks.push(check('remote', 'info', '远程通道', '当前未启用。'))
  } else if (snapshot.remote.state === 'ready' && snapshot.remote.origin !== undefined) {
    if (remoteObservation.state === 'ready') {
      checks.push(check('remote', 'ok', '远程通道', `${snapshot.remote.provider} 公共地址 ${remoteSuffix(snapshot.remote.origin)} 可达，往返约 ${String(remoteObservation.latencyMs ?? 0)} ms。`))
    } else if (remoteObservation.state === 'rate-limited') {
      checks.push(check('remote', 'warning', '远程通道', '公共地址可达，但本次检查观察到服务限流。', '稍后重试；旧会话会按需加载以减少流量。'))
    } else if (snapshot.remote.provider === 'tailscale' && remoteObservation.fakeIp === true) {
      checks.push(check(
        'remote',
        'error',
        '远程通道',
        'Tailscale 地址被当前 VPN 或 DNS 代理接管，但 TLS 链路未建立。',
        'Switch VPN node or proxy mode, then retry.',
      ))
    } else {
      checks.push(check('remote', 'error', '远程通道', '提供方显示已就绪，但公共地址暂不可达。', '点击“重新连接”；仍失败时检查提供方状态。'))
    }
  } else if (snapshot.remote.state === 'starting' || snapshot.remote.state === 'connecting' || snapshot.remote.state === 'needs-login') {
    checks.push(check(
      'remote',
      'warning',
      '远程通道',
      snapshot.remote.state === 'needs-login' ? '等待完成 Tailscale 登录。' : '仍在建立连接。',
      snapshot.remote.state === 'needs-login' ? '返回远程页继续登录。' : '等待片刻后重新检查。',
    ))
  } else {
    checks.push(check(
      'remote',
      'error',
      '远程通道',
      `连接未建立（${snapshot.remote.errorCode ?? snapshot.remote.state}）。`,
      REMOTE_ERROR_GUIDANCE[snapshot.remote.errorCode ?? ''] ?? '返回远程页点击“重新连接”。',
    ))
  }

  checks.push(check(
    'phone-network',
    'info',
    '手机网络',
    '电脑无法判断路由器是否隔离了手机。',
    '局域网仍失败时，确认手机与电脑在同一网络，并关闭访客网络或 AP 隔离。',
  ))

  const overall = checks.some(entry => entry.status === 'error')
    ? 'error'
    : checks.some(entry => entry.status === 'warning') ? 'attention' : 'ok'
  const summary = overall === 'ok' ? '连接基础检查正常。' : overall === 'attention' ? '发现需要留意的项目。' : '发现会影响连接的问题。'
  const report = [
    'DSH Mobile 诊断报告',
    `生成时间: ${new Date().toISOString()}`,
    `版本: plugin=${DSH_ON_PHONE_VERSION}; dsh=${snapshot.dshVersion}; min-app=${MINIMUM_ANDROID_APP_VERSION}`,
    `LAN: ${snapshot.lan.running ? 'on' : 'off'}; endpoint=${maskLanOrigin(snapshot.lan.origin)}`,
    `Remote: provider=${snapshot.remote.provider}; state=${snapshot.remote.state}; endpoint=${remoteSuffix(snapshot.remote.origin)}`,
    ...checks.map(reportLine),
  ].join('\n')
  return Object.freeze({
    version: 1,
    generatedAt: Date.now(),
    overall,
    versions: Object.freeze({ plugin: DSH_ON_PHONE_VERSION, dsh: snapshot.dshVersion, minimumAndroidApp: MINIMUM_ANDROID_APP_VERSION }),
    summary,
    checks: Object.freeze(checks),
    report,
  })
}
