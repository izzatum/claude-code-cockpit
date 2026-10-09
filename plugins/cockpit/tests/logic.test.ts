import { expect, test } from 'claude-code/testing'
import {
  bar,
  budgetCrossed,
  burnText,
  contextCrossed,
  duration,
  folderMatcher,
  parsePaths,
  rateCrossed,
  resetText,
  compactLabel,
  isEnabled,
  isRecursiveDelete,
  modesOf,
  money,
  numberOf,
  parseMcpList,
  parseTags,
  projectOf,
  statusText,
  syncVerdict,
  tildify,
} from '../hooks/logic'

type Kind = 'deny' | 'warn' | undefined
const kind = (command: string, cwd: string): { command: string; cwd: string; kind: Kind } => {
  const v = syncVerdict(command, cwd)
  return { command, cwd, kind: v === undefined ? undefined : 'deny' in v ? 'deny' : 'warn' }
}
// Each row reports itself on failure.
const check = (rows: [command: string, cwd: string, want: Kind][]) => {
  for (const [command, cwd, want] of rows) expect(kind(command, cwd)).toEqual({ command, cwd, kind: want })
}

const DIR = '/Users/me/Library/CloudStorage/Dropbox/work/app'

test('sync guard knows the synced folders', () => {
  const synced = [
    DIR,
    '/Users/me/Library/CloudStorage/GoogleDrive-me@example.com/My Drive/app',
    '/Users/me/Library/CloudStorage/OneDrive-Personal/app',
    '/Users/me/Library/Mobile Documents/com~apple~CloudDocs/app',
    '/home/me/Dropbox/app',
    '/home/me/Dropbox',
    '/Users/me/Google Drive/app',
    '/Users/me/Dropbox (Personal)/app',
    '/Users/me/OneDrive - Contoso/app',
    'C:\\Users\\me\\Dropbox\\app',
    'C:\\Users\\me\\OneDrive - Contoso\\app',
  ]
  check(synced.map(dir => ['rm -rf dist', dir, 'deny']))
  check(synced.map(dir => ['npm install', dir, 'warn']))
  check([
    ['rm -rf x', '/Users/me/code/dropbox-clone', undefined],
    ['rm -rf dist', '/Users/me/code/sdk/dropbox', undefined],
    ['rm -rf node_modules/dropbox', '/Users/me/code/app', undefined],
    ['npm install dropbox', '/Users/me/code/app', undefined],
    ['rm -rf node_modules', '/Users/me/code/app', undefined],
  ])
})

test('sync guard finds a synced target from outside it', () => {
  check([
    ['rm -rf ~/Dropbox', '/Users/me', 'deny'],
    ['rm -rf ~/Dropbox && echo ok', '/Users/me', 'deny'],
    ['rm -rf "$HOME/Dropbox"', '/Users/me', 'deny'],
    ['cd ~/Dropbox && rm -rf proj', '/Users/me', 'deny'],
    ['cd Dropbox; rm -rf proj', '/Users/me', 'deny'],
    ['rm -rf Dropbox/proj', '/Users/me', 'deny'],
    ['rm -rf ~/Library/Mobile\\ Documents/com~apple~CloudDocs/x', '/tmp', 'deny'],
    ['rm -rf ~/Google\\ Drive/x', '/tmp', 'deny'],
    ['rm -rf "/Users/me/Dropbox (Acme)/x"', '/tmp', 'deny'],
    ['rm -rf "/Users/me/OneDrive - Acme/x"', '/tmp', 'deny'],
    [`rm -rf "${DIR}/old"`, '/tmp', 'deny'],
  ])
})

