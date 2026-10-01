import assert from 'node:assert/strict'
import { GatewayRequestError, requestGateway, settleGateway, type PendingRequest } from '../src/GatewayClient.ts'
import { RunEventFence } from '../src/RunEventFence.ts'

const pending = new Map<string, PendingRequest>()
const workspace = 'E:\\project'
let starts = 0; let writes = 0
const request = requestGateway({ pending, id: 'one', workspace, method: 'session.info', params: {}, timeoutMs: 500,
  write: async () => { writes++; if (writes === 1) throw new Error('gateway is not running') }, start: async () => { starts++ } })
await new Promise(resolve => setTimeout(resolve, 5))
assert.equal(starts, 1); assert.equal(writes, 2)
settleGateway(pending, 'E:\\unrelated', { id: 'one', result: {} })
assert.equal(pending.size, 1)
settleGateway(pending, 'e:/project', { id: 'one', result: { cwd: workspace } })
assert.equal((await request).cwd, workspace); assert.equal(pending.size, 0)

const timeout = requestGateway({ pending, id: 'timeout', workspace, method: 'session.info', params: {}, timeoutMs: 5, write: async () => {}, start: async () => {} })
await assert.rejects(timeout, (error: unknown) => error instanceof GatewayRequestError && error.kind === 'transport_timeout')
assert.equal(pending.size, 0)
settleGateway(pending, workspace, { id: 'timeout', result: {} })

const closed = requestGateway({ pending, id: 'closed', workspace, method: 'session.info', params: {}, timeoutMs: 500, write: async () => {}, start: async () => {} })
pending.get('closed')!.reject(new Error('gateway exited'))
await assert.rejects(closed, /exited/); assert.equal(pending.size, 0)

const fence = new RunEventFence(); const key = 'project::session'
assert(fence.accept(key, 'message.start', 'one'))
assert(fence.accept(key, 'run.start', 'one'))
assert(fence.accept(key, 'message.delta', 'one'))
assert(fence.accept(key, 'message.complete', 'one'))
assert(!fence.accept(key, 'tool.complete', 'one'))
assert(fence.accept(key, 'session.titled', 'one'))
assert(fence.accept(key, 'run.start', 'two'))
assert(!fence.current(key, 'one'))
assert(!fence.accept(key, 'message.complete', 'one'))
assert(!fence.accept(key, 'run.start', 'one'))
assert(fence.accept(key, 'tool.complete', 'two'))
assert(fence.accept('other::session', 'message.delta', 'one'))
fence.clear('project::')
assert(!fence.current(key, 'two'))
console.log('Desktop runtime: startup recovery, workspace matching, request timeout, exit cleanup and run fencing passed.')
