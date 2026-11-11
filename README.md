# source-gates

Build gates that read your source as a syntax tree, so a comment is never a finding, and every hit is reported with
its syntactic context (`jsx:href`, `jsx:xmlns`, `prop:url`) for review.

| command | fails the build when | runs on |
|---|---|---|
| `addresses` | an address is written into the source: a URL, an e-mail address, a bare host name, an IP, a host-suffix test, a port | any JavaScript or TypeScript project; Python optional |
| `env` | the code reads an environment variable you have not declared | any JavaScript or TypeScript project |
| `bundle-secrets` | after `next build`: a secret's value is in the client bundle, or the build inlined a variable you read at runtime | a Next.js build |
| `access` | a page, route handler or server action checks no permission and is not declared as checking none | a Next.js App Router project |

Exceptions live in a short, reviewable list (with a reason for each when you use a `Map` or an object). A stale
exception silently permits the next mistake, so `addresses` fails on a pin that no longer matches a literal, and
`access` fails on a pin, declaration or forbidden-name allowance that no longer matches; `env` warns about a
declaration nothing reads. Allow-lists of hosts and addresses are not checked for staleness.

```sh
npm install --save-dev source-gates
npx source-gates addresses        # exit 0 clean, 1 on a finding, 2 when it cannot run (any error)
npx source-gates addresses --list # every hit and its verdict
```

Flags: `--list` (`addresses` and `access` only), `--root <dir>` (default: the current directory), `--config <file>`
(absolute, or relative to the root; default `source-gates.config.mjs`).

It needs Node 22.17 or later. It parses with TypeScript 7's native parser, pinned in its own dependencies, so your
project's TypeScript version does not matter.

## Configuration

Put `source-gates.config.mjs` in the project root. It is a module, so a list can be computed (read from another file,
say) rather than copied.

```js
export default {
  addresses: {
    include: ['src', 'scripts'],
    allowedHosts: ['api.stripe.com', 'www.w3.org'],      // third parties you mean to call, or namespaces
    allowedAddresses: ['billing@vendor.example'],         // third parties' e-mail addresses
    allowedLiterals: [],                                  // host-shaped strings that are not hosts
    pinned: [],                                           // '<file>|<literal>': known addresses tolerated for now;
                                                          // fails once the literal is gone
  },
  env: {
    include: ['src'],
    declared: [{ name: 'DATABASE_URL', secret: true }, { name: 'PORT' }, { name: 'SESSION_KEY', secret: true, warnUnused: false }],
    requiredHelpers: ['mustEnv'],                         // helpers that throw when the variable is absent
  },
  bundleSecrets: {},                                      // defaults to env.declared
  access: {
    primitive: 'can',                                     // your one permission check
    guards: { requireRole: { file: 'src/lib/auth.ts', refuses: true } },
    declared: { 'src/app/(public)/about/page.tsx': 'public: the about page' },
  },
}
```

The address lists (`allowedHosts`, `allowedAddresses`, `allowedLiterals`, `pinned`) may be an array, a `Set`, a `Map`
(its keys are the entries, its values the reasons) or a plain object. `access.guards`, `declared`, `pinned` and
`forbiddenNames` must be a `Map` or a plain object. `env.declared` must be an array.

### addresses

Configuration key: `addresses`. Why no list of domains to refuse: such a list only catches what someone remembered to
add. Instead every host is collected, and you review a short allow-list.

- **url** — a literal with a scheme; refused unless its host name (on any port) is in `allowedHosts`, reserved, or
  loopback.
- **email** — `local@host`, or `@host` alone in text; refused unless its host is reserved, its address is in
  `allowedAddresses`, or it is `@host` with an allowed host.
- **bare-host** — a whole string literal that is a host name, when its top-level label is one your URLs or allowed
  hosts use (so `orders.write` is not a host); refused unless allowed or in `allowedLiterals`.
- **zone** — a host name or a dot-led suffix (`'.internal'`) handed to `endsWith`, `includes` or `startsWith` on, or
  compared with, a value read as a host; refused unless allowed or reserved.
- **ip** — a whole string literal that is an IPv4 or IPv6 address, not loopback (`127.*`, `::1`). Like a port, only
  moving it to configuration or pinning it clears it.
- **port** — a number handed to `listen`, `connect`, `createServer` or `createConnection`, or written as `port:`. A
  port has no host, so only moving it to configuration or pinning it clears it.

Reserved names (RFC 2606, RFC 6761) always pass: the top-level labels `example`, `test`, `invalid`, `localhost`, and
`example.com`, `example.org`, `example.net`. Module specifiers are never addresses.

Keys: `include` (default `src`, `scripts`), `includeFiles` (single files, such as root configuration files),
`exclude` (patterns on the path relative to the root; default: test files — setting it replaces that default, so add
the test pattern yourself), `python` (directories whose `.py` string
constants are judged by the same rules, through Python's own parser; needs `python3`, and a `.py` file that does not
parse stops the gate), `message` (your own closing text on a failure).

