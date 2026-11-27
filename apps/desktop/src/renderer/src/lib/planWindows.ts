/** Names of the CLI's plan windows (`rate_limit_event`), shared by the status bar and Spawn. */

/** "five_hour" → "Session", "seven_day" → "Week". */
export function windowLabel(window: string | undefined): { short: string; long: string } {
  if (!window || window === 'plan') return { short: 'Plan', long: 'Plan limit' };
  if (/five_hour|session/i.test(window)) return { short: 'Session', long: 'Session limit' };
  if (/seven_day|week/i.test(window)) return { short: /opus/i.test(window) ? 'Week (Opus)' : 'Week', long: 'Weekly limit' };
  return { short: window.replace(/_/g, ' '), long: `${window.replace(/_/g, ' ')} limit` };
}
