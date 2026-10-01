import { installDrawerPan } from './drawer-pan.js'
import { TELEMETRY_ENDPOINT, installGestureTelemetry } from './gesture-telemetry.js'
import { installPageFetchGuard } from './page-fetch-guard.js'
import { installPageTiming } from './page-timing.js'
import { installStripSwipe } from './strip-swipe.js'
import { installTerminalKeyRepair } from './terminal-keys.js'

/** Mobile feature and compatibility rules applied to DSH React surfaces. */
export const NATIVE_MOBILE_STYLES = `
/* iOS inflates text in wide (landscape) viewports unless text-size-adjust is
   pinned; this must apply outside the width media query so landscape phones
   (which exceed 720px wide) are covered too. */
html.dsh-native-mobile-active { -webkit-text-size-adjust:100%; text-size-adjust:100%; }
@media (max-width:720px) {
  html.dsh-native-mobile-active,html.dsh-native-mobile-active body { width:100%; height:100%; max-width:100%; overflow:hidden; overscroll-behavior:none; }
  html.dsh-native-mobile-active { --dsh-on-phone-motion-duration:200ms; --dsh-on-phone-motion-ease:cubic-bezier(.22,1,.36,1); }
  html.dsh-native-mobile-active :is(a,button,[role="button"],[role="tab"],[tabindex]) { -webkit-tap-highlight-color:transparent; }
  html.dsh-native-mobile-active [data-dsh-on-phone-sidebar] [role="treeitem"] { -webkit-tap-highlight-color:transparent; touch-action:manipulation; }
  html.dsh-native-mobile-active[data-dsh-on-phone-input="touch"] :is(a,button,[role="button"],[role="tab"],[tabindex]):focus { outline:none !important; }
  html.dsh-native-mobile-active [role="tooltip"] { display:none !important; }
  /* Touch has no persistent hover affordance: keep workspace rows neutral after a tap. */
  html.dsh-native-mobile-active [data-dsh-on-phone-sidebar] { --dsw-alias-interactive-bg-hover:transparent !important; }
  html.dsh-native-mobile-active [data-dsh-on-phone-sidebar] [role="treeitem"]:is(:hover,:active,:focus,[aria-selected="true"]),
  html.dsh-native-mobile-active [data-dsh-on-phone-sidebar] [class*="_sessionRow"][class*="_selected"],
  html.dsh-native-mobile-active [data-dsh-on-phone-sidebar] [class*="_searchResultRow"][class*="_selected"] { background:transparent !important; outline:0 !important; box-shadow:none !important; }
  /* Sidebar row menus are hover-only on desktop. Touch has no hover, so keep
     the ellipsis action visible and give it a reliable hit target. */
  html.dsh-native-mobile-active [data-dsh-on-phone-sidebar] [class*="_rowActions"] { display:inline-flex !important; align-items:center !important; gap:8px !important; }
  html.dsh-native-mobile-active [data-dsh-on-phone-sidebar] [class*="_sessionRow"] [class*="_time"] { display:none !important; }
  html.dsh-native-mobile-active [data-dsh-on-phone-sidebar] [class*="_rowActions"] button { box-sizing:border-box !important; width:32px !important; min-width:32px !important; height:32px !important; min-height:32px !important; }
  [data-dsh-on-phone-frame] { grid-template-columns:0 minmax(0,1fr) 0 !important; width:100% !important; height:100dvh !important; overflow:hidden !important; }
  [data-dsh-on-phone-center] { grid-column:2 !important; width:100% !important; max-width:100% !important; min-width:0 !important; }
  [data-dsh-on-phone-center] > * { min-width:0 !important; }
  [data-dsh-on-phone-header] { box-sizing:border-box !important; width:calc(100% - 16px) !important; margin:0 8px !important; min-width:0; padding-top:max(4px,env(safe-area-inset-top)) !important; padding-right:8px !important; padding-left:42px !important; }
  [data-dsh-on-phone-header] [class*="_titleRow"] { box-sizing:border-box !important; display:flex !important; align-items:center !important; min-width:0; min-height:32px !important; height:32px !important; gap:6px !important; padding:0 6px !important; }
  [data-dsh-on-phone-header] [class*="_titleCluster"] { min-width:0; }
  [data-dsh-on-phone-header] [class*="_crumbs"] { min-width:0; overflow:hidden; }
  [data-dsh-on-phone-header] [class*="_crumb"] { max-width:46vw; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  [data-dsh-on-phone-header] [class*="_headerActions"] { min-width:0; overflow-x:auto; scrollbar-width:none; }
  [data-dsh-on-phone-header] [class*="_headerActions"]::-webkit-scrollbar { display:none; }
  [data-dsh-on-phone-header] [class*="_headerUtilities"] { gap:2px !important; }
  [data-dsh-on-phone-header] [class*="_sessionLogButton"] { width:40px; min-width:40px; padding:0 !important; overflow:hidden; color:transparent; font-size:0 !important; }
  [data-dsh-on-phone-header] [class*="_sessionLogButton"] > * { display:none !important; }
  [data-dsh-on-phone-header] [class*="_sessionLogButton"]::after { color:var(--dsw-text, #171a21); content:"日志"; font-size:11px; font-weight:600; }
  [data-dsh-on-phone-header] [class*="_tabs"] { box-sizing:border-box !important; width:max-content !important; max-width:calc(100% - 58px) !important; min-height:28px !important; height:28px !important; margin-top:0 !important; padding-left:6px !important; padding-right:6px !important; overflow-x:auto; scrollbar-width:none; }
  [data-dsh-on-phone-header] [class*="_tab"] { padding-bottom:5px !important; }
  [data-dsh-on-phone-header] [class*="_tabs"]::-webkit-scrollbar { display:none; }
  [data-dsh-on-phone-sidebar] { position:fixed !important; z-index:240 !important; inset:0 auto 0 0 !important; width:0 !important; overflow:visible !important; }
  [data-dsh-on-phone-sidebar-root] { position:fixed !important; z-index:241 !important; inset:max(env(safe-area-inset-top),0px) auto 0 0 !important; height:auto !important; transition:width 180ms var(--dsh-on-phone-motion-ease),box-shadow 180ms ease !important; }
  [data-dsh-on-phone-sidebar][data-open="true"] [data-dsh-on-phone-sidebar-root] { width:min(88vw,340px) !important; padding-top:0 !important; box-shadow:18px 0 46px rgb(15 23 42 / 18%); }
  [data-dsh-on-phone-sidebar][data-open="true"] [data-dsh-on-phone-sidebar-root] [class*="_logoRow"] { height:52px !important; padding:4px 0 4px 4px !important; margin-bottom:4px !important; }
  [data-dsh-on-phone-sidebar][data-open="false"] [data-dsh-on-phone-sidebar-root] { width:0 !important; border:0 !important; background:transparent !important; box-shadow:none !important; overflow:visible !important; }
  [data-dsh-on-phone-sidebar][data-open="false"] [data-dsh-on-phone-sidebar-root] > :not(:has([data-dsh-on-phone-toggle])) { display:none !important; }
  [data-dsh-on-phone-sidebar][data-open="false"] [data-dsh-on-phone-sidebar-root] > :has([data-dsh-on-phone-toggle]) { position:fixed !important; z-index:244 !important; top:env(safe-area-inset-top) !important; left:0 !important; box-sizing:border-box !important; width:50px !important; height:52px !important; padding:4px !important; border:0 !important; background:transparent !important; }
  [data-dsh-on-phone-sidebar][data-open="false"] [data-dsh-on-phone-sidebar-root] > :has([data-dsh-on-phone-toggle]) > :not([data-dsh-on-phone-toggle]) { display:none !important; }
  [data-dsh-on-phone-toggle] { width:44px !important; height:44px !important; min-width:44px !important; min-height:44px !important; }
  [data-dsh-on-phone-sidebar][data-open="false"] [data-dsh-on-phone-toggle] > svg[class*="_railFish"] { transform:translateY(-4px) !important; }
  .dsh-native-mobile-backdrop { position:fixed; z-index:235; inset:env(safe-area-inset-top) 0 0; border:0; background:rgb(15 23 42 / 32%); }
  .dsh-native-mobile-backdrop:not([hidden]) { animation:dsh-on-phone-fade-in var(--dsh-on-phone-motion-duration) ease-out; }
  .dsh-native-mobile-backdrop[hidden] { display:none; }
  [data-dsh-on-phone-details] { position:fixed !important; z-index:250 !important; inset:0 0 0 auto !important; width:min(94vw,460px) !important; max-width:none !important; transform:translateX(100%); transition:transform var(--dsh-on-phone-motion-duration) var(--dsh-on-phone-motion-ease); background:var(--dsh-on-phone-drawer-bg,var(--dsw-alias-bg-base,var(--dsw-bg,#fff))); box-shadow:-18px 0 46px rgb(15 23 42 / 18%); }
  [data-dsh-on-phone-details][data-open="true"] { transform:translateX(0); }
  [data-dsh-on-phone-handle] { display:none !important; }
  [data-dsh-on-phone-settings] { flex-direction:column !important; width:100vw !important; height:100dvh !important; max-width:none !important; border-radius:0 !important; animation:dsh-on-phone-panel-in var(--dsh-on-phone-motion-duration) var(--dsh-on-phone-motion-ease); }
  [data-dsh-on-phone-settings-nav] { flex:none !important; width:100% !important; padding:max(14px,env(safe-area-inset-top)) 12px 8px !important; gap:10px !important; border-bottom:1px solid var(--dsw-alias-border-subtle,#e8ebef); }
  [data-dsh-on-phone-settings-nav] [class*="_navTitle"] { padding:0 8px !important; font-size:18px !important; line-height:28px !important; }
  [data-dsh-on-phone-settings-list] { flex-direction:row !important; gap:4px !important; overflow-x:auto !important; scrollbar-width:none; }
  [data-dsh-on-phone-settings-list]::-webkit-scrollbar { display:none; }
  [data-dsh-on-phone-settings-list] [class*="_navCell"] { flex:0 0 auto !important; min-width:max-content !important; height:44px !important; padding:10px 12px !important; }
  [data-dsh-on-phone-settings-list] [aria-current="true"] { border-color:transparent !important; outline:0 !important; box-shadow:none !important; }
  [data-dsh-on-phone-settings-content] { flex:1 1 auto !important; width:100% !important; min-height:0 !important; }
  [data-dsh-on-phone-settings-header] { height:48px !important; min-height:48px !important; padding:10px 12px 6px !important; }
  [data-dsh-on-phone-settings-header] [class*="_close"] { width:36px !important; height:36px !important; }
  [data-dsh-on-phone-settings-options] { box-sizing:border-box !important; width:100% !important; padding:4px 16px max(24px,env(safe-area-inset-bottom)) !important; overflow-x:hidden !important; }
  [data-dsh-on-phone-settings-options] > * { width:100% !important; min-width:0 !important; }
  [data-dsh-on-phone-settings-options] [data-slot="settings.general.item"] > [class*="_row"] { flex-direction:column !important; align-items:stretch !important; gap:12px !important; }
  [data-dsh-on-phone-settings-options] [data-slot="settings.general.item"] [class*="_rowText"] { width:100% !important; padding-right:0 !important; }
  [data-dsh-on-phone-settings-options] [data-slot="settings.general.item"] [class*="_selector"] { box-sizing:border-box !important; align-self:flex-start !important; justify-content:space-between !important; min-width:0 !important; min-height:44px !important; max-width:100% !important; }
  [data-dsh-on-phone-settings-options] :is(input,select,textarea,button) { max-width:100%; }
  [data-dsh-on-phone-settings-options] :is(input,select,textarea) { box-sizing:border-box; width:100%; min-width:0; }
  [data-dsh-on-phone-settings-options] [class*="_head"] { min-width:0; flex-wrap:wrap; }
  /* Provider names may shrink, but their edit/delete actions remain horizontal
     and retain a full touch target on narrow screens. */
  [data-dsh-on-phone-settings-options] [class*="_rowHead"]:has(> [class*="_rowIdentity"]) { flex-wrap:nowrap !important; align-items:center !important; }
  [data-dsh-on-phone-settings-options] [class*="_rowIdentity"] { flex:1 1 auto !important; min-width:0 !important; overflow:hidden !important; }
  [data-dsh-on-phone-settings-options] [class*="_rowName"] { min-width:0 !important; overflow:hidden !important; text-overflow:ellipsis !important; white-space:nowrap !important; }
  [data-dsh-on-phone-settings-options] [class*="_rowActions"] { flex:0 0 auto !important; flex-wrap:nowrap !important; width:max-content !important; min-width:max-content !important; max-width:none !important; }
  [data-dsh-on-phone-settings-options] [class*="_rowActions"] button { flex:none !important; width:auto !important; min-width:44px !important; max-width:none !important; min-height:44px !important; padding-inline:10px !important; white-space:nowrap !important; word-break:keep-all !important; writing-mode:horizontal-tb !important; }
  [data-dsh-on-phone-settings-content][data-dsh-on-phone-view-transition="true"],
  [data-dsh-on-phone-view][data-dsh-on-phone-view-transition="true"] { animation:dsh-on-phone-view-in var(--dsh-on-phone-motion-duration) var(--dsh-on-phone-motion-ease); }
  [data-dsh-on-phone-center] textarea { font-size:16px !important; }
  /* Markdown tables use content-sized columns. Small tables fill the phone;
     wider tables keep readable cells and scroll inside their own region. */
  [data-dsh-on-phone-table-scroll] { box-sizing:border-box; width:100%; max-width:100%; overflow-x:auto; overscroll-behavior-x:contain; -webkit-overflow-scrolling:touch; }
  [data-dsh-on-phone-table-scroll] table { display:table !important; width:max-content !important; min-width:100% !important; max-width:none !important; table-layout:auto !important; }
  [data-dsh-on-phone-table-scroll] :is(th,td) { box-sizing:border-box; min-width:8ch; max-width:32ch; overflow-wrap:anywhere; word-break:break-word; vertical-align:top; }
  [data-dsh-on-phone-center] pre { max-width:100%; overflow-x:auto; }
  [data-dsh-on-phone-center] :is(img,video,canvas,svg) { max-width:100%; }
  [data-dsh-on-phone-message-scroll] { box-sizing:border-box !important; width:100% !important; padding:8px 10px 20px !important; }
  /* The transcript scrolls one way only: an overflowing composer row used to
     leave the conversation column with a few pixels of sideways travel, which
     iOS turns into a full-page rubber-band. Tables and code blocks keep the
     inner scrollers granted above.
     The vertical bounce goes with it. WebKit fires a scroll event every frame
     while the transcript rubber-bands at an end, and the app answers each one -
     re-pinning the floor while it follows the tail, re-compensating while older
     pages land - so the render is repositioned at frame rate and the content
     shivers: the phone reports it as "the picture springs up and down, small
     but fast". No bounce, no per-frame scroll event, no shiver. */
  [data-conversation-scroll] { overflow-x:hidden !important; overscroll-behavior:none !important; }
  [data-dsh-on-phone-history-loader] { position:relative !important; min-height:0 !important; padding:2px 0 4px !important; }
  [data-dsh-on-phone-history-loader] button:not(:disabled) { position:static !important; display:block !important; box-sizing:border-box !important; width:auto !important; height:auto !important; min-height:32px !important; margin:0 auto !important; padding:2px 14px !important; font-size:12px !important; line-height:18px !important; clip-path:none !important; opacity:1 !important; pointer-events:auto !important; }
  [data-dsh-on-phone-history-loader] button:disabled { min-height:28px !important; padding:4px 12px !important; }
  [data-dsh-on-phone-message-column] { box-sizing:border-box !important; width:100% !important; max-width:none !important; margin:0 !important; padding:0 !important; gap:10px !important; }
  [data-dsh-on-phone-message-column] > * { width:100% !important; max-width:100% !important; }
  [data-dsh-on-phone-message-column] [data-disclosure-row] { box-sizing:border-box !important; display:grid !important; grid-template-columns:16px minmax(0,1fr) !important; grid-auto-rows:auto !important; align-items:center !important; column-gap:6px !important; width:100% !important; height:auto !important; min-height:40px !important; padding:4px 0 !important; }
  [data-dsh-on-phone-message-column] [data-disclosure-row] > [class*="_leading"] { grid-column:1 !important; grid-row:1 !important; margin-right:0 !important; }
  [data-dsh-on-phone-message-column] [data-disclosure-row] > [class*="_title"] { grid-column:2 !important; grid-row:1 !important; min-width:0 !important; overflow:hidden !important; text-overflow:ellipsis !important; white-space:nowrap !important; }
  [data-dsh-on-phone-message-column] [data-disclosure-row] > :is([class*="_sep"],[class*="_separator"]) { display:none !important; }
  [data-dsh-on-phone-message-column] [data-disclosure-row] > :is([class*="_summary"],[class*="_fileLink"]) { grid-column:2 !important; grid-row:2 !important; width:100% !important; min-width:0 !important; max-width:100% !important; overflow:hidden !important; line-height:19px !important; text-overflow:ellipsis !important; white-space:nowrap !important; }
  [data-dsh-on-phone-message-column] [data-disclosure-row] > [class*="_summarySuffix"] { grid-column:2 !important; grid-row:3 !important; margin-left:0 !important; }
  [data-dsh-on-phone-message-column] [data-context-fields] > * { display:grid !important; grid-template-columns:minmax(72px,30%) minmax(0,1fr) !important; gap:4px 10px !important; }
  [data-dsh-on-phone-message-column] [class*="_ioSection"] { grid-template-columns:1fr !important; row-gap:4px !important; }
  [data-dsh-on-phone-message-column] [class*="_body"] { max-width:100% !important; overflow-wrap:anywhere; }
  [data-dsh-on-phone-center] [data-composer-card] ~ [class*="_root"],
  [data-dsh-on-phone-center] [data-composer-card] ~ * [class*="_root"] { box-sizing:border-box !important; width:100% !important; max-width:100% !important; margin-bottom:-6px !important; padding:3px 4px 0 !important; font-size:11px !important; line-height:18px !important; white-space:normal !important; overflow:visible !important; text-overflow:clip !important; }
  [data-dsh-on-phone-center] [data-composer-card] ~ [class*="_root"] [class*="_sep"],
  [data-dsh-on-phone-center] [data-composer-card] ~ * [class*="_root"] [class*="_sep"] { margin:0 6px !important; }
  /* The status dock under the composer holds the turn/token pills, the context
     ring and the cost readout. Two problems on a 390px screen: the pills are
     wider than the row on their own, so the readout used to be squeezed into a
     bare "本会话 …" ellipsis; and as a wrapping flex row the ring could never
     share the pills' line (150px + 149px + ring overflows, and flex-wrapping
     prefers a new line over shrinking), so the footer spent three rows on
     status alone. A two-column grid keeps the pills and the ring on one line
     (the pills shrink only down to their text and then ellipsize, so the
     leading turn/token numbers stay readable), the readout spans the row
     underneath, and a notch-smaller face keeps the two rows tight: measured
     772px for pills + ring, 790px for the readout, dock height 84px -> 54px. */
  [data-dsh-on-phone-center] [data-composer-card] ~ [class*="_dock"] { box-sizing:border-box !important; display:grid !important; grid-template-columns:minmax(0,1fr) auto !important; align-items:center !important; gap:1px 6px !important; height:auto !important; max-width:100% !important; padding-top:2px !important; padding-bottom:2px !important; }
  [data-dsh-on-phone-center] [data-composer-card] ~ [class*="_dock"] [class*="_label"] { font-size:10px !important; line-height:14px !important; overflow:hidden !important; text-overflow:ellipsis !important; white-space:nowrap !important; }
  [data-dsh-on-phone-center] [data-composer-card] ~ [class*="_dock"] [class*="_trigger"] { padding:0 !important; }
  /* order:3 parks the readout after every other dock child, and grid-column
     1/-1 gives it the full row. */
  [data-dsh-on-phone-center] [data-composer-card] ~ [class*="_dock"] :is([class*="cm-root"],[class*="cm-footer-stack"]) { box-sizing:border-box !important; grid-column:1 / -1 !important; order:3 !important; width:100% !important; min-width:0 !important; max-width:100% !important; font-size:10px !important; line-height:14px !important; white-space:normal !important; overflow:visible !important; text-overflow:clip !important; }
  /* Message runtime details are inline on desktop. Give the clock/runtime
     label its own wrapping row on narrow screens so TTFT and throughput do
     not push the action buttons or clip at the viewport edge. */
  [data-dsh-on-phone-center] [class*="_actions"]:has(> [class*="_timeStart"]),
  [data-dsh-on-phone-center] [class*="_actions"]:has(> [class*="_timeEnd"]) { box-sizing:border-box !important; width:100% !important; flex-wrap:wrap !important; justify-content:flex-end !important; height:auto !important; min-height:28px !important; row-gap:2px !important; }
  [data-dsh-on-phone-center] [class*="_timeStart"],
  [data-dsh-on-phone-center] [class*="_timeEnd"] { box-sizing:border-box !important; flex:1 1 100% !important; order:2 !important; min-width:0 !important; max-width:100% !important; padding:0 !important; line-height:20px !important; text-align:center !important; white-space:normal !important; overflow-wrap:anywhere !important; }
  [data-dsh-on-phone-center] [class*="_timeStart"] { box-sizing:border-box !important; flex:1 1 100% !important; order:2 !important; min-width:0 !important; max-width:100% !important; padding:0 !important; line-height:20px !important; text-align:center !important; white-space:normal !important; overflow-wrap:anywhere !important; }
  [data-dsh-on-phone-center] [class*="_timeStart"] [class*="_runTimeDot"],
  [data-dsh-on-phone-center] [class*="_timeEnd"] [class*="_runTimeDot"] { margin:0 6px !important; }
  /* Keep the context meter's legend rows as readable label/value pairs.
     Generic mobile flex rules can otherwise place the rows side by side and
     break Chinese labels in the middle of a word. */
  [data-dsh-on-phone-center] [role="dialog"][aria-label*="上下文"],
  [data-dsh-on-phone-center] [role="dialog"][aria-label*="Context"] { width:min(264px,calc(100vw - 32px)) !important; min-width:0 !important; max-width:calc(100vw - 32px) !important; }
  [data-dsh-on-phone-center] [role="dialog"][aria-label*="上下文"] [class*="_rows"],
  [data-dsh-on-phone-center] [role="dialog"][aria-label*="Context"] [class*="_rows"] { display:block !important; }
  [data-dsh-on-phone-center] [role="dialog"][aria-label*="上下文"] [class*="_rows"] > [class*="_row"],
  [data-dsh-on-phone-center] [role="dialog"][aria-label*="Context"] [class*="_rows"] > [class*="_row"] { display:flex !important; align-items:center !important; justify-content:space-between !important; width:100% !important; min-width:0 !important; white-space:nowrap !important; }
  [data-dsh-on-phone-center] [role="dialog"][aria-label*="上下文"] :is(dt,dd),
  [data-dsh-on-phone-center] [role="dialog"][aria-label*="Context"] :is(dt,dd) { white-space:nowrap !important; word-break:keep-all !important; }
  .dsh-on-phone-branch-toast { position:fixed; z-index:300; top:max(12px,env(safe-area-inset-top)); left:50%; max-width:calc(100vw - 32px); box-sizing:border-box; padding:7px 14px; border:1px solid rgb(15 23 42 / 10%); border-radius:999px; background:rgb(15 23 42 / 92%); color:#fff; font-size:13px; line-height:20px; text-align:center; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; opacity:0; pointer-events:none; transform:translate(-50%,-8px); transition:opacity 160ms ease,transform 160ms ease; }
  .dsh-on-phone-branch-toast[data-visible="true"] { opacity:1; transform:translate(-50%,0); }
  [data-dsh-on-phone-center] [class*="_composer"] { padding-left:8px !important; padding-right:8px !important; padding-bottom:max(8px,env(safe-area-inset-bottom)) !important; }
  /* The desktop composer intentionally wraps whole toolbar groups. On a phone,
     dynamic model and status labels made that row alternate between one and
     two lines. Keep two stable columns and let only the model label shrink. */
  [data-dsh-on-phone-composer-row] { display:grid !important; grid-template-columns:max-content minmax(0,1fr) !important; align-items:center !important; gap:4px 8px !important; }
  [data-dsh-on-phone-composer-tools] { display:flex !important; flex-wrap:nowrap !important; width:max-content !important; min-width:0 !important; max-width:max-content !important; gap:6px !important; }
  [data-dsh-on-phone-composer-trailing] { display:flex !important; flex-wrap:nowrap !important; width:100% !important; min-width:0 !important; max-width:100% !important; gap:6px !important; margin-left:0 !important; justify-content:flex-end !important; }
  [data-dsh-on-phone-composer-model] { flex:1 1 0 !important; width:auto !important; min-width:0 !important; max-width:none !important; }
  [data-dsh-on-phone-composer-model-trigger] { box-sizing:border-box !important; width:100% !important; max-width:100% !important; min-width:0 !important; padding-left:6px !important; padding-right:4px !important; }
  [data-dsh-on-phone-composer-model-label] { flex:1 1 auto !important; max-width:none !important; min-width:0 !important; overflow:hidden !important; text-overflow:ellipsis !important; white-space:nowrap !important; }
  [data-dsh-on-phone-center] [class*="_root"]:has(> [class*="_card"] textarea) { box-sizing:border-box !important; width:100% !important; padding:0 0 8px !important; }
  [data-dsh-on-phone-center] [class*="_root"]:has(> [class*="_card"] textarea) > [class=""]:last-child { display:none !important; }
}
@keyframes dsh-on-phone-fade-in { from { opacity:0; } }
@keyframes dsh-on-phone-panel-in { from { opacity:.72; transform:translateY(6px); } }
@keyframes dsh-on-phone-view-in { from { opacity:.58; transform:translateY(5px); } }
@media (max-width:420px) {
  [data-dsh-on-phone-header] [class*="_headerActions"] { max-width:42vw; }
  [data-dsh-on-phone-settings-options] [data-slot="settings.general.item"] [class*="_selector"] { align-self:stretch !important; width:100% !important; }
  [data-dsh-on-phone-message-column] [data-context-fields] > * { grid-template-columns:1fr !important; }
}
@media (prefers-reduced-motion:reduce) {
  [data-dsh-on-phone-sidebar-root],[data-dsh-on-phone-details] { transition:none !important; }
  .dsh-native-mobile-backdrop:not([hidden]),[data-dsh-on-phone-settings],
  [data-dsh-on-phone-settings-content][data-dsh-on-phone-view-transition="true"],
  [data-dsh-on-phone-view][data-dsh-on-phone-view-transition="true"] { animation:none !important; }
}
/* Touch feedback: taps must give an immediate, perceivable response. The
   stock app relies on :hover, which touch has no persistent form of, so we
   add :active feedback here. Sidebar rows keep their deliberate neutral
   background handling above; opacity still gives them feedback.
   role=treeitem rows (the session list) are plain divs, so they are matched
   explicitly. Two things are deliberately missing:
   - No brightness filter: on a dark theme dimming a full-width row reads as
     the whole screen changing, which is the "screen got darker when I tapped"
     complaint.
   - No transform, and never on the app's structural boxes. A browser marks
     the whole ancestor chain :active, so a transform:scale(.97) on a
     section[data-dockkit-host] re-layers the pane and its scroller for the
     length of the press: the content jumps and blinks, which is exactly the
     "scroll up, it sticks and shivers, then the history appears" report. The
     phone telemetry caught the pane host at opacity 0.72 - our own feedback
     value - while every neighbour stayed at 1.
   - Never on a focus container. A long press on the settings page used to
     turn the whole surface translucent and show the layer underneath it: the
     app renders that page as div[role="dialog"][tabindex="-1"], an ancestor
     of everything the finger can land on, and this plugin's own layout sizes
     it to 100vw x 100dvh. [tabindex] matched it, so 0.72 landed on the full
     screen box. tabindex="-1" is a programmatic focus target by definition
     and never a tap target, so it is dropped from that matcher, and dialogs
     are excluded outright the way sections and the dockkit hosts already
     were. */
html.dsh-native-mobile-active :is(a,button,[role="button"],[role="tab"],[role="treeitem"],label,[tabindex]:not([tabindex="-1"]),[contenteditable]):active:not(section):not([role="dialog"]):not([data-dockkit-host]):not([data-dockkit-pane]):not([data-dsh-on-phone-workbench]):not([data-conversation-scroll]) {
  opacity:.72 !important;
}
/* Inside the right drawer the host paints its own pressed background, so keep
   the opacity feedback only. A touch tap also leaves a pointer :hover behind
   it, which is why the hover token is neutralized here the same way the left
   sidebar does it. */
html.dsh-native-mobile-active [data-dsh-on-phone-workbench] { --dsw-alias-interactive-bg-hover:transparent !important; }
html.dsh-native-mobile-active [data-dsh-on-phone-workbench] :is(a,button,[role="button"],[role="tab"],[role="treeitem"],label,[tabindex]:not([tabindex="-1"]),[contenteditable]):active:not(section):not([role="dialog"]):not([data-dockkit-host]):not([data-dockkit-pane]):not([data-dsh-on-phone-workbench]):not([data-conversation-scroll]) {
  opacity:.72 !important;
  transform:none !important;
  filter:none !important;
}
/* Prevent iOS auto-zoom when a field with a small font receives focus: any
   field under 16px triggers it, which reads as "the page suddenly gets big".
   The composer is a contenteditable div, so it must be covered too. */
html.dsh-native-mobile-active :is(input,textarea,select,[contenteditable]) { font-size:16px !important; }
/* Kill the double-tap-zoom affordance and the 300ms tap delay everywhere. */
html.dsh-native-mobile-active :is(a,button,[role="button"],[role="tab"],[role="treeitem"],[tabindex]) { touch-action:manipulation !important; }
/* The right details/explorer toggle sits directly beside the session-log
   button in the narrow header; reserve room so the two never overlap. */
html.dsh-native-mobile-active [data-dsh-on-phone-header] [class*="_sessionLogButton"] { margin-right:48px !important; }
/* In portrait the workbench panel (Files / terminal) would otherwise fill the
   whole screen; present it as a right-side drawer at the same ratio as the
   left sidebar, FULL-HEIGHT like the native panel. The app's own toggle
   buttons are floated above the drawer (like the left sidebar's floating
   toggle), so opening and closing both go through the button — consistent
   with the desktop layout. */
@media (orientation: portrait) {
  html.dsh-native-mobile-active [data-dsh-on-phone-workbench] {
    position:fixed !important;
    inset:0 0 0 auto !important;
    z-index:250 !important;
    width:min(88vw,340px) !important;
    height:100dvh !important;
    max-width:none !important;
    transform:translateX(100%) !important;
    transition:transform var(--dsh-on-phone-motion-duration,200ms) var(--dsh-on-phone-motion-ease,cubic-bezier(.22,1,.36,1)) !important;
    /* The drawer's own paint is what shows on the transition frames, while the
       app's pane inside it is still mounting or already torn down. --dsw-bg is
       undefined in this build, so the old #fff fallback painted a white flash on
       the dark theme; --dsh-on-phone-drawer-bg is mirrored from the pane itself by
       sync() and the alias token is the theme's real surface. */
    background:var(--dsh-on-phone-drawer-bg,var(--dsw-alias-bg-base,var(--dsw-bg,#fff))) !important;
    box-shadow:-18px 0 46px rgb(15 23 42 / 18%) !important;
    /* The app lays its docked panes out as a strip inside this box (measured:
       730px of content in a 340px drawer), so a plain overflow:auto turned the
       drawer into a sideways scroller that slid the empty tab host into view.
       Only the vertical axis scrolls; wide content keeps its own scrollers. */
    overflow-y:auto !important;
    overflow-x:hidden !important;
    overscroll-behavior-x:none !important;
  }
  /* The open state is published as an attribute by the DOM pass rather than
     inferred from a class token: the older workbench hid itself with
     *_panelHidden, while 0.1.7's sidebar-right root carries
     data-sidebar-right-open (and aria-hidden while collapsed), plus
     data-sidebar-right-unavailable on the tab fallback. All of them are folded
     into data-dsh-on-phone-workbench-open, so one selector covers either build.
     pointer-events is re-armed here because 0.1.7 makes the panel root
     click-through (.GrpIoq_panel{pointer-events:none}) and relies on each docked
     pane to re-enable it for itself. */
  html.dsh-native-mobile-active [data-dsh-on-phone-workbench][data-dsh-on-phone-workbench-open="true"] {
    transform:translateX(0) !important;
    pointer-events:auto !important;
  }
  /* A finger drag only pans the page when the node it landed on allows that
     axis. The app's own rows (file tree, tabs) claim the gesture for pointer
     dragging, so a swipe inside the drawer never reached the pane's scroller.
     Hand the pan back to every node in the open drawer, and let the
     drawer itself be a real scrolling box (overscroll contained, so the page
     behind it never moves instead).
     NB: -webkit-overflow-scrolling is deliberately NOT set here. On iOS it turns
     every descendant into its own momentum scroller, a nest in which the pane's
     own scroller can lose the drag outright; modern iOS scrolls without it.
     Both axes are handed back, never the vertical one alone: WebKit resolves a
     gesture against the ancestor chain as well as the touched node, so a blanket
     pan-y above a horizontal scroller (the open-files strip) can leave the
     browser with no axis it may claim; the host's own pointer drag then pulls the
     pane out of the window instead of scrolling the tabs. pan-x pan-y still
     outranks the none the app puts on its rows, which is why the vertical pan
     works at all.
     installDrawerPan() covers a device that still drops the gesture. */
  html.dsh-native-mobile-active [data-dsh-on-phone-workbench][data-dsh-on-phone-workbench-open="true"],
  html.dsh-native-mobile-active [data-dsh-on-phone-workbench][data-dsh-on-phone-workbench-open="true"] * {
    touch-action:pan-x pan-y pinch-zoom !important;
  }
  html.dsh-native-mobile-active [data-dsh-on-phone-workbench][data-dsh-on-phone-workbench-open="true"] {
    overscroll-behavior:contain;
  }
  /* Wide content still has to pan sideways inside the drawer. */
  html.dsh-native-mobile-active [data-dsh-on-phone-workbench][data-dsh-on-phone-workbench-open="true"] :is(pre,[data-dsh-on-phone-table-scroll]) {
    touch-action:pan-x pan-y pinch-zoom !important;
  }
  /* The dockkit tab strip is the app's own horizontal scroller
     (._stripTabs_1s7ij_257{overflow-x:auto}) and it declares touch-action:none
     on both the bar and the strip; the blanket above outranks that, so
     the tabs past the drawer's right edge became unreachable. Hand the
     horizontal pan back to the strip chain (bar, strip and their children),
     which is what makes "swipe the open files" work again. The right details
     tabs of the older build (._3LvJsq_detailTabs{overflow:auto hidden}) get the
     same treatment. */
  html.dsh-native-mobile-active [data-dsh-on-phone-workbench][data-dsh-on-phone-workbench-open="true"] :is([class*="_tabStrip"],[class*="_stripTabs"],[class*="_detailTabs"]),
  html.dsh-native-mobile-active [data-dsh-on-phone-workbench][data-dsh-on-phone-workbench-open="true"] :is([class*="_tabStrip"],[class*="_stripTabs"],[class*="_detailTabs"]) * {
    touch-action:pan-x pinch-zoom !important;
  }
  /* Keep the dockkit chain between the drawer and the app's own scroller from
     collapsing to zero height: the panel body then has nothing left to scroll. */
  html.dsh-native-mobile-active [data-dsh-on-phone-workbench][data-dsh-on-phone-workbench-open="true"] :is([data-dockkit-host],[data-dockkit-pane],[data-dockkit-content]) {
    box-sizing:border-box !important;
    min-height:0 !important;
  }
  /* The workbench toggle cluster shares its stacking context with the panel
     (both live inside [data-dsh-panel-host], z-index:25), so it only needs a
     z-index ABOVE the drawer's 250 to stay clickable on top of it. It is
     NOT moved in the DOM — moving it would detach it from the app's React
     portal click handler. */
  html.dsh-native-mobile-active [class*="_toggleCluster"] {
    position:fixed !important;
    top:max(4px,env(safe-area-inset-top)) !important;
    right:8px !important;
    z-index:260 !important;
    display:flex !important;
    align-items:center !important;
    justify-content:center !important;
    gap:4px !important;
  }
}
/* Landscape phones are short: the sidebar's fixed header + footer squeeze the
   session list to a couple of rows, and forcing overflow:visible on the list
   disables its native scroll. Reclaim the height by dropping the secondary
   footer actions and compressing the logo row, then keep the list scrollable
   (native overflow:auto). Settings stay reachable via the kept settingsArea. */
@media (max-height:520px) and (orientation: landscape) {
  html.dsh-native-mobile-active [data-dsh-on-phone-sidebar] [class*="_footerActions"] {
    display:none !important;
  }
  html.dsh-native-mobile-active [data-dsh-on-phone-sidebar] [class*="_logoRow"] {
    height:44px !important;
    min-height:44px !important;
  }
  html.dsh-native-mobile-active [data-dsh-on-phone-sidebar] [class*="_list"]:not([class*="_listArea"]) {
    overflow-y:auto !important;
    min-height:0 !important;
    -webkit-overflow-scrolling:touch !important;
  }
}
`

