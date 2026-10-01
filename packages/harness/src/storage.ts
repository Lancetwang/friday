import { chmod, mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import lockfile from 'proper-lockfile'
import { setTimeout as delay } from 'node:timers/promises'

/** Cross-process serialization on a local filesystem, with stale-lock recovery. */
export async function withStateLock<T>(path: string, work: () => Promise<T>, wait = true, signal?: AbortSignal): Promise<T> {
  const release = await acquireStateLock(path, wait, signal)
  try { return await work() } finally { await release() }
}

export async function acquireStateLock(path: string, wait = true, signal?: AbortSignal): Promise<() => Promise<void>> {
  signal?.throwIfAborted()
  await mkdir(dirname(path), { recursive: true })
  if (signal) {
    const until = Date.now() + 25_000
    for (;;) {
      signal.throwIfAborted()
      let release: () => Promise<void>
      try { release = await lockfile.lock(path, { realpath: false, stale: 30_000, update: 5_000, retries: 0 }) }
      catch (error) {
        if (!wait || (error as NodeJS.ErrnoException).code !== 'ELOCKED' || Date.now() >= until) throw error
        await delay(50, undefined, { signal })
        continue
      }
      if (signal.aborted) { await release(); signal.throwIfAborted() }
      return release
    }
  }
  return lockfile.lock(path, {
    realpath: false,
    stale: 30_000,
    update: 5_000,
    retries: wait ? { retries: 100, minTimeout: 50, maxTimeout: 250, factor: 1.1 } : 0
  })
}

export async function writeJsonAtomic(path: string, value: unknown, privateFile = false): Promise<void> {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`, privateFile)
}

export async function writeTextAtomic(path: string, value: string, privateFile = false, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  await mkdir(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`)
  try {
    const previous = await stat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return undefined
    })
    const mode = privateFile ? 0o600 : previous ? previous.mode & 0o777 : 0o666
    const file = await open(temporary, 'wx', mode)
    try { await file.writeFile(value, 'utf8'); await file.sync() } finally { await file.close() }
    if (privateFile || previous) await chmod(temporary, mode)
    signal?.throwIfAborted()
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

/** Stop waiting without acquiring or leaking a later resource. */
export function waitForSignal<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort)).catch(() => {})
  })
}
