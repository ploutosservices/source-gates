#!/usr/bin/env node
// source-gates <command> [--list] [--root <dir>] [--config <file>]
//   addresses       no hard-coded address in the source
//   env             every environment variable the code reads is declared
//   bundle-secrets  after `next build`: no secret in the client bundle, no declared name inlined
//   access          every Next.js App Router entry checks a permission, or is declared
//   icons           every icon a React tree renders is inside a tooltip
//   literals        numbers and lists written into the named files may only fall (--write-baseline to record a fall)
//   imports         named modules are value-imported only by the files a rule allows
//   patterns        lines matching a rule's expressions may only fall (--write-baseline to record a fall)
// Exit 0 clean, 1 on a finding, 2 when it cannot run.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { iconVerdicts } from '../src/icons.mjs'
import { countLiterals, judgeLiterals, nextBaseline, gitRenames, totalOf } from '../src/literals.mjs'
import { importVerdicts } from '../src/imports.mjs'
import { countPatterns } from '../src/patterns.mjs'
import { judgeRatchet, nextRatchet } from '../src/ratchet.mjs'
import { loadConfig } from '../src/config.mjs'
import { fileSet, isSourceFile, DEFAULT_TEST_FILE } from '../src/files.mjs'
import { hitsInFiles, pyHits, judgeAddresses } from '../src/addresses.mjs'
import { codeVars, judgeEnv, DEFAULT_IGNORE } from '../src/env.mjs'
import { bundleVerdicts } from '../src/bundle-secrets.mjs'
import { accessVerdicts, accessFiles, defaultAppDir } from '../src/access.mjs'

const USAGE = `usage: source-gates <addresses|env|bundle-secrets|access|icons|literals|imports|patterns> [--list] [--write-baseline] [--root <dir>] [--config <file, absolute or relative to the root>]`
const COMMANDS = new Set(['addresses', 'env', 'bundle-secrets', 'access', 'icons', 'literals', 'imports', 'patterns'])
const LISTS = new Set(['addresses', 'access', 'icons', 'literals', 'imports', 'patterns'])
const RATCHETS = new Set(['literals', 'patterns'])

