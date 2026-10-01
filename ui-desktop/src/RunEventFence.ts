/** Streaming callbacks and delayed events may only update their own run. */
export class RunEventFence {
  private readonly active = new Map<string, string>()
  private readonly closed = new Map<string, Set<string>>()
  accept(key: string, type: string, runId: string): boolean {
    if (!runId) return true // Older gateways had no run ids.
    const closed = this.closed.get(key) ?? new Set<string>()
    const current = this.active.get(key)
    if (type === 'run.start' || type === 'message.start') {
      if (closed.has(runId)) return false
      if (current && current !== runId) closed.add(current)
      this.active.set(key, runId)
    } else if (current && current !== runId || closed.has(runId) && !['session.updated', 'session.titled'].includes(type)) return false
    else if (!current) this.active.set(key, runId)
    if (['message.complete', 'message.cancelled', 'message.suspended'].includes(type)) closed.add(runId)
    while (closed.size > 16) closed.delete(closed.values().next().value!)
    this.closed.set(key, closed)
    return true
  }
  current(key: string, runId: string): boolean { return !runId || this.active.get(key) === runId }
  clear(workspacePrefix: string): void {
    for (const key of this.active.keys()) if (key.startsWith(workspacePrefix)) { this.active.delete(key); this.closed.delete(key) }
  }
}
