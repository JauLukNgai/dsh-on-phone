import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function main() {
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  if (typeof manifest.version !== 'string') throw new Error('package.version must be a string')

  const packageVersion = manifest.version

  if (process.argv.includes('--tag-env')) {
    const expectedTag = `v${packageVersion}`
    const actualTag = process.env.GITHUB_REF_NAME
    if (actualTag !== expectedTag) {
      throw new Error(`GITHUB_REF_NAME ${JSON.stringify(actualTag)} must equal ${JSON.stringify(expectedTag)}`)
    }
    console.log(`release tag ok: ${actualTag}`)
  }

  console.log(`release version ok: package=${packageVersion}`)
}

main().catch((error) => {
  console.error(`release version check failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
