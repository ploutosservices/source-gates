// THE BUNDLE-SECRETS GATE, run after `next build`. Two findings, and why both:
//
//  1. THE LEAK. `.next/static` is served to browsers, so a secret's value appearing there is not a style problem.
//
//  2. THE INLINING. `process.env[name]` is a dynamic index the bundler cannot inline, while the same variable written
//     as `process.env.NAME` can be replaced with its build-time value. Where that happens, code that reads the
//     variable dynamically (a diagnostics endpoint, say) sees the runtime value while the inlined code uses the
//     build-time one, and changing the variable at runtime has no effect on it. When the bundler inlines a read, the
//     variable's NAME stops appearing in the server chunks; a declared name missing from the chunks is the signature of
//     inlining, and it is reported rather than assumed absent. NEXT_PUBLIC_* names (inlined by design) and names
//     declared `warnUnused: false` (read by a framework, not by your code) are not checked for it.
//
// It prints a variable's name and a verdict, never a value.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { filesUnder } from './files.mjs'

// Values shorter than this are words, ports and flags: they collide with ordinary code text and would make the gate
// cry wolf, which is how a gate gets switched off. Real credentials are longer.
export const MIN_SECRET_LEN = 16

/** KEY=VALUE lines; `#` comments and blank lines skipped; one matching pair of surrounding quotes removed. */
export function readEnvFile(path) {
  if (!existsSync(path)) return {}
  const env = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#') || !t.includes('=')) continue
    const i = t.indexOf('=')
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^(["'])(.*)\1$/, '$2')
  }
  return env
}

/** The chunk directory: a standalone build's when it exists, else the default build's. */
export function defaultChunksDir(root) {
  const standalone = join(root, '.next/standalone/.next/server/chunks')
  return existsSync(standalone) ? standalone : join(root, '.next/server/chunks')
}

/**
 * @param {string} root
 * @param {{ declared: { name: string, secret?: boolean, warnUnused?: boolean }[], envFile?: string, staticDir?: string, chunksDir?: string }} opts
 *   paths relative to root
 * @returns {{ ran: false, reason: string } | { ran: true, names: number, checkedValues: number, leaked: string[], inlined: string[] }}
 */
export function bundleVerdicts(root, { declared, envFile = '.env.local', staticDir = '.next/static', chunksDir }) {
  const staticAbs = join(root, staticDir)
  const chunksAbs = chunksDir ? join(root, chunksDir) : defaultChunksDir(root)
  if (!existsSync(staticAbs) || !existsSync(chunksAbs)) {
    return { ran: false, reason: `no build found (${!existsSync(staticAbs) ? staticDir : chunksDir ?? 'the server chunks'} is missing): run \`next build\` first` }
  }
  const env = readEnvFile(join(root, envFile))
  const staticText = filesUnder(staticAbs).map(f => readFileSync(f, 'utf8')).join('\n')
  const chunkText = filesUnder(chunksAbs).map(f => readFileSync(f, 'utf8')).join('\n')
  const leaked = [], inlined = []
  let checkedValues = 0
  for (const { name, secret, warnUnused } of declared) {
    // NEXT_PUBLIC_* is public by declaration: being in the client bundle is its job. And only a secret's value is a
    // leak: configuration, flags and endpoints are public by nature, and comparing them cries wolf (a framework's own
    // default origin in its client code would read as a leak).
    if (secret === true && !name.startsWith('NEXT_PUBLIC')) {
      const v = env[name]
      if (v && v.length >= MIN_SECRET_LEN) {
        checkedValues++
        if (staticText.includes(v)) leaked.push(name)
      }
    }
    // A whole-word match: a short name (PORT) inside a longer one (REPORT) is not an appearance.
    if (!name.startsWith('NEXT_PUBLIC') && warnUnused !== false && !new RegExp(`(^|[^A-Za-z0-9_$])${name}([^A-Za-z0-9_$]|$)`).test(chunkText)) inlined.push(name)
  }
  return { ran: true, names: declared.length, checkedValues, leaked, inlined }
}
