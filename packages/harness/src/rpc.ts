import type { RpcRequest } from 'friday-agent-protocol'

export const PROTOCOL_VERSION = 1 as const
export const MAX_RPC_BYTES = 32 * 1024 * 1024
const METHODS = new Set(['session.info', 'session.current', 'session.resume_choices', 'session.tree', 'context.get', 'progress.get', 'trace.serve', 'trace.stop', 'memory.command', 'checkpoint.list', 'checkpoint.undo', 'plugin.list', 'plugin.toggle', 'skill.list', 'skill.get', 'artifact.get', 'attachment.prepare', 'model.list', 'projects.list', 'projects.close', 'settings.web.get', 'settings.compaction.get', 'settings.compaction.save', 'settings.web.key.get', 'settings.web.save', 'settings.user.save', 'settings.memory.read', 'settings.memory.save', 'settings.get', 'permission.set', 'approval.pending', 'session.reset', 'session.new', 'session.compact', 'session.resume', 'session.rename', 'session.fork', 'session.delete', 'goal.run', 'thinking.set', 'model.save', 'model.key.get', 'model.key.clear', 'model.refresh', 'model.enabled.set', 'model.select', 'model.delete', 'chat.send', 'chat.steer', 'chat.cancel', 'approval.approve', 'approval.instruct', 'approval.reject', 'session.list', 'session.messages', 'plugin.reload'])

export class RpcError extends Error {
  constructor(readonly code: number, message: string) { super(message); this.name = 'RpcError' }
}

/** Validate the transport boundary before any session or settings mutation. */
export function validateRpcRequest(value: unknown): RpcRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RpcError(-32600, 'Expected a request object.')
  const request = value as Record<string, unknown>
  if (request.id !== undefined && typeof request.id !== 'string' && typeof request.id !== 'number') throw new RpcError(-32600, 'Invalid request id.')
  if (request.jsonrpc !== undefined && request.jsonrpc !== '2.0') throw new RpcError(-32600, 'Unsupported JSON-RPC version.')
  if (request.protocol_version !== undefined && request.protocol_version !== PROTOCOL_VERSION) throw new RpcError(-32600, 'Unsupported Friday protocol version.')
  if (typeof request.method !== 'string' || !METHODS.has(request.method)) throw new RpcError(-32601, 'Unknown method.')
  if (request.params !== undefined && (!request.params || typeof request.params !== 'object' || Array.isArray(request.params))) throw new RpcError(-32602, 'Parameters must be an object.')
  const params = (request.params ?? {}) as Record<string, unknown>
  const strings = ['text', 'name', 'id', 'path', 'command', 'profile_id', 'trust_digest']
  for (const key of strings) if (params[key] !== undefined && typeof params[key] !== 'string') throw new RpcError(-32602, `${key} must be a string.`)
  for (const key of ['enabled', 'activate']) if (params[key] !== undefined && typeof params[key] !== 'boolean') throw new RpcError(-32602, `${key} must be boolean.`)
  for (const key of ['offset', 'limit', 'message_index']) if (params[key] !== undefined && (!Number.isSafeInteger(params[key]) || Number(params[key]) < 0)) throw new RpcError(-32602, `${key} must be a non-negative integer.`)
  if (request.method === 'plugin.toggle' && (typeof params.name !== 'string' || typeof params.enabled !== 'boolean')) throw new RpcError(-32602, 'Plugin name and enabled are required.')
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_RPC_BYTES) throw new RpcError(-32600, 'Request exceeds the 32 MiB limit.')
  return request as RpcRequest
}
