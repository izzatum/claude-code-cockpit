import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const SYNCED = '/home/me/Dropbox/app'
const PANE_PROPS = { title: 'Cockpit', isFocused: false, bodyColumns: 30, placement: 'inline', scroll: { offset: 0, bodyRows: 20 }, view: {} } as const

// A shell command through every plugin's tool.call hook. Typed loosely: the per-tool
// overloads of `$.tool.call` are too deep for tsc to instantiate here.
function shell($: Engine, tool: 'Bash' | 'Monitor', command: string): Promise<unknown> {
  const engine = $ as unknown as { tool: { call: (e: object) => Promise<unknown> } }
  return engine.tool.call(tool === 'Monitor' ? { tool, command, description: 'watch', timeout_ms: 1000 } : { tool, command })
}

// The engine beneath the plugin: usage figures, folders and what reached the screen.
function world(on: On, opts: { cwd?: string; isCwdBroken?: boolean; surfaces?: ('terminal' | 'desktop')[] } = {}) {
  const seen = { status: [] as (string | undefined)[], toasts: [] as string[], ran: [] as string[] }
  const usage = { startedAt: 1, usd: 1, percent: 10, rateLimits: [] as { kind: string; percentUsed: number; resetsAt?: string }[] }
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/home/me' })
  on('session.usage', () => ({
    value: {
      startedAt: usage.startedAt,
      context: { percent: usage.percent, tokens: usage.percent * 2_000, window: 200_000 },
      rateLimits: usage.rateLimits,
      cost: { usd: usage.usd },
    },
  }))
  on('session.root', () => ({ value: '/home/me/code/acme-web' }))
  on('session.surfaces', () => ({ value: opts.surfaces ?? ['terminal'] }))
  on('session.cwd', () => {
    if (opts.isCwdBroken) throw new Error('cwd down')
    return { value: opts.cwd ?? '/home/me/code/acme-web' }
  })
  on('ui.status', ($, e) => (seen.status.push(e.text), { value: undefined }))
  on('ui.toast', ($, e) => (seen.toasts.push(e.text), { value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('tool.call', ($, e) => (seen.ran.push(String(e.tool)), { result: 'ran' }))
  const measure = { context: { percent: 10, tokens: 20_000, window: 200_000 }, rateLimits: [], changed: ['cost' as const] }
  return { seen, usage, measure, clock }
}

test('a project tag reaches the status line', { options: { projectTags: 'acme=Acme' } }, async ($, on) => {
  const { seen, measure } = world(on)
  await $.session.measure(measure)
  expect(seen.status.at(-1)).toBe('Acme · ctx 10% · $1.00')
})

test('the cost alert fires once, and again after /clear', async ($, on) => {
  const { seen, usage, measure } = world(on)
  usage.usd = 6
  await $.session.measure(measure)
  await $.session.measure(measure)
  expect(seen.toasts.filter(t => t.includes('alert')).length).toBe(1)
  usage.startedAt = 2 // /clear starts the figures over
  await $.session.measure(measure)
  expect(seen.toasts.filter(t => t.includes('alert')).length).toBe(2)
})

test('a blank budget keeps the default alert', { options: { budget: '' } }, async ($, on) => {
  const { seen, usage, measure } = world(on)
  usage.usd = 6
  await $.session.measure(measure)
  expect(seen.toasts).toEqual(['cockpit: session cost $6.00 reached your $5.00 alert'])
})

test('the guard blocks a recursive delete in a synced folder, from Bash or Monitor', async ($, on) => {
  const { seen } = world(on, { cwd: SYNCED })
  const bash = await shell($, 'Bash', 'rm -rf dist')
  expect(bash).toHaveProperty('deny', expect.stringContaining('is blocked'))
  const monitor = await shell($, 'Monitor', 'rm -rf dist')
  expect(monitor).toHaveProperty('deny', expect.stringContaining('is blocked'))
  await shell($, 'Bash', 'ls')
  expect(seen.ran).toEqual(['Bash'])
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'cockpit', surface, component: 'Pane', requestId: 'cockpit', props: PANE_PROPS })
    expect(await pane.find({ text: '2 command(s) blocked' })).toBeDefined()
  }
})

test('/clear starts the blocked count over', async ($, on) => {
  const { usage, measure } = world(on, { cwd: SYNCED })
  await $.session.measure(measure)
  await shell($, 'Bash', 'rm -rf dist')
  usage.startedAt = 2 // /clear
  await $.session.measure(measure)
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'cockpit', props: PANE_PROPS })
  expect(await pane.find({ text: 'nothing blocked' })).toBeDefined()
})

