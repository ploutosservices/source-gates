// THE ADDRESSES GATE: every address the source carries, found by parsing, not by matching lines.
//
// Why no list of domains to refuse: a list of what to refuse only catches what someone remembered to add, and a domain
// bought tomorrow is invisible to it. So every host is collected, and the ALLOWED list — the third parties the code
// deliberately calls — is the reviewable thing. Any URL, e-mail address, zone or IP not allowed and not pinned is a
// finding, whatever its domain; a bare host name counts when its top-level domain is one the code's URLs use.
//
// Why a syntax tree and not grep:
//   · Comments are not nodes, so an address in a comment is never a finding.
//   · Concatenation and template literals are seen as the pieces they are.
//   · Every hit carries its syntactic context, printed so a reviewer can tell a link (`jsx:href`) from a look-alike
//     (`jsx:xmlns`, `jsx:placeholder`). The verdict does not use it: a namespace's host is allowed explicitly.
//
// The arms:
//   url        a literal with a scheme; its host name (any port) must be allowed, reserved or loopback
//   email      `local@host`, or `@host` alone in text; refused unless its host is reserved, its address is allowed,
//              or it is `@host` with an allowed host
//   bare-host  a literal that is a whole hostname whose top label the tree's own URLs (or the allowed hosts) use
//   zone       a host-shaped literal handed to endsWith/includes/startsWith on, or compared with, a value read as a host
//   ip         a literal that is a whole IPv4 or IPv6 address, not loopback; like a port, only a pin clears it
//   port       a number handed to listen/connect/createServer/createConnection, or written as a `port:` property; it has
//              no host, so only a pin clears it
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isIP } from 'node:net'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSources, is, SyntaxKind, ParseError } from './parse.mjs'

const PY = join(dirname(fileURLToPath(import.meta.url)), 'py-strings.py')

// Reserved names (RFC 2606, RFC 6761): nobody's server answers at them.
const RESERVED_TOP = new Set(['example', 'test', 'invalid', 'localhost'])
const RESERVED_DOMAINS = /(^|\.)example\.(com|org|net)$/i