test('sync guard blocks recursive deletes in any spelling', () => {
  const deny = [
    'rm -r build',
    'cd x && rm -r build',
    'rm -f -r x',
    'rm -v -rf x',
    'rm -i -R x',
    'rm --force --recursive build',
    'rm x -rf',
    'rm "-rf" x',
    "'rm' -rf x",
    'RM -rf x',
    'rm -rf -- x',
    '/bin/rm -rf x',
    './node_modules/.bin/rm -rf x',
    '$HOME/bin/rm -rf x',
    '~/bin/rm -rf x',
    'sudo /usr/bin/rm -rf x',
    '(/bin/rm -rf x)',
    '{ /bin/rm -rf x; }',
    '/usr/bin/git rm -r x',
    '/usr/bin/find . -delete',
    '\\rm -rf x',
    'sudo rm -rf x',
    'ls | xargs rm -r',
    'time rm -rf dist',
    'find . -name x -exec rm -rf {} +',
    'bash -c "rm -rf dist"',
    "sh -c 'rm -rf dist'",
    'echo "$(rm -rf dist)"',
    'if [ -d x ]; then rm -rf x; fi',
    'git rm -rf src',
    'git rm -r src',
    'git -C x rm -r foo',
    'git rm -r --cached a && rm -rf b',
    'find . -delete',
    'rsync -a --delete empty/ x/',
    'git clean -fdx',
    'git clean -d --force',
    'bash <<EOF\nrm -rf dist\nEOF',
    'bash -s <<EOF\nrm -rf dist\nEOF',
    '/bin/sh <<EOF\nrm -rf dist\nEOF',
    'cat <<EOF | sh\nrm -rf dist\nEOF',
    'cat <<EOF | sudo bash\nrm -rf dist\nEOF',
    'source /dev/stdin <<EOF\nrm -rf dist\nEOF',
    'eval "$(cat <<EOF\nrm -rf dist\nEOF\n)"',
    'cat <<< x\nrm -rf dist\nx', // a here-string has no body
    'echo "a <<EOF"\nrm -rf dist', // a body that never closes is code
    'CI=1 rm -rf node_modules',
    'FOO=bar rm -rf dist',
    'A="x y" B=\'z\' rm -rf dist',
    'D=$(pwd)/dist rm -rf "$D"',
    'bash -lc "rm -rf dist"',
    'bash -ec "rm -rf dist"',
    'sh -c -- "rm -rf dist"',
    'if rm -rf dist; then echo ok; fi',
    'if false; then :; elif rm -rf x; then :; fi',
    'until rm -rf x; do sleep 1; done',
    'while true; do rm -rf x; done',
    'find . -print0 | xargs -0 -n 1 -P 4 -I {} rm -rf {}',
    'git --work-tree /x rm -r y',
    'git -C "my dir" rm -r x',
    'git --git-dir .git rm -rf x',
    'git -c core.x=1 --no-pager rm -r x',
    'rm -rf /tmp/x', // the cwd is synced: targets are not resolved
  ]
  check(deny.map(command => [command, DIR, 'deny']))
})

test('sync guard lets harmless commands through', () => {
  const allow = [
    'git rm -r --cached foo',
    'git rm --cached -r foo',
    'rm file.txt',
    'rm -f foo -- -r',
    'rm -f x && ls -R',
    'rm -f x | sort -r',
    'docker run --rm -it img -r',
    'git commit -m "drop rm -rf usage"',
    'git commit -m "do not rm -rf build"',
    'grep -rn "rm -r" .',
    'echo "rm -rf" > notes.txt',
    "cat > notes.md <<'EOF'\nrm -rf dist\nEOF",
    "cat > clean.sh <<'EOF'\nrm -rf dist\nEOF", // writing a script does not run it
    "cat > scripts/clean.sh <<'EOF'\nrm -rf dist\nEOF",
    "tee deploy.bash <<'EOF'\nrm -rf dist\nEOF",
    "cat > a <<A > b <<-'B'\nrm -rf x\nA\nrm -rf y\n\tB\nls",
    'sudo xrm -rf x',
    'git clean -nfd',
    'ls -la',
    'which yarn',
    'yarn test',
    'cat yarn.lock',
    'git commit -m "npm install fix"',
  ]
  check(allow.map(command => [command, DIR, undefined]))
})

test('sync guard warns before installs and builds', () => {
  const warn = [
    'pnpm run build',
    'npm ci',
    'npm run-script build',
    'yarn',
    'cd x && yarn',
    'yarn --frozen-lockfile',
    'yarn add react',
    'bun install',
    'pip install x',
    'pip3 install x',
    'cargo build',
    '/usr/local/bin/npm ci',
    'NODE_ENV=production npm run build',
    'CI=1 npm ci',
    'bash -lc "npm install"',
    'if npm ci; then echo ok; fi',
  ]
  check(warn.map(command => [command, DIR, 'warn']))
})

