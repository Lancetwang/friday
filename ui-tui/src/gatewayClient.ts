import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import type { GatewayEvent } from './types.js'

type Pending = {
  reject: (error: Error) => void
  resolve: (value: unknown) => void
}

export class GatewayClient extends EventEmitter {
  private proc: ChildProcess | null = null
  private pending = new Map<string, Pending>()
  private seq = 0

  start() {
    if (this.proc) return
    const env = { ...process.env }
    const cwd = process.env.FRIDAY_CWD || process.cwd()
    const here = dirname(fileURLToPath(import.meta.url))
    const packaged = resolve(here, 'gateway.js')
    const source = resolve(here, '../../packages/harness/dist/gateway.js')
    const entry = process.env.FRIDAY_GATEWAY_ENTRY || (existsSync(packaged) ? packaged : source)
    if (!existsSync(entry)) throw new Error(`Friday gateway is not built: ${entry}. Run npm run build first.`)

    const proc = spawn(process.execPath, [entry], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.proc = proc

    createInterface({ input: proc.stdout! }).on('line', line => this.dispatch(line))
    createInterface({ input: proc.stderr! }).on('line', line =>
      this.emit('event', { type: 'gateway.stderr', payload: { line } } satisfies GatewayEvent)
    )
    proc.on('exit', code => {
      if (this.proc === proc) this.proc = null
      for (const pending of this.pending.values()) {
        pending.reject(new Error(`gateway exited${code === null ? '' : ` (${code})`}`))
      }
      this.pending.clear()
      this.emit('exit', code)
    })
  }

  request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.proc?.stdin) {
      this.start()
    }
    const id = `r${++this.seq}`
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: value => resolve(value as T), reject })
      this.proc!.stdin!.write(JSON.stringify({ id, jsonrpc: '2.0', method, params }) + '\n', error => {
        if (!error || !this.pending.delete(id)) return
        reject(error)
      })
    })
  }

  kill() {
    this.proc?.kill()
    this.proc = null
  }

  private dispatch(line: string) {
    try {
      const msg = JSON.parse(line) as { id?: string; method?: string; params?: unknown; result?: unknown; error?: { message?: string } }
      if (msg.id && this.pending.has(msg.id)) {
        const pending = this.pending.get(msg.id)!
        this.pending.delete(msg.id)
        msg.error ? pending.reject(new Error(msg.error.message || 'request failed')) : pending.resolve(msg.result)
        return
      }
      if (msg.method === 'event' && msg.params) {
        this.emit('event', msg.params as GatewayEvent)
      }
    } catch {
      this.emit('event', { type: 'gateway.protocol_error', payload: { preview: line.slice(0, 160) } } satisfies GatewayEvent)
    }
  }
}
