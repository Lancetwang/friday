import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export async function writeJsonAtomic(path: string, value: unknown, privateFile = false): Promise<void> {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`, privateFile)
}

export async function writeTextAtomic(path: string, value: string, privateFile = false): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, value, { encoding: 'utf8', mode: privateFile ? 0o600 : 0o666 })
    if (privateFile) await chmod(temporary, 0o600).catch(() => {})
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}
