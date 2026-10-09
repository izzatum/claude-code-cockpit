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
  guarded: number
  // `${startedAt}:${budget}` of the last cost alert.
  alertedFor?: string
  mcp?: McpHealth
  // When a `claude mcp list` run in flight started.
  mcpSince?: number
}

declare module 'claude-code' {
  interface PluginState {
    cockpit: { snap: Snapshot }
  }
}