/* Locate the native mobile surface so it can be installed without re-reading the layout. */

function classToken(element: Element, suffix: string): boolean {
  return Array.from(element.classList).some(value => value.endsWith(suffix))
}

function firstByClassSuffix(root: ParentNode, suffix: string): HTMLElement | undefined {
  return Array.from(root.querySelectorAll<HTMLElement>('[class]')).find(element => classToken(element, suffix))
}

const AUTO_HISTORY_THRESHOLD_PX = 64

/**
 * The right-column track that becomes the mobile details sheet, if any.
 *
 * Only the legacy `details` generation is re-containered. 0.1.7 renamed that
 * track to `rightbar` (`*_rightbarCol`) and moved the sidebar-right panel
 * INSIDE it, so forcing `position:fixed` and `translateX(100%)` onto the track
 * made the track the panel's containing block and slid the track — panel and the
 * chrome buttons inside it included — permanently off screen. The rightbar
 * generation is therefore deliberately not eligible for the sheet; its panel is
 * tagged as the drawer through {@link findRightPanelHost} instead.
 * @param frame - The stock layout frame, when one was identified.
 * @returns The sheet host, or `undefined` when the frame has no sheet column.
 */
export function findDetailsSheetHost(frame: HTMLElement | undefined): HTMLElement | undefined {
  if (frame === undefined) return undefined
  const column = firstByClassSuffix(frame, '_detailsCol')
  // Some builds could ship both names on one node; the rightbar one still wins
  // the exclusion, because it is the node that carries the panel.
  return column !== undefined && !classToken(column, '_rightbarCol') ? column : undefined
}

