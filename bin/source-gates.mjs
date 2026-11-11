#!/usr/bin/env node
// source-gates <command> [--list] [--root <dir>] [--config <file>]
//   addresses       no hard-coded address in the source
//   env             every environment variable the code reads is declared
//   bundle-secrets  after `next build`: no secret in the client bundle, no declared name inlined
//   access          every Next.js App Router entry checks a permission, or is declared
// Exit 0 clean, 1 on a finding, 2 when it cannot run.
import { join, resolve } from 'node:path'
import { loadConfig } from '../src/config.mjs'
import { fileSet, isSourceFile, DEFAULT_TEST_FILE } from '../src/files.mjs'
import { hitsInFiles, pyHits, judgeAddresses } from '../src/addresses.mjs'
import { codeVars, judgeEnv, DEFAULT_IGNORE } from '../src/env.mjs'
import { bundleVerdicts } from '../src/bundle-secrets.mjs'
import { accessVerdicts, accessFiles, defaultAppDir } from '../src/access.mjs'

const USAGE = `usage: source-gates <addresses|env|bundle-secrets|access> [--list] [--root <dir>] [--config <file, absolute or relative to the root>]`
const COMMANDS = new Set(['addresses', 'env', 'bundle-secrets', 'access'])
const LISTS = new Set(['addresses', 'access'])

function parseArgs(argv) {
  const [command, ...rest] = argv
  if (!COMMANDS.has(command)) return { error: command ? `unknown command: ${command}` : 'no command' }
  const out = { command, list: false, root: process.cwd(), config: undefined }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--list' && LISTS.has(command)) out.list = true
    else if ((a === '--root' || a === '--config') && rest[i + 1] && !rest[i + 1].startsWith('--')) out[a.slice(2)] = rest[++i]
    else return { error: `unknown or incomplete argument for ${command}: ${a}` }
  }
  out.root = resolve(out.root)
  return out
}

const say = (title, list) => {
  if (!list.length) return false
  console.error(title)
  for (const x of list) console.error(`  ${x}`)
  return true
}

const asList = x => x instanceof Map ? [...x.keys()] : Array.isArray(x) ? x : x instanceof Set ? [...x] : Object.keys(x ?? {})

function addresses(root, cfg, list) {
  const c = cfg.addresses ?? {}
  const excludeList = c.exclude ?? [cfg.testFile ?? DEFAULT_TEST_FILE]
  const files = fileSet(root, {
    include: c.include ?? ['src', 'scripts'],
    includeFiles: c.includeFiles ?? [],
    exclude: excludeList,
    keep: isSourceFile,
  })
  const exclude = excludeList.map(e => e instanceof RegExp ? e : new RegExp(e))
  const hits = [...hitsInFiles(files, root),
    ...(c.python ?? []).flatMap(d => pyHits(join(root, d), root)).filter(h => !exclude.some(r => r.test(h.file)))]
  const lists = {
    allowedHosts: asList(c.allowedHosts), allowedAddresses: asList(c.allowedAddresses),
    allowedLiterals: asList(c.allowedLiterals), pinned: asList(c.pinned),
  }
  const { findings, stale, counted } = judgeAddresses(hits, lists)
  if (list) {
    const flagged = new Set(counted)
    console.log(`${hits.length} address-shaped literals\n`)
    for (const h of hits) console.log(`${flagged.has(h) ? 'COUNTED' : 'allowed'}  ${h.arm.padEnd(9)} ${h.file}:${h.line}  ${h.ctx}  ${h.literal}`)
    return 0
  }
  // A pin that matches nothing is a hole, not tidiness: it silently permits the next address written into that file.
  if (say('Pinned entries that match no literal any more. A pin that matches nothing permits the next one silently; delete these:', stale)) return 1
  if (findings.length) {
    console.error('An address is written into the code.\n')
    for (const o of findings) console.error(`  ${o.file}:${o.line}  ${o.arm}  ${o.ctx}\n      ${o.literal}`)
    console.error(`
Read it from configuration at runtime instead: an address in the source decides, silently, which deployment the code
talks to. If it genuinely is not an address (a namespace, a placeholder, an identifier shaped like a URL), add the host
to allowedHosts, a third party's address to allowedAddresses, or the literal to allowedLiterals, with a reason. If it
is an address that cannot move yet, add "<file>|<literal>" to pinned, with a note on why it is still there and what
will remove it. A port has no host, so only moving it to configuration or pinning it clears it.`)
    if (c.message) console.error(`\n${c.message}`)
    return 1
  }
  console.log(`addresses: ${hits.length} address-shaped literals (${hits.filter(h => h.arm === 'url').length} URLs), none unaccounted for`)
  return 0
}

