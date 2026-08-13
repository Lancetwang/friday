import { realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'

export type LocalAttachment = { kind: 'file' | 'folder'; name: string; path: string; size?: number }

const IMAGE = /^data:image\/(?:png|jpeg|webp|gif);base64,([A-Za-z0-9+/]*={0,2})$/i
const IMAGE_BYTES = 10 * 1024 * 1024

export function imageUrls(value: unknown): string[] {
  if (value === undefined || value === null || Array.isArray(value) && !value.length) return []
  if (!Array.isArray(value) || value.length > 4) throw new Error('Attach at most four images.')
  const images = value.map(String)
  if (images.some(item => {
    const body = IMAGE.exec(item)?.[1]
    return !body || body.length % 4 !== 0 || decodedBytes(body) > IMAGE_BYTES
  })) {
    throw new Error('Images must be PNG, JPEG, WebP, or GIF data URLs no larger than 10 MB.')
  }
  if (images.reduce((sum, item) => sum + item.length, 0) > 20_000_000) throw new Error('Attached images are too large.')
  return images
}

function decodedBytes(value: string): number {
  return value.length / 4 * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0)
}

export async function localAttachments(value: unknown): Promise<LocalAttachment[]> {
  if (value === undefined || value === null || Array.isArray(value) && !value.length) return []
  if (!Array.isArray(value) || value.length > 8) throw new Error('Attach at most eight local files or folders.')
  const attachments: LocalAttachment[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('Local attachments must be files or folders selected on this computer.')
    }
    const raw = String((item as Record<string, unknown>).path || '')
    if (!isAbsolute(raw)) throw new Error('Local attachment paths must be absolute.')
    let path: string
    let status
    try {
      path = await realpath(raw)
      status = await stat(path)
    } catch {
      throw new Error(`Attached item is unavailable: ${raw}`)
    }
    if (!status.isFile() && !status.isDirectory()) throw new Error(`Attached item is not a file or folder: ${path}`)
    const key = process.platform === 'win32' ? path.toLowerCase() : path
    if (seen.has(key)) continue
    seen.add(key)
    attachments.push({
      kind: status.isDirectory() ? 'folder' : 'file',
      name: basename(path) || path,
      path,
      ...(status.isFile() ? { size: status.size } : {})
    })
  }
  return attachments
}

export function attachmentPrompt(text: string, attachments: readonly LocalAttachment[]): string {
  if (!attachments.length) return text
  const rows = attachments.map(item => `- ${JSON.stringify(item)}`)
  return `${text}\n\nAttached local items (inspect with Read when relevant):\n${rows.join('\n')}`
}
