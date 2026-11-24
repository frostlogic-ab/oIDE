// @vitest-environment jsdom
import { createElement } from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ContextRing, ContextRingButton, contextColor, contextFraction, contextLevel, contextPercent } from './ContextRing';
import { agentStatusMeta, modelLetter } from './status';

describe('contextLevel thresholds', () => {
  it('uses the canvas defaults: accent < 65% ≤ amber < 85% ≤ red', () => {
    // The six Wall tiles: 54 23 41 → accent, 67 81 → amber, 92 → red.
    expect([0.54, 0.23, 0.41].map((f) => contextLevel(f))).toEqual(['ok', 'ok', 'ok']);
    expect([0.67, 0.81].map((f) => contextLevel(f))).toEqual(['warn', 'warn']);
    expect(contextLevel(0.92)).toBe('danger');
    expect(contextLevel(0.65)).toBe('warn');
    expect(contextLevel(0.85)).toBe('danger');
    expect(contextLevel(0.6499)).toBe('ok');
  });

  it('honours Settings thresholds', () => {
    expect(contextLevel(0.67, { warnAt: 0.7, dangerAt: 0.9 })).toBe('ok');
    expect(contextLevel(0.88, { warnAt: 0.7, dangerAt: 0.9 })).toBe('warn');
    expect(contextLevel(0.9, { warnAt: 0.7, dangerAt: 0.9 })).toBe('danger');
  });

  it('clamps out-of-range values', () => {
    expect(contextPercent(-1)).toBe(0);
    expect(contextPercent(Number.NaN)).toBe(0);
    expect(contextPercent(1.7)).toBe(100);
    expect(contextFraction(162_000, 200_000)).toBeCloseTo(0.81);
    expect(contextFraction(5, 0)).toBe(0);
  });

  it('maps levels to colours', () => {
    expect(contextColor('ok')).toBe('var(--color-accent)');
    expect(contextColor('warn')).toBe('var(--color-warn)');
    expect(contextColor('danger')).toBe('var(--color-bad)');
  });
});

describe('ContextRing rendering', () => {
  it('draws the arc with pathLength 100 and the level colour', () => {
    const { container } = render(createElement(ContextRing, { used: 0.81 }));
    const circles = container.querySelectorAll('circle');
    expect(circles).toHaveLength(2);
    expect(circles[1]!.getAttribute('stroke-dasharray')).toBe('81 100');
    expect(circles[1]!.getAttribute('stroke')).toBe('var(--color-warn)');
    expect(container.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('button variant has an accessible label and a tooltip', () => {
    const { getByRole } = render(createElement(ContextRingButton, { used: 0.54, subject: 'Build the window shell layout' }));
    const btn = getByRole('button');
    expect(btn.getAttribute('aria-label')).toBe('Context 54% full for Build the window shell layout. Compact this session');
    const tipId = btn.getAttribute('aria-describedby')!;
    expect(document.getElementById(tipId)?.textContent).toBe('Context 54% full · click to /compact');
  });
});

describe('status helpers', () => {
  it('maps model ids to chip letters', () => {
    expect(modelLetter('claude-haiku-4-5')).toBe('H');
    expect(modelLetter('sonnet')).toBe('S');
    expect(modelLetter('claude-opus-4-1[1m]')).toBe('O');
    expect(modelLetter(undefined)).toBe('?');
  });

  it('maps agent statuses to canvas colours and tones', () => {
    expect(agentStatusMeta('running')).toMatchObject({ label: 'Running', color: 'var(--color-ok)' });
    expect(agentStatusMeta('needs-permission')).toMatchObject({ tone: 'needs', color: 'var(--color-warn)' });
    expect(agentStatusMeta('ready-for-review')).toMatchObject({ tone: 'review', color: 'var(--color-review)' });
    expect(agentStatusMeta('error').tone).toBe('error');
  });
});
