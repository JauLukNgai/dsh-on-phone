// TEMPORARY: prints what the Windows runner does when the tests hand the
// controller a fake `tailscale` executable. Delete once the platform is fixed.
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const dir = await mkdtemp(join(tmpdir(), 'dsh-probe-'))
const log = join(dir, 'calls.txt')
const fake = join(dir, 'tailscale-fake.mjs')
await writeFile(fake, [
  "import { readFileSync, writeFileSync } from 'node:fs'",
  `const log = ${JSON.stringify(log)}`,
  "const args = process.argv.slice(2)",
  "const line = args.join(' ')",
  'try { writeFileSync(log, line + "\\n", { flag: "a" }) } catch {}',
  "if (line.endsWith('status --json')) process.stdout.write('{\"Self\":{\"DNSName\":\"node.tailnet.ts.net.\"}}')",
  '',
].join('\n'))
const shim = join(dir, 'tailscale.cmd')
await writeFile(shim, ['@echo off', `node "${fake}" %*`, ''].join('\r\n'))

console.log('  platform =', process.platform, 'node =', process.version)
console.log('  temp dir =', dir)
console.log('  shim =', shim)
for (const [label, target, options] of [
  ['as the test builds it (join)', shim, {}],
  ['backslash path', shim.replaceAll('/', '\\'), {}],
  ['shell: true', shim, { shell: true }],
  ['forward slashes', shim.replaceAll('\\', '/'), {}],
]) {
  try {
    const { stdout } = await run(target, ['status', '--json'], options)
    console.log(`  [${label}] OK stdout=${JSON.stringify(stdout)}`)
  } catch (error) {
    console.log(`  [${label}] code=${error.code} errno=${error.errno} message=${error.message}`)
  }
  try {
    console.log(`      calls.txt=${JSON.stringify(await readFile(log, 'utf8'))}`)
  } catch {
    console.log('      calls.txt 不存在')
  }
}

// The controller's own first two calls, in the order it makes them.
for (const args of [['serve', 'status', '--json'], ['serve', '--bg', '--yes', '--https=443', 'http://127.0.0.1:54321']]) {
  try {
    const { stdout } = await run(shim, args, {})
    console.log(`  [controller] ${args.join(' ')} → OK ${JSON.stringify(stdout)}`)
  } catch (error) {
    console.log(`  [controller] ${args.join(' ')} → code=${error.code} message=${error.message}`)
  }
}
try {
  console.log('  calls.txt =', JSON.stringify(await readFile(log, 'utf8')))
} catch {
  console.log('  calls.txt 不存在')
}
