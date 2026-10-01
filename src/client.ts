import { createElement } from 'react'
import { installNativeMobileSurface, NATIVE_MOBILE_STYLES } from './native-mobile.js'
import { holdSessionOpen } from './session-hold.js'
import { installSessionOpenGuard } from './session-open-guard.js'
import { reselectSession } from './session-reselect.js'

interface ClientContext {
  effect(effect: () => void | (() => void), label?: string): void
  get(name: 'connection'): MobileConnectionHandle
  /**
   * The app's session service, read opportunistically — see
   * {@link holdSessionOpen}. Deliberately not declared in `inject`: a hard
   * dependency would keep this client half from loading at all on an app build
   * that names the service differently.
   */
  get(name: 'sessions'): unknown
  /**
   * The app's workspace navigation service, read the same opportunistic way —
   * see {@link reselectSession}. Its `openSession` is what the sidebar calls on a
   * tap, and it is the only repair for a session whose retain was aborted.
   */
  get(name: 'uiWorkspace'): unknown
  slots: {
    inject(key: string, callback: () => (() => void)): () => void
    register<Props>(options: { name: string; id: string; order?: number; label?: string }, component: (props: Props) => unknown): () => void
  }
}

interface MobileConnectionHandle {
  isLoopback: boolean
}

interface MobileExtensionContext {
  readonly document: Document
  readonly request: (path: string, init?: RequestInit) => Promise<Response>
  readonly root: HTMLElement
  readonly window: Window
}

type MobileExtensionMount = (context: MobileExtensionContext) => void | (() => void)
type MobileSurfacePlacement = 'page' | 'sidebar-action' | 'header-action' | 'composer-dock' | 'settings-section' | 'overlay'
interface MobileSurface {
  readonly id: string
  readonly placement: MobileSurfacePlacement
  readonly label: string
  mount(container: HTMLElement): void | (() => void)
}
interface MobileClientApi {
  readonly host: {
    invoke(action: string, input: unknown): Promise<unknown>
    fetch(path: string, init?: RequestInit): Promise<Response>
  }
  readonly ui: {
    registerSurface(surface: MobileSurface): () => void
    open(surfaceId: string): void
    close(surfaceId: string): void
    toast(message: string): void
  }
  readonly native: {
    capabilities(): Promise<readonly string[]>
    invoke(action: string, input?: unknown): Promise<unknown>
  }
  readonly signal: AbortSignal
  readonly document: Document
  readonly window: Window
}
interface MobileClientDefinition {
  readonly apiVersion: 1
  readonly id: string
  activate(api: MobileClientApi): void | (() => void) | Promise<void | (() => void)>
}

declare global {
  interface Window {
    dshMobile?: {
      register(mount: MobileExtensionMount): void
      define(definition: MobileClientDefinition): void
    }
    __DSH_ON_PHONE_FRONTEND__?: 'dedicated'
    /**
     * Set only by the plugin's own LAN gateway or remote proxy, never by a page
     * reached through a third-party reverse proxy, so claiming the loopback
     * trust hint stays limited to the channels this plugin authenticates.
     */
    __DSH_ON_PHONE_TRUSTED_GATEWAY__?: boolean
    __DSH_ON_PHONE_NATIVE__?: {
      capabilities(): Promise<readonly string[]> | readonly string[]
      invoke(action: string, input?: unknown): Promise<unknown>
    }
  }
}

const queuedDefinitions: MobileClientDefinition[] = []
let queuedLegacyMount: MobileExtensionMount | undefined
if (typeof window !== 'undefined' && window.dshMobile === undefined) {
  window.dshMobile = {
    register: mount => { queuedLegacyMount = mount },
    define: definition => { queuedDefinitions.push(definition) },
  }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
}

/** Privileged scheme the official DSH desktop application serves its window from. */
const DSH_DESKTOP_PROTOCOL = 'dsh-app:'

/**
 * Decide which surface the current document installs: the phone adaptation or
 * the host's own local control entry.
 *
 * The host's own page is not always a loopback HTTP origin. The official DSH
 * desktop application loads this very frontend from its privileged
 * `dsh-app://app/` scheme, where `location.hostname` is `app`, so classifying by
 * hostname alone took the desktop window for a phone: the phone DOM layer fought
 * the desktop layout (flicker and offset on click, a sidebar that would not
 * close) while the local control entry was never registered.
 *
 * The gateway and the remote proxy stamp an explicit marker on every document
 * they serve, so trust those first, then the desktop shell's own scheme, and
 * keep the hostname heuristic only for a page that reaches DSH through some
 * other non-loopback origin.
 */
export function resolveClientSurface(input: {
  protocol: string
  hostname: string
  search: string
  trustedGateway: boolean
  dedicatedFrontend: string | undefined
}): 'desktop' | 'mobile' {
  if (input.trustedGateway || input.dedicatedFrontend === 'dedicated') return 'mobile'
  // Local preview escape hatch: `?dsh-on-phone-preview` renders the phone
  // adaptation inside the host's own page, whatever its origin; the
  // pre-rename `?dsh-mobile-preview` spelling still opens it.
  const preview = new URLSearchParams(input.search)
  if (preview.has('dsh-on-phone-preview') || preview.has('dsh-mobile-preview')) return 'mobile'
  if (input.protocol === DSH_DESKTOP_PROTOCOL) return 'desktop'
  return isLoopbackHost(input.hostname) ? 'desktop' : 'mobile'
}

/**
 * Match DSH's client-side privilege hint to the authenticated mobile gateway.
 * The gateway authenticates the paired device and forwards allowed requests to
 * DSH's loopback listener, so settings RPCs receive the same Host-side checks
 * as the desktop page even though the phone's visible URL is a LAN address.
 */
export function trustAuthenticatedGatewayConnection(connection: MobileConnectionHandle): () => void {
  const previous = connection.isLoopback
  connection.isLoopback = true
  return () => { connection.isLoopback = previous }
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  return node
}

/** Viewport rectangle of the sidebar trigger that opens the control panel. */
export interface PanelTriggerRect {
  readonly left: number
  readonly right: number
  readonly bottom: number
}

/** Resolved placement for the floating control panel. */
export interface PanelAnchor {
  readonly left: number
  readonly bottom: number
  readonly width: number
  readonly availableHeight: number
}

const PANEL_MAX_WIDTH = 380
const PANEL_MIN_WIDTH = 240
const PANEL_MIN_HEIGHT = 160
const PANEL_MARGIN = 8
const PANEL_GAP = 8
/** Placement used before the trigger has been measured. */
const PANEL_FALLBACK_BOTTOM = 112

/**
 * Anchor the floating control panel beside its sidebar trigger instead of a
 * fixed viewport corner. The sidebar is user-resizable and collapses to a rail,
 * so a hard-coded offset either detaches from the trigger or slips under the
 * sidebar edge; deriving the placement from the live trigger rectangle keeps the
 * two together at any width.
 * @param trigger - Measured trigger rectangle, or undefined before first layout.
 * @param viewport - Current viewport size in CSS pixels.
 * @returns Clamped placement that keeps the panel inside the viewport.
 */
export function resolvePanelAnchor(
  trigger: PanelTriggerRect | undefined,
  viewport: { readonly width: number; readonly height: number },
): PanelAnchor {
  const width = Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, viewport.width - PANEL_MARGIN * 4))
  const maxLeft = Math.max(PANEL_MARGIN, viewport.width - width - PANEL_MARGIN)
  const maxBottom = Math.max(PANEL_MARGIN, viewport.height - PANEL_MIN_HEIGHT)
  if (trigger === undefined) {
    const bottom = Math.max(PANEL_MARGIN, Math.min(PANEL_FALLBACK_BOTTOM, maxBottom))
    return Object.freeze({
      left: Math.min(PANEL_MARGIN, maxLeft),
      bottom,
      width,
      availableHeight: Math.max(PANEL_MIN_HEIGHT, viewport.height - bottom - PANEL_MARGIN),
    })
  }
  // Prefer the panel to the right of the trigger; fall back to its left edge when
  // there is no room, then clamp so the panel never leaves the viewport.
  const beside = trigger.right + PANEL_GAP
  const left = Math.max(PANEL_MARGIN, Math.min(beside + width <= viewport.width - PANEL_MARGIN ? beside : trigger.left, maxLeft))
  const bottom = Math.max(PANEL_MARGIN, Math.min(viewport.height - trigger.bottom, maxBottom))
  return Object.freeze({
    left,
    bottom,
    width,
    availableHeight: Math.max(PANEL_MIN_HEIGHT, viewport.height - bottom - PANEL_MARGIN),
  })
}

const CONTROL_REQUEST_TIMEOUT_MS = 15_000

