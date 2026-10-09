// Self-contained (the validator refuses imports here): SessionRateLimit's shape.
export type RateLimit = { kind: string; percentUsed: number; resetsAt?: string }

export type McpHealth = {
  ok: number
  auth: string[]
  failed: string[]
  checkedAt: number
  // Set when `claude mcp list` could not run or answered nothing.
  error?: string
}

export type Snapshot = {
  pct?: number
  tokens?: number
  window: number
  usd?: number
  limits: RateLimit[]
  modes: string[]
  project: string
  tag?: string
  // The project root, `~` for the home folder.
  path: string
  // Commands the guard blocked this session.
  guarded: number
  // The session's usage.startedAt; a new one (/clear) starts the session's counters over.
  startedAt?: number
  // `${startedAt}:${budget}` of the last cost alert.
  alertedFor?: string
  // Whether context stood at or over the context alert at the last reading.
  ctxOver?: boolean
  // `${kind}:${resetsAt}` of each rate-limit window already alerted.
  rateAlerted?: string[]
  mcp?: McpHealth
  // When a `claude mcp list` run in flight started.
  mcpSince?: number
}

declare module 'claude-code' {
  interface PluginState {
    // `tick` counts minutes while the pane shows, so its countdowns redraw.
    cockpit: { snap: Snapshot; tick: number }
  }
}
