const MAX_PROVIDER_DETAIL = 4_000

/**
 * A provider rejected an HTTP model request.
 *
 * `status` and `detail` let callers apply provider-specific policies while
 * Core remains transport-only. The message preserves the adapter's historical
 * behaviour for callers that use no policy of their own.
 */
export class ModelRequestError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string
  ) {
    super(`Model request failed (${status}): ${detail}`)
    this.name = 'ModelRequestError'
  }
}

export async function throwModelRequestError(response: Response): Promise<never> {
  throw new ModelRequestError(response.status, await providerDetail(response))
}

async function providerDetail(response: Response): Promise<string> {
  if (!response.body) return ''
  const decoder = new TextDecoder()
  let detail = ''
  try {
    for await (const chunk of response.body) {
      detail += decoder.decode(chunk, { stream: true })
      if (detail.length >= MAX_PROVIDER_DETAIL) break
    }
  } catch {
    // A broken error body must not replace the useful HTTP status.
  }
  return detail.slice(0, MAX_PROVIDER_DETAIL)
}
