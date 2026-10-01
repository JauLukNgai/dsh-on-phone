import { describe, expect, it } from 'vitest'
import { resolvePanelAnchor } from '../src/client.js'

/**
 * The control panel used to be pinned to a fixed viewport corner, so resizing or
 * collapsing the DSH sidebar detached it from the trigger that opens it. These
 * cases pin the derived placement, including the clamps that keep it on screen.
 */
describe('mobile control panel anchoring', () => {
  it('falls back to the legacy corner before the trigger has been measured', () => {
    expect(resolvePanelAnchor(undefined, { width: 1200, height: 800 })).toEqual({
      left: 8, bottom: 112, width: 380, availableHeight: 680,
    })
  })

  it('places the panel beside the trigger and aligns its bottom edge', () => {
    expect(resolvePanelAnchor({ left: 200, right: 360, bottom: 760 }, { width: 1200, height: 800 })).toEqual({
      left: 368, bottom: 40, width: 380, availableHeight: 752,
    })
  })

  it('falls back to the trigger left edge and stays inside a right-hand sidebar', () => {
    const anchor = resolvePanelAnchor({ left: 700, right: 860, bottom: 760 }, { width: 900, height: 800 })

    expect(anchor.left).toBe(512)
    expect(anchor.left + anchor.width).toBeLessThanOrEqual(900)
    expect(anchor.bottom).toBe(40)
  })

  it('keeps the panel reachable on a narrow phone-width viewport', () => {
    const anchor = resolvePanelAnchor({ left: 0, right: 32, bottom: 560 }, { width: 320, height: 600 })

    expect(anchor.left).toBe(8)
    expect(anchor.width).toBe(288)
    expect(anchor.left + anchor.width).toBeLessThanOrEqual(320)
  })

  it('never reports less than the minimum panel height on a short viewport', () => {
    const anchor = resolvePanelAnchor({ left: 40, right: 200, bottom: 150 }, { width: 1024, height: 180 })

    expect(anchor.bottom).toBeGreaterThanOrEqual(8)
    expect(anchor.availableHeight).toBeGreaterThanOrEqual(160)
  })

  it('keeps the panel anchored when the sidebar collapses to its rail width', () => {
    const wide = resolvePanelAnchor({ left: 8, right: 288, bottom: 760 }, { width: 1440, height: 900 })
    const rail = resolvePanelAnchor({ left: 8, right: 56, bottom: 760 }, { width: 1440, height: 900 })

    expect(wide.left).toBe(296)
    expect(rail.left).toBe(64)
    for (const anchor of [wide, rail]) {
      expect(anchor.left).toBeGreaterThanOrEqual(8)
      expect(anchor.left + anchor.width).toBeLessThanOrEqual(1440)
      expect(anchor.bottom).toBeGreaterThanOrEqual(8)
    }
  })
})
