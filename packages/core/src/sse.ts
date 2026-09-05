import type { JsonObject } from './types.js'

export async function* readSseJson(body: ReadableStream<Uint8Array>, hooks: { onDone?: () => void; onActivity?: () => void } = {}): AsyncGenerator<JsonObject> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  let data: string[] = []
  try {
  while (true) {
    const { value, done } = await reader.read()
    if (value?.length) hooks.onActivity?.()
    pending += decoder.decode(value, { stream: !done })
    if (done) pending += '\n\n'
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() ?? ''
    for (const line of lines) {
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
      else if (!line && data.length) {
        const text = data.join('\n')
        data = []
        if (text.trim() === '[DONE]') { hooks.onDone?.(); return }
        const parsed: unknown = JSON.parse(text)
        if (isObject(parsed)) yield parsed
      }
    }
    if (done) return
  }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
