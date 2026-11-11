// The project's configuration: `source-gates.config.mjs` in the project root, a module whose default export is an
// object (or a function returning one, called with the root). A module rather than JSON, so a project may compute a
// list — read it from package.json or another file, say — instead of copying it.
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const CONFIG_FILE = 'source-gates.config.mjs'

/** @param {string} root @param {string} [file] absolute, or relative to root */
export async function loadConfig(root, file = CONFIG_FILE) {
  const path = resolve(root, file)
  if (!existsSync(path)) {
    throw Object.assign(new Error(`no ${file} in ${root}`), { exitCode: 2 })
  }
  const mod = await import(pathToFileURL(path).href)
  const value = typeof mod.default === 'function' ? await mod.default(root) : mod.default
  if (!value || typeof value !== 'object') {
    throw Object.assign(new Error(`${file} must export an object (or a function returning one) as its default`), { exitCode: 2 })
  }
  return value
}