test('a failed guard judges the command text alone', () => {
  expect(isRecursiveDelete('rm -rf x')).toBe(true)
  expect(isRecursiveDelete('git rm -rf x')).toBe(true)
  expect(isRecursiveDelete('git rm -r --cached x')).toBe(false)
  expect(isRecursiveDelete('ls')).toBe(false)
  expect(isRecursiveDelete('npm install')).toBe(false)
  expect(isRecursiveDelete('CI=1 rm -rf x')).toBe(true)
  expect(isRecursiveDelete("cat > a <<'EOF'\nrm -rf x\nEOF")).toBe(false)
})

test('a long command does not stall the guard', () => {
  const json = JSON.stringify(Array.from({ length: 4000 }, (_, i) => ({ id: i, name: `item ${i}`, tags: ['a', 'b'] })))
  const long = [
    `echo '${json}' > data.json`, // ~200 KB on one line
    `python3 -c "${'x = y << 2\n'.repeat(5000)}"`, // many lines that look like heredocs
    `git ${'-c -a '.repeat(30)}status`, // options that could parse two ways
    `do${' '.repeat(20_000)}x`,
    `node -e '${'if(!a){b(c)}'.repeat(8000)}'`, // code with no spaces, ~96 KB
    `echo "${'(x)'.repeat(8000)}"`,
    `node -e '${'(e=t.x,n=e.y,r=n(e)'.repeat(5000)}'`, // assignments that never end
    `echo '${'(git -c (git -c '.repeat(5000)}'`, // git options that never end
  ]
  for (const command of long) {
    const t = Date.now()
    syncVerdict(command, '/home/me/code/app')
    syncVerdict(command, DIR)
    isRecursiveDelete(command)
    expect({ size: command.length, isQuick: Date.now() - t < 250 }).toEqual({ size: command.length, isQuick: true })
  }
})

test('parseTags/projectOf match needles case-insensitively', () => {
  const tags = parseTags('acme=Acme Corp; client-x = Client X; broken; =nope; rd=R=D')
  expect(tags).toEqual([
    ['acme', 'Acme Corp'],
    ['client-x', 'Client X'],
    ['rd', 'R=D'],
  ])
  expect(projectOf('/Users/me/code/ACME-web', tags)).toEqual({ project: 'ACME-web', tag: 'Acme Corp' })
  expect(projectOf('/Users/me/code/other', tags)).toEqual({ project: 'other', tag: undefined })
  expect(projectOf('/Users/me/code/app/', []).project).toBe('app')
  expect(projectOf('C:\\Users\\me\\proj', []).project).toBe('proj')
  expect(parseTags(undefined)).toEqual([])
})

test('home folder shows as ~', () => {
  expect(tildify('/Users/al/x', '/Users/al')).toBe('~/x')
  expect(tildify('/Users/al', '/Users/al/')).toBe('~')
  expect(tildify('/Users/alice/x', '/Users/al')).toBe('/Users/alice/x')
  expect(tildify('C:\\Users\\me\\x', 'C:\\Users\\me')).toBe('~\\x')
  expect(tildify('/x', undefined)).toBe('/x')
  expect(tildify('/x', '')).toBe('/x')
})

test('modes take one short word per file', () => {
  expect(modesOf('caveman', 'full', true)).toEqual(['caveman', 'ponytail:full', 'mem'])
  expect(modesOf(' ultra\n', undefined)).toEqual(['caveman:ultra'])
  expect(modesOf('off', 'off')).toEqual([])
  expect(modesOf('caveman\n\u001b[31mEVIL', 'x'.repeat(50))).toEqual(['caveman'])
  expect(modesOf('\u001b[31m', 'a b')).toEqual([])
  expect(isEnabled({ 'claude-mem@market': true }, 'claude-mem')).toBe(true)
  expect(isEnabled({ 'claude-mem@market': false }, 'claude-mem')).toBe(false)
  expect(isEnabled({ 'claude-memory@market': true }, 'claude-mem')).toBe(false)
  expect(isEnabled(undefined, 'claude-mem')).toBe(false)
})

