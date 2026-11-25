// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { insertText, type SlashItem } from '../lib/slash';
import { MOCK_SLASH_COMMANDS } from '../lib/mock/focus';
import { SlashMenu, useSlashMenu } from './SlashMenu';

const scrolled: Element[] = [];
beforeAll(() => {
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
});
afterEach(() => {
  cleanup();
  scrolled.length = 0;
});

function Harness({ commands, onPicked }: { commands: readonly string[]; onPicked?: (item: SlashItem) => void }) {
  const [text, setText] = useState('');
  const menu = useSlashMenu({
    text,
    commands,
    onPick: (item) => {
      onPicked?.(item);
      setText(insertText(item));
    },
  });
  return (
    <div className="relative">
      <SlashMenu menu={menu} />
      <label htmlFor="in">Message</label>
      <textarea id="in" value={text} {...menu.inputProps} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => menu.onKeyDown(e)} />
    </div>
  );
}

const setup = (commands: readonly string[] = MOCK_SLASH_COMMANDS, onPicked?: (item: SlashItem) => void) => {
  render(<Harness commands={commands} onPicked={onPicked} />);
  return screen.getByRole('combobox', { name: 'Message' }) as HTMLTextAreaElement;
};
const options = () => screen.getAllByRole('option');
const activeOption = () => options().find((o) => o.getAttribute('aria-selected') === 'true')!;

describe('SlashMenu', () => {
  it('lists ~100 commands as one fixed row each, grouped, with a count', () => {
    const input = setup();
    fireEvent.change(input, { target: { value: '/' } });
    const list = screen.getByRole('listbox', { name: 'Commands' });
    expect(options().length).toBe(MOCK_SLASH_COMMANDS.length);
    expect(screen.getByText(`${MOCK_SLASH_COMMANDS.length} commands`)).toBeTruthy();
    const groups = within(list).getAllByRole('group');
    expect(groups[0]!.getAttribute('aria-labelledby')).toBeTruthy();
    expect(within(list).getByRole('group', { name: 'Claude Code' })).toBeTruthy();
    const hub = within(list).getByRole('group', { name: 'HubSpot (MCP)' });
    const row = within(hub).getAllByRole('option')[0]!;
    // Pretty label in the row, full command in the tooltip; rows never wrap.
    expect(row.querySelector('span')!.textContent).toBe('check-database-status');
    expect(row.getAttribute('title')).toBe('/mcp__claude_ai_HubSpot__check-database-status');
    expect(row.className).toContain('h-7');
    expect(row.className).toContain('whitespace-nowrap');
    expect(row.querySelector('span')!.className).toContain('truncate');
    // Built-ins first, with descriptions.
    expect(options()[0]!.textContent).toContain('/compact');
    expect(options()[0]!.textContent).toContain('asks first');
  });

  it('wires combobox semantics to the active option', () => {
    const input = setup();
    expect(input.getAttribute('aria-expanded')).toBe('false');
    fireEvent.change(input, { target: { value: '/' } });
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.getAttribute('aria-controls')).toBe(screen.getByRole('listbox').id);
    expect(input.getAttribute('aria-activedescendant')).toBe(activeOption().id);
  });

  it('filters as you type, prefix matches first, and shows "N of M"', () => {
    const input = setup();
    fireEvent.change(input, { target: { value: '/dfs-co' } });
    expect(options().map((o) => o.getAttribute('title'))).toEqual(['/mcp__claude_ai_DataForSEO__dfs-competitor-gap-analysis-for-a-domain-with-very-long-name', '/mcp__claude_ai_DataForSEO__dfs-content-brief']);
    expect(screen.getByText(`2 of ${MOCK_SLASH_COMMANDS.length}`)).toBeTruthy();
    fireEvent.change(input, { target: { value: '/hubspot' } });
    expect(options().every((o) => o.getAttribute('title')!.includes('HubSpot'))).toBe(true);
    fireEvent.change(input, { target: { value: '/nothing-matches-this' } });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('moves with arrows, PageUp/PageDown, Home/End and keeps the active row in view', () => {
    const input = setup();
    fireEvent.change(input, { target: { value: '/' } });
    const n = options().length;
    expect(activeOption()).toBe(options()[0]);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(activeOption()).toBe(options()[1]);
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'ArrowUp' }); // wraps
    expect(activeOption()).toBe(options()[n - 1]);
    fireEvent.keyDown(input, { key: 'Home' });
    expect(activeOption()).toBe(options()[0]);
    fireEvent.keyDown(input, { key: 'PageDown' });
    expect(activeOption()).toBe(options()[8]);
    fireEvent.keyDown(input, { key: 'PageUp' });
    expect(activeOption()).toBe(options()[0]);
    fireEvent.keyDown(input, { key: 'End' });
    expect(activeOption()).toBe(options()[n - 1]);
    expect(scrolled[scrolled.length - 1]).toBe(options()[n - 1]);
  });

  it('Enter and Tab insert "/<command> " without sending; Esc closes until the text changes', () => {
    const picked = vi.fn();
    const input = setup(['compact', 'context', 'init', 'mcp__claude_ai_HubSpot__check-database-status'], picked);
    fireEvent.change(input, { target: { value: '/che' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.value).toBe('/mcp__claude_ai_HubSpot__check-database-status ');
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.change(input, { target: { value: '/in' } });
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(input.value).toBe('/init ');
    expect(picked).toHaveBeenCalledTimes(2);

    fireEvent.change(input, { target: { value: '/c' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.change(input, { target: { value: '/co' } });
    expect(screen.getByRole('listbox')).toBeTruthy();
  });

  it('hover moves the highlight and a click picks', () => {
    const input = setup(['compact', 'context', 'init']);
    fireEvent.change(input, { target: { value: '/' } });
    fireEvent.mouseMove(options()[2]!);
    expect(activeOption()).toBe(options()[2]);
    fireEvent.mouseDown(options()[1]!);
    expect(input.value).toBe('/context ');
  });
});
