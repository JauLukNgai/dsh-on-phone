/**
 * Give every test run its own DSH home.
 *
 * Some of the code under test resolves paths from `DSH_HOME` when it is not
 * given one — the telemetry log is the current example — and the remote proxy
 * records a history-page round trip on every proxied page request. Without
 * this, running the suite would append test noise to the developer's real
 * `~/.dsh` directory, and a later reading of that log would see fixtures
 * (`session-a`, a synthetic page size) as if a device had produced them.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

const scratch = mkdtempSync(join(tmpdir(), 'dsh-test-home-'))
process.env.DSH_HOME = scratch

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})
