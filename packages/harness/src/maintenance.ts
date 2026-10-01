import type { MemoryPreparation, MemoryProvider } from './plugin-api.js'
import { RunBudget } from './budget.js'
import { ResourceBudget, type ResourceLimits } from './resources.js'

/** Auxiliary operations have their own deadline and ledger, never a prior run's. */
export async function maintenanceOperation<T>(controller: AbortController, limits: ResourceLimits,
  work: (operation: { resources: ResourceBudget; signal: AbortSignal }) => Promise<T>): Promise<T> {
  const resources = new ResourceBudget(limits)
  const deadline = new RunBudget(resources.state.deadline, controller)
  try { return await work({ resources, signal: controller.signal }) }
  finally { deadline.dispose() }
}

/** Optional memory cannot prevent a user request from reaching the model. */
export async function prepareSessionMemory(provider: MemoryProvider | undefined,
  request: Parameters<MemoryProvider['prepare']>[0], warn: (message: string) => void): Promise<MemoryPreparation> {
  if (!provider) return {}
  try {
    const prepared = await provider.prepare(request)
    request.signal?.throwIfAborted()
    for (const warning of prepared.warnings ?? []) warn(warning)
    return prepared
  } catch (error) {
    if (request.signal?.aborted) throw error
    warn(`Automatic memory preparation was skipped: ${error instanceof Error ? error.message : String(error)}`)
    return {}
  }
}
