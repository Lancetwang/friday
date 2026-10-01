import type { RuntimeMethods } from 'friday-agent-protocol'

export type PendingRequest = { reject: (error: Error) => void; resolve: (value: unknown) => void; workspace: string }
export type GatewayMessage = {
  error?: { code?: number; data?: { kind?: string; status?: number }; message?: string }
  id?: string
  method?: string
  params?: { payload?: Record<string, unknown>; type?: string }
  result?: unknown
}
export class GatewayRequestError extends Error {
  readonly kind: string
  readonly status?: number
  constructor(message: string, kind = '', status?: number) {
    super(message); this.name = 'GatewayRequestError'; this.kind = kind; this.status = status
  }
}

export type RuntimeArguments<M extends keyof RuntimeMethods> = Record<string, never> extends RuntimeMethods[M]['params']
  ? [params?: RuntimeMethods[M]['params']] : [params: RuntimeMethods[M]['params']]

/** No UI state or native imports: the caller owns gateway startup and lifecycle. */
export function requestGateway<M extends keyof RuntimeMethods>(options: {
  pending: Map<string, PendingRequest>; id: string; workspace: string; method: M; params: RuntimeMethods[M]['params']
  write(message: string): Promise<unknown>; start(): Promise<unknown>; timeoutMs?: number
}): Promise<RuntimeMethods[M]['result']> {
  const long = ['chat.send', 'goal.run', 'approval.approve', 'approval.instruct', 'approval.reject', 'session.compact', 'memory.command'].includes(options.method)
  const run = (options.params as { run?: { timeout_ms?: number } }).run
  const timeout = options.timeoutMs ?? (long ? Math.max(18 * 60_000, (run?.timeout_ms ?? 0) + 30_000) : 60_000)
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (work: () => void) => {
      if (settled) return
      settled = true; clearTimeout(timer); options.pending.delete(options.id); work()
    }
    const timer = setTimeout(() => finish(() => reject(new GatewayRequestError(`Gateway request timed out: ${options.method}`, 'transport_timeout'))), timeout)
    options.pending.set(options.id, { workspace: options.workspace,
      resolve: value => finish(() => resolve(value as RuntimeMethods[M]['result'])), reject: error => finish(() => reject(error)) })
    const message = JSON.stringify({ id: options.id, jsonrpc: '2.0', protocol_version: 1, method: options.method, params: options.params })
    void options.write(message).catch(async error => {
      if (settled) return
      if (!String(error).includes('gateway is not running')) throw error
      await options.start()
      if (!settled) await options.write(message)
    }).catch(error => finish(() => reject(error instanceof Error ? error : new Error(String(error)))))
  })
}

export function settleGateway(pending: Map<string, PendingRequest>, workspace: string, message: GatewayMessage): void {
  if (!message.id) return
  const request = pending.get(message.id)
  const key = (value: string) => value.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()
  if (!request || key(workspace) !== key(request.workspace)) return
  if (message.error) request.reject(new GatewayRequestError(message.error.message || 'Friday gateway failed.', message.error.data?.kind, message.error.data?.status))
  else request.resolve(message.result)
}