async function requestJson(
  path: string,
  init?: RequestInit,
  timeoutMs = CONTROL_REQUEST_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const controller = new AbortController()
  const upstreamSignal = init?.signal
  const abortFromUpstream = (): void => { controller.abort(upstreamSignal?.reason) }
  if (upstreamSignal?.aborted === true) abortFromUpstream()
  else upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true })
  const timer = window.setTimeout(() => { controller.abort() }, timeoutMs)
  try {
    const response = await fetch(path, {
      ...init,
      signal: controller.signal,
      headers: { 'content-type': 'application/json', ...init?.headers },
    })
    const body = await response.json() as Record<string, unknown>
    if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${String(response.status)}`)
    return body
  } catch (error) {
    if (controller.signal.aborted && upstreamSignal?.aborted !== true) {
      throw new Error('操作超时，请确认 DSH 仍在运行后重试。')
    }
    throw error
  } finally {
    clearTimeout(timer)
    upstreamSignal?.removeEventListener('abort', abortFromUpstream)
  }
}

function installControl(): { remove: () => void; toggle: () => void } {
  const root = element('div', 'dsh-on-phone-control')
  const panel = element('section', 'dsh-on-phone-control__panel'); panel.hidden = true
  panel.setAttribute('aria-label', '移动访问')
  const header = element('header', 'dsh-on-phone-control__header')
  const title = element('h2'); title.textContent = '移动访问'
  const headerActions = element('div', 'dsh-on-phone-control__header-actions')
  const diagnosticsEntry = element('button', 'dsh-on-phone-control__diagnostic-entry'); diagnosticsEntry.type = 'button'; diagnosticsEntry.textContent = '诊断'; diagnosticsEntry.setAttribute('aria-label', '打开连接诊断'); diagnosticsEntry.setAttribute('aria-pressed', 'false')
  const close = element('button', 'dsh-on-phone-control__close'); close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', '收起移动访问')
  headerActions.append(diagnosticsEntry, close)
  const remoteView = element('div', 'dsh-on-phone-control__view is-remote')
  const remoteIntro = element('p', 'dsh-on-phone-control__intro'); remoteIntro.textContent = '通过 Tailscale Serve 提供私密远程访问。手机安装 Tailscale 并加入同一 tailnet 后，打开下方地址即可；无需配对。'
  const remoteAccess = element('div', 'dsh-on-phone-control__access'); remoteAccess.hidden = true
  const remoteAccessLabel = element('span', 'dsh-on-phone-control__access-label'); remoteAccessLabel.textContent = '远程地址'
  const remoteAccessLink = element('a', 'dsh-on-phone-control__access-link'); remoteAccessLink.target = '_blank'; remoteAccessLink.rel = 'noreferrer'; remoteAccess.append(remoteAccessLabel, remoteAccessLink)
  const remoteStatus = element('p', 'dsh-on-phone-control__status'); remoteStatus.textContent = '正在读取远程状态…'; remoteStatus.setAttribute('aria-live', 'polite')
  const remoteActions = element('div', 'dsh-on-phone-control__actions')
  const remoteToggle = element('button', 'dsh-on-phone-control__primary'); remoteToggle.type = 'button'; remoteToggle.textContent = '启用远程访问'
  const remoteReconnect = element('button', 'dsh-on-phone-control__secondary'); remoteReconnect.type = 'button'; remoteReconnect.textContent = '重新连接'; remoteReconnect.hidden = true
  const remoteCopy = element('button', 'dsh-on-phone-control__secondary'); remoteCopy.type = 'button'; remoteCopy.textContent = '复制地址'; remoteCopy.hidden = true
  remoteActions.append(remoteToggle, remoteReconnect, remoteCopy)
  const diagnosticsView = element('div', 'dsh-on-phone-control__view is-diagnostics'); diagnosticsView.hidden = true
  const diagnosticsIntro = element('p', 'dsh-on-phone-control__intro'); diagnosticsIntro.textContent = '检查版本、网关、网卡、防火墙和远程通道。报告自动脱敏，不读取对话或凭据。'
  const diagnosticsSummary = element('section', 'dsh-on-phone-control__diagnostic-summary is-idle'); diagnosticsSummary.setAttribute('aria-live', 'polite')
  const diagnosticsSummaryMain = element('div', 'dsh-on-phone-control__diagnostic-summary-main')
  const diagnosticsSummaryIcon = element('span', 'dsh-on-phone-control__diagnostic-summary-icon'); diagnosticsSummaryIcon.setAttribute('aria-hidden', 'true')
  const diagnosticsSummaryBody = element('div', 'dsh-on-phone-control__diagnostic-summary-body')
  const diagnosticsSummaryTitle = element('strong'); diagnosticsSummaryTitle.textContent = '尚未检查'
  const diagnosticsSummaryText = element('span'); diagnosticsSummaryText.textContent = '点击下方按钮开始。'
  const diagnosticsSummaryMeta = element('span', 'dsh-on-phone-control__diagnostic-summary-meta'); diagnosticsSummaryMeta.textContent = '等待运行 · 仅收集连接状态'
  diagnosticsSummaryBody.append(diagnosticsSummaryTitle, diagnosticsSummaryText)
  diagnosticsSummaryMain.append(diagnosticsSummaryIcon, diagnosticsSummaryBody)
  diagnosticsSummary.append(diagnosticsSummaryMain, diagnosticsSummaryMeta)
  const diagnosticsToolbar = element('div', 'dsh-on-phone-control__diagnostic-toolbar')
  const diagnosticsRun = element('button', 'dsh-on-phone-control__primary dsh-on-phone-control__diagnostic-run'); diagnosticsRun.type = 'button'; diagnosticsRun.textContent = '开始检查'
  const diagnosticsCopy = element('button', 'dsh-on-phone-control__secondary dsh-on-phone-control__diagnostic-copy'); diagnosticsCopy.type = 'button'; diagnosticsCopy.textContent = '复制脱敏报告'; diagnosticsCopy.disabled = true; diagnosticsCopy.hidden = true
  diagnosticsToolbar.append(diagnosticsRun, diagnosticsCopy)
  const diagnosticsFeedback = element('p', 'dsh-on-phone-control__diagnostic-feedback'); diagnosticsFeedback.hidden = true; diagnosticsFeedback.setAttribute('role', 'status'); diagnosticsFeedback.setAttribute('aria-live', 'polite')
  const diagnosticsChecks = element('div', 'dsh-on-phone-control__diagnostic-checks'); diagnosticsChecks.hidden = true
  const diagnosticsDetails = element('details', 'dsh-on-phone-control__details dsh-on-phone-control__diagnostic-details'); diagnosticsDetails.hidden = true
  const diagnosticsDetailsSummary = element('summary'); diagnosticsDetailsSummary.textContent = '高级诊断详情'
  const diagnosticsReport = element('pre', 'dsh-on-phone-control__diagnostic-report')
  diagnosticsDetails.append(diagnosticsDetailsSummary, diagnosticsReport)
  header.append(title, headerActions)
  remoteView.append(remoteIntro, remoteAccess, remoteStatus, remoteActions)
  diagnosticsView.append(diagnosticsIntro, diagnosticsSummary, diagnosticsToolbar, diagnosticsFeedback, diagnosticsChecks, diagnosticsDetails)
  panel.append(header, remoteView, diagnosticsView); root.append(panel); document.body.append(root)
  let remoteRunning = false
  let remoteReady = false
  let remoteReconnectBusy = false
  let diagnosticsBusy = false
  let copiedDiagnosticReport = ''
  const selectView = (view: 'remote' | 'diagnostics'): void => {
    remoteView.hidden = view !== 'remote'
    diagnosticsView.hidden = view !== 'diagnostics'
    diagnosticsEntry.setAttribute('aria-pressed', String(view === 'diagnostics'))
    diagnosticsEntry.textContent = view === 'diagnostics' ? '返回' : '诊断'
    diagnosticsEntry.setAttribute('aria-label', view === 'diagnostics' ? '返回移动访问' : '打开连接诊断')
    title.textContent = view === 'remote' ? '远程访问' : '连接诊断'
  }
  // The trigger is rendered by the host sidebar slot, so it is looked up live
  // rather than captured: the panel then follows the sidebar as it resizes.
  const panelTrigger = (): HTMLElement | undefined => {
    const node = document.querySelector('.dsh-on-phone-control__trigger')
    return node instanceof HTMLElement ? node : undefined
  }
  const positionPanel = (): void => {
    const rect = panelTrigger()?.getBoundingClientRect()
    const anchor = resolvePanelAnchor(
      rect === undefined ? undefined : { left: rect.left, right: rect.right, bottom: rect.bottom },
      { width: window.innerWidth, height: window.innerHeight },
    )
    root.style.left = `${anchor.left}px`
    root.style.bottom = `${anchor.bottom}px`
    root.style.setProperty('--dsh-on-phone-control-panel-width', `${anchor.width}px`)
    root.style.setProperty('--dsh-on-phone-control-panel-height', `${anchor.availableHeight}px`)
  }
  let panelObserver: ResizeObserver | undefined
  const stopTrackingPanel = (): void => {
    panelObserver?.disconnect()
    panelObserver = undefined
    window.removeEventListener('resize', positionPanel)
  }
  const startTrackingPanel = (): void => {
    positionPanel()
    window.addEventListener('resize', positionPanel)
    const trigger = panelTrigger()
    if (trigger === undefined || typeof ResizeObserver === 'undefined') return
    // The trigger is width:100% inside the sidebar footer, so observing it also
    // reports a sidebar drag-resize, which a window resize event never sees.
    panelObserver = new ResizeObserver(() => { positionPanel() })
    panelObserver.observe(trigger)
  }
  const setOpen = (open: boolean): void => {
    panel.hidden = !open
    for (const trigger of document.querySelectorAll('.dsh-on-phone-control__trigger')) trigger.setAttribute('aria-expanded', String(open))
    if (open) startTrackingPanel()
    else stopTrackingPanel()
  }
  const renderRemote = (data: Record<string, unknown>): void => {
    remoteRunning = data.running === true
    const state = typeof data.state === 'string' ? data.state : 'error'
    const errorCode = typeof data.errorCode === 'string' ? data.errorCode : ''
    const remoteOrigin = typeof data.origin === 'string' ? data.origin : ''
    remoteReady = remoteRunning && state === 'ready' && remoteOrigin !== ''
    remoteAccess.hidden = !remoteReady
    remoteAccessLink.href = remoteOrigin
    remoteAccessLink.textContent = remoteOrigin
    remoteAccessLink.title = remoteOrigin
    remoteStatus.classList.toggle('is-running', remoteReady)
    remoteCopy.hidden = !remoteReady
    const labels: Record<string, string> = {
      off: '远程访问未启用。手机目前无法打开这个地址。',
      starting: '正在启动 Tailscale Serve…',
      ready: '远程访问已就绪。手机加入同一 tailnet 后打开下方地址即可访问。',
      unavailable: '当前电脑缺少 Tailscale，请安装后重试。',
      error: '远程连接未建立。可重新连接；仍失败时检查电脑上的 Tailscale。',
    }
    const errorLabels: Record<string, string> = {
      tailscale_not_logged_in: 'Tailscale 未登录或未加入 tailnet，请登录后重试。',
      tailscale_missing: '未找到 tailscale 命令：请安装 Tailscale，或把 DSH_ON_PHONE_TAILSCALE_BIN 设为 tailscale 可执行文件的绝对路径。',
      funnel_unavailable: 'Tailscale 未启用 Funnel（Serve 需要），请在 Tailscale 管理后台确认。',
      permission_denied: '权限不足，请以管理员身份运行后重试。',
      serve_failed: 'Tailscale Serve 启动失败，请检查网络后重新连接。',
      serve_port_conflict: 'Tailscale 443 端口正被其他服务占用，已自动尝试清理（仅清理 serve 自身残留）。若仍失败，请手动检查 `tailscale serve status`。',
      gateway_start_failed: '远程网关启动失败，请重新连接。',
    }
    remoteStatus.textContent = state === 'error' ? (errorLabels[errorCode] ?? labels.error!) : (labels[state] ?? labels.error!)
    remoteToggle.textContent = remoteRunning ? '关闭远程访问' : '启用远程访问'
    remoteToggle.disabled = false
    remoteReconnect.hidden = state !== 'error' && state !== 'unavailable'
  }
  let remoteLoadInFlight = false
  const loadRemote = (): void => {
    if (remoteLoadInFlight) return
    remoteLoadInFlight = true
    void requestJson('/api/mobile-access/remote/control')
      .then(renderRemote, error => { remoteStatus.textContent = String(error) })
      .finally(() => { remoteLoadInFlight = false })
  }
  remoteToggle.addEventListener('click', () => {
    remoteToggle.disabled = true
    void requestJson('/api/mobile-access/remote/control', { method: 'POST', body: JSON.stringify({ running: !remoteRunning }) })
      .then(renderRemote, error => { remoteStatus.textContent = String(error) })
      .finally(loadRemote)
  })
  remoteReconnect.addEventListener('click', () => {
    if (remoteReconnectBusy) return
    remoteReconnectBusy = true
    remoteReconnect.disabled = true
    remoteStatus.textContent = '正在重新连接 Tailscale Serve…'
    void requestJson('/api/mobile-access/remote/reconnect', { method: 'POST', body: '{}' })
      .then(renderRemote, error => { remoteStatus.textContent = String(error) })
      .finally(() => { remoteReconnectBusy = false; remoteReconnect.disabled = false })
  })
  let remoteCopyTimer: number | undefined
  remoteCopy.addEventListener('click', () => {
    void navigator.clipboard.writeText(remoteAccessLink.href).then(() => {
      remoteCopy.textContent = '已复制'
    }, () => {
      remoteCopy.textContent = '复制失败'
    }).then(() => {
      if (remoteCopyTimer !== undefined) window.clearTimeout(remoteCopyTimer)
      remoteCopyTimer = window.setTimeout(() => { remoteCopy.textContent = '复制地址' }, 1_600)
    })
  })
  const renderDiagnostics = (data: Record<string, unknown>): void => {
    const overall = data.overall === 'error' ? 'error' : data.overall === 'attention' ? 'attention' : 'ok'
    diagnosticsSummary.className = `dsh-on-phone-control__diagnostic-summary is-${overall}`
    diagnosticsSummaryTitle.textContent = overall === 'ok' ? '检查完成' : overall === 'attention' ? '有项目需要留意' : '发现连接问题'
    diagnosticsSummaryText.textContent = typeof data.summary === 'string' ? data.summary : '检查已完成。'
    const entries = Array.isArray(data.checks) ? data.checks as Record<string, unknown>[] : []
    diagnosticsChecks.replaceChildren()
    const statusLabels: Record<string, string> = { ok: '正常', warning: '注意', error: '问题', info: '说明' }
    const statusOf = (entry: Record<string, unknown>): 'ok' | 'warning' | 'error' | 'info' => entry.status === 'ok' || entry.status === 'warning' || entry.status === 'error' ? entry.status : 'info'
    const appendGroup = (label: string, groupEntries: Record<string, unknown>[]): void => {
      if (groupEntries.length === 0) return
      const group = element('section', 'dsh-on-phone-control__diagnostic-group')
      const groupHeader = element('header', 'dsh-on-phone-control__diagnostic-group-header')
      const groupTitle = element('h3'); groupTitle.textContent = label
      const groupCount = element('span'); groupCount.textContent = `${String(groupEntries.length)} 项`
      const list = element('div', 'dsh-on-phone-control__diagnostic-list'); list.setAttribute('role', 'list')
      groupHeader.append(groupTitle, groupCount)
      for (const entry of groupEntries) {
        const state = statusOf(entry)
        const row = element('section', `dsh-on-phone-control__diagnostic-check is-${state}`); row.setAttribute('role', 'listitem')
        const marker = element('span', 'dsh-on-phone-control__diagnostic-marker'); marker.setAttribute('aria-hidden', 'true')
        const rowBody = element('div', 'dsh-on-phone-control__diagnostic-check-body')
        const rowHeader = element('div', 'dsh-on-phone-control__diagnostic-check-header')
        const rowTitle = element('strong'); rowTitle.textContent = typeof entry.label === 'string' ? entry.label : '检查项'
        const badge = element('span', 'dsh-on-phone-control__diagnostic-badge'); badge.textContent = statusLabels[state]!
        const detail = element('p'); detail.textContent = typeof entry.detail === 'string' ? entry.detail : ''
        rowHeader.append(rowTitle, badge); rowBody.append(rowHeader, detail)
        if (typeof entry.action === 'string' && entry.action !== '') {
          const action = element('p', 'dsh-on-phone-control__diagnostic-action')
          const actionLabel = element('span'); actionLabel.textContent = '建议'
          action.append(actionLabel, document.createTextNode(entry.action)); rowBody.append(action)
        }
        row.append(marker, rowBody); list.append(row)
      }
      group.append(groupHeader, list); diagnosticsChecks.append(group)
    }
    const issues = entries.filter(entry => statusOf(entry) === 'error' || statusOf(entry) === 'warning')
    const otherChecks = entries.filter(entry => statusOf(entry) !== 'error' && statusOf(entry) !== 'warning')
    appendGroup('需要处理', issues)
    appendGroup(issues.length === 0 ? '检查详情' : '其他检查', otherChecks)
    diagnosticsSummaryMeta.textContent = issues.length === 0
      ? `${String(entries.length)} 项检查 · 未发现阻断问题`
      : `${String(entries.length)} 项检查 · ${String(issues.length)} 项需要处理`
    diagnosticsChecks.hidden = entries.length === 0
    copiedDiagnosticReport = typeof data.report === 'string' ? data.report : ''
    diagnosticsReport.textContent = copiedDiagnosticReport
    diagnosticsDetails.hidden = copiedDiagnosticReport === ''
    diagnosticsCopy.disabled = copiedDiagnosticReport === ''
    diagnosticsCopy.hidden = copiedDiagnosticReport === ''
    diagnosticsToolbar.classList.toggle('has-report', copiedDiagnosticReport !== '')
  }
  const loadDiagnostics = (): void => {
    if (diagnosticsBusy) return
    diagnosticsBusy = true
    diagnosticsRun.disabled = true
    diagnosticsRun.setAttribute('aria-busy', 'true')
    diagnosticsRun.textContent = '正在检查…'
    diagnosticsSummary.className = 'dsh-on-phone-control__diagnostic-summary is-running'
    diagnosticsSummaryTitle.textContent = '正在检查连接'
    diagnosticsSummaryText.textContent = '通常几秒内完成。远程通道会执行一次真实可达性测试。'
    diagnosticsSummaryMeta.textContent = '正在运行 · 请保持 DSH 在线'
    diagnosticsFeedback.hidden = true
    diagnosticsChecks.classList.add('is-refreshing')
    diagnosticsChecks.setAttribute('aria-busy', 'true')
    void requestJson('/api/mobile-access/diagnostics').then(renderDiagnostics, error => {
      diagnosticsSummary.className = 'dsh-on-phone-control__diagnostic-summary is-error'
      diagnosticsSummaryTitle.textContent = '检查未完成'
      diagnosticsSummaryText.textContent = `无法读取诊断结果：${String(error)}`
      diagnosticsSummaryMeta.textContent = '诊断服务暂不可用 · 请稍后重试'
    }).finally(() => {
      diagnosticsBusy = false
      diagnosticsRun.disabled = false
      diagnosticsRun.setAttribute('aria-busy', 'false')
      diagnosticsRun.textContent = '重新检查'
      diagnosticsChecks.classList.remove('is-refreshing')
      diagnosticsChecks.setAttribute('aria-busy', 'false')
    })
  }
  diagnosticsEntry.addEventListener('click', () => {
    if (!diagnosticsView.hidden) { selectView('remote'); loadRemote(); return }
    selectView('diagnostics'); loadDiagnostics()
  })
  diagnosticsRun.addEventListener('click', loadDiagnostics)
  diagnosticsCopy.addEventListener('click', () => {
    if (copiedDiagnosticReport === '') return
    void navigator.clipboard.writeText(copiedDiagnosticReport).then(() => {
      diagnosticsFeedback.textContent = '脱敏报告已复制，可直接粘贴到 Issue。'
      diagnosticsFeedback.hidden = false
    }, () => {
      diagnosticsDetails.open = true
      diagnosticsFeedback.textContent = '浏览器未允许复制，已展开详情，请手动复制。'
      diagnosticsFeedback.hidden = false
    })
  })
  close.addEventListener('click', () => { setOpen(false) })
  const dismiss = (event: PointerEvent): void => {
    if (panel.hidden || !(event.target instanceof Node)) return
    if (!panel.contains(event.target) && !document.querySelector('.dsh-on-phone-control__trigger')?.contains(event.target)) setOpen(false)
  }
  document.addEventListener('pointerdown', dismiss)
  loadRemote()
  const remotePoll = window.setInterval(() => { if (!panel.hidden && !remoteView.hidden) loadRemote() }, 1_500)
  return { remove: () => { window.clearInterval(remotePoll); if (remoteCopyTimer !== undefined) window.clearTimeout(remoteCopyTimer); stopTrackingPanel(); document.removeEventListener('pointerdown', dismiss); root.remove() }, toggle: () => { setOpen(panel.hidden !== false) } }
}

function mobileRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const target = new URL(path, location.href)
  if (target.origin !== location.origin) throw new TypeError('mobile extension requests must stay on the DSH origin')
  const headers = new Headers(init.headers)
  const method = (init.method ?? 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') {
    const csrf = document.cookie.split(';').map(value => value.trim()).find(value => value.startsWith('dsh_ma_csrf='))?.slice(12)
    if (csrf !== undefined) headers.set('x-dsh-on-phone-csrf', csrf)
  }
  return fetch(target, { ...init, headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
}

function installCustomAssets(): () => void {
  const legacyStyle = element('style'); legacyStyle.dataset.plugin = 'dsh-on-phone-custom'; document.head.append(legacyStyle)
  const previous = window.dshMobile
  let legacyMount: MobileExtensionMount | undefined = queuedLegacyMount
  let legacySource = ''
  let legacyRoot: HTMLElement | undefined
  let legacyDispose: (() => void) | undefined
  const definitions = new Map<string, MobileClientDefinition>()
  const active = new Map<string, { readonly controller: AbortController; readonly dispose: () => void; readonly surfaces: Map<string, { readonly dispose: () => void; readonly container: HTMLElement }> }>()
  const styleNodes = new Map<string, HTMLStyleElement>()
  const styleEtags = new Map<string, string>()
  const scriptDigests = new Map<string, string>()
  const manifestExtensionIds = new Set<string>()
  const managedDefinitionIds = new Set<string>()
  const activationQueues = new Map<string, Promise<boolean>>()
  let manifestEtag = ''
  let expectedDefinitionId: string | undefined
  const SURFACE_HOST_STYLES: Readonly<Record<string, string>> = {
    'sidebar-action': 'position:fixed;z-index:1100;top:calc(env(safe-area-inset-top) + 8px);left:8px;display:flex;flex-direction:column;gap:6px;pointer-events:none',
    'header-action': 'position:fixed;z-index:1100;top:calc(env(safe-area-inset-top) + 8px);right:8px;display:flex;flex-direction:column;gap:6px;pointer-events:none',
    'composer-dock': 'position:fixed;z-index:1100;bottom:calc(env(safe-area-inset-bottom) + 8px);left:50%;transform:translateX(-50%);display:flex;flex-direction:column;gap:6px;pointer-events:none',
    'settings-section': 'position:fixed;z-index:1100;inset:auto 8px calc(env(safe-area-inset-bottom) + 72px) 8px;max-height:40vh;overflow:auto;pointer-events:none',
  }
  const surfaceHost = (placement: string): HTMLElement | undefined => {
    const existing = document.querySelector<HTMLElement>(`[data-dsh-on-phone-surface-host="${placement}"]`)
    if (existing !== null) return existing
    const style = SURFACE_HOST_STYLES[placement]
    if (style === undefined) return undefined
    const host = element('div'); host.dataset.dshOnPhoneSurfaceHost = placement; host.style.cssText = style
    document.body.append(host); return host
  }
  const shellLayer = (): HTMLElement => {
    const existing = document.querySelector<HTMLElement>('[data-dsh-on-phone-extension-layer]')
    if (existing !== null) return existing
    const layer = element('div'); layer.dataset.dshOnPhoneExtensionLayer = 'true'; layer.style.cssText = 'position:fixed;inset:0;z-index:1200;pointer-events:none;overflow:hidden'
    document.body.append(layer); return layer
  }
  const toast = (message: string): void => {
    const node = element('div'); node.textContent = message; node.style.cssText = 'position:absolute;top:16px;left:50%;transform:translateX(-50%);padding:9px 14px;border-radius:999px;background:#1f2937;color:white;font:14px system-ui;pointer-events:auto;box-shadow:0 8px 24px #0003'
    shellLayer().append(node); window.setTimeout(() => node.remove(), 2600)
  }
  const materializeNativeFile = (value: unknown): unknown => {
    if (typeof value !== 'object' || value === null || !('base64' in value) || !('name' in value)) return value
    const candidate = value as { base64?: unknown; name?: unknown; type?: unknown }
    if (typeof candidate.base64 !== 'string' || typeof candidate.name !== 'string') return value
    try {
      const encoded = atob(candidate.base64)
      const bytes = Uint8Array.from(encoded, character => character.charCodeAt(0))
      return new File([bytes], candidate.name, { type: typeof candidate.type === 'string' ? candidate.type : 'application/octet-stream' })
    } catch {
      return value
    }
  }
  const invokeNative = async (action: string, input?: unknown): Promise<unknown> => {
    const bridge = window.__DSH_ON_PHONE_NATIVE__
    if (bridge !== undefined) return materializeNativeFile(await bridge.invoke(action, input))
    if (action === 'share' && typeof navigator.share === 'function') { await navigator.share((input ?? {}) as ShareData); return { ok: true } }
    if (action === 'clipboard.read' && navigator.clipboard !== undefined) return { text: await navigator.clipboard.readText() }
    if (action === 'clipboard.write' && navigator.clipboard !== undefined) { await navigator.clipboard.writeText(typeof input === 'object' && input !== null && 'text' in input ? String((input as { text: unknown }).text) : ''); return { ok: true } }
    if (action === 'files.pick' || action === 'camera.capture') {
      const inputElement = element('input'); inputElement.type = 'file'; inputElement.accept = action === 'camera.capture' ? 'image/*' : '*/*'; if (action === 'camera.capture') inputElement.capture = 'environment';
      return new Promise<File | undefined>(resolve => { inputElement.onchange = () => resolve(inputElement.files?.[0]); inputElement.click() })
    }
    throw new Error('native capability is unavailable')
  }
  const makeApi = (id: string, controller: AbortController): MobileClientApi => {
    const surfaces = active.get(id)?.surfaces ?? new Map()
    const mountSurface = (surface: MobileSurface): (() => void) => {
      if (!/^[a-z][a-z0-9-]{0,63}$/u.test(surface.id) || surface.label.length > 120) throw new Error('invalid mobile surface')
      const container = element('section'); container.dataset.dshOnPhoneSurface = surface.id; container.hidden = surface.placement === 'page' || surface.placement === 'overlay'; container.style.cssText = surface.placement === 'page' || surface.placement === 'overlay' ? 'position:absolute;inset:0;overflow:auto;background:var(--dsw-alias-bg-layer-1,#fff);padding:16px;pointer-events:auto' : 'pointer-events:auto'
      const host = surface.placement === 'page' || surface.placement === 'overlay' ? shellLayer() : surfaceHost(surface.placement) ?? shellLayer()
      host.append(container)
      const mounted = surface.mount(container)
      const dispose = (): void => { if (typeof mounted === 'function') mounted(); container.remove() }
      surfaces.set(surface.id, { dispose, container });
      return () => { if (surfaces.get(surface.id)?.dispose === dispose) surfaces.delete(surface.id); dispose() }
    }
    return {
      host: {
        invoke: (action: string, input: unknown) => mobileRequest(`/mobile-access/extensions/${encodeURIComponent(id)}/actions/${encodeURIComponent(action)}`, { method: 'POST', body: JSON.stringify(input ?? {}) }).then(async response => { const value = await response.json() as unknown; if (!response.ok) throw new Error(typeof value === 'object' && value !== null && 'error' in value ? String((value as { error: unknown }).error) : `HTTP ${String(response.status)}`); return value }),
        fetch: (path: string, init?: RequestInit) => {
          if (!path.startsWith('/') || path.startsWith('//') || path.includes('://')
            || path.split('/').some(part => part === '..' || part === '.')) throw new TypeError('extension routes must be relative')
          return mobileRequest(`/mobile-access/extensions/${encodeURIComponent(id)}/routes${path}`, init)
        },
      },
      ui: { registerSurface: mountSurface, open: id => { const entry = surfaces.get(id); if (entry !== undefined) entry.container.hidden = false }, close: id => { const entry = surfaces.get(id); if (entry !== undefined) entry.container.hidden = true }, toast },
      native: { capabilities: async () => { const bridge = window.__DSH_ON_PHONE_NATIVE__; return bridge === undefined ? ['files.pick', 'camera.capture', 'share', 'clipboard.read', 'clipboard.write'] : bridge.capabilities() }, invoke: invokeNative },
      signal: controller.signal, document, window,
    }
  }
  const activateDefinitionNow = async (definition: MobileClientDefinition): Promise<boolean> => {
    const previousActive = active.get(definition.id)
    const controller = new AbortController()
    const surfaces = new Map<string, { readonly dispose: () => void; readonly container: HTMLElement }>()
    active.set(definition.id, { controller, surfaces, dispose: () => { controller.abort(); for (const surface of surfaces.values()) surface.dispose(); surfaces.clear() } })
    try {
      const cleanup = await definition.activate(makeApi(definition.id, controller))
      const current = active.get(definition.id)
      if (current === undefined || current.controller !== controller) { if (typeof cleanup === 'function') cleanup(); return false }
      const oldDispose = current.dispose
      active.set(definition.id, { ...current, dispose: () => { if (typeof cleanup === 'function') cleanup(); oldDispose() } })
      previousActive?.dispose()
      return true
    } catch {
      const current = active.get(definition.id)
      if (current?.controller === controller) {
        current.dispose(); active.delete(definition.id); if (previousActive !== undefined) active.set(definition.id, previousActive)
      }
      return false
    }
  }
  const activateDefinition = (definition: MobileClientDefinition): Promise<boolean> => {
    const previous = activationQueues.get(definition.id) ?? Promise.resolve(true)
    const task = previous.then(
      () => definitions.get(definition.id) === definition ? activateDefinitionNow(definition) : false,
      () => definitions.get(definition.id) === definition ? activateDefinitionNow(definition) : false,
    )
    activationQueues.set(definition.id, task)
    void task.finally(() => { if (activationQueues.get(definition.id) === task) activationQueues.delete(definition.id) })
    return task
  }
  const define = (definition: MobileClientDefinition): void => {
    if (definition.apiVersion !== 1 || !/^[a-z][a-z0-9-]{0,63}$/u.test(definition.id) || typeof definition.activate !== 'function') return
    if (expectedDefinitionId !== undefined && definition.id !== expectedDefinitionId) return
    definitions.set(definition.id, definition)
    if (started && expectedDefinitionId === undefined) void activateDefinition(definition)
  }
  let started = false
  window.dshMobile = Object.freeze({ register: mount => { legacyMount = mount }, define })
  for (const definition of queuedDefinitions.splice(0)) define(definition)
  let legacyJsEtag = ''
  let legacyJsModified = ''
  const refreshLegacy = async (signal?: AbortSignal): Promise<boolean> => {
    const previousMount = legacyMount
    let pendingRoot: HTMLElement | undefined
    try {
      const headers: Record<string, string> = {}
      if (legacyJsEtag !== '') headers['if-none-match'] = legacyJsEtag
      if (legacyJsModified !== '') headers['if-modified-since'] = legacyJsModified
      const response = await fetch('/mobile-access/custom.js', { credentials: 'same-origin', cache: 'no-store', headers, ...(signal === undefined ? {} : { signal }) })
      if (response.status === 304) return true
      if (!response.ok) return false
      legacyJsEtag = response.headers.get('etag') ?? ''
      legacyJsModified = response.headers.get('last-modified') ?? ''
      const next = await response.text(); if (next === legacySource) return true; legacyMount = undefined
      const script = element('script'); script.textContent = `${next}\n//# sourceURL=dsh-on-phone-custom.js`; document.head.append(script); script.remove()
      const mount = legacyMount as MobileExtensionMount | undefined
      if (mount === undefined) { legacySource = next; return true }
      const nextRoot = element('div'); pendingRoot = nextRoot; nextRoot.dataset.dshOnPhoneExtension = 'true'; document.body.append(nextRoot)
      const nextDispose = mount({ document, request: mobileRequest, root: nextRoot, window })
      legacyDispose?.(); legacyRoot?.remove(); legacyRoot = nextRoot; pendingRoot = undefined; legacyDispose = typeof nextDispose === 'function' ? nextDispose : undefined; legacySource = next
      return true
    } catch { pendingRoot?.remove(); legacyMount = previousMount; return false }
  }
  let legacyScriptRevision = ''
  let legacyStyleRevision = ''
  const refreshExtensions = async (signal?: AbortSignal): Promise<boolean> => {
    try {
      const headers: Record<string, string> = {}
      if (manifestEtag !== '') headers['if-none-match'] = manifestEtag
      const response = await fetch('/mobile-access/extensions/manifest', { credentials: 'same-origin', cache: 'no-store', headers, ...(signal === undefined ? {} : { signal }) })
      if (response.status === 404) {
        const results = await Promise.all([refreshLegacy(signal), refreshCssLegacy(legacyStyle, signal)])
        return results.every(Boolean)
      }
      if (response.status === 304) return true
      if (!response.ok) return false
      const nextManifestEtag = response.headers.get('etag') ?? ''
      const payload = await response.json() as { extensions?: unknown; legacy?: { scriptRevision?: unknown; styleRevision?: unknown } }
      const scriptRevision = typeof payload.legacy?.scriptRevision === 'string' ? payload.legacy.scriptRevision : ''
      const styleRevision = typeof payload.legacy?.styleRevision === 'string' ? payload.legacy.styleRevision : ''
      let refreshComplete = true
      if (scriptRevision === '' || scriptRevision !== legacyScriptRevision) {
        if (await refreshLegacy(signal)) legacyScriptRevision = scriptRevision
        else refreshComplete = false
      }
      if (styleRevision === '' || styleRevision !== legacyStyleRevision) {
        if (await refreshCssLegacy(legacyStyle, signal)) legacyStyleRevision = styleRevision
        else refreshComplete = false
      }
      const entries = Array.isArray(payload.extensions) ? payload.extensions as Record<string, unknown>[] : []
      const seen = new Set<string>()
      for (const entry of entries) {
        if (typeof entry.id !== 'string') continue
        seen.add(entry.id)
        try {
          let pendingCss: string | undefined
          let pendingStyleEtag: string | undefined
          const cssUrl = typeof entry.styleUrl === 'string' ? entry.styleUrl : undefined
          if (cssUrl !== undefined) {
            const cssHeaders: Record<string, string> = {}
            const storedEtag = styleEtags.get(entry.id)
            if (storedEtag !== undefined) cssHeaders['if-none-match'] = storedEtag
            const cssResponse = await fetch(cssUrl, { credentials: 'same-origin', cache: 'no-store', headers: cssHeaders, ...(signal === undefined ? {} : { signal }) })
            if (cssResponse.status !== 304) {
              if (!cssResponse.ok) throw new Error('mobile extension style failed to load')
              pendingStyleEtag = cssResponse.headers.get('etag') ?? undefined
              pendingCss = await cssResponse.text()
            }
          }

          const scriptUrl = typeof entry.scriptUrl === 'string' ? entry.scriptUrl : undefined
          if (scriptUrl !== undefined) {
            const scriptHeaders: Record<string, string> = {}
            const storedDigest = scriptDigests.get(entry.id)
            if (storedDigest !== undefined) scriptHeaders['if-none-match'] = storedDigest
            const scriptResponse = await fetch(scriptUrl, { credentials: 'same-origin', cache: 'no-store', headers: scriptHeaders, ...(signal === undefined ? {} : { signal }) })
            if (scriptResponse.status !== 304) {
              if (!scriptResponse.ok) throw new Error('mobile extension script failed to load')
              const source = await scriptResponse.text()
              const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source))
              const key = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')
              if (scriptDigests.get(entry.id) !== key) {
                const previousDefinition = definitions.get(entry.id)
                try {
                  expectedDefinitionId = entry.id
                  try {
                    const script = element('script'); script.textContent = `${source}\n//# sourceURL=dsh-on-phone-extension-${entry.id}.js`; document.head.append(script); script.remove()
                  } finally { expectedDefinitionId = undefined }
                  const nextDefinition = definitions.get(entry.id)
                  if (nextDefinition === undefined || nextDefinition === previousDefinition) throw new Error('mobile extension did not define its manifest id')
                  if (!await activateDefinition(nextDefinition)) throw new Error('mobile extension activation failed')
                  managedDefinitionIds.add(entry.id)
                  scriptDigests.set(entry.id, key)
                } catch (error) {
                  if (previousDefinition === undefined) definitions.delete(entry.id)
                  else definitions.set(entry.id, previousDefinition)
                  throw error
                }
              }
            }
            const definition = definitions.get(entry.id)
            if (definition !== undefined && !active.has(entry.id) && !await activateDefinition(definition)) throw new Error('mobile extension activation failed')
          }

          if (pendingCss !== undefined) {
            const oldStyle = styleNodes.get(entry.id)
            if (oldStyle?.textContent !== pendingCss) {
              const node = element('style'); node.dataset.dshOnPhoneExtensionStyle = entry.id; node.textContent = pendingCss; document.head.append(node); styleNodes.set(entry.id, node); oldStyle?.remove()
            }
            if (pendingStyleEtag !== undefined && pendingStyleEtag !== '') styleEtags.set(entry.id, pendingStyleEtag)
          }
        } catch {
          refreshComplete = false
        }
      }
      for (const id of manifestExtensionIds) {
        if (seen.has(id)) continue
        active.get(id)?.dispose(); active.delete(id)
        styleNodes.get(id)?.remove(); styleNodes.delete(id); styleEtags.delete(id); scriptDigests.delete(id)
        if (managedDefinitionIds.delete(id)) definitions.delete(id)
      }
      manifestExtensionIds.clear(); for (const id of seen) manifestExtensionIds.add(id)
      manifestEtag = refreshComplete ? nextManifestEtag : ''
      return refreshComplete
    } catch { return false }
  }
  started = true
  for (const definition of definitions.values()) void activateDefinition(definition)
  const remoteOrigin = window.location.hostname.endsWith('.ts.net')
  const refreshIntervalMs = remoteOrigin ? 15_000 : 3_000
  const refreshTimeoutMs = remoteOrigin ? 20_000 : 8_000
  let stopped = false
  let refreshTimer: number | undefined
  let refreshFailures = 0
  let refreshController: AbortController | undefined
  const scheduleRefresh = (delayMs: number): void => {
    if (stopped || document.visibilityState === 'hidden' || !navigator.onLine) return
    if (refreshTimer !== undefined) clearTimeout(refreshTimer)
    refreshTimer = window.setTimeout(runRefresh, delayMs)
  }
  const runRefresh = (): void => {
    if (stopped || refreshController !== undefined) return
    refreshController = new AbortController()
    const controller = refreshController
    const timeout = window.setTimeout(() => { controller.abort() }, refreshTimeoutMs)
    void refreshExtensions(controller.signal).then(success => {
      refreshFailures = success ? 0 : refreshFailures + 1
    }).finally(() => {
      clearTimeout(timeout)
      if (refreshController === controller) refreshController = undefined
      const backoff = Math.min(60_000, refreshIntervalMs * (2 ** Math.min(refreshFailures, 3)))
      scheduleRefresh(backoff)
    })
  }
  const resumeRefresh = (): void => {
    if (document.visibilityState !== 'hidden' && navigator.onLine) scheduleRefresh(0)
  }
  document.addEventListener('visibilitychange', resumeRefresh)
  window.addEventListener('online', resumeRefresh)
  scheduleRefresh(0)
  return () => { stopped = true; if (refreshTimer !== undefined) clearTimeout(refreshTimer); refreshController?.abort(); document.removeEventListener('visibilitychange', resumeRefresh); window.removeEventListener('online', resumeRefresh); started = false; legacyDispose?.(); legacyRoot?.remove(); legacyStyle.remove(); for (const current of active.values()) current.dispose(); for (const node of styleNodes.values()) node.remove(); const layer = document.querySelector('[data-dsh-on-phone-extension-layer]'); layer?.remove(); for (const host of document.querySelectorAll('[data-dsh-on-phone-surface-host]')) host.remove(); if (previous === undefined) delete window.dshMobile; else window.dshMobile = previous }
}

