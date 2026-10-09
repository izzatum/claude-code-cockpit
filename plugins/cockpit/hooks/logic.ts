// Pure helpers: no `$`, so tests run them directly.
import type { McpHealth, RateLimit, Snapshot } from '../types'

export type Verdict = { deny: string } | { warn: string } | undefined

// Folders a sync client uploads as they change: Dropbox, iCloud Drive, Google Drive, OneDrive.
// The bare names also match `Dropbox (Team)`, `OneDrive - Org`, shell-escaped spaces and
// Windows backslashes. Case-sensitive on purpose: a `dropbox` SDK folder is not the sync root.
const SYNCED =
  /[\/\\]Library[\/\\](CloudStorage[\/\\](Dropbox|GoogleDrive|OneDrive)|Mobile\\? Documents)|(^|[\/\\\s"'=({,\x60])(Dropbox( \([^)\/\\]*\))?|OneDrive( - [^\/\\"']*)?|Google\\? Drive)(?=$|[\/\\\s"';&|)<>},\x60])/

// Where a command word starts: the line, after ; & | ( { ` $( or !, after a keyword or
// wrapper (if, then, do, sudo, xargs, time, find -exec…), inside `sh -lc '…'` / `eval "…"`,
// past `VAR=value` assignments, and past the command's own path (`/bin/rm`). So `rm -r`
// quoted in a commit message, grep pattern or echo is not a command. Every step is bounded
// (10 words or options, 200 characters of a value or path part, the path stops at ( { !)
// or splits one way only, so long code or data cannot stall the match.
const CMD = String.raw`(?:^|[;&|\n({!\x60]|\$\(|-exec(?:dir)?\s|\b(?:if|elif|then|do|else|while|until|time|nohup|builtin|command|exec|eval)(?:\s+-\S+){0,10}\s|\b(?:sudo|doas|env|nice|timeout|xargs)(?:\s+[^\s;&|]+){0,10}?\s|\b(?:ba|z|da|k)?sh(?:\s+-[a-zA-Z]+){0,10}\s+-[a-zA-Z]*c[a-zA-Z]*(?:\s+--)?\s)\s*(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|[^\s;&|"']{0,200})\s+){0,10}["']?\\?(?:[^\s;&|"'\x60(){}!/]{0,200}\/)*`
// Up to 10 of git's global options, those whose value stands apart (`-C dir`) too.
const GIT_ARG = String.raw`(?:-c|--(?:git-dir|work-tree|namespace|exec-path|super-prefix|config-env))(?=\s)`
const GIT = String.raw`git\s+(?:${GIT_ARG}\s+(?:"[^"]*"|'[^']*'|[^\s"']\S*)\s+|(?!${GIT_ARG})--?\w[\w-]*(?:=\S*)?\s+){0,10}`
// A recursive flag anywhere in this rm (before `--`), except `git rm --cached` (index-only).
const RM = String.raw`rm["']?(?=\s)(?![^;&|\n]*--cached\b)(?:(?!\s--\s)[^;&|\n])*?\s["']?(?:-[a-z]*r[a-z]*|--recursive)\b`
const FIND = String.raw`find\s[^;&|\n]*\s-delete\b`
const RSYNC = String.raw`rsync\s[^;&|\n]*\s--delete`
const GIT_CLEAN = String.raw`clean\b(?![^;&|\n]*\s(?:-[a-z]*n|--dry-run\b))[^;&|\n]*\s(?:-[a-z]*f|--force\b)`
// ponytail: regex over shell text, a tripwire, not a sandbox. Misses symlinks, globs,
// lowercase paths, flags in variables, aliases, in-word escapes (r\m) and scripts
// (python, node, mv out of the folder). Each `rm`, `find` or `rsync` that starts a command
// scans the rest of its segment, so quoted prose full of `(rm ` or `do rm` stays quadratic.
// A shell tokenizer if it ever matters.
const DELETE = new RegExp(`${CMD}(?:${RM}|${FIND}|${RSYNC})|${CMD}${GIT}(?:${RM}|${GIT_CLEAN})`, 'i')
const HEAVY = new RegExp(
  CMD +
    String.raw`(?:(?:npm|pnpm|yarn|bun)\s+(?:install|i|ci|add|(?:run(?:-script)?\s+)?build)\b|yarn(?:\s+--?[\w-]+)*\s*(?=$|[;&|\n)])|pip3?\s+install\b|cargo\s+build\b)`,
)
// A heredoc opener (`<<EOF`, `<<-'EOF'`), not a here-string (`<<<`).
const OPENER = /(?<!<)<<(?!<)-?[ \t]*(['"]?)(\w+)\1/g
// A shell that reads the body: one standing as a command word, not a name such as `clean.sh`.
const SHELL = new RegExp(CMD + String.raw`(?:(?:ba|z|da|k)?sh|eval|source)\b`, 'i')

const DENY =
  'cockpit: recursive delete inside a cloud-synced folder is blocked: the sync app would delete it on every device. Do not retry another way (find -delete, rsync, mv, a script). Tell the user what you wanted to delete and let them do it.'
const DENY_PROTECTED =
  'cockpit: recursive delete in or above a folder the user protected (cockpit guardPaths or desktopSync) is blocked. Do not retry another way (find -delete, rsync, mv, a script). Tell the user what you wanted to delete and let them do it.'
export const GUARD_FAILED =
  'cockpit: the cloud-sync guard could not check this recursive delete, so it was not run. Tell the user what you wanted to delete and let them do it.'

// The command without heredoc bodies, which are data unless a shell reads them (`bash <<EOF`,
// `<<EOF | sh`). One pass over the lines, so a long command cannot stall the guard; a body
// that never closes stays in, as code.
function code(command: string): string {
  if (!command.includes('<<')) return command
  const kept: string[] = []
  let body: string[] = []
  let ends: string[] = [] // closing words still to come
  let isData = false
  for (const line of command.split('\n')) {
    if (!ends.length) {
      kept.push(line)
      ends = Array.from(line.matchAll(OPENER), m => String(m[2]))
      isData = !SHELL.test(line)
      continue
    }
    if (isData) body.push(line)
    else kept.push(line)
    if (line.trim() === ends[0]) ends.shift()
    if (!ends.length) body = []
  }
  return kept.concat(body).join('\n')
}

// Fails closed: a guard that cannot read the cwd still refuses any recursive delete.
export const isRecursiveDelete = (command: string): boolean => DELETE.test(code(command))

// Folders from settings, as matchers: `synced` count as the sync apps' own (deletes blocked,
// installs warned), `protected` only block recursive deletes, and `above` (the folders over
// either) block them too, since deleting a parent deletes the folder.
export type Guard = { synced?: RegExp; protected?: RegExp; above?: RegExp }

// A word that may be a path relative to the cwd: `work`, `../work`, `./x` (not ~, / or $).
const RELATIVE = /(?<![^\s=({,])[\w.][^\s;&|()<>{},\x60]*/g

export function syncVerdict(command: string, cwd: string, guard: Guard = {}): Verdict {
  const run = code(command)
  // Quotes and space escapes gone, so `"$HOME"/work`, `~/'work'` and `My\ Projects` read as paths.
  const bare = run.replace(/\\(?=\s)/g, '').replace(/["']/g, '')
  // Relative words on the cwd, so `rm -rf work` from ~ or `rm -rf ../work` names ~/work.
  const near = (bare.match(RELATIVE) ?? []).map(word => joinPath(cwd, word))
  const names = (re?: RegExp) => !!re && (re.test(cwd) || re.test(bare) || near.some(p => re.test(p)))
  const isSynced = names(SYNCED) || names(guard.synced)
  if (!isSynced && !names(guard.protected) && !names(guard.above)) return undefined
  if (DELETE.test(run)) return { deny: isSynced ? DENY : DENY_PROTECTED }
  if (isSynced && HEAVY.test(run)) {
    return { warn: 'cockpit: cloud-synced folder: installs and builds here upload node_modules and build output. A local, unsynced clone avoids it.' }
  }
  return undefined
}

// cwd + "../work" -> the folder it names, `.` and `..` folded (no Node here for path.resolve).
export function joinPath(cwd: string, word: string): string {
  const parts: string[] = []
  for (const part of `${cwd}/${word}`.split(/[\\/]+/)) {
    if (part === '..') {
      if (parts.length > 1) parts.pop()
    } else if (part !== '.') parts.push(part)
  }
  return parts.join('/') || '/'
}

// "~/work; /Volumes/NAS" -> ["~/work", "/Volumes/NAS"]; trailing slashes dropped, blanks skipped.
export function parsePaths(spec: string | undefined): string[] {
  return (spec ?? '')
    .split(';')
    .map(p => p.trim().replace(/(.)[\\/]+$/, '$1'))
    .filter(Boolean)
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Where a path starts and ends in shell text: `~/work/x` and `~/work` end the folder `~/work`,
// `~` alone (nothing below it) ends a parent.
const START = String.raw`(?:^|[\s"'=(:{,\x60])`
const SEP = String.raw`[\/\\]+`
const END = String.raw`(?=$|[\/\\\s"';&|)<>},\x60])`
const WORD_END = String.raw`[\/\\]*(?=$|[\s"';&|)<>},\x60])`

// The folders above a path, to its root: "/a/b/c" -> "/a/b", "/a", "/"; "~/a" -> "~".
function above(path: string): string[] {
  const out: string[] = []
  let cur = path.replace(/[\\/]+$/, '')
  for (let i = Math.max(cur.lastIndexOf('/'), cur.lastIndexOf('\\')); i >= 0; i = Math.max(cur.lastIndexOf('/'), cur.lastIndexOf('\\'))) {
    cur = cur.slice(0, i)
    out.push(cur || '/')
    if (!cur) break
  }
  return out
}

// Builds the matchers for folders from settings. A folder under the home folder matches as
// `~`, `$HOME`, `${HOME}` or the home path (any letter case), Windows paths also as Git Bash
// writes them (/c/Users), with either slash, doubled or not, and only as a whole folder name:
// `~/work` matches `~/work/app`, not `~/workshop`.
function matchers(home?: string) {
  const h = home?.replace(/[\\/]+$/, '') || undefined
  const drive = (p: string) => (/^[A-Za-z]:/.test(p) ? `(?:${escape(p)}|/${p[0]}${escape(p.slice(2))})` : escape(p))
  const lower = (p: string) => p.replace(/\\/g, '/').toLowerCase()
  const homeAlt = String.raw`(?:~|\$HOME|\$\{HOME\}${h ? `|${drive(h)}` : ''})`
  // "~/x", "$HOME/x" or "<home>/x" -> "/x"; undefined for a folder outside home.
  const restOf = (path: string): string | undefined => {
    const lead = /^(?:~|\$HOME|\$\{HOME\})(?=[\\/]|$)/.exec(path)?.[0]
    if (lead !== undefined) return path.slice(lead.length)
    const isUnder = h && lower(path).startsWith(lower(h)) && /^([\\/]|$)/.test(path.slice(h.length))
    return isUnder ? path.slice(h.length) : undefined
  }
  const form = (path: string) => {
    const rest = restOf(path)
    return (rest === undefined ? drive(path) : homeAlt + escape(rest)).replace(/\\\\|\//g, SEP)
  }
  const compile = (forms: string[]) => (forms.length ? new RegExp(`${START}(?:${forms.join('|')})`, 'i') : undefined)
  return {
    // A root (`/`) covers everything below it, so it needs no end.
    folders: (paths: string[]) => compile(paths.map(form).map(f => (f === SEP ? f : f + END))),
    parents: (paths: string[]) => {
      const ups = paths.flatMap(path => {
        const rest = restOf(path)
        return rest === undefined ? above(path) : [...above(`~${rest}`), ...(h ? above(h) : [])]
      })
      return compile([...new Set(ups)].map(p => form(p) + WORD_END))
    },
  }
}

export const folderMatcher = (paths: string[], home?: string): RegExp | undefined => matchers(home).folders(paths)
export const parentMatcher = (paths: string[], home?: string): RegExp | undefined => matchers(home).parents(paths)

export type Tag = [needle: string, label: string]

// "acme=Acme Corp; client-x=Client X" -> pairs, split at the first '='; a bad entry is skipped.
export function parseTags(spec: string | undefined): Tag[] {
  return (spec ?? '').split(';').flatMap(part => {
    const i = part.indexOf('=')
    const needle = part.slice(0, i).trim()
    const label = part.slice(i + 1).trim()
    return i > 0 && needle && label ? [[needle, label] as Tag] : []
  })
}

// The needle is matched anywhere in the full path, parent folders included.
export function projectOf(path: string, tags: Tag[]): { project: string; tag?: string } {
  const lower = path.toLowerCase()
  const tag = tags.find(([needle]) => lower.includes(needle.toLowerCase()))?.[1]
  const project = path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
  return { project, tag }
}

// "/Users/me/code/app" -> "~/code/app"; a sibling such as /Users/meg is left alone.
export function tildify(path: string, home?: string): string {
  const h = home?.replace(/[\\/]+$/, '')
  const rest = h && path.startsWith(h) ? path.slice(h.length) : undefined
  return rest !== undefined && /^([\\/]|$)/.test(rest) ? `~${rest}` : path
}

// A mode file holds one short word (`full`, `lite`); anything else is ignored, never drawn.
function modeWord(text?: string): string | undefined {
  const word = text?.split('\n')[0]?.trim()
  return word && word !== 'off' && /^[\w:-]{1,24}$/.test(word) ? word : undefined
}

export function modesOf(caveman?: string, ponytail?: string, hasMem = false): string[] {
  const modes: string[] = []
  const cave = modeWord(caveman)
  if (cave) modes.push(cave === 'caveman' ? 'caveman' : `caveman:${cave}`)
  const pony = modeWord(ponytail)
  if (pony) modes.push(`ponytail:${pony}`)
  if (hasMem) modes.push('mem')
  return modes
}

// settings' enabledPlugins: { "claude-mem@market": true }.
export function isEnabled(enabledPlugins: unknown, plugin: string): boolean {
  if (typeof enabledPlugins !== 'object' || enabledPlugins === null) return false
  return Object.entries(enabledPlugins).some(([id, isOn]) => id.startsWith(`${plugin}@`) && isOn === true)
}

export function money(usd?: number): string {
  return usd === undefined ? '$—' : `$${usd.toFixed(2)}`
}

export function statusText(s: Pick<Snapshot, 'pct' | 'usd' | 'modes' | 'project' | 'tag'>): string {
  const where = s.tag ?? s.project
  const ctx = s.pct === undefined ? 'ctx —' : `ctx ${Math.round(s.pct)}%`
  return [where, ctx, money(s.usd), s.modes.join('+')].filter(Boolean).join(' · ')
}

// Options arrive validated, but a number field stored blank reaches register as ''.
export const numberOf = (value: unknown, fallback: number): number => (typeof value === 'number' ? value : fallback)

// Once per session and budget: `key` is `${startedAt}:${budget}`, so /clear or a new budget re-arms it.
export function budgetCrossed(usd: number | undefined, budget: number, alertedFor: string | undefined, key: string): boolean {
  return budget > 0 && usd !== undefined && usd >= budget && alertedFor !== key
}

// The context alert fires on the way up past the line; falling back under it (a /compact,
// a /clear) re-arms it. Before the first figure nothing changes.
export function contextCrossed(pct: number | undefined, threshold: number, wasOver = false): { isOver: boolean; shouldAlert: boolean } {
  const isOver = pct === undefined ? wasOver : threshold > 0 && pct >= threshold
  return { isOver, shouldAlert: isOver && !wasOver }
}

// Once per rate-limit window: the key is the window's kind and reset time.
export function rateCrossed(limits: RateLimit[], threshold: number, alerted: string[]): { fired: RateLimit[]; alerted: string[] } {
  const keyOf = (l: RateLimit) => `${l.kind}:${l.resetsAt ?? ''}`
  const fired = threshold > 0 ? limits.filter(l => l.percentUsed >= threshold && !alerted.includes(keyOf(l))) : []
  // A key stays until its kind reports another window, or, with no reset time to tell windows
  // apart, until usage falls back under the line. A reading that leaves a window out keeps it,
  // so each kind holds one key at most.
  const kept = alerted.filter(k => {
    const now = limits.find(l => k.startsWith(`${l.kind}:`))
    return !now || (keyOf(now) === k && (now.resetsAt !== undefined || now.percentUsed >= threshold))
  })
  return { fired, alerted: [...kept, ...fired.map(keyOf)] }
}

// 5 min -> "5m", 125 min -> "2h05m", 3 days 4 h -> "3d4h"; rounded up to the minute.
export function duration(ms: number): string {
  const min = Math.max(1, Math.ceil(ms / 60_000))
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  if (h < 48) return `${h}h${String(min % 60).padStart(2, '0')}m`
  return `${Math.floor(h / 24)}d${h % 24}h`
}

// "resets in 2h05m", "resets now", or undefined when the time is missing or unreadable.
export function resetText(resetsAt: string | undefined, now: number): string | undefined {
  const at = resetsAt ? Date.parse(resetsAt) : NaN
  if (Number.isNaN(at)) return undefined
  return at <= now ? 'resets now' : `resets in ${duration(at - now)}`
}

// ponytail: the session's average since startedAt, which for a resumed session counts the time
// it was away too, so the rate reads low. A recent-window rate would need cost samples over time.
// "$1.20/h · alert in ~3h30m"; undefined in the first 5 minutes or before any cost.
export function burnText(usd: number | undefined, startedAt: number | undefined, now: number, budget: number): string | undefined {
  const elapsed = startedAt === undefined ? 0 : now - startedAt
  if (!usd || elapsed < 5 * 60_000) return undefined
  const perMs = usd / elapsed
  const rate = `${money(perMs * 3_600_000)}/h`
  return budget > usd ? `${rate} · alert in ~${duration((budget - usd) / perMs)}` : rate
}

export function bar(pct: number, width: number): string {
  const cells = Math.max(0, Math.floor(width))
  const full = Math.max(0, Math.min(cells, Math.round((pct / 100) * cells)))
  return '█'.repeat(full) + '░'.repeat(cells - full)
}

// `claude mcp list` rows: "<name>: <target> - <mark> <state>", the mark one of ✔ connected,
// ! needs authentication, ✘ failed to connect, ⏸ pending approval, - not configured.
const MCP_ROW = /^(.+?): .*? - ([✔✓!✘✗⏸-]) /u

export function parseMcpList(stdout: string, now: number): McpHealth {
  const health: McpHealth = { ok: 0, auth: [], failed: [], checkedAt: now }
  for (const line of stdout.split('\n')) {
    const [, rawName = '', mark] = MCP_ROW.exec(line) ?? []
    const name = rawName.replace(/^claude\.ai /, '').replace(/^plugin:/, '')
    if (mark === '✔' || mark === '✓') health.ok++
    else if (mark === '!') health.auth.push(name)
    else if (mark === '✘' || mark === '✗') health.failed.push(name)
  }
  return health
}

// Built-in read-only tools drawn compact. Glob and Grep exist only on some builds.
const COMPACT: Record<string, string> = { Read: 'file_path', Glob: 'pattern', Grep: 'pattern' }

// One dim line for a finished call, with where a search ran; undefined leaves the engine's row.
export function compactLabel(tool: string, input: unknown): string | undefined {
  const field = COMPACT[tool]
  if (!field || typeof input !== 'object' || input === null) return undefined
  const args = input as Record<string, unknown>
  const value = args[field]
  const where = typeof args.path === 'string' && args.path ? ` in ${args.path}` : ''
  return typeof value === 'string' ? `✓ ${tool} ${value}${where}` : undefined
}
