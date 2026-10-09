import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { McpHealth, RateLimit, Snapshot } from '../types'
import {
  GUARD_FAILED,
  bar,
  budgetCrossed,
  burnText,
  compactLabel,
  contextCrossed,
  folderMatcher,
  isEnabled,
  isRecursiveDelete,
  modesOf,
  money,
  numberOf,
  parseMcpList,
  parsePaths,
  parseTags,
  projectOf,
  rateCrossed,
  resetText,
  statusText,
  syncVerdict,
  tildify,
} from './logic'
import type { Tag } from './logic'

// The options register reads, once per load.
type Config = { budget: number; contextAlert: number; rateAlert: number; tags: Tag[] }

const PANE = 'cockpit'
const MCP_DELAY_MS = 30_000 // after the session's own MCP startup
const MCP_TIMEOUT_MS = 120_000
const MCP_STALE_MS = 10 * 60_000
const LABEL_W = 11 // longest rate-limit kind: spend_limit
const EMPTY: Snapshot = { window: 0, limits: [], modes: [], project: '', path: '', guarded: 0 }
const snap = atom({ plugin: 'cockpit', key: 'snap' } as const, EMPTY)
const tick = atom({ plugin: 'cockpit', key: 'tick' } as const, 0)

async function readText($: EngineInterface, path: string): Promise<string | undefined> {
  try {
    return await $.fs.read(path)
  } catch {
    return undefined
  }
}