let cssEtag = ''
let cssModified = ''
async function refreshCssLegacy(style: HTMLStyleElement, signal?: AbortSignal): Promise<boolean> {
  try {
    const headers: Record<string, string> = {}
    if (cssEtag !== '') headers['if-none-match'] = cssEtag
    if (cssModified !== '') headers['if-modified-since'] = cssModified
    const response = await fetch('/mobile-access/custom.css', { credentials: 'same-origin', cache: 'no-store', headers, ...(signal === undefined ? {} : { signal }) })
    if (response.status === 304) return true
    if (response.ok) {
      cssEtag = response.headers.get('etag') ?? ''
      cssModified = response.headers.get('last-modified') ?? ''
      style.textContent = await response.text()
      return true
    }
    return false
  } catch { return false }
}

const CONTROL_STYLES = `
.dsh-on-phone-control{position:fixed;z-index:1000;left:16px;bottom:112px;font:14px/1.45 system-ui;color:var(--dsw-alias-label-primary,#16181d)}
.dsh-on-phone-control__panel{box-sizing:border-box;width:min(var(--dsh-on-phone-control-panel-width,380px),calc(100vw - 16px));max-height:var(--dsh-on-phone-control-panel-height,calc(100vh - 140px));overflow-y:auto;padding:16px;border:1px solid var(--dsw-alias-border-subtle,#e1e5eb);border-radius:18px;background:var(--dsw-alias-bg-layer-2,#fff);box-shadow:0 18px 50px rgb(15 23 42 / 18%)}
.dsh-on-phone-control__header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px}.dsh-on-phone-control__panel h2{margin:0;font-size:17px;line-height:24px}.dsh-on-phone-control__header-actions{display:flex;align-items:center;gap:2px}.dsh-on-phone-control__diagnostic-entry,.dsh-on-phone-control__close{display:inline-flex;align-items:center;justify-content:center;min-width:44px;height:44px;padding:0;border:0;border-radius:10px;background:transparent;color:inherit;cursor:pointer}.dsh-on-phone-control__diagnostic-entry{padding:0 9px;color:#2563eb;font:650 12px/1 system-ui}.dsh-on-phone-control__close{font-size:24px;line-height:1}.dsh-on-phone-control__diagnostic-entry:hover,.dsh-on-phone-control__close:hover{background:var(--dsw-alias-interactive-bg-hover,#f1f3f6)}
.dsh-on-phone-control__view[hidden]{display:none}.dsh-on-phone-control__intro{margin:0 0 12px;color:var(--dsw-alias-label-secondary,#606873);font-size:12px;line-height:1.55}.dsh-on-phone-control__view.is-remote .dsh-on-phone-control__actions{display:grid;grid-template-columns:1fr 1fr;gap:8px}.dsh-on-phone-control__view.is-remote .dsh-on-phone-control__actions button[hidden]{display:none}
.dsh-on-phone-control__provider-section{position:relative;margin:0 0 12px}.dsh-on-phone-control__section-title{margin:0 0 8px;color:var(--dsw-alias-label-primary,#16181d);font:650 13px/1.4 system-ui}.dsh-on-phone-control__provider-section>.dsh-on-phone-control__section-title{padding-right:42px}.dsh-on-phone-control__provider-choices{display:grid;gap:8px}.dsh-on-phone-control__provider{display:flex;flex-direction:column;gap:5px;min-height:68px;padding:11px 12px;border:1px solid var(--dsw-alias-border-subtle,#dbe1e8);border-radius:13px;background:#fff;color:inherit;text-align:left;cursor:pointer;transition:border-color 160ms ease,background-color 160ms ease,box-shadow 160ms ease}.dsh-on-phone-control__provider:hover{border-color:#9fb9e8;background:#f8fbff}.dsh-on-phone-control__provider.is-selected{border-color:#2563eb;background:#f5f8ff;box-shadow:0 0 0 1px #2563eb inset}.dsh-on-phone-control__provider:disabled{cursor:wait;opacity:.62}.dsh-on-phone-control__provider-top{display:flex;align-items:center;justify-content:space-between;gap:8px}.dsh-on-phone-control__provider-top strong{font-size:13px}.dsh-on-phone-control__provider-badge{flex:none;padding:3px 7px;border-radius:999px;background:#e8f0ff;color:#1d4ed8;font:650 10px/1.2 system-ui}.dsh-on-phone-control__provider-badge.is-cpolar{background:#eaf8f2;color:#087454}.dsh-on-phone-control__provider-description{color:var(--dsw-alias-label-secondary,#606873);font-size:11px;line-height:1.45}.dsh-on-phone-control__provider-info{position:absolute;z-index:5;top:-13px;right:-8px}.dsh-on-phone-control__provider-info-button{display:flex;align-items:center;justify-content:center;width:44px;height:44px;padding:0;border:0;border-radius:50%;background:transparent;color:#475569;cursor:pointer;touch-action:manipulation}.dsh-on-phone-control__provider-info-button:hover{background:#f1f5f9;color:#1d4ed8}.dsh-on-phone-control__provider-info-glyph{display:flex;align-items:center;justify-content:center;box-sizing:border-box;width:18px;height:18px;border:1.5px solid currentColor;border-radius:50%;font:700 12px/1 system-ui}.dsh-on-phone-control__provider-info-popover{position:absolute;z-index:6;top:38px;right:4px;box-sizing:border-box;width:min(292px,calc(100vw - 72px));padding:10px 12px;border:1px solid var(--dsw-alias-border-subtle,#dbe1e8);border-radius:12px;background:var(--dsw-alias-bg-layer-2,#fff);box-shadow:0 10px 28px rgb(15 23 42 / 16%)}.dsh-on-phone-control__provider-info-popover[hidden]{display:none}.dsh-on-phone-control__provider-info-popover strong,.dsh-on-phone-control__provider-info-popover span{display:block}.dsh-on-phone-control__provider-info-popover strong{margin-bottom:3px;font-size:12px}.dsh-on-phone-control__provider-info-popover span{color:var(--dsw-alias-label-secondary,#606873);font-size:11px;line-height:1.55}
.dsh-on-phone-control__cpolar-setup{margin:0 0 12px;padding:12px;border:1px solid var(--dsw-alias-border-subtle,#dbe1e8);border-radius:13px;background:#fff}.dsh-on-phone-control__cpolar-setup[hidden],.dsh-on-phone-control__cpolar-account[hidden],.dsh-on-phone-control__details[hidden],.dsh-on-phone-control__view.is-remote .dsh-on-phone-control__actions[hidden],.dsh-on-phone-control__danger[hidden]{display:none}.dsh-on-phone-control__component-status,.dsh-on-phone-control__component-note{margin:0 0 10px;color:var(--dsw-alias-label-secondary,#606873);font-size:11px;line-height:1.55}.dsh-on-phone-control__cpolar-setup>.dsh-on-phone-control__primary{width:100%;min-height:44px;padding:9px 12px;border-radius:10px;font:600 12px/1.3 system-ui;cursor:pointer}.dsh-on-phone-control__cpolar-account{margin-top:10px}.dsh-on-phone-control__link-row{display:flex;flex-wrap:wrap;gap:6px 12px;margin:0 0 10px}.dsh-on-phone-control__text-link{color:#2563eb;font-size:11px;text-decoration:none}.dsh-on-phone-control__text-link:hover{text-decoration:underline}.dsh-on-phone-control__token-label{display:flex;flex-direction:column;gap:5px;margin:0 0 8px;color:var(--dsw-alias-label-secondary,#606873);font-size:11px}.dsh-on-phone-control__token{box-sizing:border-box;width:100%;min-height:44px;padding:9px 10px;border:1px solid var(--dsw-alias-border-normal,#cfd5dd);border-radius:10px;background:#fff;color:inherit;font:16px/1.4 system-ui}.dsh-on-phone-control__cpolar-connect{display:flex;align-items:center;justify-content:center;box-sizing:border-box;width:100%;min-height:44px;padding:10px 14px;border-radius:12px;font:650 13px/1.2 system-ui;cursor:pointer;transition:background-color 160ms ease,border-color 160ms ease,opacity 160ms ease}.dsh-on-phone-control__cpolar-connect:hover:not(:disabled){border-color:#1d4ed8;background:#1d4ed8}.dsh-on-phone-control__cpolar-connect:active:not(:disabled){border-color:#1e40af;background:#1e40af}.dsh-on-phone-control__cpolar-connect:disabled{cursor:wait;opacity:.55}.dsh-on-phone-control__details{margin:10px 0 0;border-top:1px solid var(--dsw-alias-border-subtle,#e1e5eb);padding-top:9px}.dsh-on-phone-control__details>summary{min-height:30px;color:var(--dsw-alias-label-secondary,#606873);font-size:11px;line-height:30px;cursor:pointer}.dsh-on-phone-control__details-body{display:flex;flex-wrap:wrap;align-items:center;gap:7px 12px;padding:4px 0}.dsh-on-phone-control__details-body p{flex:1 0 100%;margin:0;color:var(--dsw-alias-label-secondary,#606873);font-size:11px;line-height:1.5}.dsh-on-phone-control__storage{display:block;flex:1 0 100%;max-width:100%;overflow:hidden;padding:7px 8px;border-radius:8px;background:#f3f5f8;color:#475569;font:10px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;text-overflow:ellipsis;white-space:nowrap}.dsh-on-phone-control__danger{flex:1 0 100%;min-height:38px;margin-top:3px;padding:7px 10px;border:1px solid #dc2626;border-radius:9px;background:transparent;color:#b91c1c;font:12px/1.3 system-ui;cursor:pointer}
.dsh-on-phone-control__access{display:flex;align-items:baseline;gap:6px;min-width:0;margin:0 0 12px}.dsh-on-phone-control__access[hidden]{display:none}.dsh-on-phone-control__access-label{flex:none;color:var(--dsw-alias-label-secondary,#606873);white-space:nowrap}.dsh-on-phone-control__access-label::after{content:"："}.dsh-on-phone-control__access-link{min-width:0;overflow:hidden;color:#2563eb;text-decoration:none;text-overflow:ellipsis;white-space:nowrap}.dsh-on-phone-control__access-link:hover{text-decoration:underline}padding:8px}
.dsh-on-phone-control__status{margin:0 0 14px;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary,#606873)}.dsh-on-phone-control__status::before{display:inline-block;width:8px;height:8px;margin-right:7px;border-radius:50%;background:#98a1ad;content:""}.dsh-on-phone-control__status.is-running::before{background:#16a36a}word-break:break-all}
.dsh-on-phone-control__guide{margin:0 0 14px;padding:12px;border:1px solid #bfdbfe;border-radius:12px;background:#eff6ff}.dsh-on-phone-control__guide[hidden]{display:none}.dsh-on-phone-control__guide-title{margin:0;color:#172554;font:650 13px/1.45 system-ui}.dsh-on-phone-control__guide-summary,.dsh-on-phone-control__guide-note{margin:4px 0 0;color:#475569;font-size:12px;line-height:1.5}.dsh-on-phone-control__guide-steps{margin:8px 0 0;padding-left:20px;color:#1e293b;font-size:12px;line-height:1.6}.dsh-on-phone-control__guide-note{color:#64748b}.dsh-on-phone-control__guide-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}.dsh-on-phone-control__guide-actions button{min-width:0;min-height:44px;padding:8px;border-radius:10px;font:12px/1.25 system-ui;cursor:pointer}.dsh-on-phone-control__guide-actions button:disabled{cursor:not-allowed;opacity:.45}
.dsh-on-phone-control__view.is-diagnostics{--dsh-diagnostic-ok:#087454;--dsh-diagnostic-warning:#a35b00;--dsh-diagnostic-error:#c62828;--dsh-diagnostic-info:#526071}.dsh-on-phone-control__diagnostic-summary{box-sizing:border-box;margin:0;padding:13px;border:1px solid var(--dsw-alias-border-subtle,#dbe1e8);border-radius:16px;background:var(--dsw-alias-bg-layer-1,#f8fafc)}.dsh-on-phone-control__diagnostic-summary-main{display:grid;grid-template-columns:36px minmax(0,1fr);align-items:center;gap:11px}.dsh-on-phone-control__diagnostic-summary-icon{position:relative;display:block;width:36px;height:36px;border-radius:50%;background:#e8edf3;color:var(--dsh-diagnostic-info)}.dsh-on-phone-control__diagnostic-summary-icon::before,.dsh-on-phone-control__diagnostic-summary-icon::after{position:absolute;content:""}.dsh-on-phone-control__diagnostic-summary-body{display:flex;min-width:0;flex-direction:column;gap:2px}.dsh-on-phone-control__diagnostic-summary-body strong{font-size:13px;line-height:1.35}.dsh-on-phone-control__diagnostic-summary-body span{color:var(--dsw-alias-label-secondary,#606873);font-size:11px;line-height:1.5}.dsh-on-phone-control__diagnostic-summary-meta{display:block;margin-top:11px;padding-top:9px;border-top:1px solid var(--dsw-alias-border-subtle,#dbe1e8);color:var(--dsw-alias-label-secondary,#606873);font-size:10px;line-height:1.45}.dsh-on-phone-control__diagnostic-summary.is-ok .dsh-on-phone-control__diagnostic-summary-icon{background:#e6f7f0;color:var(--dsh-diagnostic-ok)}.dsh-on-phone-control__diagnostic-summary.is-ok .dsh-on-phone-control__diagnostic-summary-icon::before{top:10px;left:10px;width:13px;height:7px;border-bottom:2px solid currentColor;border-left:2px solid currentColor;transform:rotate(-45deg)}.dsh-on-phone-control__diagnostic-summary.is-attention .dsh-on-phone-control__diagnostic-summary-icon{background:#fff4dc;color:var(--dsh-diagnostic-warning)}.dsh-on-phone-control__diagnostic-summary.is-error .dsh-on-phone-control__diagnostic-summary-icon{background:#fdecec;color:var(--dsh-diagnostic-error)}.dsh-on-phone-control__diagnostic-summary.is-attention .dsh-on-phone-control__diagnostic-summary-icon::before,.dsh-on-phone-control__diagnostic-summary.is-error .dsh-on-phone-control__diagnostic-summary-icon::before{top:8px;left:17px;width:2px;height:13px;border-radius:2px;background:currentColor}.dsh-on-phone-control__diagnostic-summary.is-attention .dsh-on-phone-control__diagnostic-summary-icon::after,.dsh-on-phone-control__diagnostic-summary.is-error .dsh-on-phone-control__diagnostic-summary-icon::after{bottom:8px;left:17px;width:2px;height:2px;border-radius:50%;background:currentColor}.dsh-on-phone-control__diagnostic-summary.is-running .dsh-on-phone-control__diagnostic-summary-icon{background:#e8f0ff;color:#2563eb}.dsh-on-phone-control__diagnostic-summary.is-running .dsh-on-phone-control__diagnostic-summary-icon::before{inset:9px;border:2px solid rgb(37 99 235 / 24%);border-top-color:currentColor;border-radius:50%;animation:dsh-diagnostic-spin .8s linear infinite}
.dsh-on-phone-control__diagnostic-summary.is-idle .dsh-on-phone-control__diagnostic-summary-icon::before{top:8px;left:17px;width:2px;height:2px;border-radius:50%;background:currentColor}.dsh-on-phone-control__diagnostic-summary.is-idle .dsh-on-phone-control__diagnostic-summary-icon::after{top:13px;left:17px;width:2px;height:11px;border-radius:2px;background:currentColor}
.dsh-on-phone-control__diagnostic-toolbar{display:grid;grid-template-columns:1fr;gap:8px;margin-top:10px}.dsh-on-phone-control__diagnostic-toolbar.has-report{grid-template-columns:1fr 1fr}.dsh-on-phone-control__diagnostic-run,.dsh-on-phone-control__diagnostic-copy{box-sizing:border-box;width:100%;min-height:44px;padding:9px 10px;border-radius:11px;font:650 12px/1.3 system-ui;cursor:pointer;touch-action:manipulation}.dsh-on-phone-control__diagnostic-copy[hidden]{display:none}.dsh-on-phone-control__diagnostic-run:disabled{cursor:wait;opacity:.58}.dsh-on-phone-control__diagnostic-feedback{margin:8px 0 0;padding:8px 10px;border-radius:9px;background:#eff6ff;color:#1d4ed8;font-size:11px;line-height:1.45}.dsh-on-phone-control__diagnostic-feedback[hidden]{display:none}
.dsh-on-phone-control__diagnostic-checks{display:grid;gap:12px;margin-top:12px;animation:dsh-diagnostic-reveal 160ms ease-out both}.dsh-on-phone-control__diagnostic-checks[hidden]{display:none}.dsh-on-phone-control__diagnostic-group{overflow:hidden;border:1px solid var(--dsw-alias-border-subtle,#dbe1e8);border-radius:13px;background:var(--dsw-alias-bg-layer-2,#fff)}.dsh-on-phone-control__diagnostic-group-header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 11px;border-bottom:1px solid var(--dsw-alias-border-subtle,#e1e5eb);background:var(--dsw-alias-bg-layer-1,#f8fafc)}.dsh-on-phone-control__diagnostic-group-header h3{margin:0;font:650 11px/1.4 system-ui}.dsh-on-phone-control__diagnostic-group-header span{color:var(--dsw-alias-label-secondary,#606873);font-size:10px}.dsh-on-phone-control__diagnostic-list{display:flex;flex-direction:column}.dsh-on-phone-control__diagnostic-check{display:grid;grid-template-columns:26px minmax(0,1fr);gap:9px;padding:11px;background:var(--dsw-alias-bg-layer-2,#fff)}.dsh-on-phone-control__diagnostic-check + .dsh-on-phone-control__diagnostic-check{border-top:1px solid var(--dsw-alias-border-subtle,#e1e5eb)}.dsh-on-phone-control__diagnostic-marker{position:relative;width:26px;height:26px;border-radius:50%;background:#edf1f5;color:var(--dsh-diagnostic-info)}.dsh-on-phone-control__diagnostic-marker::before,.dsh-on-phone-control__diagnostic-marker::after{position:absolute;content:""}.dsh-on-phone-control__diagnostic-check.is-ok .dsh-on-phone-control__diagnostic-marker{background:#e6f7f0;color:var(--dsh-diagnostic-ok)}.dsh-on-phone-control__diagnostic-check.is-ok .dsh-on-phone-control__diagnostic-marker::before{top:7px;left:7px;width:9px;height:5px;border-bottom:1.8px solid currentColor;border-left:1.8px solid currentColor;transform:rotate(-45deg)}.dsh-on-phone-control__diagnostic-check.is-warning .dsh-on-phone-control__diagnostic-marker{background:#fff4dc;color:var(--dsh-diagnostic-warning)}.dsh-on-phone-control__diagnostic-check.is-error .dsh-on-phone-control__diagnostic-marker{background:#fdecec;color:var(--dsh-diagnostic-error)}.dsh-on-phone-control__diagnostic-check.is-warning .dsh-on-phone-control__diagnostic-marker::before,.dsh-on-phone-control__diagnostic-check.is-error .dsh-on-phone-control__diagnostic-marker::before{top:6px;left:12px;width:2px;height:9px;border-radius:2px;background:currentColor}.dsh-on-phone-control__diagnostic-check.is-warning .dsh-on-phone-control__diagnostic-marker::after,.dsh-on-phone-control__diagnostic-check.is-error .dsh-on-phone-control__diagnostic-marker::after{bottom:6px;left:12px;width:2px;height:2px;border-radius:50%;background:currentColor}.dsh-on-phone-control__diagnostic-check.is-info .dsh-on-phone-control__diagnostic-marker::before{top:6px;left:12px;width:2px;height:2px;border-radius:50%;background:currentColor}.dsh-on-phone-control__diagnostic-check.is-info .dsh-on-phone-control__diagnostic-marker::after{top:10px;left:12px;width:2px;height:9px;border-radius:2px;background:currentColor}.dsh-on-phone-control__diagnostic-check-body{min-width:0}.dsh-on-phone-control__diagnostic-check-header{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}.dsh-on-phone-control__diagnostic-check-header strong{min-width:0;font-size:12px;line-height:1.4}.dsh-on-phone-control__diagnostic-badge{flex:none;padding:2px 6px;border-radius:999px;background:#edf1f5;color:var(--dsh-diagnostic-info);font:650 10px/1.3 system-ui}.dsh-on-phone-control__diagnostic-check.is-ok .dsh-on-phone-control__diagnostic-badge{background:#e6f7f0;color:var(--dsh-diagnostic-ok)}.dsh-on-phone-control__diagnostic-check.is-warning .dsh-on-phone-control__diagnostic-badge{background:#fff4dc;color:var(--dsh-diagnostic-warning)}.dsh-on-phone-control__diagnostic-check.is-error .dsh-on-phone-control__diagnostic-badge{background:#fdecec;color:var(--dsh-diagnostic-error)}.dsh-on-phone-control__diagnostic-check p{margin:4px 0 0;color:var(--dsw-alias-label-secondary,#606873);font-size:11px;line-height:1.5;overflow-wrap:anywhere}.dsh-on-phone-control__diagnostic-check .dsh-on-phone-control__diagnostic-action{margin-top:7px;padding:7px 8px;border-radius:8px;background:var(--dsw-alias-bg-layer-1,#f8fafc);color:var(--dsw-alias-label-primary,#16181d)}.dsh-on-phone-control__diagnostic-action span{display:inline-block;margin-right:6px;color:#2563eb;font-weight:700}.dsh-on-phone-control__diagnostic-details{margin-top:12px}.dsh-on-phone-control__diagnostic-details[hidden]{display:none}.dsh-on-phone-control__diagnostic-details>summary{box-sizing:border-box;min-height:44px;line-height:44px}.dsh-on-phone-control__diagnostic-report{box-sizing:border-box;max-height:220px;margin:4px 0 0;overflow:auto;padding:10px;border:1px solid var(--dsw-alias-border-subtle,#dbe1e8);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#f3f5f8);color:var(--dsw-alias-label-secondary,#606873);font:10px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
.dsh-on-phone-control__diagnostic-checks{transition:opacity 150ms ease}.dsh-on-phone-control__diagnostic-checks.is-refreshing{opacity:.52}
@keyframes dsh-diagnostic-spin{to{transform:rotate(360deg)}}@keyframes dsh-diagnostic-reveal{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
.dsh-on-phone-control__actions{display:flex;flex-wrap:nowrap;gap:6px}.dsh-on-phone-control__actions button{flex:1 1 0;min-width:0;min-height:40px;padding:8px 4px;border-radius:10px;font:12px/1.2 system-ui;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dsh-on-phone-control__secondary{border:1px solid var(--dsw-alias-border-normal,#cfd5dd);background:transparent;color:inherit}.dsh-on-phone-control__primary{border:1px solid #2563eb;background:#2563eb;color:#fff}.dsh-on-phone-control__actions button:disabled{cursor:not-allowed;opacity:.45}
.dsh-on-phone-control button:focus-visible,.dsh-on-phone-control a:focus-visible,.dsh-on-phone-control input:focus-visible,.dsh-on-phone-control summary:focus-visible{outline:3px solid rgb(37 99 235 / 28%);outline-offset:2px}
div:has(.dsh-on-phone-control__trigger){flex-wrap:wrap}
.dsh-on-phone-control__trigger{box-sizing:border-box;display:flex;flex:1 0 100%;align-items:center;justify-content:flex-start;gap:8px;width:100%;min-width:0;height:34px;margin:4px 0;padding:6px 8px;border:0;border-radius:12px;background:transparent;color:var(--dsw-alias-label-primary,#16181d);font:14px/22px system-ui;cursor:pointer}.dsh-on-phone-control__trigger:hover{background:var(--dsw-alias-interactive-bg-hover,#f1f3f6)}.dsh-on-phone-control__trigger.is-rail{flex:0 0 auto;width:36px;height:36px;margin:8px 0 10px;padding:0;justify-content:center;border-radius:50%}.dsh-on-phone-control__trigger-icon{position:relative;box-sizing:border-box;flex:none;width:14px;height:19px;border:1.7px solid currentColor;border-radius:3px}.dsh-on-phone-control__trigger-icon::after{position:absolute;right:4px;bottom:2px;width:4px;height:1.5px;border-radius:2px;background:currentColor;content:""}.dsh-on-phone-control__trigger-label{flex:0 1 auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
@media (prefers-reduced-motion:reduce){.dsh-on-phone-control__provider,.dsh-on-phone-control__cpolar-connect{transition:none}.dsh-on-phone-control__diagnostic-summary.is-running .dsh-on-phone-control__diagnostic-summary-icon::before,.dsh-on-phone-control__diagnostic-checks{animation:none}}
`

