// Types for the source-gates library. The commands are documented in README.md.

/** A parsed source file from TypeScript 7's native parser (`typescript/unstable`). */
export type SourceFile = import('typescript/unstable/ast').SourceFile
export const is: typeof import('typescript/unstable/ast/is')
export const SyntaxKind: typeof import('typescript/unstable/ast').SyntaxKind
export function isStringLiteralLike(node: unknown): boolean
export class ParseError extends Error {}
export function parseSources(cwd: string, files: string[]): { sources: Map<string, SourceFile>; close(): void }

export const SOURCE_FILE: RegExp
export const DEFAULT_TEST_FILE: RegExp
export function isSourceFile(name: string): boolean
export function skipCommon(name: string): boolean
export function filesUnder(dir: string, rules?: { skip?: (name: string) => boolean; keep?: (name: string) => boolean }): string[]
export function fileSet(root: string, set: {
  include?: string[]
  includeFiles?: string[]
  exclude?: (RegExp | string)[]
  keep: (name: string) => boolean
  skip?: (name: string) => boolean
}): string[]

// ── addresses ──
export type Arm = 'url' | 'email' | 'bare-host' | 'zone' | 'ip' | 'port'
export type AddressHit = {
  arm: Arm
  literal: string
  host: string | null
  address?: string
  file?: string
  line?: number
  /** The syntactic parent: `jsx:href`, `prop:url`, `const:API`, a node kind, or a Python context. */
  ctx?: string
}
export function isReservedHost(host: string): boolean
export function hitsInText(text: string, opts: { wholeLiteral: boolean; inJsxText: boolean }): AddressHit[]
export function hitsInFiles(files: string[], root: string): AddressHit[]
export function urlsInFiles(files: string[], root: string): AddressHit[]
export function pyStrings(dir: string): { file: string; line: number; text: string; ctx: string }[]
export function pyHits(dir: string, root: string): AddressHit[]
export function pyAndTextUrls(dir: string): { file: string; line: number; url: string; ctx: string; how: string }[]
export function judgeAddresses(hits: AddressHit[], lists?: {
  allowedHosts?: Iterable<string>
  allowedAddresses?: Iterable<string>
  allowedLiterals?: Iterable<string>
  /** Keys `<file>|<literal>`. */
  pinned?: Iterable<string>
}): { findings: AddressHit[]; stale: string[]; counted: AddressHit[] }

// ── env ──
export type CodeVar = {
  file: string
  default?: string | number
  guarded?: boolean
  bare?: boolean
  /** Read outside every function somewhere (never set from a test file): it runs on import. */
  moduleScope?: boolean
}
export type Declaration = { name: string; secret?: boolean; warnUnused?: boolean }
export const DEFAULT_IGNORE: string[]
export function isRequired(v: CodeVar): boolean
export function codeVars(root: string, dirs: string[], opts?: { requiredHelpers?: Iterable<string>; testFile?: RegExp }): Map<string, CodeVar>
export function codeVarsOfFiles(root: string, files: string[], opts?: { requiredHelpers?: Iterable<string>; testFile?: RegExp }): Map<string, CodeVar>
export function judgeEnv(code: Map<string, CodeVar>, lists: { declared: Declaration[]; ignore?: Iterable<string> }): {
  undeclared: { name: string; file: string }[]
  unused: string[]
}

// ── bundle-secrets ──
export const MIN_SECRET_LEN: number
export function readEnvFile(path: string): Record<string, string>
export function defaultChunksDir(root: string): string
export function bundleVerdicts(root: string, opts: { declared: Declaration[]; envFile?: string; staticDir?: string; chunksDir?: string }):
  | { ran: false; reason: string }
  | { ran: true; names: number; checkedValues: number; leaked: string[]; inlined: string[] }

// ── access ──
type Listing<V> = Map<string, V> | Record<string, V>
export type AccessConfig = {
  appDir?: string
  include?: string[]
  primitive: string
  guards: Listing<{ file: string; refuses: boolean }>
  declared?: Listing<string>
  pinned?: Listing<string>
  forbiddenNames?: Listing<string[]>
  extraAnswer?: (arg: { file: string; root: string; sources: Map<string, SourceFile> }) => { reason: string; names?: string[] } | null
  message?: string
}
export type AccessEntry = {
  file: string
  /** `checks`, `layout <file>`, `declared: <reason>`, the extraAnswer reason, or `<own> · <reason>` when the entry passes on
   *  its own (checks, layout or declared) and extraAnswer answers too; null when it checks nothing. */
  how: string | null
  names: string[]
}
export function defaultAppDir(root: string): string
export function accessFiles(root: string, appDir?: string, opts?: { include?: string[]; testFile?: RegExp }): string[]
export function accessVerdicts(root: string, files: string[], config: AccessConfig): {
  entries: AccessEntry[]
  silent: string[]
  unusedPins: string[]
  unusedDeclared: string[]
  forbiddenUses: string[]
  unusedAllowances: string[]
  problems: string[]
}