async function homeOf($: EngineInterface): Promise<string | undefined> {
  return (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || undefined
}

async function readModes($: EngineInterface, home: string | undefined): Promise<string[]> {
  const [cave, pony, plugins] = await Promise.all([
    home ? readText($, `${home}/.claude/.caveman-active`) : undefined,
    home ? readText($, `${home}/.claude/.ponytail-active`) : undefined,
    $.settings.read().then(s => s.enabledPlugins, () => undefined),
  ])
  return modesOf(cave, pony, isEnabled(plugins, 'claude-mem'))
}

// Reads the figures, redraws the status line and raises the alerts. Never rejects, so callers
// need no catch.
async function refresh($: EngineInterface, c: Config, withModes = false): Promise<Snapshot | undefined> {
  try {
    const home = await homeOf($)
    // The root, not the cwd: a shell `cd` into a subfolder does not relabel the project.
    const [u, root, modes, now] = await Promise.all([
      $.session.usage(),
      $.session.root(),
      withModes ? readModes($, home) : undefined,
      $.clock.now(),
    ])
    const usd = u.cost?.usd
    const key = `${u.startedAt}:${c.budget}`
    let isCostAlert = false
    let isContextAlert = false
    let rateFired: RateLimit[] = []
    const s = await update($, snap, prev => {
      // A new startedAt is a /clear: the session's own counters start over. Rate-limit windows
      // are the account's, so their alerts stay.
      const s = prev.startedAt !== undefined && prev.startedAt !== u.startedAt ? { ...prev, guarded: 0, ctxOver: false } : prev
      isCostAlert = budgetCrossed(usd, c.budget, s.alertedFor, key)
      const ctx = contextCrossed(u.context.percent, c.contextAlert, s.ctxOver)
      isContextAlert = ctx.shouldAlert
      const rate = rateCrossed(u.rateLimits, c.rateAlert, s.rateAlerted ?? [])
      rateFired = rate.fired
      return {
        ...s,
        startedAt: u.startedAt,
        pct: u.context.percent,
        tokens: u.context.tokens,
        window: u.context.window,
        usd,
        limits: u.rateLimits,
        modes: modes ?? s.modes,
        path: tildify(root, home),
        ...projectOf(root, c.tags),
        alertedFor: isCostAlert ? key : s.alertedFor,
        ctxOver: ctx.isOver,
        rateAlerted: rate.alerted,
      }
    })
    $.ui.status(statusText(s))
    if (isCostAlert) $.ui.toast(`cockpit: session cost ${money(usd)} reached your ${money(c.budget)} alert`)
    if (isContextAlert) {
      $.ui.toast(`cockpit: context is ${Math.round(s.pct ?? 0)}% full (alert at ${c.contextAlert}%): /compact frees room, /clear starts fresh`)
    }
    for (const l of rateFired) {
      const reset = resetText(l.resetsAt, now)
      $.ui.toast(`cockpit: ${l.kind} rate limit ${Math.round(l.percentUsed)}% used${reset ? `, ${reset}` : ''}`)
    }
    return s
  } catch (err) {
    $.ui.log(`cockpit: refresh failed: ${String(err)}`, { to: 'debug' })
    return undefined
  }
}

// The hook API lists no MCP server status, so ask the CLI. That starts each configured server
// once, so it runs at most every MCP_STALE_MS, claimed in $.state (which outlives a reload),
// and never where nothing draws the result (a plain `claude -p` run).
async function checkMcp($: EngineInterface): Promise<void> {
  try {
    if (!(await $.session.surfaces()).length) return
    const now = await $.clock.now()
    let prev: McpHealth | undefined
    let isDue = false
    await update($, snap, s => {
      prev = s.mcp
      const isFresh = s.mcp !== undefined && now - s.mcp.checkedAt < MCP_STALE_MS
      // A run lost to a reload expires after its timeout.
      const isRunning = s.mcpSince !== undefined && now - s.mcpSince < MCP_TIMEOUT_MS + 10_000
      isDue = !isFresh && !isRunning
      return isDue ? { ...s, mcpSince: now } : s
    })
    if (!isDue) return
    let mcp: McpHealth
    try {
      const run = await $.process.run(['claude', 'mcp', 'list'], { timeoutMs: MCP_TIMEOUT_MS })
      mcp = parseMcpList(run.stdout, await $.clock.now())
      if (run.exitCode !== 0 && mcp.ok + mcp.auth.length + mcp.failed.length === 0) {
        mcp.error = run.stderr.trim().split('\n')[0] || `exit ${run.exitCode}`
      }
    } catch (err) {
      mcp = { ok: 0, auth: [], failed: [], checkedAt: await $.clock.now(), error: String(err) }
    }
    if (mcp.error) $.ui.log(`cockpit: claude mcp list unavailable: ${mcp.error}`, { to: 'debug' })
    await update($, snap, s => ({ ...s, mcp, mcpSince: undefined }))
    // Only a session's first result pops up; re-checks and reloads stay quiet.
    if (!prev && mcp.failed.length > 0) {
      $.ui.toast(`cockpit: ${mcp.failed.length} MCP server(s) failed to connect: ${mcp.failed.join(', ')}`)
    }
  } catch (err) {
    $.ui.log(`cockpit: MCP check failed: ${String(err)}`, { to: 'debug' })
  }
}

// Each minute while the pane shows, so its reset and budget countdowns move between turns.
async function tickPane($: EngineInterface): Promise<void> {
  try {
    if ((await $.ui.panes()).some(p => p.id === PANE && p.isShown)) await update($, tick, n => n + 1)
  } catch (err) {
    $.ui.log(`cockpit: pane tick failed: ${String(err)}`, { to: 'debug' })
  }
}

export const register: Register = (on, options) => {
  const text = (value: unknown) => (typeof value === 'string' ? value : undefined)
  const c: Config = {
    budget: numberOf(options.budget, 5),
    contextAlert: numberOf(options.contextAlert, 80),
    rateAlert: numberOf(options.rateAlert, 90),
    tags: parseTags(text(options.projectTags)),
  }
  const { budget, tags } = c
  const isCompact = options.compactTools !== false
  // macOS iCloud "Desktop & Documents Folders" (or OneDrive folder backup) syncs these two.
  const syncedPaths = options.desktopSync === true ? ['~/Desktop', '~/Documents'] : []
  const protectedPaths = parsePaths(text(options.guardPaths))

  on('session.start', async ($, e, next) => {
    void refresh($, c, true)
    // Later, so it does not compete with the session's own MCP startup. A reload cancels the
    // timer, and a short `claude -p` run is over before it fires.
    $.clock.after(MCP_DELAY_MS, () => void checkMcp($))
    $.clock.every(60_000, () => void tickPane($))
    await $.command.register({ name: 'cockpit', description: 'Toggle the cockpit dashboard pane', immediate: true })
    return next(e)
  })

  on('command.run', { command: 'cockpit' }, async $ => {
    if ((await $.ui.panes()).some(p => p.id === PANE && p.isShown && p.isPlaced)) {
      await $.ui.close({ id: PANE })
      return { text: 'Cockpit closed.' }
    }
    const s = (await refresh($, c, true)) ?? (await read($, snap))
    void checkMcp($)
    // The pane's rows: 19 fixed, 2 MCP detail lines, and the rate-limit block, kept for the two
    // subscription windows even before the first reading (the frame shrinks to a shorter tree).
    // ponytail: a gateway reporting more kinds after the pane opened gets cut; reopen it then.
    const rows = 21 + 2 + Math.max(s.limits.length, 2)
    const opened = await $.ui.open({ id: PANE, title: 'Cockpit', rows })
    return { text: opened.isPlaced ? 'Cockpit opened.' : `Cockpit is open but not drawn: ${opened.reason}` }
  })

  // After the UserPromptSubmit hooks beneath have run, so a mode one just switched shows.
  on('prompt.submit', async ($, e, next) => {
    const done = await next(e)
    void refresh($, c, true)
    return done
  })

  // Pushed after each main-thread turn and when a rate-limit window moves, one at a time.
  on('session.measure', async ($, e, next) => {
    await refresh($, c)
    return next(e)
  })

  // Cloud-sync guard: every shell command Claude runs, through Bash or Monitor.
  on('tool.call', { tool: ['Bash', 'Monitor'] }, async ($, e, next) => {
    const [cwd, home] = await Promise.all([$.session.cwd(), syncedPaths.length || protectedPaths.length ? homeOf($) : undefined])
    const guard = { synced: folderMatcher(syncedPaths, home), protected: folderMatcher(protectedPaths, home) }
    const verdict = syncVerdict(e.command ?? '', cwd, guard)
    if (verdict && 'deny' in verdict) {
      await update($, snap, s => ({ ...s, guarded: s.guarded + 1 }))
      return { deny: verdict.deny }
    }
    if (verdict) $.ui.toast(verdict.warn)
    return next(e)
  }).catch(($, e, next) => {
    if (next.called) return next(e)
    // No `$` here (it rejects on re-entry): judge the command text alone.
    const command = 'command' in e && typeof e.command === 'string' ? e.command : ''
    return isRecursiveDelete(command) ? { deny: GUARD_FAILED } : next(e)
  })

  // Restyle: the spinner carries the project tag, read from the root so no state write redraws it.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const { tag, project } = projectOf(await $.session.root(), tags)
    const label = tag ?? project
    if (!label) return next(e)
    const p = e.props
    const props = p.message === null ? { ...p, word: `${label} · ${p.word}` } : { ...p, message: `${label} · ${p.message}` }
    return next({ ...e, props })
  })

  // Restyle: finished read-only calls (the tools compactLabel knows) as one dim line.
  if (isCompact) {
    on(
      'ui.render',
      { component: 'ToolUse', props: { tool: ['Read', 'Glob', 'Grep'], isRunning: false, isErrored: false, isInterrupted: false } },
      async ($, e, next) => {
        const label = compactLabel(e.props.tool, e.props.input)
        if (!label) return next(e)
        const { Text } = $.ui.resolve(e)
        return <Text dimColor wrap="truncate-middle">{label}</Text>
      },
    )
  }

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const [s, now] = await Promise.all([read($, snap), $.clock.now(), read($, tick)])
    const cols = e.props.bodyColumns
    const width = Math.max(10, Math.min(40, cols - 14))
    // label, space, bar, space, up to "100%", then " · 2h05m" when a reset time is known
    const hasReset = s.limits.some(l => resetText(l.resetsAt, now))
    const rateWidth = Math.max(4, Math.min(20, cols - LABEL_W - 6 - (hasReset ? 9 : 0)))
    const burn = burnText(s.usd, s.startedAt, now, budget)
    const pct = s.pct ?? 0
    const ctxColor = pct >= 80 ? 'error' : pct >= 60 ? 'warning' : 'success'
    const isOver = budget > 0 && (s.usd ?? 0) >= budget

    return (
      <Box flexDirection="column">
        <Text bold>{s.tag ? `${s.tag} · ${s.project}` : s.project || '—'}</Text>
        <Text dimColor wrap="truncate-start">{s.path}</Text>
        <Text> </Text>
        <Text bold>Context</Text>
        <Text>
          <Text color={ctxColor}>{bar(pct, width)}</Text> {s.pct === undefined ? '—' : `${Math.round(pct)}%`}
        </Text>
        <Text dimColor>
          {s.tokens === undefined ? '' : `${Math.round(s.tokens / 1000)}k / ${Math.round(s.window / 1000)}k tokens`}
        </Text>
        <Text> </Text>
        <Text bold>Cost</Text>
        <Text color={isOver ? 'error' : undefined}>
          {money(s.usd)}
          {budget > 0 ? ` of ${money(budget)} alert` : ''}
        </Text>
        <Text dimColor>{burn ?? ''}</Text>
        {s.limits.length > 0 && <Text> </Text>}
        {s.limits.length > 0 && <Text bold>Rate limits</Text>}
        {s.limits.map(l => {
          const reset = resetText(l.resetsAt, now)?.replace(/^resets (in )?/, '')
          return (
            <Text wrap="truncate-end">
              {l.kind.padEnd(LABEL_W)} {bar(l.percentUsed, rateWidth)} {Math.round(l.percentUsed)}%
              {reset ? <Text dimColor>{` · ${reset}`}</Text> : ''}
            </Text>
          )
        })}
        <Text> </Text>
        <Text bold>Modes</Text>
        <Text>{s.modes.length ? s.modes.join(' · ') : 'none'}</Text>
        <Text> </Text>
        <Text bold>MCP servers</Text>
        {!s.mcp && <Text dimColor>checking…</Text>}
        {s.mcp?.error && <Text dimColor>unavailable: run `claude mcp list` to see why</Text>}
        {s.mcp && !s.mcp.error && (
          <Text>
            <Text color="success">{s.mcp.ok} ok</Text>
            {' · '}
            <Text color={s.mcp.auth.length ? 'warning' : undefined}>{s.mcp.auth.length} need sign-in</Text>
            {' · '}
            <Text color={s.mcp.failed.length ? 'error' : undefined}>{s.mcp.failed.length} failed</Text>
          </Text>
        )}
        {s.mcp && s.mcp.failed.length > 0 && <Text color="error" wrap="truncate-end">✗ {s.mcp.failed.join(', ')}</Text>}
        {s.mcp && s.mcp.auth.length > 0 && <Text dimColor wrap="truncate-end">! {s.mcp.auth.join(', ')}</Text>}
        <Text> </Text>
        <Text bold>Cloud-sync guard</Text>
        <Text dimColor>{s.guarded ? `${s.guarded} command(s) blocked` : 'nothing blocked'}</Text>
      </Box>
    )
  })
}
