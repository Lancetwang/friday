import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import { fetchProviderModels } from './config.js'

test('model discovery keeps positive image evidence without treating missing metadata as text-only', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      data: [
        { id: 'future-model', input_modalities: ['text', 'image'] },
        { id: 'catalog-model', architecture: { modality: 'text+image->text' } },
        { id: 'unknown-model', supports_vision: false },
        { id: 'future-model' }
      ]
    }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address === 'object')
  try {
    assert.deepEqual(
      await fetchProviderModels('openai-compatible', `http://127.0.0.1:${address.port}`, 'test'),
      [
        { id: 'catalog-model', vision: true },
        { id: 'future-model', vision: true },
        { id: 'unknown-model' }
      ]
    )
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