test('status line', () => {
  expect(statusText({ pct: 41.6, usd: 1.8, modes: ['caveman', 'ponytail:full'], project: 'web', tag: 'Acme' })).toBe(
    'Acme · ctx 42% · $1.80 · caveman+ponytail:full',
  )
  expect(statusText({ usd: 0, modes: [], project: 'web' })).toBe('web · ctx — · $0.00')
  expect(money(undefined)).toBe('$—')
})

test('budget alert fires once per session and budget', () => {
  expect(numberOf('', 5)).toBe(5)
  expect(numberOf(undefined, 80)).toBe(80)
  expect(numberOf(0, 5)).toBe(0)
  expect(numberOf(7, 5)).toBe(7)
  expect(budgetCrossed(5, 5, undefined, '1:5')).toBe(true)
  expect(budgetCrossed(5.2, 5, '1:5', '1:5')).toBe(false)
  expect(budgetCrossed(4.9, 5, undefined, '1:5')).toBe(false)
  expect(budgetCrossed(undefined, 5, undefined, '1:5')).toBe(false)
  expect(budgetCrossed(99, 0, undefined, '1:0')).toBe(false)
  expect(budgetCrossed(6, 5, '1:5', '2:5')).toBe(true) // after /clear
  expect(budgetCrossed(21, 20, '1:5', '1:20')).toBe(true) // budget raised
})

test('bars clamp', () => {
  expect(bar(28, 10)).toBe('███░░░░░░░')
  expect(bar(150, 4)).toBe('████')
  expect(bar(50, -3)).toBe('')
})

test('mcp list parsing sorts connected, needs-auth and failed', () => {
  const out = [
    'Checking MCP server health…',
    '',
    'claude.ai Docs: https://docs.example.com/mcp - ✔ Connected',
    'claude.ai Wiki: https://wiki.example.com/mcp - ! Needs authentication',
    'plugin:a:mail:  (HTTP) - - Not configured',
    'plugin:b:mail: https://mail.example.com/mcp (HTTP) - ✘ Failed to connect — ENOTFOUND: getaddrinfo ENOTFOUND mail.example.com',
    'plugin:c:files: https://files.example.com/mcp (HTTP) - ✘ Failed to connect — OAuth discovery failed',
    'plugin:d:calc: https://calc.example.com (HTTP) - ✘ Failed to connect — bad gateway - try later',
    'local: node server.js - a - b.js - ✔ Connected',
    'project-tool: /usr/bin/tool --serve - ⏸ Pending approval (run `claude` to approve)',
  ].join('\n')
  expect(parseMcpList(out, 1)).toEqual({ ok: 2, auth: ['Wiki'], failed: ['b:mail', 'c:files', 'd:calc'], checkedAt: 1 })
  expect(parseMcpList("error: unknown command 'mcp'", 1)).toEqual({ ok: 0, auth: [], failed: [], checkedAt: 1 })
})

test('compact rows for read-only tools, with where a search ran', () => {
  expect(compactLabel('Read', { file_path: '/a/b.ts' })).toBe('✓ Read /a/b.ts')
  expect(compactLabel('Glob', { pattern: '**/*.ts' })).toBe('✓ Glob **/*.ts')
  expect(compactLabel('Grep', { pattern: 'TODO', path: '/x/.ssh' })).toBe('✓ Grep TODO in /x/.ssh')
  expect(compactLabel('Bash', { command: 'ls' })).toBeUndefined()
  expect(compactLabel('LS', { path: '/x' })).toBeUndefined()
  expect(compactLabel('Grep', {})).toBeUndefined()
  expect(compactLabel('Read', 'nope')).toBeUndefined()
})

