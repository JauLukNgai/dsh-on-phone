/**
 * Loads the built artifacts the way a DSH host does, so a bundle that only
 * looks healthy under the test runner cannot ship.
 *
 * Motivating bug: `import { Z_SYNC_FLUSH } from 'node:zlib'` typechecked
 * cleanly and passed the whole vitest suite, because the runner resolves
 * builtins through its own interop (the constant came back `undefined`). In a
 * plain Node ESM process the same line is a module-load `SyntaxError` — the
 * ESM facade for `node:zlib` exports the functions and `constants`, not the
 * bare constants — which would take the plugin's server half down with it on
 * the next app start. Only importing the real file catches that.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const server = fileURLToPath(new URL('../lib/index.mjs', import.meta.url))
const client = fileURLToPath(new URL('../lib/client.js', import.meta.url))

const fail = (message) => {
  console.error(`check-bundle: ${message}`)
  process.exit(1)
}

for (const path of [server, client]) {
  if (!existsSync(path)) fail(`${path} is missing — run \`npm run build\` first`)
}

const expected = ['apply', 'inject', 'name', 'MobileAccessGateway', 'rewriteRemoteMobileIndex']
let loaded
try {
  loaded = await import(server)
} catch (error) {
  fail(`lib/index.mjs cannot be imported by Node: ${error instanceof Error ? error.message : String(error)}`)
}
const missing = expected.filter((name) => loaded[name] === undefined)
if (missing.length > 0) fail(`lib/index.mjs no longer exports ${missing.join(', ')}`)

const browser = await readFile(client, 'utf8')
if (/\bnode:[a-z/]+/.test(browser) || /\brequire\(\s*["']node:/.test(browser)) {
  fail('lib/client.js references a node: builtin; the phone has no such module')
}

console.log(`check-bundle: lib/index.mjs imports cleanly (${expected.length} exports checked), lib/client.js stays browser-only`)