function parseArgs(argv) {
  const [command, ...rest] = argv
  if (!COMMANDS.has(command)) return { error: command ? `unknown command: ${command}` : 'no command' }
  const out = { command, list: false, writeBaseline: false, root: process.cwd(), config: undefined }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--list' && LISTS.has(command)) out.list = true
    else if (a === '--write-baseline' && RATCHETS.has(command)) out.writeBaseline = true
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

function icons(root, cfg, list) {
  const c = cfg.icons ?? {}
  const files = fileSet(root, {
    include: c.include ?? ['src'],
    exclude: c.exclude ?? [cfg.testFile ?? DEFAULT_TEST_FILE],
    keep: n => /\.(tsx|jsx)$/.test(n),
  })
  const v = iconVerdicts(root, files, c)
  if (list) {
    console.log(`${v.icons} icon element(s); labelling themselves: ${v.selfLabelled.join(', ') || 'none'}`)
    for (const b of v.bare) console.log(`BARE  ${b.file}:${b.line}  <${b.tag}>`)
    return 0
  }
  const wrappers = [...(c.wrappers ?? ['Tooltip'])].map(w => `<${w}>`).join(' or ')
  const bad = [
    say(`Icons not inside ${wrappers} — wrap each and say what the icon means, e.g. "saved, awaiting review", not what it looks like, e.g. "green circle":`,
      v.bare.map(b => `${b.file}:${b.line}  <${b.tag}>`)),
    say('An exemption for a file that renders no icon — remove it:', v.unusedExempt),
  ].some(Boolean)
  if (bad && c.message) console.error(`\n${c.message}`)
  console.log(`icons: ${v.icons} icon element(s), ${v.bare.length} without ${wrappers}`)
  return bad ? 1 : 0
}

function literals(root, cfg, list, writeBaseline) {
  const c = cfg.literals ?? {}
  const files = fileSet(root, {
    include: c.include ?? ['src'],
    exclude: c.exclude ?? [cfg.testFile ?? DEFAULT_TEST_FILE],
    keep: isSourceFile,
  }).map(f => f.slice(root.length + 1).split('\\').join('/'))
  const baselinePath = join(root, c.baseline ?? 'source-gates.literals.json')
  const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : {}
  const counts = countLiterals(root, files, { allowed: c.allowed })
  if (list) {
    for (const [f, n] of Object.entries(counts)) if (totalOf(n) > 0) console.log(`${totalOf(n)}\t${f}`)
    return 0
  }
  if (writeBaseline) {
    const { next, raised } = nextBaseline(counts, baseline, gitRenames(root))
    if (say('The baseline is never raised. These grew:', raised)) return 1
    writeFileSync(baselinePath, JSON.stringify(next, null, 2) + '\n')
    console.log(`literals: baseline written — ${Object.keys(next).length} files, ${Object.values(next).reduce((a, b) => a + b, 0)} literals`)
    return 0
  }
  const { grew, fell, gone } = judgeLiterals(counts, baseline)
  const bad = [
    say('A number or list was written into these files. Move it to a module that names it, or for layout to your styles:', grew),
    say('A count fell — record the gain in this change (source-gates literals --write-baseline):', fell),
    say('The baseline names files that are gone — a rename carries its count (--write-baseline reads git\'s renames):', gone),
  ].some(Boolean)
  if (bad && c.message) console.error(`\n${c.message}`)
  const n = Object.values(counts).reduce((a, x) => a + totalOf(x), 0)
  console.log(`literals: ${n} literals in ${Object.keys(counts).length} files, ${grew.length} grown`)
  return bad ? 1 : 0
}

const cannot = msg => Object.assign(new Error(msg), { exitCode: 2 })

/** A gate that walks nothing reads green on nothing: at least one include directory must exist. */
const needOne = (root, include, what) => {
  if (!include.some(d => existsSync(join(root, d)))) throw cannot(`${what}: none of its include directories exists (${include.join(', ')})`)
}

function imports(root, cfg, list) {
  const c = cfg.imports ?? {}
  if (!Array.isArray(c.rules) || !c.rules.length) throw cannot('imports.rules (a list of { name, modules, allow }) is missing from the configuration')
  for (const r of c.rules) {
    if (!r?.name || !Array.isArray(r.modules) || !Array.isArray(r.allow)) throw cannot('each imports rule needs a name, a modules list and an allow list')
  }
  needOne(root, c.include ?? ['src'], 'imports')
  const files = fileSet(root, {
    include: c.include ?? ['src'],
    includeFiles: c.includeFiles ?? [],
    exclude: c.exclude ?? [cfg.testFile ?? DEFAULT_TEST_FILE],
    keep: isSourceFile,
  })
  const { hits, stale } = importVerdicts(root, files, { rules: c.rules, aliases: c.aliases, pinned: c.pinned })
  if (list) {
    for (const h of hits) console.log(`${h.verdict.toUpperCase().padEnd(8)} ${h.rule}  ${h.file}:${h.line}  ${h.specifier}`)
    console.log(`\n${hits.length} imports of a ruled module`)
    return 0
  }
  const refused = hits.filter(h => h.verdict === 'refused')
  const bad = [
    say('Pinned entries that match no import any more. A pin that matches nothing permits the next import silently; delete these:', stale),
    say('A module imported outside the files its rule allows. Call the layer that may import it, or pin the file as "<file>|<rule>" with the reason it is still there:',
      refused.map(h => `${h.file}:${h.line}  ${h.specifier}  (rule ${h.rule}${c.rules.find(r => r.name === h.rule)?.message ? ': ' + c.rules.find(r => r.name === h.rule).message : ''})`)),
  ].some(Boolean)
  if (bad && c.message) console.error(`\n${c.message}`)
  console.log(`imports: ${hits.length} imports of a ruled module, ${refused.length} refused, ${hits.filter(h => h.verdict === 'pinned').length} pinned`)
  return bad ? 1 : 0
}

function patterns(root, cfg, list, writeBaseline) {
  const c = cfg.patterns ?? {}
  const rules = Object.entries(c.rules ?? {})
  if (!rules.length) throw cannot('patterns.rules (a map of name → { match, include }) is missing from the configuration')
  const baselinePath = join(root, c.baseline ?? 'source-gates.patterns.json')
  const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : null
  const next = {}, problems = []
  let total = 0, grown = 0
  // A baseline entry for a rule the configuration no longer holds would never be judged again.
  const goneRules = Object.keys(baseline ?? {}).filter(n => !(c.rules ?? {})[n])
  if (!writeBaseline) problems.push(['The baseline holds rules the configuration no longer has — record the baseline again (--write-baseline):', goneRules])
  for (const [name, r] of rules) {
    if (!Array.isArray(r?.match) || !r.match.length || !Array.isArray(r.include) || !r.include.length) {
      throw cannot(`patterns rule ${name} needs a match list and an include list`)
    }
    needOne(root, r.include, `patterns rule ${name}`)
    // A rule's first write records today's counts; once the baseline holds the rule, it is never raised. The rule's
    // presence decides, not the file's: a rule added later can be recorded, and an all-zero rule is kept as {}.
    const first = !baseline || !(name in baseline)
    // Without the g and y flags, which would carry lastIndex from one file name to the next and skip files.
    const keepName = r.files
      ? (rx => n => rx.test(n))(r.files instanceof RegExp ? new RegExp(r.files.source, r.files.flags.replace(/[gy]/g, '')) : new RegExp(r.files))
      : isSourceFile
    const exempt = new Set(r.exempt ?? [])
    const files = fileSet(root, {
      include: r.include,
      exclude: r.exclude ?? [cfg.testFile ?? DEFAULT_TEST_FILE],
      keep: keepName,
    }).map(f => f.slice(root.length + 1).split('\\').join('/')).filter(f => !exempt.has(f))
    const { counts, lines } = countPatterns(root, files, r.match)
    const ruleTotal = Object.values(counts).reduce((a, b) => a + b, 0)
    total += ruleTotal
    if (list) {
      for (const [f, ls] of Object.entries(lines)) console.log(`${name}\t${f}:${ls.join(',')}`)
      continue
    }
    const goneExempt = [...exempt].filter(f => !existsSync(join(root, f)))
    if (writeBaseline) {
      const n = nextRatchet(counts, baseline?.[name] ?? {}, gitRenames(root), { first })
      problems.push([`The baseline is never raised. These grew under ${name}:`, n.raised])
      next[name] = n.next
      continue
    }
    const { grew, fell, gone } = judgeRatchet(counts, baseline?.[name] ?? {}, {
      describe: (f, n, was) => `${f}: ${n}, baseline ${was} (lines ${lines[f].join(', ')})`,
    })
    grown += grew.length
    problems.push(
      [first
        ? `${name}: no baseline holds this rule yet — record today's counts with source-gates patterns --write-baseline:`
        : `${name}: a line matching the rule was added${r.message ? ` — ${r.message}` : ''}:`, grew],
      [`${name}: a count fell — record the gain in this change (source-gates patterns --write-baseline):`, fell],
      [`${name}: the baseline names files no longer counted (gone, exempt or excluded) — record the baseline again; a rename carries its count (--write-baseline reads git's renames):`, gone],
      [`${name}: exempt files that are gone — remove them from the rule:`, goneExempt],
    )
  }
  if (list) { console.log(`\npatterns: ${total} matching lines`); return 0 }
  const bad = problems.map(([t, l]) => say(t, l)).some(Boolean)
  if (writeBaseline) {
    if (bad) return 1
    writeFileSync(baselinePath, JSON.stringify(next, null, 2) + '\n')
    console.log(`patterns: baseline written — ${rules.length} rules, ${total} matching lines`)
    return 0
  }
  if (bad && c.message) console.error(`\n${c.message}`)
  console.log(`patterns: ${rules.length} rules, ${total} matching lines, ${grown} files grown`)
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
    case 'icons': return icons(a.root, cfg, a.list)
    case 'literals': return literals(a.root, cfg, a.list, a.writeBaseline)
    case 'imports': return imports(a.root, cfg, a.list)
    case 'patterns': return patterns(a.root, cfg, a.list, a.writeBaseline)
  }
}

main().then(code => process.exit(code), e => {
  console.error(`source-gates: ${e.message}`)
  // Every error is "cannot run": a gate that stopped has judged nothing.
  process.exit(2)
})
