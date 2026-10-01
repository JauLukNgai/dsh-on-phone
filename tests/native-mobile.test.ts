import { describe, expect, it } from 'vitest'
import { BACKDROP_SETTLE_MS, HISTORY_FILL_INTERVAL_MS, HISTORY_FILL_MAX_PAGES, HISTORY_FILL_MAX_STALLS, HISTORY_TOP_RETRY_MS, NATIVE_MOBILE_STYLES, drawerBackgroundColor, findDetailsSheetHost, findRightPanelHost, isComposerEditorFocus, isMenuSearchFocus, nextSyncDelay, preservesMenuFocus, rightColumnOpen, rightPanelOpen, selectsSidebarRow, shouldAutoLoadEarlier, shouldFillEarlierHistory, shouldRetryEarlierHistory } from '../src/native-mobile.js'

/** Minimal stand-in for an element whose `closest` resolves to a fixed match. */
function fakeElement(closest: Element | null): Element {
  return { closest: () => closest } as unknown as Element
}

/**
 * Stand-in for the stock layout frame.
 *
 * `rightbarMarker` stands for the `[data-rightbar-col]` child that identifies
 * the 0.1.7 generation; `rightbarCollapsed` is the frame-level collapse flag;
 * `columns` are the `[class]`-carrying right-column tracks below the frame.
 */
function fakeFrame(options: { grid: string; rightbarCollapsed?: boolean; rightbarMarker?: boolean; columns?: HTMLElement[] }): HTMLElement {
  return {
    hasAttribute: (name: string) => name === 'data-rightbar-collapsed' && options.rightbarCollapsed === true,
    querySelector: (selector: string) => (selector === '[data-rightbar-col]' && options.rightbarMarker === true ? ({} as Element) : null),
    querySelectorAll: (selector: string) => (selector === '[class]' ? options.columns ?? [] : []),
    style: { gridTemplateColumns: options.grid },
  } as unknown as HTMLElement
}

/** Stand-in for the right-column panel host. */
function fakeElementHost(
  kind: 'panel',
  state: {
    hidden?: boolean
    unavailable?: boolean
    /** The 0.1.7 sidebar-right root marker. */
    panelMarker?: boolean
    /** The 0.1.7 expansion marker (`data-sidebar-right-open`). */
    open?: boolean
    ariaHidden?: boolean
    /** Whether an ancestor (a background session wrapper) hides this panel. */
    hiddenAncestor?: boolean
  } = {},
): HTMLElement {
  const attributes = new Set<string>()
  if (state.hidden === true) attributes.add('hidden')
  if (state.unavailable === true) attributes.add('data-sidebar-right-unavailable')
  if (state.panelMarker === true) attributes.add('data-sidebar-right-panel')
  if (state.open === true) attributes.add('data-sidebar-right-open')
  if (state.ariaHidden === true) attributes.add('aria-hidden')
  return {
    kind,
    hasAttribute: (name: string) => attributes.has(name),
    closest: (selector: string) => (state.hiddenAncestor === true && selector === '[hidden]' ? ({} as unknown as Element) : null),
    classList: { contains: () => false },
    dataset: {},
  } as unknown as HTMLElement
}

/** Stand-in for an element whose only interesting feature is its class list. */
function fakeClassElement(classes: string[]): HTMLElement {
  return {
    classList: Object.assign(classes.slice(), { contains: (value: string) => classes.includes(value) }),
    hasAttribute: () => false,
    dataset: {},
  } as unknown as HTMLElement
}

/** Stand-in for a search root that answers `querySelector`/`querySelectorAll`. */
function fakeRoot(
  matches: Record<string, HTMLElement>,
  legacy: HTMLElement[] = [],
  panels: HTMLElement[] = [],
): ParentNode {
  return {
    querySelector: (selector: string) => matches[selector] ?? null,
    querySelectorAll: (selector: string) => {
      if (selector === '[class]') return legacy
      if (selector === '[data-sidebar-right-panel]') return panels
      return []
    },
  } as unknown as ParentNode
}

