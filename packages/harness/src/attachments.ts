import { open, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'

import type { LocalAttachment, PreparedLocalAttachments } from 'friday-agent-protocol'

export type LocalImageAttachment = { data_url: string; name: string; path: string; size: number }
export type { LocalAttachment, PreparedLocalAttachments } from 'friday-agent-protocol'

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

/**
 * Resolve user-selected paths once, promoting real image files into the same
 * data-URL input used by clipboard images. Everything else remains a Read-able
 * local attachment. File extensions are not trusted: the magic bytes decide.
 */
export async function prepareLocalAttachments(value: unknown): Promise<PreparedLocalAttachments> {
  if (value === undefined || value === null || Array.isArray(value) && !value.length) {
    return { attachments: [], images: [] }
  }
  if (!Array.isArray(value) || value.length > 8) throw new Error('Attach at most eight local files or folders.')
  const attachments: LocalAttachment[] = []
  const images: LocalImageAttachment[] = []
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
    if (status.isFile()) {
      const image = await localImage(path, status.size)
      if (image) {
        images.push(image)
        continue
      }
    }
    attachments.push({
      kind: status.isDirectory() ? 'folder' : 'file',
      name: basename(path) || path,
      path,
      ...(status.isFile() ? { size: status.size } : {})
    })
  }
  imageUrls(images.map(image => image.data_url))
  return { attachments, images }
}

async function localImage(path: string, size: number): Promise<LocalImageAttachment | undefined> {
  const handle = await open(path, 'r')
  try {
    const header = Buffer.alloc(12)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    const mime = imageMime(header.subarray(0, bytesRead))
    if (!mime) return undefined
    if (size > IMAGE_BYTES) throw new Error(`Attached image is larger than 10 MB: ${path}`)
    const content = await handle.readFile()
    if (content.length > IMAGE_BYTES) throw new Error(`Attached image is larger than 10 MB: ${path}`)
    return {
      data_url: `data:${mime};base64,${content.toString('base64')}`,
      name: basename(path) || path,
      path,
      size: content.length
    }
  } finally {
    await handle.close()
  }
}

function imageMime(header: Buffer): 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp' | undefined {
  if (header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png'
  }
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return 'image/jpeg'
  const prefix = header.subarray(0, 6).toString('ascii')
  if (prefix === 'GIF87a' || prefix === 'GIF89a') return 'image/gif'
  if (header.length >= 12 && header.subarray(0, 4).toString('ascii') === 'RIFF'
    && header.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return undefined
}

export function attachmentPrompt(text: string, attachments: readonly LocalAttachment[]): string {
  if (!attachments.length) return text
  const rows = attachments.map(item => `- ${JSON.stringify(item)}`)
  return `${text}\n\nAttached local items (inspect with Read when relevant):\n${rows.join('\n')}`
}