/**
 * Install the object-layer session-open guard, when this build has a sessions
 * service to find.
 *
 * The service is resolved per arm attempt rather than here: this client half is
 * evaluated before the app's own services register, so the guard polls a bounded
 * number of times until a live session hands it the class prototype — and that
 * prototype then covers every instance the app builds afterwards. A host whose
 * service never appears, or whose shape differs, is left exactly as it was.
 * @param ctx - The plugin's client context.
 * @returns A function that stops the arming poll and gives every hold back.
 */
function installSessionOpenGuardSafely(ctx: ClientContext): () => void {
  const read = (name: 'sessions' | 'uiWorkspace' | 'connection'): unknown => {
    try {
      return (ctx.get as (service: string) => unknown)(name)
    } catch {
      return undefined
    }
  }
  try {
    return installSessionOpenGuard({
      sessions: () => read('sessions'),
      reopenSession: sessionId => reselectSession(read('uiWorkspace'), sessionId),
      holdSession: sessionId => holdSessionOpen(read('sessions'), sessionId),
      // The app's documented recovery seam: once the same-carrier repairs have
      // come up empty, rebuild the connection generation the app's streams are
      // built to resume on — what a full page reload does, without the reload.
      reconnectCarrier: (): void => {
        try {
          const connection = read('connection') as { reconnect?: () => unknown } | undefined
          if (typeof connection?.reconnect === 'function') connection.reconnect()
        } catch {
          // The ladder continues without a rebuilt carrier.
        }
      },
    })
  } catch {
    return () => undefined
  }
}

