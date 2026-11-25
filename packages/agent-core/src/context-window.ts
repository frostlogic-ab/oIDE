import { baseModelId, contextWindowFor } from '@oide/protocol';

/**
 * Context windows per model, learned from what the CLI reports (`result.modelUsage[model].contextWindow`
 * and `/context`), with the protocol table as the fallback before the first report.
 *
 * Why it exists: the CLI only reports the window at the end of a turn, and a first turn can run for
 * many minutes. Before this, a long first turn on claude-opus-5-5 (1,000,000 tokens) was drawn against
 * the 200,000 fallback, so the ring read 5x too full (an 85k first request showed 42%). The supervisor
 * shares one book across agents, so a window learned from one agent applies to the next agent's first
 * turn too.
 */
export class ContextWindowBook {
  private readonly learned = new Map<string, number>();

  /** The window for `model`: what the CLI reported for it, else the table. */
  get(model: string | undefined): number {
    if (!model) return contextWindowFor(model);
    return this.learned.get(baseModelId(model)) ?? contextWindowFor(model);
  }

  /** Remember a window the CLI reported (ignores non-positive values). */
  learn(model: string | undefined, tokens: number | undefined): void {
    if (!model || !tokens || !Number.isFinite(tokens) || tokens <= 0) return;
    this.learned.set(baseModelId(model), tokens);
  }

  has(model: string): boolean {
    return this.learned.has(baseModelId(model));
  }
}
