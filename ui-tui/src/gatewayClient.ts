import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'

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
    const python = process.env.FRIDAY_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
    const env = { ...process.env }
    const root = process.env.FRIDAY_ROOT
    const cwd = process.env.FRIDAY_CWD || process.cwd()

    this.proc = spawn(python, ['-m', 'friday.tui_gateway'], {
      cwd,
      env: root ? { ...env, PYTHONPATH: env.PYTHONPATH ? `${root}${process.platform === 'win32' ? ';' : ':'}${env.PYTHONPATH}` : root } : env,
      stdio: ['pipe', 'pipe', 'pipe']
    })

    createInterface({ input: this.proc.stdout! }).on('line', line => this.dispatch(line))
    createInterface({ input: this.proc.stderr! }).on('line', line =>
      this.emit('event', { type: 'gateway.stderr', payload: { line } } satisfies GatewayEvent)
    )
    this.proc.on('exit', code => {
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
      this.proc!.stdin!.write(JSON.stringify({ id, jsonrpc: '2.0', method, params }) + '\n')
    })
  }

  kill() {
    this.proc?.kill()
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
