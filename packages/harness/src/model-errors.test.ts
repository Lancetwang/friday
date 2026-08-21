import assert from 'node:assert/strict'
import test from 'node:test'

import { ModelRequestError } from 'friday-agent-core'

import { ImageInputRejectedError, presentImageInputError } from './model-errors.js'

test('only an explicit image-capability rejection gets a Harness presentation', () => {
  const rejection = new ModelRequestError(400, 'Images are not supported by this model.')
  const presented = presentImageInputError(rejection, true)

  assert(presented instanceof ImageInputRejectedError)
  assert.equal(presented.status, 400)
  assert.equal(presented.kind, 'image_input_rejected')
})

test('unrelated provider errors remain untouched', () => {
  const invalid = new ModelRequestError(400, 'Invalid tool schema: image field is malformed.')
  const unavailable = new ModelRequestError(503, 'Service unavailable.')
  const textOnlyWithoutImage = new ModelRequestError(400, 'Images are not supported.')

  assert.equal(presentImageInputError(invalid, true), invalid)
  assert.equal(presentImageInputError(unavailable, true), unavailable)
  assert.equal(presentImageInputError(textOnlyWithoutImage, false), textOnlyWithoutImage)
})
