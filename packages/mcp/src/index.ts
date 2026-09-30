// @openrampkit/mcp: a Model Context Protocol server for OpenRampKit. AI agents create deposit and
// payout sessions inside config guardrails; a person pays or receives through a hosted pay link.

export { createOpenRampMcpServer } from './server.js'
export { createMcpHttpHandler } from './http.js'
export type { McpHttpOptions } from './http.js'
export { createRampOps } from './ramp.js'
export type { RampOps, DepositArgs, WithdrawArgs, WaitOptions } from './ramp.js'
export { RampError, createBackend } from './backend.js'
export type { Backend, Connection, CreatedSession, InProcessOpenRamp, SessionInput } from './backend.js'
export type { NamedDestination, OpenRampMcpConfig } from './config.js'
export { memoryRegistry } from './registry.js'
export type { RegistryEntry, SessionRegistry } from './registry.js'
