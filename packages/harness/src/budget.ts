export type RunBudgetSpec = {
  /** Absolute Unix time in milliseconds. One deadline is shared across all phases. */
  deadlineMs: number
  /** Time reserved for the model to summarize, persist, and shut down cleanly. */
  reserveMs: number
}

/**
 * Splits one absolute deadline into a work phase and a hard stop. Tool work is
 * cancelled at the first boundary; model calls may use the reserve to return
 * a useful final response. The caller still owns the hard AbortController.
 */
export class RunBudget {
  readonly toolSignal: AbortSignal
  private readonly tools = new AbortController()
  private readonly timers: NodeJS.Timeout[] = []
  private announced = false
  private readonly onHardAbort: () => void

  constructor(readonly spec: RunBudgetSpec, private readonly hard: AbortController) {
    if (!Number.isFinite(spec.deadlineMs) || !Number.isFinite(spec.reserveMs) || spec.reserveMs < 0) {
      throw new Error('Invalid run budget.')
    }
    this.toolSignal = this.tools.signal
    this.onHardAbort = () => this.stopTools(hard.signal.reason)
    hard.signal.addEventListener('abort', this.onHardAbort, { once: true })
    this.schedule(spec.deadlineMs - spec.reserveMs, () => this.stopTools(new FinishReserveReached()))
    this.schedule(spec.deadlineMs, () => {
      const error = new Error('Run deadline exceeded.')
      error.name = 'TimeoutError'
      hard.abort(error)
    })
  }

  get finalizing(): boolean {
    if (!this.tools.signal.aborted && Date.now() >= this.spec.deadlineMs - this.spec.reserveMs) {
      this.stopTools(new FinishReserveReached())
    }
    return this.tools.signal.reason instanceof FinishReserveReached && !this.hard.signal.aborted
  }

  /** True once, so only one finalization instruction enters the transcript. */
  enterFinalization(): boolean {
    if (!this.finalizing || this.announced) return false
    this.announced = true
    return true
  }

  dispose(): void {
    for (const timer of this.timers) clearTimeout(timer)
    this.hard.signal.removeEventListener('abort', this.onHardAbort)
  }

  private schedule(at: number, action: () => void): void {
    if (at <= Date.now()) {
      action()
      return
    }
    const remaining = at - Date.now()
    const timer = setTimeout(
      remaining > 2_147_483_647 ? () => this.schedule(at, action) : action,
      Math.min(remaining, 2_147_483_647)
    )
    this.timers.push(timer)
  }

  private stopTools(reason: unknown): void {
    if (!this.tools.signal.aborted) this.tools.abort(reason)
  }
}

class FinishReserveReached extends Error {
  constructor() {
    super('Run budget entered its finishing reserve; stop tool work and return the best supported result.')
    this.name = 'FinishReserveReached'
  }
}

export function budgetIsFinishing(spec: RunBudgetSpec | undefined): boolean {
  return !!spec && Date.now() >= spec.deadlineMs - spec.reserveMs
}