/** Mount the desktop control or mobile feature enhancements. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    // Both plugin-served channels (LAN gateway and Tailscale Serve proxy) inject
    // the trust flag; the frontend flag is kept as a fallback for a page cached
    // from an earlier build. Without this the phone page is treated as an
    // untrusted browser and DSH resolves settings to its in-memory backend.
    const trusted = window.__DSH_ON_PHONE_TRUSTED_GATEWAY__ === true || window.__DSH_ON_PHONE_FRONTEND__ === 'dedicated'
    if (!trusted) return
    return trustAuthenticatedGatewayConnection(ctx.get('connection'))
  }, 'dsh-on-phone: authenticated gateway client trust')

  ctx.effect(() => {
    // The desktop window (dsh-app://app/) reaches this module too, so an
    // origin-based guess must never be allowed to install the phone layer there.
    const desktop = resolveClientSurface({
      protocol: location.protocol,
      hostname: location.hostname,
      search: location.search,
      trustedGateway: window.__DSH_ON_PHONE_TRUSTED_GATEWAY__ === true,
      dedicatedFrontend: window.__DSH_ON_PHONE_FRONTEND__,
    }) === 'desktop'
    const style = element('style'); style.dataset.plugin = 'dsh-on-phone'; style.textContent = desktop
      ? CONTROL_STYLES
      : NATIVE_MOBILE_STYLES
    document.head.append(style)
    if (!desktop) {
      const removeCustom = installCustomAssets()
      const removeSurface = installNativeMobileSurface()
      // The strand lives in the app's session class, not in the DOM: while a
      // session is opening, hold a reference of our own so the navigation that
      // releases the app's reference cannot retire and dispose the session
      // mid-open — which is the state the view never leaves. No reload, no
      // socket rebuild.
      const stopOpenGuard = installSessionOpenGuardSafely(ctx)
      return () => { removeCustom(); removeSurface(); stopOpenGuard(); style.remove() }
    }
    const control = installControl()
    const disposeSlot = ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register<{ wide: boolean }>({ name: 'sidebar.footer.action', id: 'dsh-on-phone' }, ({ wide }) => createElement('button', {
      'aria-expanded': false,
      'aria-label': '移动访问',
      className: `dsh-on-phone-control__trigger${wide ? '' : ' is-rail'}`,
      type: 'button',
      title: '移动访问',
      onClick: control.toggle,
    }, createElement('span', { 'aria-hidden': true, className: 'dsh-on-phone-control__trigger-icon' }), wide ? createElement('span', { className: 'dsh-on-phone-control__trigger-label' }, '移动访问') : undefined)))
    return () => { disposeSlot(); control.remove(); style.remove() }
  }, 'dsh-on-phone: stock mobile adaptation and local control')
}

/** Client services required by the mobile adaptation. */
export const inject: readonly string[] = ['slots']