/**
 * Whether the frame's right column currently occupies grid space.
 *
 * DSH renamed this column between generations: it was the `details` column
 * (`*_detailsCol`), and 0.1.7 turned it into the `rightbar` (`*_rightbarCol`).
 * The collapse signal changed with it — 0.1.7 drives a three-track frame
 * (`sidebar / centre / rightbar`) and marks a right column that takes no space
 * with `data-rightbar-collapsed`, while its trailing grid track is written as
 * `minmax(0px, 0px)`. The older exact-match grid probe compared the track
 * against `0px`, so on 0.1.7 it would read such a column as open.
 *
 * This answers "does the column take space", NOT "is the panel showing". A phone
 * viewport always answers "no space" — `computeColumns` wants 400px of chrome
 * plus 300px of track before it allocates any — even while the sidebar-right
 * panel is expanded and overlaying the app, so this can never be the mobile
 * drawer's open signal. Panels publish their own state (see
 * {@link rightPanelOpen}); this probe only drives the legacy details sheet.
 * @param frame - The stock layout frame, when one was identified.
 * @returns Whether the right column occupies grid space.
 */
export function rightColumnOpen(frame: HTMLElement | undefined): boolean {
  if (frame === undefined) return false
  const isRightbarFrame = frame.hasAttribute('data-rightbar-collapsed')
    || frame.querySelector('[data-rightbar-col]') !== null
  if (isRightbarFrame) return !frame.hasAttribute('data-rightbar-collapsed')
  const lastColumn = frame.style.gridTemplateColumns.trim().split(/\s+/).at(-1)
  return lastColumn !== undefined && lastColumn !== '0px' && lastColumn !== '0'
}

