import { chmod, mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import lockfile from 'proper-lockfile'

/** Cross-process serialization on a local filesystem, with stale-lock recovery. */
export async function withStateLock<T>(path: string, work: () => Promise<T>, wait = true): Promise<T> {
  const release = await acquireStateLock(path, wait)
  try { return await work() } finally { await release() }
}

export async function acquireStateLock(path: string, wait = true): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true })
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

export async function writeTextAtomic(path: string, value: string, privateFile = false): Promise<void> {
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
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}
