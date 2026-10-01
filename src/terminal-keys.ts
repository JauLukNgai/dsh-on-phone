/**
 * Soft-keyboard repair for the phone terminal.
 *
 * DSH's terminal is xterm.js, which reads a key from `keydown` and steps aside
 * when the event carries the legacy IME code 229 — the code iOS and Android soft
 * keyboards report for keys they take over themselves. Letters survive because
 * the IME commits them through composition/text input, but a space press
 * produces no composition at all, and a punctuation press is usually just a 229
 * keydown with nothing behind it, so both are dropped and the terminal never
 * sees them.
 *
 * The repair cannot be another keydown. Measured against the real page, a
 * synthetic keydown carrying the reconstructed code never reaches the terminal
 * process: xterm steps aside for the very code that has to be repaired, so the
 * generated event lands in the same dead end as the one it replaces. What does
 * reach the process is xterm's own text path — the character written into
 * `.xterm-helper-textarea` followed by the `input` event xterm listens for. That
 * is what this module dispatches, and only when every other path stayed silent.
 *
 * Four rules keep the repair from ever typing twice:
 *
 * - Only a keydown carrying the legacy IME code is repaired. A keydown with a
 *   real code is one xterm already forwards, so repairing it would type the
 *   character a second time; that is also why this never counts outbound traffic
 *   to decide whether the key got through — the app's own streaming would look
 *   like "delivered" and stall every repair.
 * - Only space and punctuation are repaired. Letters and digits arrive through
 *   the IME's own commit, and that commit can land late, so repairing them would
 *   add the duplicate that once made the first typed character repeat.
 * - The textarea is looked up again for every repair: xterm swaps the helper
 *   node out between inputs, and an injection into a detached node is lost.
 * - Alphanumerics are never repaired, and a pending repair is cancelled the
 *   moment the terminal shows any other sign of the key: text or composition
 *   events inside `.xterm`, or a real `keypress`.
 */

/**
 * US-layout key codes for the printable characters a soft keyboard reports as a
 * bare 229. Membership is the whole point: it is the set of characters the IME
 * never commits, so the set the repair is allowed to deliver.
 */
const TERMINAL_PUNCTUATION_CODES: Readonly<Record<string, number>> = (() => {
  const codes: Record<string, number> = {}
  const pairs: ReadonlyArray<readonly [number, number]> = [
    [32, 32], [59, 186], [58, 186], [61, 187], [43, 187], [44, 188], [60, 188],
    [45, 189], [95, 189], [46, 190], [62, 190], [47, 191], [63, 191], [96, 192],
    [126, 192], [91, 219], [123, 219], [92, 220], [124, 220], [93, 221], [125, 221],
    [39, 222], [34, 222],
  ]
  for (const pair of pairs) codes[String.fromCharCode(pair[0])] = pair[1]
  return codes
})()

/** The code a soft keyboard reports for a key it takes over from the page. */
const LEGACY_IME_KEY_CODE = 229

/** The textarea xterm reads committed text from; it is replaced between inputs. */
const TERMINAL_TEXTAREA_SELECTOR = '.xterm-helper-textarea'

/**
 * How long the terminal gets to show that it received the key. A soft keyboard's
 * own commit can lag well behind the keydown, so this has to outlast it: the
 * repair is worthless if it fires first and the commit then lands on top.
 */
const TERMINAL_KEY_QUIET_MS = 400

/** Shortest gap between two repairs; a soft keyboard can report a key several times. */
const TERMINAL_KEY_DEDUPE_MS = 400

/** How many recent repairs are kept for on-device diagnosis. */
const TERMINAL_KEY_LOG_LIMIT = 12

/** Events inside the terminal that prove the key arrived without the repair. */
const TERMINAL_EVIDENCE_EVENTS: readonly string[] = [
  'beforeinput',
  'input',
  'compositionstart',
  'compositionupdate',
  'compositionend',
  'keypress',
]

/**
 * Whether a key or input payload is the single printable character xterm can
 * drop. Control keys, multi-character payloads and the delete code are ignored
 * so the repair never invents input the user did not ask for.
 * @param text - The event's `key` or `data` payload.
 * @returns Whether it is one printable character.
 */
export function isPrintableTerminalKey(text: string): boolean {
  if (typeof text !== 'string' || text.length !== 1) return false
  const code = text.charCodeAt(0)
  return code >= 32 && code !== 127
}