test('protected folders block deletes there, with no install warning', { options: { guardPaths: '~/work; /Volumes/NAS' } }, async ($, on) => {
  const { seen } = world(on, { cwd: '/home/me/work/app' })
  expect(await shell($, 'Bash', 'rm -rf dist')).toHaveProperty('deny', expect.stringContaining('guardPaths'))
  expect(await shell($, 'Bash', 'npm install')).toEqual({ result: 'ran' })
  expect(seen.toasts).toEqual([])
  expect(await shell($, 'Bash', 'cd /tmp && rm -rf /Volumes/NAS/backup')).toHaveProperty('deny')
})

test('desktopSync guards ~/Documents like a synced folder', { options: { desktopSync: true } }, async ($, on) => {
  const { seen } = world(on, { cwd: '/home/me/Documents/app' })
  expect(await shell($, 'Bash', 'rm -rf dist')).toHaveProperty('deny', expect.stringContaining('cloud-synced'))
  await shell($, 'Bash', 'npm install')
  expect(seen.toasts).toEqual([expect.stringContaining('installs and builds')])
})

test('desktopSync is off by default', async ($, on) => {
  const { seen } = world(on, { cwd: '/home/me/Documents/app' })
  expect(await shell($, 'Bash', 'rm -rf dist')).toEqual({ result: 'ran' })
  expect(seen.ran).toEqual(['Bash'])
})

test('the context alert fires on the way up, and again after a /compact', async ($, on) => {
  const { seen, usage, measure } = world(on)
  const alerts = () => seen.toasts.filter(t => t.includes('context is'))
  usage.percent = 79
  await $.session.measure(measure)
  expect(alerts()).toEqual([])
  usage.percent = 81
  await $.session.measure(measure)
  await $.session.measure(measure)
  expect(alerts()).toEqual(['cockpit: context is 81% full (alert at 80%): /compact frees room, /clear starts fresh'])
  usage.percent = 20 // compacted
  await $.session.measure(measure)
  usage.percent = 85
  await $.session.measure(measure)
  expect(alerts().length).toBe(2)
})

test('contextAlert 0 turns the context alert off', { options: { contextAlert: 0 } }, async ($, on) => {
  const { seen, usage, measure } = world(on)
  usage.percent = 99
  await $.session.measure(measure)
  expect(seen.toasts).toEqual([])
})

test('a rate limit alerts once per window, with its reset time', async ($, on) => {
  const { seen, usage, measure } = world(on)
  const resetsAt = new Date(1_000_000 + 65 * 60_000).toISOString()
  usage.rateLimits = [{ kind: 'five_hour', percentUsed: 92, resetsAt }, { kind: 'seven_day', percentUsed: 40 }]
  await $.session.measure(measure)
  await $.session.measure(measure)
  expect(seen.toasts).toEqual(['cockpit: five_hour rate limit 92% used, resets in 1h05m'])
  usage.rateLimits = [{ kind: 'five_hour', percentUsed: 95, resetsAt: new Date(1_000_000 + 5 * 3_600_000).toISOString() }]
  await $.session.measure(measure) // the next window
  expect(seen.toasts.length).toBe(2)
})

test('the dashboard shows reset times and the burn rate', async ($, on) => {
  const { usage, measure, clock } = world(on)
  usage.startedAt = 1_000_000
  usage.usd = 2
  usage.rateLimits = [{ kind: 'five_hour', percentUsed: 28, resetsAt: new Date(1_000_000 + 3 * 3_600_000).toISOString() }]
  await $.session.measure(measure)
  await clock.advance(3_600_000) // an hour in: $2.00/h, $3 to go
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'cockpit', surface, component: 'Pane', requestId: 'cockpit', props: { ...PANE_PROPS, bodyColumns: 40 } })
    expect(await pane.find({ text: '$2.00/h · alert in ~1h30m' })).toBeDefined()
    expect(await pane.find({ text: /2h00m/ })).toBeDefined()
  }
})

test('a rate-limit window alerts once, across /clear too', async ($, on) => {
  const { seen, usage, measure } = world(on)
  usage.rateLimits = [{ kind: 'five_hour', percentUsed: 92, resetsAt: new Date(1_000_000 + 3_600_000).toISOString() }]
  await $.session.measure(measure)
  usage.startedAt = 2 // /clear, same account window
  await $.session.measure(measure)
  expect(seen.toasts.filter(t => t.includes('rate limit')).length).toBe(1)
})