/**
 * The right-column panel host that becomes a portrait drawer.
 *
 * The panel that used to be tagged was the `workbench` (Files explorer /
 * terminal), whose outer class token ended exactly in `_panel`. DSH 0.1.7 has no
 * `_workbench` token at all: those panes now render through the sidebar-right
 * dockkit, whose root carries `data-sidebar-right-panel`. That root is the
 * element the drawer CSS has to position, so it is preferred, and the legacy
 * `_workbench` walk is kept only as the fallback for older generations. Several
 * sessions keep a panel mounted at once, so the expanded visible one wins over
 * its collapsed or background siblings.
 * @param root - Subtree to search.
 * @returns The panel host, when the surface is present.
 */
export function findRightPanelHost(root: ParentNode): HTMLElement | undefined {
  const panels = Array.from(root.querySelectorAll<HTMLElement>('[data-sidebar-right-panel]'))
  if (panels.length > 0) {
    // Several sessions keep a panel mounted at once; only the expanded one is
    // showing, and a background session's wrapper carries `hidden`, so an
    // expanded-but-hidden panel must not win over the visible one — a background
    // session keeps its stale expanded flag around.
    const isShowing = (panel: HTMLElement): boolean => panel.closest('[hidden]') === null
    const isExpanded = (panel: HTMLElement): boolean => panel.hasAttribute('data-sidebar-right-open')
    return panels.find(panel => isExpanded(panel) && isShowing(panel))
      ?? panels.find(isShowing)
      ?? panels[0]
  }
  const dockHost = root.querySelector<HTMLElement>('[data-dockkit-host]')
  if (dockHost !== null) return dockHost.closest<HTMLElement>('[data-sidebar-right-panel]') ?? dockHost
  const isPanelToken = (element: Element): boolean =>
    Array.from(element.classList).some(token => /_panel$/u.test(token))
  let candidate: HTMLElement | null | undefined = firstByClassSuffix(root, '_workbench')?.parentElement
  while (candidate !== null && candidate !== undefined && !isPanelToken(candidate)) {
    candidate = candidate.parentElement
  }
  return candidate ?? undefined
}

