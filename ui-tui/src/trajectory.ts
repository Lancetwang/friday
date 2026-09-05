import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const RENAME_RETRY_DELAYS = [20, 40, 80, 160, 320]

export class TrajectoryWriter {
  private queued = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly path: string,
    private readonly snapshot: () => unknown,
    private readonly write = writeTrajectory,
    private readonly onError = (error: unknown) => {
      process.stderr.write(`friday: could not save trajectory: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  ) {}

  schedule(immediate = false): void {
    if (immediate) {
      if (this.timer) clearTimeout(this.timer)
      this.timer = undefined
      void this.flush().catch(this.onError)
      return
    }
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush().catch(this.onError)
    }, 200)
  }

  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    const value = this.snapshot()
    const pending = this.queued.then(() => this.write(this.path, value))
    // Return this write's error to its caller, but keep the serialization tail
    // usable so a failed background snapshot cannot disable every later save.
    this.queued = pending.catch(() => {})
    return pending
  }
}

export async function writeTrajectory(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, path); break }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        const pause = RENAME_RETRY_DELAYS[attempt]
        if (pause === undefined || !['EBUSY', 'EPERM', 'EACCES'].includes(code ?? '')) throw error
        // Windows can briefly deny replacement while a reader or scanner holds
        // the destination. Keep the old snapshot intact until rename succeeds.
        await delay(pause)
      }
    }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}
