import type { JsonObject } from './types.js'

export async function* readSseJson(body: ReadableStream<Uint8Array>): AsyncGenerator<JsonObject> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  while (true) {
    const { value, done } = await reader.read()
    pending += decoder.decode(value, { stream: !done })
    if (done && pending && !pending.endsWith('\n')) pending += '\n'
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data || data === '[DONE]') continue
      const value: unknown = JSON.parse(data)
      if (isObject(value)) yield value
    }
    if (done) return
  }
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