/**
 * Whether the right-column panel host is currently showing.
 *
 * 0.1.7 mounts the sidebar-right panel permanently and publishes its own
 * expansion: the root carries `data-sidebar-right-open` only while expanded
 * (React writes `expanded || undefined`) and an `aria-hidden` that mirrors it.
 * The markers that generation uses to hide *content* live on other nodes —
 * `hidden` sits on the session wrapper and `data-sidebar-right-unavailable` on a
 * tab fallback — so probing them read the always-mounted root as open, which
 * pinned the mobile drawer on screen no matter what the panel was doing. The
 * older workbench generation really did hide its host with `*_panelHidden`, so
 * those probes survive as the fallback.
 * @param panel - The panel host returned by {@link findRightPanelHost}.
 */
export function rightPanelOpen(panel: HTMLElement): boolean {
  if (panel.hasAttribute('data-sidebar-right-panel') || panel.hasAttribute('data-sidebar-right-open')) {
    return panel.hasAttribute('data-sidebar-right-open') && !panel.hasAttribute('aria-hidden')
  }
  if (panel.hasAttribute('hidden')) return false
  if (panel.hasAttribute('data-sidebar-right-unavailable')) return false
  return !classToken(panel, '_panelHidden')
}

/** Whether a user-driven scroll moved upward into the automatic history-loading zone. */
export function shouldAutoLoadEarlier(previousTop: number, currentTop: number): boolean {
  return currentTop <= AUTO_HISTORY_THRESHOLD_PX && currentTop < previousTop - 0.5
}

/**
 * How long the automatic history fill waits between two attempts.
 *
 * The fill exists because the phone's compact flow collapses thinking and tool
 * rows to a few pixels each: a freshly loaded transcript can be SHORTER than the
 * viewport. There is then no scroll range to react to and
 * {@link shouldAutoLoadEarlier} can never fire, which left the newest turns on
 * screen with no way back into the older ones.
 */
export const HISTORY_FILL_INTERVAL_MS = 1500

/** Consecutive fill attempts that grew nothing before the fill gives up. */
export const HISTORY_FILL_MAX_STALLS = 2

/**
 * Pages one uninterrupted fill may pull before it gives up.
 *
 * The stall counter compares the transcript height between two attempts, and
 * the app grows the transcript from above, so its own scroll compensation fires
 * a scroll event that restarts the counter. The page budget is the hard stop
 * that keeps a transcript which stays too short to scroll from being filled for
 * ever; a fresh user gesture resets it.
 */
export const HISTORY_FILL_MAX_PAGES = 12

/**
 * Whether the automatic history fill should pull one more page.
 *
 * Only a transcript that cannot meaningfully scroll is filled. Once the loaded
 * pages have made it scrollable the user's own upward scroll drives
 * {@link shouldAutoLoadEarlier}, so the fill stops rather than draining the
 * whole session into the phone.
 * @param hasScrollRange - Whether the transcript scrolls by more than {@link AUTO_HISTORY_THRESHOLD_PX}.
 * @param atTop - Whether the transcript sits at (or within the threshold of) its top.
 * @param buttonAvailable - Whether the app's enabled `load earlier` button is present.
 * @param sinceLastAttemptMs - Time elapsed since the previous fill attempt.
 * @param stalls - Consecutive attempts that did not grow the transcript.
 * @param attempts - Pages this fill already pulled since the last user gesture.
 * @returns Whether another page should be requested.
 */
export function shouldFillEarlierHistory(hasScrollRange: boolean, atTop: boolean, buttonAvailable: boolean, sinceLastAttemptMs: number, stalls: number, attempts: number): boolean {
  if (hasScrollRange || !atTop || !buttonAvailable) return false
  if (attempts >= HISTORY_FILL_MAX_PAGES) return false
  if (sinceLastAttemptMs < HISTORY_FILL_INTERVAL_MS) return false
  return stalls < HISTORY_FILL_MAX_STALLS
}

/**
 * Minimum gap between two history loads asked for by one finger gesture.
 *
 * iOS stops sending `scroll` events once the transcript is pinned at its top,
 * and a transcript shorter than the viewport never sends one at all, so
 * {@link shouldAutoLoadEarlier} cannot fire again however often the user swipes
 * up. The gesture itself has to be able to ask for the next page.
 */
export const HISTORY_TOP_RETRY_MS = 1200

/**
 * Where the gesture listeners sit in the event path.
 *
 * Capture phase, because the app's own touch handling can stop a bubbling
 * `touchmove` from a transcript row before it ever reaches the scroller the
 * history binding watches.
 */
const HISTORY_TOUCH_OPTIONS: AddEventListenerOptions = { passive: true, capture: true }

/**
 * Whether a swipe at the top of the transcript should ask for another page.
 *
 * Only the gesture path uses this: a scroll event carries the position delta
 * {@link shouldAutoLoadEarlier} reacts to, while a finger on a pinned or
 * unscrollable transcript produces nothing else to react to.
 * @param currentTop - Current scroll offset of the transcript.
 * @param sinceLastLoadMs - Time elapsed since the previous history load.
 * @param loads - Pages this gesture already asked for.
 * @returns Whether one more page should be requested.
 */
export function shouldRetryEarlierHistory(currentTop: number, sinceLastLoadMs: number, loads: number): boolean {
  if (currentTop > AUTO_HISTORY_THRESHOLD_PX) return false
  if (sinceLastLoadMs < HISTORY_TOP_RETRY_MS) return false
  return loads < HISTORY_FILL_MAX_PAGES
}

/**
 * How long the DOM pass waits before re-scanning after an attribute change.
 *
 * The stock app rewrites `class`/`style` continuously while a turn streams, and
 * the pass walks the whole document. Running it once per animation frame (the
 * previous behaviour) kept the phone's main thread busy for the entire stream
 * and made every touch gesture feel stuck. State changes that the drawer
 * itself has to follow bypass this window (see the observer in
 * {@link installNativeMobileSurface}).
 */
export const SYNC_MIN_INTERVAL_MS = 150

/**
 * Delay before the next DOM pass.
 * @param now - Current timestamp.
 * @param lastSyncAt - When the previous pass ran, or 0 if it never has.
 * @param minIntervalMs - Shortest allowed gap between two passes.
 * @returns Milliseconds to wait; 0 when the interval has already elapsed.
 */
export function nextSyncDelay(now: number, lastSyncAt: number, minIntervalMs: number = SYNC_MIN_INTERVAL_MS): number {
  if (lastSyncAt === 0) return 0
  const elapsed = now - lastSyncAt
  return elapsed >= minIntervalMs ? 0 : minIntervalMs - elapsed
}

/**
 * How long the dim backdrop waits before following the sidebar state.
 *
 * React re-renders the shell on every tap, and for one frame the sidebar can
 * report a class list without `_collapsed`. The backdrop is a full-viewport
 * dim, so that single frame flashed the whole screen dark whenever a file was
 * tapped in the right panel. Flipping it only after the state has survived a
 * settle window drops the flash.
 */
export const BACKDROP_SETTLE_MS = 180

/**
 * The colour the right drawer should paint behind its panes.
 *
 * The drawer is a fixed, transformed box that animates in and out, and the app
 * mounts (and tears down) the panel inside it as it opens and closes. Whatever
 * the drawer paints is therefore visible on the transition frames, before the
 * pane has painted over it — and the stock theme token the app uses for that
 * surface is not the one this layer originally guessed (`--dsw-bg` is undefined
 * in 0.1.7, so a `#fff` fallback painted a white flash on a dark theme, twice
 * per open/close). Rather than trust a token, mirror the pane that will cover
 * it: only an opaque colour is accepted, so a transparent pane leaves the CSS
 * fallback in charge.
 * @param surface - A docked pane inside the drawer.
 * @param read - Computed-style reader, injectable for tests.
 * @returns The opaque background colour, or undefined when there is none.
 */
export function drawerBackgroundColor(
  surface: Element | undefined,
  read: (element: Element) => CSSStyleDeclaration = (element) => getComputedStyle(element),
): string | undefined {
  if (surface === undefined) return undefined
  const color = read(surface).backgroundColor
  const parts = /^rgba?\(([^)]+)\)$/.exec(color.trim())
  if (parts === null) return undefined
  const channels = (parts[1] ?? '').split(',').map((channel) => Number.parseFloat(channel))
  const alpha = channels.length === 4 ? channels[3] ?? 0 : 1
  if (!(alpha >= 1)) return undefined
  return color.trim()
}

/** Interactive roles that act inside a sidebar row instead of selecting it. */
const ROW_CONTROL_SELECTOR = 'button,[role="button"],[role="menu"],[aria-haspopup]'

/**
 * Whether a programmatic focus is the composer editor this layer has to mute.
 *
 * The stock app focuses the composer when a session opens, which pops the iOS
 * keyboard. Only that field is guarded: blurring any other programmatic focus
 * broke the model menu, whose search field opens focused when the user drills
 * into the model list — the blur fired the menu's own blur handler and closed
 * the overlay the user had just opened.
 * @param target - The element receiving focus.
 * @returns Whether the focus should be dropped unless the user asked for it.
 */
export function isComposerEditorFocus(target: Element): boolean {
  if (!target.matches('[contenteditable]:not([contenteditable="false"])')) return false
  return target.closest('[data-composer-card]') !== null
}

/**
 * Whether a sidebar click selected the row itself rather than one of the row's
 * own controls or an expand/collapse toggle.
 *
 * Collapsing the sidebar after a row selection is a portrait affordance, but a
 * row also hosts its action controls (the ellipsis menu, add-session). Treating
 * those as a selection collapsed the sidebar right after the menu opened, which
 * tore the menu down and read as a jump into the conversation.
 *
 * A Workspace (project) header is also a `role="treeitem"`, but its click
 * expands or collapses the session list nested beneath it instead of opening a
 * session. Only an expandable row announces `aria-expanded`, and a session row
 * never carries it, so that attribute is what separates a toggle from a
 * selection. Without this check, opening a project collapsed the drawer 240ms
 * later and read as jumping into one of its sessions.
 * @param target - Event target inside the row.
 * @param row - The enclosing `role="treeitem"` row.
 * @returns Whether the click should be treated as a row selection.
 */
