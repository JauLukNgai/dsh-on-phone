import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NATIVE_MOBILE_STYLES } from '../src/native-mobile.js'

/**
 * The phone style sheet and the code that tags the DOM speak different
 * spellings: the CSS selects `[data-dsh-on-phone-x]` while the code writes
 * `element.dataset.dshOnPhoneX`. Nothing at runtime ties the two together —
 * `element.dataset.dshMobileFrame = 'true'` produces `data-dsh-mobile-frame`,
 * which no selector in the sheet matches, and the rule is simply inert.
 *
 * That is not hypothetical: the identity rename moved every selector in
 * `NATIVE_MOBILE_STYLES` to the new spelling and left all 27 `dataset` writers
 * behind, so the whole phone adaptation — drawers, full-screen settings, header
 * relayout — stopped applying while 362 tests stayed green, because those tests
 * assert the CSS *text* rather than what `sync()` actually writes.
 *
 * These tests read both sides as text and compare them, which is the only check
 * that can see that class of drift without a DOM.
 */

const sourceFiles = ['src/native-mobile.ts', 'src/client.ts'] as const

const sources = sourceFiles.map((file) => ({
  file,
  text: readFileSync(resolve(import.meta.dirname, '..', file), 'utf8'),
}))

/** Every writer of phone attributes lives in one of these files. */
const writers = sources.map(({ text }) => text).join('\n')

/**
 * Attributes the client looks up by selector instead of the style sheet
 * selecting them. Keep in sync with the `querySelector` call sites in
 * `src/client.ts`.
 */
const lookedUpBySelector = ['data-dsh-on-phone-surface-host', 'data-dsh-on-phone-extension-layer'] as const

function attributesIn(text: string): string[] {
  return [...new Set(text.match(/data-dsh-on-phone-[a-z-]+/gu) ?? [])]
}

/**
 * The write that produces a given attribute:
 * `data-dsh-on-phone-message-scroll` -> `dataset.dshOnPhoneMessageScroll`.
 */
function datasetWriteFor(attribute: string): string {
  const camel = attribute
    .slice('data-dsh-on-phone-'.length)
    .replace(/-([a-z])/gu, (_match, letter: string) => letter.toUpperCase())
  return `dataset.dshOnPhone${camel.charAt(0).toUpperCase()}${camel.slice(1)}`
}

const required = [...new Set([...attributesIn(NATIVE_MOBILE_STYLES), ...lookedUpBySelector])].sort()

describe('phone DOM attribute contract', () => {
  for (const { file, text } of sources) {
    it(`${file} uses the dsh-on-phone spelling for every DOM attribute`, () => {
      // The carried-over `dshMobile` spelling in a dataset write is the exact
      // slip this file exists to catch, so name it explicitly rather than
      // relying on the selector comparison below.
      expect(text).not.toContain('dataset.dshMobile')
      expect(text).not.toContain('data-dsh-mobile-')
    })
  }

  it('covers the whole phone surface', () => {
    // A guard on the guard: if the extraction ever stops finding attributes,
    // every case below would vacuously pass.
    expect(required.length).toBeGreaterThan(20)
  })

  for (const attribute of required) {
    it(`something writes ${attribute}`, () => {
      const hasWriter = writers.includes(datasetWriteFor(attribute)) || writers.includes(`setAttribute('${attribute}`)
      expect(hasWriter).toBe(true)
    })
  }
})