// ── icons ──
export function iconVerdicts(root: string, files: string[], config?: {
  pattern?: RegExp | string
  wrappers?: Iterable<string>
  exempt?: Map<string, string> | Record<string, string>
}): { icons: number; bare: { file: string; line: number; tag: string }[]; selfLabelled: string[]; unusedExempt: string[] }

// ── literals ──
export type LiteralCount = { numbers: number; lists: number }
export function countLiterals(root: string, files: string[], opts?: { allowed?: Iterable<number> }): Record<string, LiteralCount>
export function totalOf(c: LiteralCount): number
export function judgeLiterals(counts: Record<string, LiteralCount>, baseline: Record<string, number>): { grew: string[]; fell: string[]; gone: string[] }
export function nextBaseline(counts: Record<string, LiteralCount>, baseline: Record<string, number>, renames?: Map<string, string>): {
  next: Record<string, number>
  raised: string[]
}

// ── the ratchet (literals, patterns) ──
export function gitRenames(root: string): Map<string, string>
export function judgeRatchet<C = number>(counts: Record<string, C>, baseline: Record<string, number>, how?: {
  total?: (c: C) => number
  describe?: (file: string, count: C, was: number) => string
}): { grew: string[]; fell: string[]; gone: string[] }
export function nextRatchet<C = number>(counts: Record<string, C>, baseline: Record<string, number>, renames?: Map<string, string>, how?: {
  total?: (c: C) => number
  first?: boolean
}): { next: Record<string, number>; raised: string[] }

// ── imports ──
export type ImportRule = { name: string; modules: string[]; allow: string[]; message?: string }
export type ImportHit = { file: string; line: number; specifier: string; module: string; rule: string; verdict: 'allowed' | 'pinned' | 'refused' }
/** `files` are absolute paths; each hit's `file` is relative to `root`. */
export function importVerdicts(root: string, files: string[], opts: {
  rules: ImportRule[]
  aliases?: Record<string, string>
  pinned?: Iterable<string> | Record<string, unknown> | Map<string, unknown>
}): { hits: ImportHit[]; stale: string[] }

// ── patterns ──
export type PatternRule = {
  match: (string | RegExp)[]
  include: string[]
  files?: string | RegExp
  exclude?: (RegExp | string)[]
  exempt?: string[]
  message?: string
}
/** `files` are paths relative to `root`, and so are the keys returned. */
export function countPatterns(root: string, files: string[], match: (string | RegExp)[]): {
  counts: Record<string, number>
  lines: Record<string, number[]>
}

// ── configuration ──
export const CONFIG_FILE: string
export type Config = {
  testFile?: RegExp
  addresses?: {
    include?: string[]
    includeFiles?: string[]
    exclude?: (RegExp | string)[]
    python?: string[]
    allowedHosts?: Iterable<string> | Record<string, unknown>
    allowedAddresses?: Iterable<string> | Record<string, unknown>
    allowedLiterals?: Iterable<string> | Record<string, unknown>
    pinned?: Iterable<string> | Record<string, unknown>
    message?: string
  }
  env?: { declared: Declaration[]; ignore?: Iterable<string>; include?: string[]; requiredHelpers?: string[] }
  bundleSecrets?: { declared?: Declaration[]; envFile?: string; staticDir?: string; chunksDir?: string }
  access?: AccessConfig
  icons?: { include?: string[]; exclude?: (RegExp | string)[]; pattern?: RegExp | string; wrappers?: string[]; exempt?: Record<string, string>; message?: string }
  literals?: { include?: string[]; exclude?: (RegExp | string)[]; allowed?: number[]; baseline?: string; message?: string }
  imports?: {
    rules: ImportRule[]
    aliases?: Record<string, string>
    pinned?: Iterable<string> | Record<string, unknown> | Map<string, unknown>
    include?: string[]
    includeFiles?: string[]
    exclude?: (RegExp | string)[]
    message?: string
  }
  patterns?: { rules: Record<string, PatternRule>; baseline?: string; message?: string }
}
export function loadConfig(root: string, file?: string): Promise<Config>