export function selectsSidebarRow(target: Element, row: Element): boolean {
  if (row.getAttribute('aria-expanded') !== null) return false
  const action = target.closest(ROW_CONTROL_SELECTOR)
  return action === null || action === row
}

/**
 * Whether a press inside an open choice menu must keep focus where it is.
 *
 * The stock model menu autofocuses its search field and closes itself from the
 * *container's* own blur handler. On touch, tapping a model row dispatches
 * `mousedown`, whose default action moves focus out of the container, so the
 * menu unmounts before `mouseup` — no `click` is ever dispatched, the row's
 * handler never runs, and no request is sent. Picking a model on the phone
 * therefore did nothing at all: no error, no toast, and an unchanged label,
 * while the identical tap through a synthetic `click` (which never dispatches
 * `mousedown`) selected the model correctly.
 *
 * Cancelling only the `mousedown` default keeps focus inside the container, so
 * no blur fires and the menu stays mounted, while `click` still arrives.
 * Cancelling `touchstart` or `pointerdown` instead would suppress the very
 * click this is meant to deliver.
 * @param menu - The enclosing `[role="menu"]`, or null when the press is outside every menu.
 * @param row - The menu item under the press.
 * @param active - The currently focused element.
 * @returns Whether the press default must be cancelled.
 */
export function preservesMenuFocus(
  menu: Element | null,
  row: Element | null,
  active: Element | null,
): boolean {
  if (menu === null || row === null) return false
  return active !== null && menu.contains(active)
}

/** The menu item roles the stock model menu renders its rows with. */
const MENU_ITEM_SELECTOR = '[role="menuitemradio"],[role="menuitem"]'

/** The search field the stock model pane autofocuses when it opens. */
const MENU_SEARCH_SELECTOR = 'input[type="search"],input[role="searchbox"]'

/**
 * Whether a focus belongs to the search field of an open choice menu.
 *
 * Drilling into the model list autofocuses this field, and on a phone that
 * raises the soft keyboard, which shrinks the visual viewport from 796px to
 * 516px and pushes the model rows out of easy reach. Suppressing the keyboard
 * with `inputMode: none` keeps the focus — so the menu's own blur handler never
 * fires and the overlay stays mounted — while leaving the list fully visible.
 * @param target - The element receiving focus.
 * @returns Whether this is the menu search field whose keyboard should be muted.
 */
export function isMenuSearchFocus(target: Element): boolean {
  if (!target.matches(MENU_SEARCH_SELECTOR)) return false
  return target.closest('[role="menu"]') !== null
}

