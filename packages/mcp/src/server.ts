// The MCP server: tools for agents that fund a wallet or pay out to a person.
// A person always completes the payment step (human in the loop): the agent gets a pay link.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import * as z from 'zod'
import { RampError } from './backend.js'
import type { OpenRampMcpConfig } from './config.js'
import { createRampOps } from './ramp.js'
import type { DepositArgs, RampOps } from './ramp.js'

const VERSION = '0.0.1'

const ok = (data: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }] })
const fail = (code: string, message: string): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify({ error: { code, message } }) }], isError: true })

/** Run a tool body; turn known errors into compact error results. Unknown errors never leak details. */
async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await fn())
  } catch (e) {
    if (e instanceof RampError) return fail(e.code, e.message)
    return fail('INTERNAL', 'Something went wrong in the ramp server. Try again later.')
  }
}

const countrySchema = z.string().describe('ISO 3166-1 alpha-2 country of the person who pays or receives, e.g. "VN", "ID", "TH", "MY", "PH", "SG". Picks local methods such as VietQR, QRIS, PromptPay, DuitNow, QR Ph, PayNow.')
const decimal = z.string().regex(/^\d+(\.\d+)?$/, 'A decimal string, e.g. "25" or "12.5"')
const direction = z.enum(['deposit', 'withdraw']).default('deposit').describe('"deposit": a person pays in to fund a wallet. "withdraw": a person receives a payout.')

/**
 * Build the OpenRampKit MCP server. Pass a config (with `connection`), or ramp operations from
 * `createRampOps(config)` to share one registry between many server instances (HTTP transport).
 */