const URLISH = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`)<>\\]+/gi
const EMAILISH = /([A-Za-z0-9._%+-]*)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})(?![A-Za-z0-9-])/g
const HOSTNAME = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i

const topLabel = host => host.split(':')[0].split('.').pop().toLowerCase()
const isLoopback = host => /^127\.|^::1$/.test(host)
export const isReservedHost = host => RESERVED_TOP.has(topLabel(host)) || RESERVED_DOMAINS.test(host.split(':')[0])

function context(n) {
  const p = n.parent
  if (!p) return ''
  if (is.isJsxAttribute(p)) return `jsx:${p.name.getText()}`
  if (is.isJsxExpression(p) && p.parent && is.isJsxAttribute(p.parent)) return `jsx:${p.parent.name.getText()}`
  if (is.isPropertyAssignment(p)) return `prop:${p.name.getText()}`
  if (is.isVariableDeclaration(p)) return `const:${p.name.getText()}`
  return SyntaxKind[p.kind]
}

/** Does this expression read a host: `.host`, `.hostname`, a header named host, a variable named for one? */
function readsHost(e) {
  return /\bhost(name)?\b|x-forwarded-host|headers\.get\(\s*['"]host['"]\)/i.test(e.getText())
}

function isZoneUse(n) {
  const p = n.parent
  if (!p) return false
  if (is.isCallExpression(p) && is.isPropertyAccessExpression(p.expression)) {
    const name = p.expression.name.getText()
    if ((name === 'endsWith' || name === 'includes' || name === 'startsWith') && readsHost(p.expression.expression)) return true
  }
  if (is.isBinaryExpression(p)) {
    const op = p.operatorToken.kind
    const cmp = op === SyntaxKind.EqualsEqualsEqualsToken || op === SyntaxKind.ExclamationEqualsEqualsToken ||
      op === SyntaxKind.EqualsEqualsToken || op === SyntaxKind.ExclamationEqualsToken
    const other = p.left === n ? p.right : p.left
    if (cmp && readsHost(other)) return true
  }
  return false
}

function isPortUse(n) {
  const p = n.parent
  if (!p) return false
  if (is.isCallExpression(p) && p.arguments.includes(n)) {
    if (/(^|\.)(listen|connect|createConnection|createServer)$/.test(p.expression.getText())) return true
  }
  if (is.isPropertyAssignment(p) && /^['"]?port['"]?$/i.test(p.name.getText())) return true
  return false
}

/** Every address-shaped hit in one text: the shared rules, for TypeScript nodes and Python strings alike. */
export function hitsInText(text, { wholeLiteral, inJsxText }) {
  const out = []
  for (const m of String(text).matchAll(URLISH)) {
    // The host name alone: an allowed host is allowed on any port.
    let host = null
    try { host = new URL(m[0]).hostname.replace(/^\[(.*)\]$/, '$1') } catch { /* the host is built from a substitution */ }
    out.push({ arm: 'url', literal: m[0], host })
  }
  const withoutUrls = String(text).replace(URLISH, ' ')
  for (const m of withoutUrls.matchAll(EMAILISH)) {
    out.push({ arm: 'email', literal: m[0], host: m[2].toLowerCase(), address: m[0].toLowerCase() })
  }
  if (wholeLiteral) {
    const t = String(text).trim()
    const bare = t.replace(/^\[(.*)\]$/, '$1').replace(/^(\d+\.\d+\.\d+\.\d+):\d{1,5}$/, '$1')
    if (isIP(bare)) out.push({ arm: 'ip', literal: t, host: bare })
    else if (HOSTNAME.test(t) && !inJsxText) out.push({ arm: 'bare-host', literal: t, host: t.toLowerCase() })
  }
  return out
}

function hitsInSource(file, src, root) {
  const hits = []
  const rel = relative(root, file).split('\\').join('/')
  const at = n => src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1
  const visit = n => {
    let text = null, whole = false, jsx = false
    if (is.isStringLiteral(n) || is.isNoSubstitutionTemplateLiteral(n)) { text = n.text; whole = true }
    else if (is.isTemplateHead(n) || is.isTemplateMiddle(n) || is.isTemplateTail(n)) text = n.text
    else if (is.isJsxText(n)) { text = n.getText(); jsx = true }
    // A module specifier is never an address.
    const specifier = n.parent && (is.isImportDeclaration(n.parent) || is.isExportDeclaration(n.parent) ||
      (is.isCallExpression(n.parent) && n.parent.expression.kind === SyntaxKind.ImportKeyword))
    if (text !== null && !specifier) {
      for (const h of hitsInText(text, { wholeLiteral: whole, inJsxText: jsx })) {
        if (h.arm === 'bare-host' && isZoneUse(n)) h.arm = 'zone'
        hits.push({ ...h, file: rel, line: at(n), ctx: context(n) })
      }
      // A zone suffix may start with a dot, which is no hostname: '.internal' handed to endsWith against a host.
      if (whole && /^\.[a-z0-9-]+(\.[a-z0-9-]+)*$/i.test(text) && isZoneUse(n)) {
        hits.push({ arm: 'zone', literal: text, host: text.slice(1).toLowerCase(), file: rel, line: at(n), ctx: context(n) })
      }
    }
    if (is.isNumericLiteral(n) && isPortUse(n)) {
      hits.push({ arm: 'port', literal: n.getText(), host: null, file: rel, line: at(n), ctx: context(n) })
    }
    n.forEachChild(visit)
  }
  src.forEachChild(visit)
  return hits
}

/** Every hit in the given TS/TSX/JS/MJS files (absolute paths). */
export function hitsInFiles(files, root) {
  if (!files.length) return []
  const parsed = parseSources(root, files)
  try {
    return files.flatMap(f => hitsInSource(f, parsed.sources.get(f), root))
  } finally {
    parsed.close()
  }
}

/** The URL hits alone. */
export function urlsInFiles(files, root) {
  return hitsInFiles(files, root).filter(h => h.arm === 'url')
}

function python(args) {
  try {
    return JSON.parse(execFileSync('python3', [PY, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))
  } catch (e) {
    if (e.code === 'ENOENT') throw Object.assign(new Error('python3 is not on PATH, and the configuration asks for Python files to be read'), { exitCode: 2 })
    throw e
  }
}

/** Every string constant of the .py files under `dir` (absolute), through Python's own parser. Throws (exit 2) when a
 * file does not parse: a gate that skips what it cannot read passes it. */
export function pyStrings(dir) {
  if (!existsSync(dir)) return []
  const { strings, unparsed } = python(['--strings', dir])
  if (unparsed.length) {
    throw new ParseError(`Python could not parse ${unparsed.length} file(s):\n  ${unparsed.map(u => `${u.file}: ${u.error}`).join('\n  ')}`)
  }
  return strings
}

/** URL-shaped text in .py (parsed) and .sh/.bash/.yml/.yaml (as text, labelled so) under `dir`. A report, never a gate. */
export function pyAndTextUrls(dir) {
  if (!existsSync(dir)) return []
  return python(['--urls', dir])
}

/** Every Python string under `dir`, judged by the same arms. */
export function pyHits(dir, root) {
  return pyStrings(dir).flatMap(s => hitsInText(s.text, { wholeLiteral: true, inJsxText: false })
    .map(h => ({ ...h, file: relative(root, s.file).split('\\').join('/'), line: s.line, ctx: s.ctx })))
}

/**
 * Judge every hit. Returns the findings, the pins nothing earns, and every hit that counted before pins.
 * @param {object[]} hits
 * @param {{ allowedHosts?: Iterable<string>, allowedAddresses?: Iterable<string>, allowedLiterals?: Iterable<string>, pinned?: Iterable<string> }} lists
 *   each an iterable of keys (a Map's keys, a Set, an array); `pinned` keys are `<file>|<literal>`
 */
export function judgeAddresses(hits, lists = {}) {
  const allowed = new Set([...(lists.allowedHosts ?? [])].map(h => h.toLowerCase()))
  const addresses = new Set([...(lists.allowedAddresses ?? [])].map(a => a.toLowerCase()))
  const literals = new Set([...(lists.allowedLiterals ?? [])].map(l => l.toLowerCase()))
  const pinned = new Set(lists.pinned ?? [])
  const tops = new Set()
  for (const h of hits) if (h.arm === 'url' && h.host) tops.add(topLabel(h.host))
  for (const a of allowed) if (a.includes('.')) tops.add(topLabel(a))
  for (const r of RESERVED_TOP) tops.delete(r)
  const pinKey = h => `${h.file}|${h.literal}`
  const counted = hits.filter(h => {
    switch (h.arm) {
      case 'url': return !!h.host && !allowed.has(h.host.toLowerCase()) && !isReservedHost(h.host) && !isLoopback(h.host)
      case 'email': return !isReservedHost(h.host) && !addresses.has(h.address)
        && !(h.address.startsWith('@') && allowed.has(h.host))
      case 'bare-host': return !allowed.has(h.host) && !literals.has(h.host) && !isReservedHost(h.host) && tops.has(topLabel(h.host))
      case 'zone': return !allowed.has(h.host) && !isReservedHost(h.host)
      case 'ip': return !isLoopback(h.host)
      default: return true
    }
  })
  const findings = counted.filter(h => !pinned.has(pinKey(h)))
  const used = new Set(counted.map(pinKey))
  const stale = [...pinned].filter(k => !used.has(k))
  return { findings, stale, counted }
}