/** Add mobile semantics without replacing feature trees. */
export function installNativeMobileSurface(): () => void {
  document.documentElement.classList.add('dsh-native-mobile-active')
  const setInputMode = (mode: 'keyboard' | 'touch'): void => {
    document.documentElement.dataset.dshOnPhoneInput = mode
  }
  const onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === 'touch' || event.pointerType === 'pen') setInputMode('touch')
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Tab' || event.key.startsWith('Arrow')) setInputMode('keyboard')
  }
  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('keydown', onKeyDown, true)
  // Guard against programmatic field focus: the stock app focuses the
  // composer when a session opens, which pops the iOS keyboard. In touch mode,
  // only keep focus that came from a real tap on the field itself.
  let lastPointerTarget: Element | undefined
  const onPointerDownForFocus = (event: PointerEvent): void => {
    if (event.pointerType === 'touch' || event.pointerType === 'pen') {
      lastPointerTarget = event.target instanceof Element ? event.target : undefined
    }
  }
  const onFocusIn = (event: FocusEvent): void => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    if (!isComposerEditorFocus(target)) return
    if (document.documentElement.dataset.dshOnPhoneInput !== 'touch') return
    const tapped = lastPointerTarget !== undefined
      && (target === lastPointerTarget || target.contains(lastPointerTarget))
    lastPointerTarget = undefined
    if (tapped) return
    requestAnimationFrame(() => {
      if (document.activeElement === target) target.blur()
    })
  }
  document.addEventListener('pointerdown', onPointerDownForFocus, true)
  document.addEventListener('focusin', onFocusIn, true)
  // Keep focus inside an open choice menu so its own blur handler cannot tear
  // the overlay down before the row's click is dispatched. See
  // {@link preservesMenuFocus} for the failure this prevents.
  const onMenuMouseDown = (event: MouseEvent): void => {
    if (!(event.target instanceof Element)) return
    const menu = event.target.closest('[role="menu"]')
    if (menu === null) return
    const row = event.target.closest(MENU_ITEM_SELECTOR)
    if (!preservesMenuFocus(menu, row, document.activeElement)) return
    event.preventDefault()
  }
  document.addEventListener('pointerdown', onMenuMouseDown, true)
  // Mute the soft keyboard the model pane's autofocused search field would
  // raise, without letting go of the focus that keeps the overlay mounted.
  // Tapping the field on purpose restores normal input so search still works.
  let lastSearchPointerTarget: Element | undefined
  const onSearchPointerDown = (event: PointerEvent): void => {
    lastSearchPointerTarget = event.target instanceof Element ? event.target : undefined
  }
  const onMenuSearchFocusIn = (event: FocusEvent): void => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    if (!isMenuSearchFocus(target)) return
    // Only a phone raises a soft keyboard. On a desktop browser reaching this
    // page over the LAN, the field must be left exactly as it is — the same
    // touch-mode gate the composer guard above uses. Opening the menu is always
    // a touch here, so the phone path is unaffected.
    if (document.documentElement.dataset.dshOnPhoneInput !== 'touch') return
    const tapped = lastSearchPointerTarget !== undefined
      && (target === lastSearchPointerTarget || target.contains(lastSearchPointerTarget))
    lastSearchPointerTarget = undefined
    if (tapped) {
      if (target.inputMode === 'none') target.inputMode = ''
      return
    }
    target.inputMode = 'none'
  }
  document.addEventListener('pointerdown', onSearchPointerDown, true)
  document.addEventListener('focusin', onMenuSearchFocusIn, true)
  const backdrop = document.createElement('button')
  backdrop.type = 'button'
  backdrop.className = 'dsh-native-mobile-backdrop'
  backdrop.hidden = true
  backdrop.setAttribute('aria-label', '关闭工作区导航')
  document.body.append(backdrop)
  // The backdrop is a viewport-covering dim behind the left drawer. React
  // re-renders the shell on every tap, and for a frame the sidebar can report a
  // class list without _collapsed — enough to flash the whole screen dark when a
  // file is tapped in the right panel. Only flip the backdrop once the reported
  // state has survived a settle window.
  const setBackdropOpen = (open: boolean): void => {
    if (open === backdropOpen) {
      if (backdropTimer !== 0) {
        window.clearTimeout(backdropTimer)
        backdropTimer = 0
      }
      return
    }
    if (backdropTimer !== 0) window.clearTimeout(backdropTimer)
    backdropTimer = window.setTimeout(() => {
      backdropTimer = 0
      backdropOpen = open
      backdrop.hidden = !open
    }, BACKDROP_SETTLE_MS)
  }
  const branchToast = document.createElement('div')
  branchToast.className = 'dsh-on-phone-branch-toast'
  branchToast.setAttribute('role', 'status')
  branchToast.setAttribute('aria-live', 'polite')
  document.body.append(branchToast)
  let branchToastTimer = 0
  const showBranchToast = (): void => {
    const header = document.querySelector<HTMLElement>('[data-dsh-on-phone-header]')
    const title = header === null ? undefined : header.querySelector<HTMLElement>('[class*="_crumbCurrent"]')?.textContent?.trim()
    branchToast.textContent = title === undefined ? '当前分支' : `当前分支：${title}`
    branchToast.dataset.visible = 'true'
    if (branchToastTimer !== 0) window.clearTimeout(branchToastTimer)
    branchToastTimer = window.setTimeout(() => {
      branchToast.removeAttribute('data-visible')
      branchToastTimer = 0
    }, 1600)
  }
  const onBranchClick = (event: MouseEvent): void => {
    if (!(event.target instanceof Element)) return
    const branch = event.target.closest<HTMLButtonElement>('button[aria-label*="分支"],button[aria-label*="Branch"],button[aria-label*="branch"]')
    if (branch === null || branch.hasAttribute('disabled') || branch.getAttribute('aria-disabled') === 'true') return
    window.setTimeout(showBranchToast, 80)
  }
  document.addEventListener('click', onBranchClick, true)
  // In portrait, selecting a session from the sidebar should collapse the
  // sidebar automatically: it would otherwise cover most of the screen while
  // the user reads the opened conversation.
  const onSidebarSessionSelect = (event: MouseEvent): void => {
    if (!(event.target instanceof Element)) return
    if (window.innerHeight <= window.innerWidth) return
    const tree = event.target.closest<HTMLElement>('[data-dsh-on-phone-sidebar] [role="treeitem"]')
    if (tree === null) return
    if (!selectsSidebarRow(event.target, tree)) return
    const sidebarEl = tree.closest<HTMLElement>('[data-dsh-on-phone-sidebar]')
    if (sidebarEl === null || sidebarEl.getAttribute('data-open') !== 'true') return
    const sidebarToggle = document.querySelector<HTMLButtonElement>('[data-dsh-on-phone-toggle]')
    if (sidebarToggle === null) return
    window.setTimeout(() => {
      if (sidebarToggle.isConnected && sidebarToggle.getAttribute('aria-expanded') !== 'false') sidebarToggle.click()
    }, 240)
  }
  document.addEventListener('click', onSidebarSessionSelect, true)
  let frame: HTMLElement | undefined
  let sidebar: HTMLElement | undefined
  let sidebarRoot: HTMLElement | undefined
  let toggle: HTMLButtonElement | undefined
  let viewArea: HTMLElement | undefined
  let workbenchPanel: HTMLElement | undefined
  let scheduled = 0
  let lastSyncAt = 0
  let backdropTimer = 0
  let backdropOpen = false
  let transitionFrame = 0
  let transitionRestartFrame = 0
  let transitionTimer = 0
  let transitionTarget: HTMLElement | undefined
  let historyScroller: HTMLElement | undefined
  let historyPreviousTop = 0
  let historyFillAt = 0
  let historyFillHeight = -1
  let historyFillStalls = 0
  let historyFillPages = 0
  let historyLoadAt = 0
  let historyGestureLoads = 0
  const historyLoadButton = (): HTMLButtonElement | undefined => {
    const loader = historyScroller === undefined ? undefined : firstByClassSuffix(historyScroller, '_older')
    return loader?.querySelector<HTMLButtonElement>('button') ?? undefined
  }
  /**
   * Click the app's `load earlier` button when it is usable, and remember when.
   *
   * The gesture retry and the fill share the timestamp, so a finger and the
   * fill can never ask for the same page twice.
   * @returns Whether the click was delivered.
   */
  const clickEarlierHistory = (): boolean => {
    const button = historyLoadButton()
    if (button === undefined || button.disabled || button.getAttribute('aria-disabled') === 'true') return false
    historyLoadAt = Date.now()
    button.click()
    return true
  }
  const onHistoryScroll = (): void => {
    if (historyScroller === undefined) return
    const currentTop = Math.max(0, historyScroller.scrollTop)
    // A scroll event at the top means the transcript is pinned there; iOS will
    // not send another one until it moves again, so the retry has to run here
    // too, not only on a finger.
    const shouldLoad = shouldAutoLoadEarlier(historyPreviousTop, currentTop)
      || shouldRetryEarlierHistory(currentTop, Date.now() - historyLoadAt, historyGestureLoads)
    historyPreviousTop = currentTop
    // A fresh gesture deserves fresh fill attempts: the transcript may have
    // become scrollable while the fill had already given up.
    historyFillStalls = 0
    historyFillPages = 0
    if (shouldLoad) clickEarlierHistory()
  }
  /**
   * Record one gesture-driven history load.
   *
   * The complaint this answers - a swipe up that loads nothing - only happens on
   * the phone, so the attempt and the transcript's state at that moment have to
   * be visible from here. Debug aid, removed with the other channels.
   * @param top - Transcript scroll offset when the load was asked for.
   */
  const reportHistoryGesture = (top: number): void => {
    if (typeof fetch !== 'function' || historyScroller === undefined) return
    const body = JSON.stringify({
      kind: 'history-gesture',
      at: new Date().toISOString(),
      top: Math.round(top),
      range: Math.round(historyScroller.scrollHeight - historyScroller.clientHeight),
      viewport: Math.round(historyScroller.clientHeight),
      loads: historyGestureLoads,
      stalls: historyFillStalls,
      fills: historyFillPages,
    })
    void fetch(TELEMETRY_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => undefined)
  }
  /** A new touch starts a new budget: the fill's give-up counters are per gesture. */
  const onHistoryGestureStart = (): void => {
    historyGestureLoads = 0
    historyFillStalls = 0
    historyFillPages = 0
  }
  /**
   * Treat a finger on the transcript as a request for older history.
   *
   * Once the transcript is pinned at the top the app sends no further scroll
   * events, and a transcript shorter than the viewport never sends one at all:
   * in both cases swiping up used to do nothing.
   */
  const onHistoryGesture = (): void => {
    if (historyScroller === undefined) return
    const currentTop = Math.max(0, historyScroller.scrollTop)
    if (historyScroller.scrollHeight - historyScroller.clientHeight <= AUTO_HISTORY_THRESHOLD_PX) {
      // Nothing can scroll, so the fill owns this case; resetting its stall
      // counter is what the scroll event it never got would have done.
      historyFillStalls = 0
      fillEarlierHistory()
      return
    }
    if (!shouldRetryEarlierHistory(currentTop, Date.now() - historyLoadAt, historyGestureLoads)) return
    if (!clickEarlierHistory()) return
    historyGestureLoads += 1
    reportHistoryGesture(currentTop)
  }
  /**
   * Pull one page of older history while the transcript is too short to scroll.
   *
   * See {@link shouldFillEarlierHistory} for why this exists next to the scroll
   * trigger: a compact flow can fit inside the viewport, and the app's own
   * button cannot be reached by scrolling in that case.
   */
  const fillEarlierHistory = (): void => {
    if (historyScroller === undefined) return
    const button = historyLoadButton()
    if (button === undefined) return
    const range = historyScroller.scrollHeight - historyScroller.clientHeight
    const atTop = Math.max(0, historyScroller.scrollTop) <= AUTO_HISTORY_THRESHOLD_PX
    const available = !button.disabled && button.getAttribute('aria-disabled') !== 'true'
    if (!shouldFillEarlierHistory(range > AUTO_HISTORY_THRESHOLD_PX, atTop, available, Date.now() - historyFillAt, historyFillStalls, historyFillPages)) return
    const height = historyScroller.scrollHeight
    historyFillStalls = historyFillHeight === height ? historyFillStalls + 1 : 0
    historyFillHeight = height
    historyFillAt = Date.now()
    historyFillPages += 1
    clickEarlierHistory()
  }
  const bindHistoryScroller = (next: HTMLElement | undefined): void => {
    if (historyScroller === next) return
    historyScroller?.removeEventListener('scroll', onHistoryScroll)
    historyScroller?.removeEventListener('touchstart', onHistoryGestureStart, HISTORY_TOUCH_OPTIONS)
    historyScroller?.removeEventListener('touchmove', onHistoryGesture, HISTORY_TOUCH_OPTIONS)
    historyScroller?.removeEventListener('pointerdown', onHistoryGestureStart, HISTORY_TOUCH_OPTIONS)
    historyScroller?.removeEventListener('pointermove', onHistoryGesture, HISTORY_TOUCH_OPTIONS)
    historyScroller = next
    historyPreviousTop = next?.scrollTop ?? 0
    historyGestureLoads = 0
    historyScroller?.addEventListener('scroll', onHistoryScroll, { passive: true })
    historyScroller?.addEventListener('touchstart', onHistoryGestureStart, HISTORY_TOUCH_OPTIONS)
    historyScroller?.addEventListener('touchmove', onHistoryGesture, HISTORY_TOUCH_OPTIONS)
    historyScroller?.addEventListener('pointerdown', onHistoryGestureStart, HISTORY_TOUCH_OPTIONS)
    historyScroller?.addEventListener('pointermove', onHistoryGesture, HISTORY_TOUCH_OPTIONS)
  }
  const animateNavigation = (event: MouseEvent): void => {
    if (!(event.target instanceof Element)) return
    const trigger = event.target.closest<HTMLElement>('button,a,[role="tab"],[aria-selected]')
    if (trigger === null || trigger.hasAttribute('disabled') || trigger.getAttribute('aria-disabled') === 'true') return
    if (trigger.getAttribute('aria-selected') === 'true' || trigger.getAttribute('aria-current') === 'true') return
    const settingsNavigation = trigger.closest('[data-dsh-on-phone-settings-list]') !== null
    const conversationNavigation = trigger.matches('[role="tab"]')
    const sidebarNavigation = trigger.closest('[data-dsh-on-phone-sidebar-root]') !== null
      && trigger.closest('[data-dsh-on-phone-toggle]') === null
    if (!settingsNavigation && !conversationNavigation && !sidebarNavigation) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    if (transitionFrame !== 0) cancelAnimationFrame(transitionFrame)
    if (transitionRestartFrame !== 0) cancelAnimationFrame(transitionRestartFrame)
    transitionFrame = requestAnimationFrame(() => {
      transitionFrame = 0
      const target = settingsNavigation
        ? document.querySelector<HTMLElement>('[data-dsh-on-phone-settings-content]')
        : viewArea
      if (target === null || target === undefined) return
      transitionTarget?.removeAttribute('data-dsh-on-phone-view-transition')
      target.removeAttribute('data-dsh-on-phone-view-transition')
      transitionRestartFrame = requestAnimationFrame(() => {
        transitionRestartFrame = 0
        transitionTarget = target
        target.dataset.dshOnPhoneViewTransition = 'true'
        if (transitionTimer !== 0) clearTimeout(transitionTimer)
        transitionTimer = window.setTimeout(() => {
          target.removeAttribute('data-dsh-on-phone-view-transition')
          if (transitionTarget === target) transitionTarget = undefined
          transitionTimer = 0
        }, 240)
      })
    })
  }
  document.addEventListener('click', animateNavigation)

  const sync = (): void => {
    scheduled = 0
    lastSyncAt = Date.now()
    const dedicatedCenter = document.querySelector<HTMLElement>('.dshm-main') ?? undefined
    // Only the stock layout module ships `_frame` *and* `_centerCol`. Other DSH
    // modules (chat TurnNavigator, attachment, plan-review, subagent) also ship
    // `*_frame` classes, and inside the dedicated shell the conversation hosts
    // one of them first — so a bare class probe picks that node, `_centerCol` is
    // nowhere below it, and `center` falls into the `center === undefined` return
    // that silently skips every DOM adaptation below (history paging included).
    const stockFrame = dedicatedCenter === undefined ? firstByClassSuffix(document, '_frame') : undefined
    frame = stockFrame !== undefined && firstByClassSuffix(stockFrame, '_centerCol') !== undefined
      ? stockFrame
      : undefined
    if (frame !== undefined) frame.dataset.dshOnPhoneFrame = 'true'
    sidebar = frame === undefined
      ? document.querySelector<HTMLElement>('.dshm-drawer') ?? undefined
      : firstByClassSuffix(frame, '_sidebarCol')
    const center = frame === undefined ? dedicatedCenter : firstByClassSuffix(frame, '_centerCol')
    // The right column is re-containered as a mobile sheet only for the legacy
    // `_detailsCol` generation; see findDetailsSheetHost for why 0.1.7's
    // `_rightbarCol` must never be treated as a sheet.
    const details = findDetailsSheetHost(frame)
    const handle = frame === undefined ? undefined : firstByClassSuffix(frame, '_handle')
    // Tag the right-column panel host (Files explorer / terminal / preview) so
    // the mobile CSS can turn it into a right-side drawer in portrait. 0.1.7
    // anchors this on the sidebar-right dockkit root rather than a `*_workbench`
    // token, and that root publishes the open state the drawer has to follow.
    workbenchPanel = findRightPanelHost(document)
    if (workbenchPanel !== undefined) {
      workbenchPanel.dataset.dshOnPhoneWorkbench = 'true'
      workbenchPanel.dataset.dshOnPhoneWorkbenchOpen = String(rightPanelOpen(workbenchPanel))
      // The drawer's own paint is visible for the length of the open/close
      // transition, before the pane inside it has painted (or after it is torn
      // down). Mirror the pane's real surface so the frames match; the CSS
      // token chain covers the first pass, before a pane exists. Written only on
      // change: this element is observed, so an unconditional write would keep
      // scheduling this pass.
      let drawerBackground: string | undefined
      const panes = workbenchPanel.querySelectorAll('[data-dockkit-pane],[data-dockkit-content]')
      for (const pane of Array.from(panes).slice(0, 4)) {
        drawerBackground = drawerBackgroundColor(pane)
        if (drawerBackground !== undefined) break
      }
      if (drawerBackground !== undefined && workbenchPanel.style.getPropertyValue('--dsh-on-phone-drawer-bg') !== drawerBackground) {
        workbenchPanel.style.setProperty('--dsh-on-phone-drawer-bg', drawerBackground)
      }
      // The toggle cluster and the panel share one stacking context in the
      // panel host, so floating the cluster by z-index is enough — no DOM move,
      // which would detach it from the app's synthetic click handler.
    }
    if (center === undefined) {
      bindHistoryScroller(undefined)
      return
    }
    if (center !== undefined) {
      center.dataset.dshOnPhoneCenter = 'true'
      center.querySelector<HTMLElement>('header')?.setAttribute('data-dsh-on-phone-header', 'true')
      viewArea = firstByClassSuffix(center, '_viewArea')
      if (viewArea !== undefined) viewArea.dataset.dshOnPhoneView = 'true'
      const conversation = center.querySelector<HTMLElement>('[data-conversation-scroll]')
      bindHistoryScroller(conversation ?? undefined)
      const historyLoader = conversation === null ? undefined : firstByClassSuffix(conversation, '_older')
      if (historyLoader !== undefined) {
        historyLoader.dataset.dshOnPhoneHistoryLoader = 'true'
        historyLoader.setAttribute('aria-live', 'polite')
        // The button stays a real, tappable control: it is the only way into the
        // older turns when the compact transcript fits the viewport, and a
        // hidden (1px, pointer-events:none) button left nothing to tap.
      }
      fillEarlierHistory()
      const messageColumn = conversation === null ? undefined : firstByClassSuffix(conversation, '_column')
      const messageScroll = messageColumn?.parentElement
      if (messageColumn !== undefined && messageScroll !== null && messageScroll !== undefined && classToken(messageScroll, '_scroll')) {
        messageColumn.dataset.dshOnPhoneMessageColumn = 'true'
        messageScroll.dataset.dshOnPhoneMessageScroll = 'true'
      }
      for (const table of center.querySelectorAll<HTMLTableElement>('table')) {
        const parent = table.parentElement
        if (parent?.dataset.dshOnPhoneTableScroll === 'true') continue
        const wrapper = document.createElement('div')
        wrapper.dataset.dshOnPhoneTableScroll = 'true'
        table.before(wrapper)
        wrapper.append(table)
      }
      const composerCard = center.querySelector<HTMLElement>('[data-composer-card]')
      const composerRow = composerCard?.querySelector<HTMLElement>(':scope > [data-input-scroll]')?.nextElementSibling
      if (composerRow instanceof HTMLElement) {
        composerRow.dataset.dshOnPhoneComposerRow = 'true'
        const groups = Array.from(composerRow.children).filter((child): child is HTMLElement => child instanceof HTMLElement)
        const composerTools = groups[0]
        const composerTrailing = groups.at(-1)
        if (composerTools !== undefined) composerTools.dataset.dshOnPhoneComposerTools = 'true'
        if (composerTrailing !== undefined && composerTrailing !== composerTools) {
          composerTrailing.dataset.dshOnPhoneComposerTrailing = 'true'
          const modelTrigger = composerTrailing.querySelector<HTMLButtonElement>('button[aria-label^="选择模型"],button[aria-label^="Select model"]')
          if (modelTrigger !== null) {
            modelTrigger.dataset.dshOnPhoneComposerModelTrigger = 'true'
            modelTrigger.parentElement?.setAttribute('data-dsh-on-phone-composer-model', 'true')
            modelTrigger.querySelector<HTMLElement>('[class*="_triggerLabel"]')?.setAttribute('data-dsh-on-phone-composer-model-label', 'true')
          }
        }
      }
    }
    if (handle !== undefined) handle.dataset.dshOnPhoneHandle = 'true'
    if (details !== undefined) {
      details.dataset.dshOnPhoneDetails = 'true'
      details.dataset.open = String(rightColumnOpen(frame))
    }
    const settings = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).find(dialog => {
      const directNav = Array.from(dialog.children).find(child => child instanceof HTMLElement && classToken(child, '_nav'))
      return directNav !== undefined
    })
    if (settings !== undefined) {
      settings.dataset.dshOnPhoneSettings = 'true'
      const nav = Array.from(settings.children).find(child => child instanceof HTMLElement && classToken(child, '_nav')) as HTMLElement | undefined
      const content = Array.from(settings.children).find(child => child instanceof HTMLElement && classToken(child, '_content')) as HTMLElement | undefined
      if (nav !== undefined) {
        nav.dataset.dshOnPhoneSettingsNav = 'true'
        firstByClassSuffix(nav, '_navList')?.setAttribute('data-dsh-on-phone-settings-list', 'true')
      }
      if (content !== undefined) {
        content.dataset.dshOnPhoneSettingsContent = 'true'
        firstByClassSuffix(content, '_header')?.setAttribute('data-dsh-on-phone-settings-header', 'true')
        firstByClassSuffix(content, '_options')?.setAttribute('data-dsh-on-phone-settings-options', 'true')
      }
    }
    if (sidebar === undefined) return
    sidebar.dataset.dshOnPhoneSidebar = 'true'
    toggle = firstByClassSuffix(sidebar, '_toggle') as HTMLButtonElement | undefined
    let candidate = toggle?.parentElement
    while (candidate !== undefined && candidate !== null && candidate !== sidebar && !classToken(candidate, '_root')) candidate = candidate.parentElement
    sidebarRoot = candidate !== sidebar && candidate !== null ? candidate : undefined
    if (sidebarRoot === undefined) return
    sidebarRoot.dataset.dshOnPhoneSidebarRoot = 'true'
    for (const brand of sidebarRoot.querySelectorAll<HTMLElement>('[class*="_fallbackBrandName"]')) {
      if (brand.textContent?.trim() === 'DSH Local Build') brand.textContent = 'DeepSeek Harness'
    }
    if (toggle !== undefined) toggle.dataset.dshOnPhoneToggle = 'true'
    const collapsed = classToken(sidebarRoot, '_collapsed')
    sidebar.dataset.open = String(!collapsed)
    setBackdropOpen(!collapsed)
  }
  // A pass walks the whole document, so mutations are coalesced: the app
  // rewrites class/style continuously while a turn streams, and running the pass
  // once per animation frame kept the phone's main thread busy for the whole
  // stream. A mutation on one of the nodes whose state this layer republishes is
  // urgent — the drawer has to follow it immediately — while everything else
  // waits out the minimum interval.
  const isStateRecord = (record: MutationRecord): boolean =>
    record.attributeName !== null
    && (record.target === workbenchPanel
      || record.target === sidebar
      || record.target === sidebarRoot
      || record.target === backdrop)
  const schedule = (urgent: boolean): void => {
    if (scheduled !== 0) {
      if (!urgent) return
      window.clearTimeout(scheduled)
      scheduled = 0
    }
    const delay = urgent ? 0 : nextSyncDelay(Date.now(), lastSyncAt)
    scheduled = window.setTimeout(() => {
      scheduled = 0
      sync()
    }, delay)
  }
  const observer = new MutationObserver(records => { schedule(records.some(isStateRecord)) })
  // The right column and its panel express open/closed as attributes rather
  // than classes on this generation, so those attributes have to be observed or
  // the drawer would only pick up its state on the next unrelated mutation.
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      'class',
      'style',
      'disabled',
      'hidden',
      'data-rightbar-collapsed',
      'data-sidebar-right-open',
      'data-sidebar-right-unavailable',
      'aria-hidden',
    ],
  })
  backdrop.addEventListener('click', () => { if (sidebar?.dataset.open === 'true') toggle?.click() })
  // The terminal drops the space and punctuation keys a soft keyboard reports as
  // a bare legacy IME keydown; the repair writes them into xterm's textarea. See
  // {@link installTerminalKeyRepair}.
  const removeTerminalKeyRepair = installTerminalKeyRepair()
  // iOS sometimes never lets the drag reach the drawer's scroller; see
  // {@link installDrawerPan}.
  const removeDrawerPan = installDrawerPan()
  // The strip is the host's pane-drag handle and the open files most often fit,
  // so a sideways swipe there has nothing to pan; see {@link installStripSwipe}.
  const removeStripSwipe = installStripSwipe()
  // Debug channel: the tab swipe cannot be reproduced off-device, so real drags
  // in the drawer are recorded and posted to the remote proxy. See
  // {@link installGestureTelemetry}; remove once the gesture is understood.
  const removeGestureTelemetry = installGestureTelemetry()
  // The server can only time how long the local app took to answer a history
  // page; the phone times the transfer and the paint from its own resource
  // timeline. See {@link installPageTiming}.
  const removePageTiming = installPageTiming()
  // The page POST has no timeout anywhere in the stack, so a page read that dies
  // on a half-open socket never resolves; the call is an idempotent read, so a
  // stalled attempt is replayed. This does not cover a first frame that never
  // arrives: measured on the live app, 「载入历史…」 is the `session/follow`
  // opening frame, which no page request can fix. See
  // {@link installPageFetchGuard} and the client half's session-open guard.
  const removePageFetchGuard = installPageFetchGuard()
  sync()
  return () => {
    observer.disconnect()
    removeTerminalKeyRepair()
    removeDrawerPan()
    removeStripSwipe()
    removeGestureTelemetry()
    removePageTiming()
    removePageFetchGuard()
    document.removeEventListener('click', onBranchClick, true)
    document.removeEventListener('click', onSidebarSessionSelect, true)
    document.removeEventListener('pointerdown', onPointerDownForFocus, true)
    document.removeEventListener('focusin', onFocusIn, true)
    document.removeEventListener('mousedown', onMenuMouseDown, true)
    document.removeEventListener('pointerdown', onSearchPointerDown, true)
    document.removeEventListener('focusin', onMenuSearchFocusIn, true)
    if (branchToastTimer !== 0) window.clearTimeout(branchToastTimer)
    branchToast.remove()
    if (scheduled !== 0) clearTimeout(scheduled)
    if (backdropTimer !== 0) clearTimeout(backdropTimer)
    if (transitionFrame !== 0) cancelAnimationFrame(transitionFrame)
    if (transitionRestartFrame !== 0) cancelAnimationFrame(transitionRestartFrame)
    if (transitionTimer !== 0) clearTimeout(transitionTimer)
    transitionTarget?.removeAttribute('data-dsh-on-phone-view-transition')
    historyScroller?.removeEventListener('scroll', onHistoryScroll)
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('keydown', onKeyDown, true)
    document.removeEventListener('click', animateNavigation)
    backdrop.remove()
    document.documentElement.classList.remove('dsh-native-mobile-active')
    delete document.documentElement.dataset.dshOnPhoneInput
  }
}