### env

Configuration key: `env`. Every `process.env.X` and `process.env['X']` read, and every call to a helper in
`requiredHelpers` with a literal name, with its literal default, a `<computed>` fallback, whether it is guarded
(`X && …`, `if (X)`, `X ? :`, `!X`, a strict comparison, the right side of `??`), and whether it is read at module
scope (it runs on import). An undeclared read fails; a declaration no code reads warns, unless it says
`warnUnused: false` (a framework reads it).

Test files are read too: a variable read only by a test must still be declared. A test's read never marks a variable
as read at module scope.

Keys: `declared` (required), `include` (default `src`; a directory that does not exist is skipped, but if none
exists the gate cannot run), `ignore` (default `NODE_ENV`, `NEXT_RUNTIME`), `requiredHelpers`. `isRequired(v)` in the library says whether a deployment must hold a variable: read bare
somewhere (test files included), never guarded, no default anywhere.

### bundle-secrets

Configuration key: `bundleSecrets`. Run after `next build`.

- **Leak** — the value of a variable declared `secret: true` (not `NEXT_PUBLIC_*`, at least 16 characters) appears in
  `.next/static`, which is served to browsers.
- **Inlined** — a declared variable's name does not appear in the server chunks: either the build replaced
  `process.env.NAME` with its build-time value (changing the variable at runtime then has no effect), or no server
  code reads it. `NEXT_PUBLIC_*` names (inlined by design) and names declared `warnUnused: false` (read by a
  framework, the edge runtime or a script) are not checked for this.

Values are read from `envFile` only, never from the process environment: with no such file, no value is compared
(the gate prints `0 values checked`). Names are matched as whole words, so `PORT` does not appear inside `REPORT`.
It prints names and verdicts, never a value. Keys: `declared` (default `env.declared`), `envFile` (default
`.env.local`), `staticDir` (default `.next/static`), `chunksDir` (default the standalone build's
`.next/standalone/.next/server/chunks` when it exists, else `.next/server/chunks`).

### access

Configuration key: `access`. With role-based access control every entry point must check a permission. An **entry**
is a `page` or `route` file, or a file whose directive prologue holds `'use server'` (comments before it allowed),
under the app directory (`src/app`, else `app`; if it does not exist the gate cannot run). Server-action files outside
the app directory are not read as entries. An entry passes when:

- its own code checks a permission — a check anywhere in the file passes the whole file, every server action and HTTP
  method in it included;
- a checking `layout` above it covers it — pages only: a route handler or a server action is an HTTP endpoint that
  runs without rendering a layout;
- your `extraAnswer` function returns a reason for it; or
- it is in `declared`, with its reason.

A **refuser** guard (`refuses: true`) refuses by itself, so calling it counts. A **question** (your `primitive`, or a
guard with `refuses: false`) counts where an `if` that tests its result — directly, or through a variable assigned
from it — has a then-branch that returns, throws, or calls `notFound`, `forbidden`, `unauthorized`, `redirect` or
`permanentRedirect`. This is a heuristic: any return in that branch counts, a refusal in an `else` branch is not seen,
and variables are matched by name within the file. A check that only decides whether a link shows does not count.
Each guard's own body must call the primitive or another guard, so listing a function as a guard cannot exempt an
entry that never really checks.

Known gaps, all of a file-level reading: a server action declared inline inside a page is not a separate entry and
takes the page's verdict, although neither the page's check nor its layout's runs when the action is called; one
checked export passes its whole file; and server-action files outside the app directory are not read.

Keys: `primitive` (required), `guards` (required), `declared`, `pinned` (entries known not to check a permission yet,
each with a reason, such as an issue link), `forbiddenNames` (`{ name: [files allowed to mention it] }`: any mention of
the name outside those files fails, type annotations included — for a privileged flag or a column that must decide
nothing), `appDir`, `include` (the directories read for entries and guards; default the one holding the app
directory), `extraAnswer({ file, root, sources })` returning `{ reason, names } | null`, `message`.

In the library, `accessVerdicts` returns each entry with `how`: `checks`, `layout <file>`, `declared: <reason>`, the
`extraAnswer` reason, or `<own> · <reason>` when the entry passes on its own (checks, layout or declared) and
`extraAnswer` answers too; `null` when it checks nothing.

## Library

```js
import { hitsInFiles, judgeAddresses, codeVars, judgeEnv, accessVerdicts } from 'source-gates'
```

Every judging function takes its lists as arguments; see `index.d.ts`. A top-level `testFile` key (a regular
expression; default `*.test.*` and `*.spec.*`) sets what the commands treat as a test file: `access` leaves test
files out, `addresses` leaves them out unless you set `addresses.exclude`, and `env` reads them but never counts a
test's read as module scope.

## Licence

Apache License 2.0. See `LICENSE` and `NOTICE`.