export function createOpenRampMcpServer(configOrOps: OpenRampMcpConfig | RampOps): McpServer {
  const ops = 'listPaymentMethods' in configOrOps ? configOrOps : createRampOps(configOrOps)
  const config = ops.config
  const server = new McpServer(config.serverInfo ?? { name: 'openrampkit', version: VERSION })
  const destinations = config.deposit?.destinations ?? []
  const destList = destinations.map((d) => `"${d.name}"${d.description ? ` (${d.description})` : ''}: ${d.symbol ?? d.token} on ${d.chain} to ${d.address}`).join('; ')
  const caps = Object.entries(config.maxAmounts).map(([c, v]) => `${v} ${c}`).join(', ')
  const destinationField = destinations.length ? z.enum(destinations.map((d) => d.name) as [string, ...string[]]) : z.string()

  server.registerTool(
    'list_payment_methods',
    {
      title: 'List payment methods',
      description: 'List the payment methods a person can use in a country, with availability, speed and limits. Read only. It does not move money.',
      inputSchema: {
        country: countrySchema,
        direction,
        ...(destinations.length > 1 ? { destination: destinationField.optional().describe(`Deposit destination to plan for. Allowed: ${destList}`) } : {}),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (a) => run(() => ops.listPaymentMethods(a as { country: string; direction: 'deposit' | 'withdraw'; destination?: string })),
  )

  server.registerTool(
    'get_quotes',
    {
      title: 'Get quotes',
      description:
        'Get price quotes for an amount: what the person pays, what arrives, fees and time. Without method, it quotes up to 3 available cash methods. For a deposit, amount is in the local currency of the method (for example VND for VietQR). For a withdraw, amount is in the source token. Read only.',
      inputSchema: {
        country: countrySchema,
        amount: decimal.describe('Amount to pay, as a decimal string'),
        method: z.string().optional().describe('A method id from list_payment_methods, e.g. "vietqr"'),
        direction,
        ...(destinations.length > 1 ? { destination: destinationField.optional().describe(`Deposit destination. Allowed: ${destList}`) } : {}),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (a) => run(() => ops.getQuotes(a as { country: string; amount: string; method?: string; direction: 'deposit' | 'withdraw'; destination?: string })),
  )

  if (config.deposit) {
    const custom: Record<string, z.ZodType> = config.deposit.allowCustomAddress?.chains.length
      ? {
          custom_destination: z
            .object({ chain: z.string(), token: z.string(), address: z.string(), symbol: z.string().optional(), decimals: z.number().int().min(0).max(36).optional() })
            .optional()
            .describe(`Your own address. Allowed only on: ${config.deposit.allowCustomAddress.chains.join(', ')}. Prefer a named destination.`),
        }
      : {}
    server.registerTool(
      'create_deposit_session',
      {
        title: 'Create deposit session',
        description:
          `Create a deposit that a person pays, to fund an allowed wallet. Returns pay_url: show it to the person (as a link or a QR code). They open it on a phone and pay with a local method (VietQR, QRIS, PromptPay, card, crypto). Funds go only to an allowed destination: ${destList || 'custom addresses only'}. ` +
          `Per-session caps: ${caps}. Give method and amount to also get direct payment instructions (for example a VietQR payload). Then call wait_for_completion.`,
        inputSchema: {
          country: countrySchema,
          ...(destinations.length ? { destination: destinationField.optional().describe(`Allowed destination name. Default: the only one, when there is one. Allowed: ${destList}`) } : {}),
          ...custom,
          currency: z.string().optional().describe(`Currency of the bounds: a currency code or token symbol. Default: the local currency of the country. Allowed: ${Object.keys(config.maxAmounts).join(', ')}`),
          max_amount: decimal.optional().describe('Largest amount the person may pay, in currency. Default: the cap.'),
          min_amount: decimal.optional().describe('Smallest amount the person may pay, in currency.'),
          method: z.string().optional().describe('Optional: a method id (e.g. "vietqr") to start the payment now and return direct instructions. Needs amount.'),
          amount: decimal.optional().describe('Optional: exact amount for method, in currency.'),
          reference: z.string().max(200).optional().describe('Your note or order id. Echoed in webhooks as metadata.reference.'),
          ttl_minutes: z.number().int().min(1).max(1440).optional().describe('Minutes until the session expires. Capped by the server config.'),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      (a) => run(() => ops.createDepositSession(a as DepositArgs)),
    )
  }

  if (config.withdraw) {
    const src = config.withdraw.source
    server.registerTool(
      'create_withdraw_session',
      {
        title: 'Create payout session',
        description:
          `Create a payout to a person, from ${src.symbol ?? src.token} on ${src.chain}. Returns pay_url: send it to the person who receives the funds. They choose how to receive them (for example a bank account or e-wallet) and confirm. You cannot choose where the funds go. ` +
          `Caps: ${caps}. Then call wait_for_completion.`,
        inputSchema: {
          country: countrySchema,
          amount: decimal.optional().describe(`Exact amount to pay out, in ${src.symbol ?? 'the source token'}. The person cannot change it.`),
          max_amount: decimal.optional().describe(`Largest amount, in ${src.symbol ?? 'the source token'}, when the person picks the amount. Default: the cap.`),
          reference: z.string().max(200).optional().describe('Your note or order id. Echoed in webhooks as metadata.reference.'),
          ttl_minutes: z.number().int().min(1).max(1440).optional().describe('Minutes until the session expires. Capped by the server config.'),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      (a) => run(() => ops.createWithdrawSession(a)),
    )
  }

  server.registerTool(
    'get_session_status',
    {
      title: 'Get session status',
      description: 'Read the status of a session that you created: open, processing, completed, failed, expired or refunded, with what was paid and received. Read only.',
      inputSchema: { session_id: z.string().describe('The session_id from create_deposit_session or create_withdraw_session') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (a) => run(() => ops.getSessionStatus(a.session_id)),
  )

  server.registerTool(
    'wait_for_completion',
    {
      title: 'Wait for completion',
      description:
        'Wait until the person finishes the payment, or until timeout_seconds pass. Returns the status. When timed_out is true, the payment is not finished yet: call it again or check with the person. Read only.',
      inputSchema: {
        session_id: z.string().describe('The session_id from create_deposit_session or create_withdraw_session'),
        timeout_seconds: z.number().int().min(1).max(600).default(60).describe('Longest wait, in seconds. Capped by the server config.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (a, extra) =>
      run(() => {
        const token = extra._meta?.progressToken
        return ops.waitForCompletion(a.session_id, {
          timeoutSeconds: a.timeout_seconds,
          signal: extra.signal,
          ...(token !== undefined
            ? {
                onPoll: (v, ms) =>
                  extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: Math.round(ms / 1000), message: `${v.status}: ${v.state}` } }).catch(() => {}),
              }
            : {}),
        })
      }),
  )

  return server
}
