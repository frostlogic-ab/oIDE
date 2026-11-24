import { describe, expect, it } from 'vitest';
import { formatResetTime } from './format';

describe('formatResetTime', () => {
  const now = new Date(2026, 10, 24, 23, 30).getTime();
  it('shows only the time when the reset is less than 24 hours away, even past midnight', () => {
    const soon = new Date(2026, 10, 25, 0, 2).getTime();
    const text = formatResetTime(soon, now);
    expect(text).toBe(new Date(soon).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }));
    expect(text).not.toMatch(/Nov|Wed/);
  });
  it('adds the day when the reset is further away', () => {
    const later = new Date(2026, 10, 27, 9, 0).getTime();
    expect(formatResetTime(later, now)).toContain(',');
    expect(formatResetTime(later, now).length).toBeGreaterThan(formatResetTime(later - 3 * 86_400_000 + 3_600_000, now).length);
  });
});