test('protected and extra synced folders, as written or through the home folder', () => {
  const home = '/Users/me'
  const guard = { protected: folderMatcher(parsePaths(' ~/work/ ; /Volumes/NAS;; '), home) }
  const rows: [string, string, Kind][] = [
    ['rm -rf dist', '/Users/me/work', 'deny'],
    ['rm -rf dist', '/Users/me/work/app', 'deny'],
    ['rm -rf dist', '/Users/me/workshop', undefined],
    ['rm -rf dist', '/Users/me/code', undefined],
    ['rm -rf ~/work/old', '/tmp', 'deny'],
    ['rm -rf $HOME/work/old', '/tmp', 'deny'],
    ['rm -rf "${HOME}/work"', '/tmp', 'deny'],
    ['rm -rf /users/ME/Work/old', '/tmp', 'deny'],
    ['rm -rf /Volumes/NAS', '/tmp', 'deny'],
    ['rm -rf /Volumes/NASTY', '/tmp', undefined],
    ['npm install', '/Users/me/work/app', undefined],
    ['ls ~/work', '/tmp', undefined],
  ]
  for (const [command, cwd, want] of rows) {
    const v = syncVerdict(command, cwd, guard)
    expect({ command, cwd, kind: v === undefined ? undefined : 'deny' in v ? 'deny' : 'warn' }).toEqual({ command, cwd, kind: want })
  }
  expect(syncVerdict('rm -rf dist', '/Users/me/work', guard)).toHaveProperty('deny', expect.stringContaining('guardPaths'))
  const synced = { synced: folderMatcher(['~/Desktop', '~/Documents'], 'C:\\Users\\me') }
  expect(syncVerdict('rm -rf dist', 'C:\\Users\\me\\Documents\\app', synced)).toHaveProperty('deny', expect.stringContaining('cloud-synced'))
  expect(syncVerdict('npm ci', '~/Desktop/app', synced)).toHaveProperty('warn')
  expect(folderMatcher([], home)).toBeUndefined()
  expect(folderMatcher(['a.b(c)'], home)?.test('/x a.b(c)/y')).toBe(true)
  expect(folderMatcher(['a.b(c)'], home)?.test('/x aXb(c)/y')).toBe(false)
})

test('context alert crosses upward, re-arms below the line', () => {
  expect(contextCrossed(79, 80, false)).toEqual({ isOver: false, shouldAlert: false })
  expect(contextCrossed(80, 80, false)).toEqual({ isOver: true, shouldAlert: true })
  expect(contextCrossed(90, 80, true)).toEqual({ isOver: true, shouldAlert: false })
  expect(contextCrossed(undefined, 80, true)).toEqual({ isOver: true, shouldAlert: false })
  expect(contextCrossed(20, 80, true)).toEqual({ isOver: false, shouldAlert: false })
  expect(contextCrossed(100, 0, false)).toEqual({ isOver: false, shouldAlert: false })
})

test('rate alert fires once per window', () => {
  const a = { kind: 'five_hour', percentUsed: 91, resetsAt: 'T1' }
  const b = { kind: 'seven_day', percentUsed: 50, resetsAt: 'T2' }
  expect(rateCrossed([a, b], 90, [])).toEqual({ fired: [a], alerted: ['five_hour:T1'] })
  expect(rateCrossed([a, b], 90, ['five_hour:T1'])).toEqual({ fired: [], alerted: ['five_hour:T1'] })
  const next = { ...a, resetsAt: 'T3' }
  expect(rateCrossed([next], 90, ['five_hour:T1'])).toEqual({ fired: [next], alerted: ['five_hour:T3'] })
  expect(rateCrossed([a], 0, [])).toEqual({ fired: [], alerted: [] })
  expect(rateCrossed([], 90, ['five_hour:T1'])).toEqual({ fired: [], alerted: [] })
})

test('durations, reset times and burn rate', () => {
  expect(duration(1)).toBe('1m')
  expect(duration(5 * 60_000)).toBe('5m')
  expect(duration(125 * 60_000)).toBe('2h05m')
  expect(duration((3 * 24 + 4) * 3_600_000)).toBe('3d4h')
  const now = Date.parse('2026-01-01T00:00:00Z')
  expect(resetText('2026-01-01T02:05:00Z', now)).toBe('resets in 2h05m')
  expect(resetText('2025-12-31T23:00:00Z', now)).toBe('resets now')
  expect(resetText(undefined, now)).toBeUndefined()
  expect(resetText('soon', now)).toBeUndefined()
  const hour = 3_600_000
  expect(burnText(2, 0, hour, 5)).toBe('$2.00/h · alert in ~1h30m')
  expect(burnText(6, 0, hour, 5)).toBe('$6.00/h')
  expect(burnText(2, 0, hour, 0)).toBe('$2.00/h')
  expect(burnText(2, 0, 4 * 60_000, 5)).toBeUndefined()
  expect(burnText(0, 0, hour, 5)).toBeUndefined()
  expect(burnText(2, undefined, hour, 5)).toBeUndefined()
})
