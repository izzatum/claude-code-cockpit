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
  const usage = { startedAt: 1, usd: 1 }
  mock.env(on, { HOME: '/home/me' })
  on('session.usage', () => ({
    value: { startedAt: usage.startedAt, context: { percent: 10, tokens: 20_000, window: 200_000 }, rateLimits: [], cost: { usd: usage.usd } },
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
  return { seen, usage, measure }
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
  const { seen } = world(on)
  const clock = mock.clock(on, { now: 1_000_000 })
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
  const { seen } = world(on, { surfaces: [] })
  const clock = mock.clock(on, { now: 1_000_000 })
  const count = mcpList(on)
  await $.session.start({ ...START, isInteractive: false })
  await clock.advance(60_000)
  expect(count.runs).toBe(0)
  expect(seen.toasts).toEqual([])
})

test('MCP health that cannot run says so instead of checking forever', async ($, on) => {
  world(on)
  const clock = mock.clock(on, { now: 1_000_000 })
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