test('countdowns in the open pane move each minute with no other write', async ($, on) => {
  const { usage, measure, clock } = world(on)
  mcpList(on)
  on('ui.panes', () => ({ value: [{ id: 'cockpit', isShown: true, isPlaced: true }] }) as never)
  usage.rateLimits = [{ kind: 'five_hour', percentUsed: 28, resetsAt: new Date(1_000_000 + 2 * 3_600_000).toISOString() }]
  await $.session.start(START)
  await $.session.measure(measure)
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'cockpit', props: { ...PANE_PROPS, bodyColumns: 40 } })
  expect(await pane.find({ text: /2h00m/ })).toBeDefined()
  await clock.advance(60_000)
  expect(await pane.find({ text: /1h59m/ })).toBeDefined()
})

// Counts `claude mcp list` runs; each finds one failed server.
function mcpList(on: On): { runs: number } {
  const count = { runs: 0 }
  on('process.run', () => {
    count.runs++
    return { value: { exitCode: 0, stdout: 'x: https://x.example.com (HTTP) - ✘ Failed to connect — timeout\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.register', () => ({ value: { command: 'cockpit' } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  return count
}
const START = { cwd: '/home/me/code/acme-web', surface: 'terminal', isInteractive: true } as const

test('MCP health runs once, later, and pops up only the first result', async ($, on) => {
  const { seen, clock } = world(on)
  const count = mcpList(on)
  await $.session.start(START)
  expect(count.runs).toBe(0)
  await clock.advance(30_000)
  expect(count.runs).toBe(1)
  expect(seen.toasts).toEqual(['cockpit: 1 MCP server(s) failed to connect: x'])
  await $.session.start(START) // a reload: the result is still fresh
  await clock.advance(30_000)
  expect(count.runs).toBe(1)
  expect(seen.toasts.length).toBe(1)
})

test('MCP health skips a run that draws nowhere (claude -p)', async ($, on) => {
  const { seen, clock } = world(on, { surfaces: [] })
  const count = mcpList(on)
  await $.session.start({ ...START, isInteractive: false })
  await clock.advance(60_000)
  expect(count.runs).toBe(0)
  expect(seen.toasts).toEqual([])
})

test('MCP health that cannot run says so instead of checking forever', async ($, on) => {
  const { clock } = world(on)
  on('process.run', () => {
    throw new Error('claude: not found')
  })
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.command.run({ command: 'cockpit', args: '' } as never)
  await clock.settle() // the check /cockpit started unawaited
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'cockpit', props: PANE_PROPS })
  expect(await pane.find({ text: /unavailable/ })).toBeDefined()
})

test('a broken guard still refuses a recursive delete, and nothing else', async ($, on) => {
  const { seen } = world(on, { isCwdBroken: true })
  const denied = await shell($, 'Bash', 'rm -rf dist')
  expect(denied).toHaveProperty('deny', expect.stringContaining('could not check'))
  await shell($, 'Bash', 'ls')
  expect(seen.ran).toEqual(['Bash'])
})

// The engine's own drawing beneath the plugin: shows the props it was handed.
function engineRow(on: On): void {
  on('ui.render', ($, e) => ({ type: 'Text', children: [`engine ${JSON.stringify(e.props)}`] }))
}
const READ = { tool_use_id: 't1', tool: 'Read', input: { file_path: '/a/b.ts' }, isRunning: false, isErrored: false, isInterrupted: false }

test('a finished read draws as one dim line', async ($, on) => {
  engineRow(on)
  const row = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'ToolUse', props: READ })
  expect(await row.find({ text: '✓ Read /a/b.ts' })).toBeDefined()
})

test('compactTools off leaves the engine its row', { options: { compactTools: false } }, async ($, on) => {
  engineRow(on)
  const row = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'ToolUse', props: READ })
  expect(await row.find({ text: /^engine / })).toBeDefined()
})

test('the spinner carries the tag, on the message while one shows', { options: { projectTags: 'acme=Acme' } }, async ($, on) => {
  world(on)
  engineRow(on)
  for (const [message, want] of [[null, '"word":"Acme · Sauteing"'], ['Compacting', '"message":"Acme · Compacting"']] as const) {
    const spinner = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Spinner', props: { word: 'Sauteing', message, suffix: '…', mode: 'responding' } })
    expect((await spinner.find({ text: /^engine / }))?.text).toContain(want)
  }
})
