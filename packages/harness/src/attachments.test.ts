import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Gateway } from './gateway.js'
import { imageUrls } from './attachments.js'

test('desktop images and selected local files reach the model and resumable history safely', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'friday-ts-attachments-'))
  const home = join(temporary, 'home')
  const workspace = join(temporary, 'workspace')
  const external = join(temporary, 'selected.txt')
  const selectedFolder = join(temporary, 'selected-folder')
  await mkdir(home)
  await mkdir(workspace)
  await mkdir(selectedFolder)
  await writeFile(external, 'selected evidence\n')
  await writeFile(join(selectedFolder, 'nested.txt'), 'nested evidence\n')
  const previous = process.env.FRIDAY_HOME
  process.env.FRIDAY_HOME = home
  const bodies: Array<Record<string, unknown>> = []
  const server = createServer((request, response) => void answer(request, response, body => {
    bodies.push(body)
    if (bodies.length === 1) return { tool_calls: [
      { index: 0, id: 'read-attachment', type: 'function', function: { name: 'Read', arguments: JSON.stringify({ path: external }) } },
      { index: 1, id: 'list-attachment', type: 'function', function: { name: 'Read', arguments: JSON.stringify({ path: selectedFolder }) } }
    ] }
    if (bodies.length === 2) return {
      tool_calls: [{ index: 0, id: 'read-nested', type: 'function', function: { name: 'Read', arguments: JSON.stringify({ path: join(selectedFolder, 'nested.txt') }) } }]
    }
    return { content: 'attachments read' }
  }))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address === 'object')
  const output: unknown[] = []
  const image = 'data:image/png;base64,aA=='
  try {
    await writeFile(join(home, 'models.json'), JSON.stringify({
      active: 'local', profiles: [{
        id: 'local', name: 'Local', provider: 'openai-compatible', model: 'mock', vision: true,
        base_url: `http://127.0.0.1:${address.port}`, context_window: 100_000, max_output_tokens: 2_000
      }]
    }))
    await writeFile(join(home, 'model-credentials.json'), JSON.stringify({ local: 'secret' }))
    const gateway = new Gateway(workspace, value => output.push(value))
    await gateway.start()
    output.length = 0

    await gateway.handle({
      id: 'chat', method: 'chat.send', params: {
        text: 'Inspect my attachments.', images: [image], attachments: [{ path: external }, { path: selectedFolder }]
      }
    })
    assert.equal((response(output, 'chat') as { text: string }).text, 'attachments read')
    assert.equal(bodies.length, 3)
    const firstMessages = bodies[0]?.messages as Array<{ role: string; content: unknown }>
    const user = firstMessages.findLast(message => message.role === 'user')
    assert(Array.isArray(user?.content))
    assert.match(String((user.content[0] as { text: string }).text), /selected\.txt/)
    assert.equal((user.content[1] as { image_url: { url: string } }).image_url.url, image)
    assert.match(JSON.stringify(bodies[1]), /selected evidence/)
    assert.match(JSON.stringify(bodies[1]), /nested\.txt/)
    assert.match(JSON.stringify(bodies[2]), /nested evidence/)

    output.length = 0
    await gateway.handle({ id: 'current', method: 'session.current' })
    const history = (response(output, 'current') as { history: Array<Record<string, unknown>> }).history
    const restored = history.find(item => item.kind === 'user')!
    assert.equal(restored.text, 'Inspect my attachments.')
    assert.deepEqual(restored.images, [image])
    assert.deepEqual(restored.attachments, [
      { kind: 'file', name: 'selected.txt', path: external, size: 18 },
      { kind: 'folder', name: 'selected-folder', path: selectedFolder }
    ])
    assert.throws(() => imageUrls(['data:image/png;base64,not base64']), /PNG, JPEG, WebP, or GIF/)
  } finally {
    if (previous === undefined) delete process.env.FRIDAY_HOME
    else process.env.FRIDAY_HOME = previous
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(temporary, { recursive: true, force: true })
  }
})

async function answer(
  request: IncomingMessage,
  response: ServerResponse,
  value: (body: Record<string, unknown>) => { content?: string; tool_calls?: unknown[] }
): Promise<void> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.write(`data: ${JSON.stringify({ choices: [{ delta: value(body) }] })}\n\n`)
  response.end('data: [DONE]\n\n')
}

function response(output: unknown[], id: string): unknown {
  const message = output.find(value => (value as { id?: unknown }).id === id) as { result?: unknown; error?: unknown } | undefined
  assert(message && !message.error, `Missing successful response ${id}: ${JSON.stringify(message?.error)}`)
  return message.result
}
