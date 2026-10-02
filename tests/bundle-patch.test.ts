import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

// js-yaml 5 replaced `new Type(...)` + `Schema.extend(...)` with a tag factory
// and `Schema.withTags(...)`: one `resolve` both validates and constructs.
const jsExpressionType = yaml.defineScalarTag<{ __jsExpr: string }>('tag:yaml.org,2002:js', {
  resolve: source => ({ __jsExpr: source }),
  identify: () => false,
})
const schema = yaml.JSON_SCHEMA.withTags(jsExpressionType)
const source = readFileSync(resolve(import.meta.dirname, '..', 'cordis.patch.yml'), 'utf8')

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('expected mapping')
  return value as Record<string, unknown>
}

function mobileRow(): Record<string, unknown> {
  const patches = yaml.load(source, { schema }) as unknown[]
  const rows = patches.flatMap(patch => (record(patch).insert as unknown[] | undefined) ?? [patch]).map(record)
  const matches = rows.filter(row => row.id === 'mobile-access')
  if (matches.length !== 1) throw new Error('expected one mobile-access row')
  return matches[0]!
}

function evaluate(value: unknown): unknown {
  const expression = record(value).__jsExpr
  if (typeof expression !== 'string') throw new TypeError('expected JavaScript scalar')
  const run = Function('dshHomePath', `"use strict"; return (${expression});`) as (
    homePath: (path: string) => string,
  ) => unknown
  return run(path => `/dsh-home/${path}`)
}

describe('stock DSH bundle patch', () => {
  it('adds one ordinary dual-face plugin and no core replacement rows', () => {
    const row = mobileRow()
    expect(row).toMatchObject({ id: 'mobile-access', name: 'dsh-on-phone', inject: ['webServer', 'connection'] })
    expect(source).not.toContain('pluginInventory')
    expect(source).not.toContain('requestAuth')
    expect(source).not.toMatch(/^\s*- id: connection$/mu)
  })

  it('starts disabled until the setup CLI writes the durable control state', () => {
    const config = record(mobileRow().config)
    expect(config.initiallyEnabled).toBe(false)
    expect(config.tls).toEqual({ mode: 'disabled' })
  })

  it('keeps generated files under DSH_HOME without assuming a local checkout path', () => {
    const config = record(mobileRow().config)
    expect(evaluate(config.setupFile)).toBe('/dsh-home/mobile-access/setup.json')
    expect(evaluate(config.stateFile)).toBe('/dsh-home/mobile-access/devices.json')
    expect(evaluate(config.controlFile)).toBe('/dsh-home/mobile-access/control.json')
    expect(evaluate(config.customCssFile)).toBe('/dsh-home/mobile-access/mobile.css')
    expect(evaluate(config.customScriptFile)).toBe('/dsh-home/mobile-access/mobile.js')
  })

  it('keeps the inert fallback listener loopback-only', () => {
    const config = record(mobileRow().config)
    expect(config.listenHost).toBe('127.0.0.1')
    expect(config.allowedCidrs).toEqual(['127.0.0.0/8'])
  })
})