/**
 * Whether a character is one only the repair can deliver.
 *
 * Space and punctuation are the keys a soft keyboard reports as a bare 229 with
 * no text behind them. Letters and digits arrive through the IME's own commit,
 * so they are left alone: repairing them could only duplicate them.
 * @param text - The event's `key` payload.
 * @returns Whether the repair may deliver this character.
 */
export function isRepairableTerminalKey(text: string): boolean {
  return isPrintableTerminalKey(text) && TERMINAL_PUNCTUATION_CODES[text] !== undefined
}

/**
 * Whether a keydown's legacy code is one only a soft keyboard produces.
 *
 * xterm hands such an event to its composition helper and returns early, so the
 * character is dropped unless the repair delivers it. A real code (space is 32)
 * is forwarded by xterm itself and must be left alone.
 * @param keyCode - The reported legacy key code (`event.keyCode`).
 * @returns Whether xterm stepped aside for this key.
 */
export function isLegacyImeKeyCode(keyCode: number): boolean {
  return keyCode === 0 || keyCode === LEGACY_IME_KEY_CODE
}

/**
 * Whether an event is even a candidate for repair.
 *
 * Every gate matters: only a trusted event can be a real key press, only a press
 * inside the terminal can be one xterm dropped, only on the phone surface is the
 * soft keyboard the problem, only a legacy IME code means xterm stepped aside,
 * and a modified key is a control sequence rather than text. Synthetic events
 * (the repair's own output) fail the trust gate, which is what stops it from
 * looping.
 * @param trusted - `event.isTrusted`.
 * @param inTerminal - Whether the event target is inside `.xterm`.
 * @param mobileActive - Whether the mobile surface is installed on this document.
 * @param key - The event's `key` or `data` payload.
 * @param modified - Whether ctrl, alt or meta was held.
 * @param reportedCode - The event's legacy key code.
 * @returns Whether the key may be repaired.
 */
export function shouldRepairTerminalKey(trusted: boolean, inTerminal: boolean, mobileActive: boolean, key: string, modified = false, reportedCode: number = LEGACY_IME_KEY_CODE): boolean {
  return trusted && inTerminal && mobileActive && !modified && isLegacyImeKeyCode(reportedCode) && isRepairableTerminalKey(key)
}

/**
 * Whether a repair that has been waiting out the quiet window should still fire.
 *
 * The key is assumed delivered the moment there is any sign of it, so a cancel
 * (text or composition events, or a real keypress, inside the terminal) stands
 * the repair down. This is what keeps a first typed character from arriving
 * twice: the soft keyboard's own commit can land after the keydown.
 * @param cancelled - Whether the terminal showed the key arriving another way.
 * @param key - The character waiting to be delivered.
 * @returns Whether to deliver the character from the textarea.
 */
export function shouldDispatchTerminalRepair(cancelled: boolean, key: string): boolean {
  return !cancelled && isRepairableTerminalKey(key)
}

/** What has to be written into xterm's textarea for a dropped character. */
export interface TerminalTextInjection {
  /** The textarea's new value; xterm forwards exactly this. */
  readonly value: string
  /** The `data` the input event carries, for hosts that read it instead. */
  readonly data: string
  /** The input type, so xterm treats it as a plain insertion. */
  readonly inputType: 'insertText'
}

/**
 * The textarea write that delivers a character xterm never received.
 *
 * Kept separate from the DOM so the decision is testable on its own: anything
 * unrepairable has no plan at all, which is what stops the installer from ever
 * writing a letter or a control key into the terminal.
 * @param key - The character to deliver.
 * @returns The write to perform, or `undefined` when nothing may be delivered.
 */
export function terminalTextInjection(key: string): TerminalTextInjection | undefined {
  if (!isRepairableTerminalKey(key)) return undefined
  return { value: key, data: key, inputType: 'insertText' }
}

/** One repair attempt, kept for on-device diagnosis through the devtools console. */
export interface TerminalKeyRepairNote {
  readonly at: number
  readonly from: string
  readonly key: string
  /** Whether the character was written into the terminal's textarea. */
  readonly injected: boolean
  /** Whether the terminal proved it had received the key before the repair ran. */
  readonly cancelled: boolean
}

type KeyLogHost = { __DSH_ON_PHONE_KEYLOG__?: TerminalKeyRepairNote[] }

