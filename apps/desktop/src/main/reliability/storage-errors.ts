import { classifyDbError, type DbFailureKind } from './db-recovery.js';

/**
 * Write failures while the app runs (an event append when the disk is full, a locked or damaged
 * database). Agents keep running and live events keep reaching the window; only persistence fails.
 * The user is told once per kind (then again at most every `repeatMs`), and once writes succeed
 * again, that they are back. Every failure is logged (counted, not one line per event).
 */

export interface StorageErrorReporterOptions {
  notify(level: 'warning' | 'error' | 'info', message: string): void;
  log: { warn(...a: unknown[]): void; info?(...a: unknown[]): void };
  repeatMs?: number;
  now?: () => number;
}

export function storageErrorMessage(kind: DbFailureKind): string {
  switch (kind) {
    case 'disk-full':
      return 'The disk is full: agents keep running, but their events are not being saved. Free some space; saving resumes on its own.';
    case 'corrupt':
      return "oIDE's database looks damaged: agent events are not being saved. Restart oIDE to back it up and recover.";
    case 'locked':
      return "oIDE's database is locked by another program: agent events are not being saved until it is released.";
    case 'permission':
      return "oIDE cannot write its database (permission denied): agent events are not being saved.";
    default:
      return 'Agent events could not be saved. Agents keep running; see the logs for details.';
  }
}

export class StorageErrorReporter {
  private failing: { kind: DbFailureKind; since: number; count: number; lastNotified: number } | null = null;

  constructor(private readonly o: StorageErrorReporterOptions) {}

  get failingKind(): DbFailureKind | null {
    return this.failing?.kind ?? null;
  }

  /** Call when a write failed. */
  failed(err: unknown, what = 'event'): void {
    const now = (this.o.now ?? Date.now)();
    const kind = classifyDbError(err);
    const f = this.failing;
    if (!f || f.kind !== kind) {
      this.failing = { kind, since: now, count: 1, lastNotified: now };
      this.o.log.warn(`could not store ${what}`, { kind, error: err });
      this.o.notify(kind === 'other' ? 'warning' : 'error', storageErrorMessage(kind));
      return;
    }
    f.count++;
    if (f.count % 100 === 0) this.o.log.warn(`still failing to store ${what}s`, { kind, failures: f.count });
    if (now - f.lastNotified >= (this.o.repeatMs ?? 10 * 60_000)) {
      f.lastNotified = now;
      this.o.notify('error', storageErrorMessage(kind));
    }
  }

  /** Call after a successful write; clears the failing state (and says so once). */
  succeeded(): void {
    if (!this.failing) return;
    const f = this.failing;
    this.failing = null;
    this.o.log.info?.('storing events works again', { kind: f.kind, failures: f.count });
    this.o.notify('info', 'Agent events are being saved again.');
  }
}

/**
 * Writes items through `write`; items that failed for a passing reason (disk full, database
 * locked) wait in a bounded queue (oldest dropped first, and counted) and are written, in order,
 * before the next item once writes work again. Other failures (a bad row) are reported and not
 * retried, so one bad item never blocks the rest. `flush()` at quit tries once more.
 */
export function isTransientStorageError(err: unknown): boolean {
  const k = classifyDbError(err);
  return k === 'disk-full' || k === 'locked';
}

export class BufferedWriter<T> {
  private readonly pending: T[] = [];
  private droppedCount = 0;

  constructor(
    private readonly write: (item: T) => void,
    private readonly reporter: Pick<StorageErrorReporter, 'failed' | 'succeeded'>,
    private readonly max = 5000,
    private readonly what = 'event',
  ) {}

  get queued(): number {
    return this.pending.length;
  }

  get dropped(): number {
    return this.droppedCount;
  }

  push(item: T): void {
    if (this.pending.length && !this.flush()) {
      this.enqueue(item);
      return;
    }
    try {
      this.write(item);
      this.reporter.succeeded();
    } catch (err) {
      if (isTransientStorageError(err)) this.enqueue(item);
      else this.droppedCount++;
      this.reporter.failed(err, this.what);
    }
  }

  /** Write queued items in order. Returns true when the queue is empty. */
  flush(): boolean {
    while (this.pending.length) {
      try {
        this.write(this.pending[0]!);
      } catch (err) {
        this.reporter.failed(err, this.what);
        if (isTransientStorageError(err)) return false;
        this.droppedCount++;
      }
      this.pending.shift();
    }
    this.reporter.succeeded();
    return true;
  }

  private enqueue(item: T): void {
    this.pending.push(item);
    if (this.pending.length > this.max) {
      this.pending.shift();
      this.droppedCount++;
    }
  }
}
