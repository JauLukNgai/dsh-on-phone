import { describe, expect, it } from 'vitest'
import { isLegacyImeKeyCode, isPrintableTerminalKey, isRepairableTerminalKey, shouldDispatchTerminalRepair, shouldRepairTerminalKey, terminalTextInjection } from '../src/terminal-keys.js'

describe('mobile terminal key repair', () => {
  it('treats a single printable character as printable input', () => {
    expect(isPrintableTerminalKey(' ')).toBe(true)
    expect(isPrintableTerminalKey('.')).toBe(true)
    expect(isPrintableTerminalKey('a')).toBe(true)
    expect(isPrintableTerminalKey('中')).toBe(true)
  })

  it('never invents input from control keys or multi-character payloads', () => {
    expect(isPrintableTerminalKey('')).toBe(false)
    expect(isPrintableTerminalKey('ab')).toBe(false)
    expect(isPrintableTerminalKey('\n')).toBe(false)
    expect(isPrintableTerminalKey('\t')).toBe(false)
    expect(isPrintableTerminalKey('\u007f')).toBe(false)
  })

  it('repairs only the keys a soft keyboard drops outright', () => {
    // Space and punctuation carry no composition text, so xterm never sees them.
    expect(isRepairableTerminalKey(' ')).toBe(true)
    expect(isRepairableTerminalKey('.')).toBe(true)
    expect(isRepairableTerminalKey('-')).toBe(true)
    // Letters and digits arrive through the IME's own commit; repairing them
    // would add a second copy once that commit lands.
    expect(isRepairableTerminalKey('a')).toBe(false)
    expect(isRepairableTerminalKey('5')).toBe(false)
    expect(isRepairableTerminalKey('中')).toBe(false)
    expect(isRepairableTerminalKey('Enter')).toBe(false)
  })

  it('only runs for a trusted press inside the terminal on the phone surface', () => {
    expect(shouldRepairTerminalKey(true, true, true, ' ')).toBe(true)
    expect(shouldRepairTerminalKey(false, true, true, ' ')).toBe(false)
    expect(shouldRepairTerminalKey(true, false, true, ' ')).toBe(false)
    expect(shouldRepairTerminalKey(true, true, false, ' ')).toBe(false)
    expect(shouldRepairTerminalKey(true, true, true, 'Enter')).toBe(false)
    expect(shouldRepairTerminalKey(true, true, true, 'a')).toBe(false)
  })

  it('delivers a dropped character by writing it into xterm’s textarea', () => {
    // A synthetic keydown does not work: xterm steps aside for the same legacy
    // code the repair exists for. Writing the character and dispatching `input`
    // is the path that reaches the terminal process.
    expect(terminalTextInjection(' ')).toEqual({ value: ' ', data: ' ', inputType: 'insertText' })
    expect(terminalTextInjection(';')).toEqual({ value: ';', data: ';', inputType: 'insertText' })
    expect(terminalTextInjection('.')).toEqual({ value: '.', data: '.', inputType: 'insertText' })
  })

  it('never writes a letter, a digit or a control key into the terminal', () => {
    // Letters and digits arrive through the IME's own commit, and a late commit
    // on top of a write is how a first character ended up repeated.
    expect(terminalTextInjection('a')).toBeUndefined()
    expect(terminalTextInjection('5')).toBeUndefined()
    expect(terminalTextInjection('中')).toBeUndefined()
    expect(terminalTextInjection('Enter')).toBeUndefined()
    expect(terminalTextInjection('')).toBeUndefined()
    expect(terminalTextInjection('\n')).toBeUndefined()
  })

  it('stands the repair down whenever the key reached the terminal', () => {
    // A soft keyboard's own commit can land after the quiet window, so text,
    // composition and keypress events inside the terminal all cancel the repair.
    expect(shouldDispatchTerminalRepair(false, ' ')).toBe(true)
    expect(shouldDispatchTerminalRepair(true, ' ')).toBe(false)
    // Nothing unrepairable is ever dispatched, whatever the state.
    expect(shouldDispatchTerminalRepair(false, 'a')).toBe(false)
    expect(shouldDispatchTerminalRepair(false, 'Enter')).toBe(false)
  })

  it('repairs only the code a soft keyboard uses to take a key over', () => {
    // 229 (and nothing) is xterm's cue to step aside; a real code is a key it
    // forwards itself, so re-dispatching it would type the character twice.
    expect(isLegacyImeKeyCode(229)).toBe(true)
    expect(isLegacyImeKeyCode(0)).toBe(true)
    expect(isLegacyImeKeyCode(32)).toBe(false)
    expect(isLegacyImeKeyCode(190)).toBe(false)
    expect(shouldRepairTerminalKey(true, true, true, ' ', false, 229)).toBe(true)
    expect(shouldRepairTerminalKey(true, true, true, ' ', false, 0)).toBe(true)
    expect(shouldRepairTerminalKey(true, true, true, ' ', false, 32)).toBe(false)
  })

  it('refuses a modified key, which is a control sequence rather than text', () => {
    expect(shouldRepairTerminalKey(true, true, true, ' ', false)).toBe(true)
    expect(shouldRepairTerminalKey(true, true, true, ' ', true)).toBe(false)
    // A press outside the terminal, an untrusted one and a desktop surface all
    // have to pass on their own.
    expect(shouldRepairTerminalKey(true, false, true, ' ')).toBe(false)
    expect(shouldRepairTerminalKey(false, true, true, ' ')).toBe(false)
    expect(shouldRepairTerminalKey(true, true, false, ' ')).toBe(false)
    expect(shouldRepairTerminalKey(true, true, true, 'a')).toBe(false)
  })
})
