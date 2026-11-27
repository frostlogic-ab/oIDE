// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelLetterChip } from './Chip.js';
import { Tooltip, tooltipPosition } from './Tooltip.js';

const rect = { top: 100, bottom: 122, left: 40, right: 140, width: 100 };

describe('tooltipPosition', () => {
  it('puts top placements 6px above the trigger, lifted by their own height', () => {
    expect(tooltipPosition(rect, 'top-start', 800)).toEqual({ top: 94, left: 40, transform: 'translateY(-100%)' });
    expect(tooltipPosition(rect, 'top', 800)).toEqual({ top: 94, left: 90, transform: 'translate(-50%, -100%)' });
  });

  it('puts bottom placements 6px below the trigger', () => {
    expect(tooltipPosition(rect, 'bottom-start', 800)).toEqual({ top: 128, left: 40, transform: 'translateY(0)' });
  });

  it('anchors end placements to the trigger right edge from the viewport right', () => {
    expect(tooltipPosition(rect, 'top-end', 800)).toEqual({ top: 94, right: 660, transform: 'translateY(-100%)' });
  });
});

describe('Tooltip portal', () => {
  afterEach(cleanup);

  it('renders the bubble in document.body, outside any clipping ancestor', () => {
    const { container, getByRole } = render(
      createElement('div', { style: { overflow: 'auto' } }, createElement(ModelLetterChip, { name: 'Audit docs', status: 'done' })),
    );
    const tip = document.body.querySelector('[role="tooltip"]')!;
    expect(container.contains(tip)).toBe(false);
    expect(getByRole('button').getAttribute('aria-describedby')).toBe(tip.id);
  });

  it('stays open while focused even after the pointer leaves, and closes on scroll', () => {
    const { getByRole } = render(createElement(Tooltip, { content: 'Hello', portal: true, children: createElement('button', null, 'x') }));
    const tip = document.body.querySelector('[role="tooltip"]')!;
    const button = getByRole('button');
    expect(tip.className).toContain('hidden');
    fireEvent.pointerEnter(button);
    fireEvent.focus(button);
    fireEvent.pointerLeave(button);
    expect(tip.className).not.toContain('hidden');
    fireEvent.scroll(window);
    expect(tip.className).toContain('hidden');
  });
});