function env(root, cfg) {
  const c = cfg.env ?? {}
  if (!Array.isArray(c.declared)) throw Object.assign(new Error('env.declared (an array of { name, secret?, warnUnused? }) is missing from the configuration'), { exitCode: 2 })
  const code = codeVars(root, c.include ?? ['src'], { requiredHelpers: c.requiredHelpers ?? [], testFile: cfg.testFile })
  const { undeclared, unused } = judgeEnv(code, { declared: c.declared, ignore: c.ignore ?? DEFAULT_IGNORE })
  if (unused.length) {
    console.warn(`warning: ${unused.length} declared variable(s) that no scanned code reads (a framework may read them):`)
    for (const n of unused) console.warn(`  ${n}`)
  }
  if (say('Environment variables the code reads that are not declared:', undeclared.map(u => `${u.name}  (read in ${u.file})`))) return 1
  console.log(`env: ${code.size} variables read, every one declared`)
  return 0
}

function bundleSecrets(root, cfg) {
  const c = cfg.bundleSecrets ?? {}
  const declared = c.declared ?? cfg.env?.declared
  if (!Array.isArray(declared)) throw Object.assign(new Error('bundleSecrets.declared or env.declared (an array of { name, secret? }) is missing from the configuration'), { exitCode: 2 })
  const v = bundleVerdicts(root, { declared, envFile: c.envFile, staticDir: c.staticDir, chunksDir: c.chunksDir })
  if (!v.ran) { console.error(`bundle-secrets: ${v.reason}`); return 2 }
  console.log(`bundle-secrets: ${v.names} declared variables, ${v.checkedValues} values checked against the client bundle`)
  if (!v.leaked.length && !v.inlined.length) {
    console.log('  ok: no value in the client bundle, no name inlined out of the server chunks')
    return 0
  }
  for (const n of v.leaked) console.error(`  LEAK: ${n} — its value is in the static output, which is served to browsers`)
  for (const n of v.inlined) {
    console.error(`  INLINED: ${n} — the name does not appear in the server chunks, so the build may have replaced it with its ` +
      `build-time value. A runtime read of it would report the value the process started with, not the one the code uses.`)
  }
  return 1
}

function access(root, cfg, list) {
  const c = cfg.access ?? {}
  if (!c.primitive || !c.guards) throw Object.assign(new Error('access.primitive and access.guards are missing from the configuration'), { exitCode: 2 })
  const appDir = c.appDir ?? defaultAppDir(root)
  const v = accessVerdicts(root, accessFiles(root, appDir, { include: c.include, testFile: cfg.testFile }), { ...c, appDir })
  const pinned = new Set(asList(c.pinned))
  if (list) {
    for (const e of v.entries.sort((a, b) => a.file.localeCompare(b.file))) console.log(`${e.how ?? (pinned.has(e.file) ? 'PINNED' : 'CHECKS NOTHING')}\t${e.file}`)
    return 0
  }
  const bad = [
    say(`An entry that performs no permission check — call ${c.primitive}() or a guard, or declare why it checks nothing:`, v.silent),
    say('A forbidden name used outside the files allowed to mention it:', v.forbiddenUses),
    say('A file allowed to mention a forbidden name that no longer does — remove it from the list:', v.unusedAllowances),
    say('A pin that matches no unchecked entry — remove it:', v.unusedPins),
    say('A declaration for an entry that checks, or no longer exists — remove it:', v.unusedDeclared),
    say('A guard that performs no check:', v.problems),
  ].some(Boolean)
  if (bad && c.message) console.error(`\n${c.message}`)
  console.log(`access: ${v.entries.length} entries, ${v.entries.filter(e => e.how).length} check or are declared, ${pinned.size} pinned`)
  return bad ? 1 : 0
}

async function main() {
  const a = parseArgs(process.argv.slice(2))
  if (a.error) { console.error(`${a.error}\n${USAGE}`); return 2 }
  const cfg = await loadConfig(a.root, a.config)
  switch (a.command) {
    case 'addresses': return addresses(a.root, cfg, a.list)
    case 'env': return env(a.root, cfg)
    case 'bundle-secrets': return bundleSecrets(a.root, cfg)
    case 'access': return access(a.root, cfg, a.list)
  }
}

main().then(code => process.exit(code), e => {
  console.error(`source-gates: ${e.message}`)
  // Every error is "cannot run": a gate that stopped has judged nothing.
  process.exit(2)
})