/**
 * Build the input event xterm reads a committed character from.
 * @param plan - The write that was just performed.
 * @returns An input event; a plain event on hosts without `InputEvent`.
 */
function terminalInputEvent(plan: TerminalTextInjection): Event {
  try {
    return new InputEvent('input', { bubbles: true, cancelable: false, inputType: plan.inputType, data: plan.data })
  } catch {
    // Safari before 10.1 has no InputEvent constructor; xterm only reads value.
    return new Event('input', { bubbles: true, cancelable: false })
  }
}

/**
 * Deliver a character the soft keyboard reported but never committed.
 * @param key - The character to deliver.
 * @returns Whether the character was written to a live textarea.
 */
function injectTerminalText(key: string): boolean {
  const plan = terminalTextInjection(key)
  if (plan === undefined || typeof document === 'undefined') return false
  // xterm replaces the helper textarea between inputs, so a stale reference
  // writes into a detached node and the character is lost.
  const textarea = document.querySelector<HTMLTextAreaElement>(TERMINAL_TEXTAREA_SELECTOR)
  if (textarea === null) return false
  if (document.activeElement !== textarea) textarea.focus()
  textarea.value = plan.value
  textarea.dispatchEvent(terminalInputEvent(plan))
  return true
}

/**
 * Install the soft-keyboard repair.
 * @returns Uninstaller that removes every listener and pending timer.
 */
export function installTerminalKeyRepair(): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return () => {}
  const pendingTimers = new Set<number>()
  // At most one repair is in flight: the dedupe gate below allows no more.
  let pendingCancel: (() => void) | null = null
  const log = (note: TerminalKeyRepairNote): void => {
    try {
      const host = window as unknown as KeyLogHost
      const entries = host.__DSH_ON_PHONE_KEYLOG__ ?? []
      entries.push(note)
      if (entries.length > TERMINAL_KEY_LOG_LIMIT) entries.shift()
      host.__DSH_ON_PHONE_KEYLOG__ = entries
    } catch {
      // A read-only host object must never break typing.
    }
  }
  const inspect = (from: string, key: string): void => {
    let cancelled = false
    const cancel = (): void => { cancelled = true }
    pendingCancel = cancel
    const timer = window.setTimeout(() => {
      pendingTimers.delete(timer)
      // Cleared before the delivery below, so the input event it dispatches is
      // never mistaken for the keyboard's own commit.
      if (pendingCancel === cancel) pendingCancel = null
      const deliver = shouldDispatchTerminalRepair(cancelled, key)
      const injected = deliver && injectTerminalText(key)
      log({ at: Date.now(), from, key, injected, cancelled })
    }, TERMINAL_KEY_QUIET_MS)
    pendingTimers.add(timer)
  }
  let dedupeUntil = 0
  const onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target
    const inTerminal = target instanceof Element && target.closest('.xterm') !== null
    // The phone path only: a desktop browser reaching this page over the LAN
    // keeps its own (working) key handling.
    const mobileActive = document.documentElement.classList.contains('dsh-native-mobile-active')
    const modified = event.ctrlKey || event.altKey || event.metaKey
    const reported = typeof event.keyCode === 'number' ? event.keyCode : 0
    if (!shouldRepairTerminalKey(event.isTrusted === true, inTerminal, mobileActive, event.key, modified, reported)) return
    const now = Date.now()
    if (now < dedupeUntil) return
    dedupeUntil = now + TERMINAL_KEY_DEDUPE_MS
    inspect('keydown', event.key)
  }
  // Any of these inside the terminal means the terminal already has the key, so
  // a pending repair must not add a second copy of it.
  const onEvidence = (event: Event): void => {
    const target = event.target
    if (target instanceof Element && target.closest('.xterm') !== null) pendingCancel?.()
  }
  document.addEventListener('keydown', onKeyDown, true)
  for (const type of TERMINAL_EVIDENCE_EVENTS) document.addEventListener(type, onEvidence, true)
  return () => {
    for (const timer of pendingTimers) window.clearTimeout(timer)
    pendingTimers.clear()
    pendingCancel = null
    document.removeEventListener('keydown', onKeyDown, true)
    for (const type of TERMINAL_EVIDENCE_EVENTS) document.removeEventListener(type, onEvidence, true)
  }
}
