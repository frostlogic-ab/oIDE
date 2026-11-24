import type { CrashReports } from './crash-reports.js';
import type { AppLogger } from './logger.js';
import type { Redactor } from './redact.js';

export * from './cleanup-queue.js';
export * from './crash-reports.js';
export * from './db-recovery.js';
export * from './diagnostics.js';
export * from './logger.js';
export * from './redact.js';
export * from './renderer-watchdog.js';
export * from './shutdown.js';
export * from './storage-errors.js';

/** Logs and crash reports, on `MainContext.reliability` (absent in plain-Node harnesses). */
export interface ReliabilityContext {
  logs: {
    dir: string;
    channel(name: string): AppLogger;
    agent(agentId: string): AppLogger;
    fileLoggingOk(): boolean;
    redactor: Redactor;
  };
  crashReports: CrashReports;
}
