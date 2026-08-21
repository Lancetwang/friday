import { ModelRequestError } from 'friday-agent-core'

/** The one model failure Friday gives product-specific recovery semantics. */
export class ImageInputRejectedError extends Error {
  readonly kind = 'image_input_rejected'

  constructor(
    readonly status: number
  ) {
    super('The selected model rejected image input. Choose a model that accepts images, or remove the image and try again.')
    this.name = 'ImageInputRejectedError'
  }
}

/**
 * Give an explicit provider image-capability rejection product language after
 * the Session has rolled the failed turn back. Every other failure keeps its
 * normal retry and error path.
 */
export function presentImageInputError(error: unknown, hasImages: boolean): unknown {
  if (!hasImages || !(error instanceof ModelRequestError) || !rejectsImageInput(error)) return error
  return new ImageInputRejectedError(error.status)
}

function rejectsImageInput(error: ModelRequestError): boolean {
  if (error.status !== 400 && error.status !== 415 && error.status !== 422) return false
  const namesImageInput = /\b(images?|image_url|input_images?|vision|visual|multimodal|modality)\b|图片|图像|视觉|多模态/i.test(error.detail)
  const saysUnsupported = /\b(unsupported|not supported|does not support|doesn't support|cannot accept|can't accept|text[- ]only|only supports? text|only supported by)\b|不支持|仅支持文本|只支持文本/i.test(error.detail)
  return namesImageInput && saysUnsupported
}