/** Stand-in for a sidebar row; `aria-expanded` is the only state the guard reads. */
function fakeRow(ariaExpanded: string | null): Element {
  return {
    getAttribute: (name: string) => (name === 'aria-expanded' ? ariaExpanded : null),
  } as unknown as Element
}

/** Stand-in for a focus target with fixed `matches` and configurable containment. */
function fakeFocusTarget(matches: boolean, inComposer: boolean, inMenu = false): Element {
  return {
    matches: () => matches,
    closest: (selector: string) => {
      const inside = selector.includes('menu') ? inMenu : inComposer
      return inside ? ({} as unknown as Element) : null
    },
  } as unknown as Element
}

describe('native mobile presentation', () => {
  it('keeps touch focus quiet without removing keyboard focus globally', () => {
    expect(NATIVE_MOBILE_STYLES).toContain('-webkit-tap-highlight-color:transparent')
    expect(NATIVE_MOBILE_STYLES).toContain('data-dsh-on-phone-input="touch"')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-on-phone-sidebar] [role="treeitem"] { -webkit-tap-highlight-color:transparent; touch-action:manipulation; }')
    expect(NATIVE_MOBILE_STYLES).toContain('[role="tooltip"] { display:none !important; }')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-on-phone-sidebar] { --dsw-alias-interactive-bg-hover:transparent !important; }')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-on-phone-sidebar] [role="treeitem"]:is(:hover,:active,:focus,[aria-selected="true"])')
    expect(NATIVE_MOBILE_STYLES).toContain('[class*="_sessionRow"][class*="_selected"],')
    expect(NATIVE_MOBILE_STYLES).toContain('padding-top:max(4px,env(safe-area-inset-top)) !important')
    expect(NATIVE_MOBILE_STYLES).toContain('inset:max(env(safe-area-inset-top),0px) auto 0 0 !important; height:auto !important')
    expect(NATIVE_MOBILE_STYLES).toContain('width:min(88vw,340px) !important; padding-top:0 !important')
    expect(NATIVE_MOBILE_STYLES).toContain('[class*="_logoRow"] { height:52px !important; padding:4px 0 4px 4px !important; margin-bottom:4px !important; }')
    expect(NATIVE_MOBILE_STYLES).toContain('inset:env(safe-area-inset-top) 0 0; border:0; background:rgb(15 23 42 / 32%)')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-on-phone-center] [data-composer-card] ~ [class*="_dock"] { box-sizing:border-box !important; display:grid !important; grid-template-columns:minmax(0,1fr) auto !important')
    expect(NATIVE_MOBILE_STYLES).toContain('grid-column:1 / -1 !important; order:3 !important; width:100% !important; min-width:0 !important')
    expect(NATIVE_MOBILE_STYLES).toContain('box-sizing:border-box !important; width:50px !important; height:52px !important; padding:4px !important')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-on-phone-sidebar][data-open="false"] [data-dsh-on-phone-toggle] > svg[class*="_railFish"] { transform:translateY(-4px) !important; }')
    expect(NATIVE_MOBILE_STYLES).toContain('min-height:32px !important; height:32px !important')
    expect(NATIVE_MOBILE_STYLES).toContain('min-height:28px !important; height:28px !important; margin-top:0 !important')
    expect(NATIVE_MOBILE_STYLES).toContain('[class*="_tab"] { padding-bottom:5px !important; }')
    expect(NATIVE_MOBILE_STYLES).toContain('width:max-content !important; max-width:calc(100% - 58px) !important')
    expect(NATIVE_MOBILE_STYLES).toContain('width:calc(100% - 16px) !important; margin:0 8px !important')
    expect(NATIVE_MOBILE_STYLES).not.toContain(':is([data-dsh-on-phone-header], header)')
    expect(NATIVE_MOBILE_STYLES).not.toContain('[data-dsh-on-phone-toggle] svg { display:none !important; }')
    expect(NATIVE_MOBILE_STYLES).not.toContain('[data-dsh-on-phone-toggle]::after')
    expect(NATIVE_MOBILE_STYLES).not.toContain('html.dsh-native-mobile-active :focus { outline:none')
  })

  it('stacks narrow settings and conversation metadata instead of squeezing text', () => {
    expect(NATIVE_MOBILE_STYLES).toContain('data-slot="settings.general.item"')
    expect(NATIVE_MOBILE_STYLES).toContain('flex-direction:column !important')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-disclosure-row]')
    expect(NATIVE_MOBILE_STYLES).toContain('gap:10px !important')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-on-phone-message-scroll] { box-sizing:border-box !important; width:100% !important')
    expect(NATIVE_MOBILE_STYLES).toContain('min-height:40px !important')
    expect(NATIVE_MOBILE_STYLES).toContain('line-height:19px !important')
    expect(NATIVE_MOBILE_STYLES).toContain('grid-template-columns:16px minmax(0,1fr)')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-context-fields]')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-composer-card] ~ * [class*="_root"]')
    expect(NATIVE_MOBILE_STYLES).toContain('white-space:normal !important; overflow:visible !important')
    expect(NATIVE_MOBILE_STYLES).toContain('margin-bottom:-6px !important')
    expect(NATIVE_MOBILE_STYLES).not.toContain('dsh-native-mobile-attach')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-on-phone-composer-row] { display:grid !important; grid-template-columns:max-content minmax(0,1fr) !important')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-on-phone-composer-trailing] { display:flex !important; flex-wrap:nowrap !important; width:100% !important')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-on-phone-composer-model] { flex:1 1 0 !important')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-on-phone-composer-model-label] { flex:1 1 auto !important; max-width:none !important')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-on-phone-history-loader] button:not(:disabled)')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-on-phone-history-loader] button:disabled')
    expect(NATIVE_MOBILE_STYLES).toContain('pointer-events:auto !important')
    expect(NATIVE_MOBILE_STYLES).not.toContain('clip-path:inset(50%)')
    expect(NATIVE_MOBILE_STYLES).toContain('[class*="_rowHead"]:has(> [class*="_rowIdentity"]) { flex-wrap:nowrap !important')
    expect(NATIVE_MOBILE_STYLES).toContain('[class*="_rowActions"] { flex:0 0 auto !important; flex-wrap:nowrap !important')
    expect(NATIVE_MOBILE_STYLES).toContain('[class*="_rowActions"] button { flex:none !important; width:auto !important; min-width:44px !important')
    expect(NATIVE_MOBILE_STYLES).toContain('white-space:nowrap !important; word-break:keep-all !important; writing-mode:horizontal-tb !important')
  })

  it('loads older history only after an upward scroll reaches the top zone', () => {
    expect(shouldAutoLoadEarlier(180, 64)).toBe(true)
    expect(shouldAutoLoadEarlier(65, 64)).toBe(true)
    expect(shouldAutoLoadEarlier(64, 64)).toBe(false)
    expect(shouldAutoLoadEarlier(40, 48)).toBe(false)
    expect(shouldAutoLoadEarlier(180, 80)).toBe(false)
  })

  it('fills earlier history while a compact transcript cannot scroll at all', () => {
    // A transcript that fits the viewport is the case the scroll trigger can
    // never reach, so the fill is the only way back into older turns.
    expect(shouldFillEarlierHistory(false, true, true, HISTORY_FILL_INTERVAL_MS, 0, 0)).toBe(true)
    // Once the loaded pages make it scrollable the fill hands over to the scroll.
    expect(shouldFillEarlierHistory(true, true, true, HISTORY_FILL_INTERVAL_MS, 0, 0)).toBe(false)
    // Never while the user is reading further down, without a button, or too soon.
    expect(shouldFillEarlierHistory(false, false, true, HISTORY_FILL_INTERVAL_MS, 0, 0)).toBe(false)
    expect(shouldFillEarlierHistory(false, true, false, HISTORY_FILL_INTERVAL_MS, 0, 0)).toBe(false)
    expect(shouldFillEarlierHistory(false, true, true, HISTORY_FILL_INTERVAL_MS - 1, 0, 0)).toBe(false)
    // An app that stops growing the transcript is not hammered for ever.
    expect(shouldFillEarlierHistory(false, true, true, HISTORY_FILL_INTERVAL_MS, HISTORY_FILL_MAX_STALLS, 0)).toBe(false)
    // Nor is a transcript that keeps growing but never becomes scrollable.
    expect(shouldFillEarlierHistory(false, true, true, HISTORY_FILL_INTERVAL_MS, 0, HISTORY_FILL_MAX_PAGES)).toBe(false)
  })

  it('retries a history load from the gesture once the transcript is pinned at the top', () => {
    // A finger at the top is the signal iOS withholds from the scroll trigger.
    expect(shouldRetryEarlierHistory(0, HISTORY_TOP_RETRY_MS, 0)).toBe(true)
    expect(shouldRetryEarlierHistory(64, HISTORY_TOP_RETRY_MS, 0)).toBe(true)
    // Never twice inside the retry gap, never away from the top.
    expect(shouldRetryEarlierHistory(0, HISTORY_TOP_RETRY_MS - 1, 0)).toBe(false)
    expect(shouldRetryEarlierHistory(65, HISTORY_TOP_RETRY_MS * 10, 0)).toBe(false)
    // One gesture cannot drain the whole session either.
    expect(shouldRetryEarlierHistory(0, HISTORY_TOP_RETRY_MS, HISTORY_FILL_MAX_PAGES)).toBe(false)
  })

  it('treats a row control as a control, not as selecting the row', () => {
    const row = fakeRow(null)
    // A plain row body (no interactive ancestor) selects the row.
    expect(selectsSidebarRow(fakeElement(null), row)).toBe(true)
    // The row itself being the interactive element still selects it.
    expect(selectsSidebarRow(fakeElement(row), row)).toBe(true)
    // The ellipsis menu button inside the row must not collapse the sidebar and
    // tear its own open menu down.
    expect(selectsSidebarRow(fakeElement({} as unknown as Element), row)).toBe(false)
  })

  it('keeps the sidebar open when a project header toggles its session list', () => {
    // The Workspace (project) header is a `role="treeitem"` too, but it carries
    // `aria-expanded` and no `aria-selected`: its click opens/closes the nested
    // session list in place. Counting it as a selection closed the drawer over
    // the list the user had just opened.
    const expanded = fakeRow('true')
    const collapsed = fakeRow('false')
    // The title/folder spans resolve to no interactive ancestor, which is
    // exactly the case the control check alone would have called a selection.
    expect(selectsSidebarRow(fakeElement(null), expanded)).toBe(false)
    expect(selectsSidebarRow(fakeElement(null), collapsed)).toBe(false)
    // Nor may the header count as a selection when it is its own click target.
    expect(selectsSidebarRow(fakeElement(expanded), expanded)).toBe(false)
    // A session row never announces `aria-expanded`, so it still collapses.
    expect(selectsSidebarRow(fakeElement(null), fakeRow(null))).toBe(true)
  })

  it('guards only the composer editor against programmatic focus', () => {
    // The composer editor: the field the app focuses when a session opens.
    expect(isComposerEditorFocus(fakeFocusTarget(true, true))).toBe(true)
    // A contenteditable outside the composer card is not this layer's business.
    expect(isComposerEditorFocus(fakeFocusTarget(true, false))).toBe(false)
    // The model menu's search field is an input inside the composer card: it
    // must keep its focus, or the menu's own blur handler closes it.
    expect(isComposerEditorFocus(fakeFocusTarget(false, true))).toBe(false)
  })

  it('keeps focus inside an open menu so tapping a model row can still click', () => {
    // Faithful stand-ins for the two containers the stock menu renders: the
    // root pane (focus on a cell) and the model pane (focus on the search
    // field). `contains` is the only structural relation the guard uses.
    const searchInput = { id: 'search' } as unknown as Element
    const modelRow = { id: 'row' } as unknown as Element
    const cell = { id: 'cell' } as unknown as Element
    const menu = {
      contains: (node: Element | null) => node === searchInput || node === cell,
    } as unknown as Element

    // The failure that broke model selection on the phone: the menu's search
    // field holds focus, the user presses a model row, and the mousedown
    // default would move focus out of the container — whose own blur handler
    // then unmounts the menu before mouseup, so no click is ever dispatched.
    expect(preservesMenuFocus(menu, modelRow, searchInput)).toBe(true)

    // Drilling from one root-pane cell to the other already keeps focus inside
    // the container (that is why it worked while selecting did not).
    expect(preservesMenuFocus(menu, cell, cell)).toBe(true)

    // Nothing focused inside the menu: leave the default alone.
    expect(preservesMenuFocus(menu, modelRow, null)).toBe(false)
    expect(preservesMenuFocus(menu, modelRow, { id: 'outside' } as unknown as Element)).toBe(false)

    // A press that is not on a menu item, or not inside a menu at all, must not
    // have its default cancelled.
    expect(preservesMenuFocus(menu, null, searchInput)).toBe(false)
    expect(preservesMenuFocus(null, modelRow, searchInput)).toBe(false)
  })

  it('mutes the keyboard only for the menu search field, never the composer', () => {
    expect(isMenuSearchFocus(fakeFocusTarget(true, false, true))).toBe(true)
    // A search field outside a menu is not ours to manage.
    expect(isMenuSearchFocus(fakeFocusTarget(true, false, false))).toBe(false)
    // The composer editor is handled by isComposerEditorFocus instead; muting
    // its keyboard would break typing entirely.
    expect(isMenuSearchFocus(fakeFocusTarget(false, true, true))).toBe(false)
  })

  it('uses bounded motion and disables every added animation for reduced motion', () => {
    expect(NATIVE_MOBILE_STYLES).toContain('--dsh-on-phone-motion-duration:200ms')
    expect(NATIVE_MOBILE_STYLES).toContain('@keyframes dsh-on-phone-view-in')
    expect(NATIVE_MOBILE_STYLES).toContain('@media (prefers-reduced-motion:reduce)')
    expect(NATIVE_MOBILE_STYLES).not.toContain('dsh-native-mobile-sheet')
  })

  it('reads the right column state from the frame attribute on this generation', () => {
    // DSH 0.1.7 marks a closed right column on the frame and writes the trailing
    // track as `minmax(0px, 0px)`. The old exact-match grid probe compared the
    // track against `0px`, so it reported a closed column as open forever.
    expect(rightColumnOpen(fakeFrame({ rightbarMarker: true, rightbarCollapsed: true, grid: '250px minmax(400px, 1fr) minmax(0px, 0px)' }))).toBe(false)
    expect(rightColumnOpen(fakeFrame({ rightbarMarker: true, rightbarCollapsed: false, grid: '250px minmax(400px, 1fr) minmax(0px, 460px)' }))).toBe(true)
    expect(rightColumnOpen(undefined)).toBe(false)
  })

  it('never re-containers the rightbar track that now carries the panel', () => {
    // 0.1.7 moved the sidebar-right panel inside `_rightbarCol`, so making that
    // track a fixed off-screen sheet dragged the panel — and the chrome buttons
    // inside it — along with it; only the legacy details track may become the
    // sheet.
    expect(findDetailsSheetHost(fakeFrame({ grid: '', columns: [fakeClassElement(['Hash_rightbarCol'])] }))).toBeUndefined()
    const legacy = fakeClassElement(['Hash_detailsCol'])
    expect(findDetailsSheetHost(fakeFrame({ grid: '', columns: [legacy] }))).toBe(legacy)
    expect(findDetailsSheetHost(fakeFrame({ grid: '', columns: [fakeClassElement(['Hash_rightbarCol', 'Hash_detailsCol'])] }))).toBeUndefined()
    expect(findDetailsSheetHost(undefined)).toBeUndefined()
  })

  it('still falls back to the trailing grid track on the older layout', () => {
    expect(rightColumnOpen(fakeFrame({ grid: '250px minmax(400px, 1fr) 0px' }))).toBe(false)
    expect(rightColumnOpen(fakeFrame({ grid: '250px minmax(400px, 1fr) 380px' }))).toBe(true)
  })

  it('prefers the sidebar-right dockkit panel over the removed workbench token', () => {
    const dockkit = fakeElementHost('panel', { panelMarker: true })
    expect(findRightPanelHost(fakeRoot({}, [], [dockkit]))).toBe(dockkit)
    // A dock host still resolves to its enclosing tagged panel.
    const nested = fakeElementHost('panel')
    const dockHost = { closest: () => nested } as unknown as HTMLElement
    expect(findRightPanelHost(fakeRoot({ '[data-dockkit-host]': dockHost }))).toBe(nested)
  })

  it('tags the expanded visible panel when several sessions keep one mounted', () => {
    const background = fakeElementHost('panel', { panelMarker: true, open: true, hiddenAncestor: true })
    const collapsed = fakeElementHost('panel', { panelMarker: true })
    const visible = fakeElementHost('panel', { panelMarker: true, open: true })
    expect(findRightPanelHost(fakeRoot({}, [], [background, collapsed, visible]))).toBe(visible)
    // A background session keeps a stale expanded flag; it must not beat the
    // visible panel, expanded or not.
    expect(findRightPanelHost(fakeRoot({}, [], [background, collapsed]))).toBe(collapsed)
    expect(findRightPanelHost(fakeRoot({}, [], [collapsed, visible]))).toBe(visible)
    // With nothing expanded the first mounted panel is the one to report closed.
    const second = fakeElementHost('panel', { panelMarker: true })
    expect(findRightPanelHost(fakeRoot({}, [], [collapsed, second]))).toBe(collapsed)
  })

  it('walks up from the legacy workbench token to its outer panel', () => {
    const outer = fakeClassElement(['Hash_panel'])
    const inner = fakeClassElement(['Hash_panelBody'])
    const workbench = fakeClassElement(['Hash_workbench'])
    ;(workbench as unknown as { parentElement: HTMLElement }).parentElement = inner
    ;(inner as unknown as { parentElement: HTMLElement }).parentElement = outer
    expect(findRightPanelHost(fakeRoot({}, [workbench]))).toBe(outer)
    // Without any anchor at all there is nothing to tag.
    expect(findRightPanelHost(fakeRoot({}))).toBeUndefined()
  })

  it('reads 0.1.7 panel expansion from the attribute the panel itself publishes', () => {
    // The sidebar-right root is mounted permanently, so the markers that
    // generation uses to hide content live on other nodes: `hidden` on the
    // session wrapper and `data-sidebar-right-unavailable` on a tab fallback.
    // Probing those reported a closed panel as open forever, which pinned the
    // mobile drawer on screen and swallowed the panel's real state.
    const shell = { panelMarker: true }
    expect(rightPanelOpen(fakeElementHost('panel', { ...shell }))).toBe(false)
    expect(rightPanelOpen(fakeElementHost('panel', { ...shell, open: false }))).toBe(false)
    expect(rightPanelOpen(fakeElementHost('panel', { ...shell, open: true }))).toBe(true)
    expect(rightPanelOpen(fakeElementHost('panel', { ...shell, open: true, ariaHidden: true }))).toBe(false)
    // Content-hiding markers must not be consulted once the root identifies
    // itself as this generation.
    expect(rightPanelOpen(fakeElementHost('panel', { ...shell, open: true, hidden: true, unavailable: true }))).toBe(true)
  })

  it('still treats a hidden or class-marker workbench as closed on the older layout', () => {
    expect(rightPanelOpen(fakeElementHost('panel', { hidden: true }))).toBe(false)
    expect(rightPanelOpen(fakeElementHost('panel', { unavailable: true }))).toBe(false)
    expect(rightPanelOpen(fakeClassElement(['Hash_panel', 'Hash_panelHidden']))).toBe(false)
    expect(rightPanelOpen(fakeClassElement(['Hash_panel']))).toBe(true)
  })

  it('publishes the panel open state through the attribute the CSS selects on', () => {
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-on-phone-workbench][data-dsh-on-phone-workbench-open="true"]')
    expect(NATIVE_MOBILE_STYLES).not.toContain('_panelHidden"]) { transform:translateX(0)')
  })

  it('gives both pan axes back to every node inside the open right drawer', () => {
    // The app's own rows claim the touch gesture (file drag), so the pane's
    // scroller never received a finger drag and the drawer could not be scrolled.
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-on-phone-workbench][data-dsh-on-phone-workbench-open="true"] * {')
    expect(NATIVE_MOBILE_STYLES).toContain('touch-action:pan-x pan-y pinch-zoom !important;')
    // Handing back the vertical axis alone left WebKit with nothing to claim for
    // a horizontal swipe over the open-files strip, and the host then dragged the
    // pane out of the window instead of scrolling the tabs.
    expect(NATIVE_MOBILE_STYLES).not.toContain('touch-action:pan-y pinch-zoom !important;')
    // Nesting every drawer descendant as its own momentum scroller is what made
    // iOS drop the drag, so the pair must not come back. (The left sidebar list
    // and the horizontal table scroller keep theirs: both are single scrollers.)
    expect(NATIVE_MOBILE_STYLES).not.toContain('touch-action:pan-x pan-y pinch-zoom !important;\n    -webkit-overflow-scrolling:touch;')
    expect(NATIVE_MOBILE_STYLES).toContain('overscroll-behavior:contain;')
    // Wide content still pans sideways.
    expect(NATIVE_MOBILE_STYLES).toContain(':is(pre,[data-dsh-on-phone-table-scroll]) {')
    // The dockkit chain must not collapse, or the panel body has nothing to scroll.
    expect(NATIVE_MOBILE_STYLES).toContain(':is([data-dockkit-host],[data-dockkit-pane],[data-dockkit-content]) {')
    expect(NATIVE_MOBILE_STYLES).toContain('box-sizing:border-box !important;\n    min-height:0 !important;')
  })

  it('hands the open-files strip its own horizontal pan back', () => {
    // `._stripTabs_1s7ij_257{overflow-x:auto}` is the app's horizontal scroller,
    // but the app also puts touch-action:none on the bar and the strip, so the
    // sole axis a swipe over the tabs may claim has to be written back.
    expect(NATIVE_MOBILE_STYLES).toContain(':is([class*="_tabStrip"],[class*="_stripTabs"],[class*="_detailTabs"])')
    expect(NATIVE_MOBILE_STYLES).toContain('touch-action:pan-x pinch-zoom !important;')
  })

  it('takes the vertical bounce off the transcript so the app cannot answer it frame by frame', () => {
    // WebKit fires a scroll event every frame while the transcript rubber-bands
    // at an end, and the app answers each one - re-pinning its follow-the-tail
    // floor, re-compensating while older pages land - so the render is
    // repositioned at frame rate and the picture springs up and down. Both axes
    // are off: the horizontal one also kills the sideways travel above.
    expect(NATIVE_MOBILE_STYLES).toContain('[data-conversation-scroll] { overflow-x:hidden !important; overscroll-behavior:none !important; }')
    expect(NATIVE_MOBILE_STYLES).toContain('overflow:hidden; overscroll-behavior:none; }')
  })

  it('keeps the host tap feedback free of a brightness filter or a re-layout', () => {
    // filter:brightness(.95) over a full-width row on a dark theme reads as the
    // whole screen dimming on every tap; opacity is the feedback that stays.
    // transform:scale(.97) is gone for the same class of reason: the browser
    // marks the whole ancestor chain :active, so scaling a structural box
    // (section[data-dockkit-host]) re-layers the pane and its scroller under the
    // finger, which is the "scroll up, it sticks and shivers" report, so those
    // boxes are excluded from the rule outright.
    const global: string = NATIVE_MOBILE_STYLES.slice(0, NATIVE_MOBILE_STYLES.indexOf('/* Inside the right drawer'))
    expect(global).not.toContain('filter:brightness')
    expect(global).toContain('opacity:.72 !important;')
    expect(global).toContain(':active:not(section):not([role="dialog"]):not([data-dockkit-host]):not([data-dockkit-pane]):not([data-dsh-on-phone-workbench]):not([data-conversation-scroll])')
    // The feedback rule itself must not scale or re-layer its target.
    const feedback: string = global.slice(global.indexOf(':active:not(section)'))
    expect(feedback.slice(0, feedback.indexOf('}'))).not.toContain('scale')
  })

  it('keeps the press feedback off a focus container, so a dialog cannot go translucent', () => {
    // The settings page is div[role="dialog"][tabindex="-1"] - the ancestor of
    // everything the finger can land on inside it - and this plugin's own layout
    // stretches that box to 100vw x 100dvh. A press marks the whole ancestor
    // chain :active, so while the matcher was a bare [tabindex] the rule put
    // opacity:.72 on a full-screen box: the surface went semi-transparent for
    // the length of the press and the layer underneath it showed through.
    const global: string = NATIVE_MOBILE_STYLES.slice(0, NATIVE_MOBILE_STYLES.indexOf('/* Inside the right drawer'))
    expect(global).toContain('label,[tabindex]:not([tabindex="-1"]),[contenteditable])')
    expect(global).not.toContain('label,[tabindex],[contenteditable])')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-on-phone-workbench] :is(a,button,[role="button"],[role="tab"],[role="treeitem"],label,[tabindex]:not([tabindex="-1"]),[contenteditable])')
  })

  it('keeps the tap feedback inside the right drawer free of a re-layered subtree', () => {
    // scale()+filter() re-composited the fixed, transformed drawer on every tap
    // and read as a blink; the host paints its own pressed background there.
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-on-phone-workbench] { --dsw-alias-interactive-bg-hover:transparent !important; }')
    const drawerFeedback = NATIVE_MOBILE_STYLES.slice(NATIVE_MOBILE_STYLES.indexOf('[data-dsh-on-phone-workbench] :is('))
    expect(drawerFeedback).toContain('transform:none !important;')
    expect(drawerFeedback).toContain('filter:none !important;')
    expect(drawerFeedback).toContain('opacity:.72 !important;')
  })

  it('coalesces DOM passes but lets the drawer follow its own state at once', () => {
    expect(nextSyncDelay(1_000, 0)).toBe(0)
    expect(nextSyncDelay(1_000, 900)).toBe(50)
    expect(nextSyncDelay(1_200, 900)).toBe(0)
    expect(nextSyncDelay(1_000, 900, 10)).toBe(0)
    expect(nextSyncDelay(1_000, 995, 10)).toBe(5)
    expect(BACKDROP_SETTLE_MS).toBe(180)
  })

  it('never paints the right drawer with a white fallback', () => {
    // `--dsw-bg` is undefined in this build, so the old
    // `background:var(--dsw-bg,#fff)` painted the fixed drawer white: opening and
    // closing then flashed a white sheet over the dark theme (measured: 52% of
    // the viewport for one frame on open, 10% on close).
    expect(NATIVE_MOBILE_STYLES).not.toContain('background:var(--dsw-bg,#fff)')
    expect(NATIVE_MOBILE_STYLES).not.toContain('background:var(--dsw-bg, #fff)')
    expect(NATIVE_MOBILE_STYLES).toContain('background:var(--dsh-on-phone-drawer-bg,var(--dsw-alias-bg-base,var(--dsw-bg,#fff))) !important;')
    expect(NATIVE_MOBILE_STYLES).toContain('background:var(--dsh-on-phone-drawer-bg,var(--dsw-alias-bg-base,var(--dsw-bg,#fff)));')
  })

  it('mirrors only an opaque pane surface onto the drawer background', () => {
    const surface = {} as Element
    const read = (color: string) => (() => ({ backgroundColor: color })) as unknown as (target: Element) => CSSStyleDeclaration
    expect(drawerBackgroundColor(surface, read('rgb(21, 21, 23)'))).toBe('rgb(21, 21, 23)')
    expect(drawerBackgroundColor(surface, read('rgb(21, 21, 23) '))).toBe('rgb(21, 21, 23)')
    expect(drawerBackgroundColor(undefined, read('rgb(21, 21, 23)'))).toBeUndefined()
    // A transparent pane must leave the CSS token chain in charge: mirroring it
    // would make the drawer see-through during the transition.
    expect(drawerBackgroundColor(surface, read('rgba(0, 0, 0, 0)'))).toBeUndefined()
    expect(drawerBackgroundColor(surface, read('rgba(21, 21, 23, 0.4)'))).toBeUndefined()
    expect(drawerBackgroundColor(surface, read(''))).toBeUndefined()
  })
})
