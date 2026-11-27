// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextMenu, Menu } from '@oide/ui';

afterEach(cleanup);

function setup(portal = true) {
  const onPick = vi.fn();
  render(
    <div>
      <div data-testid="clip" style={{ overflow: 'hidden' }}>
        <Menu
          portal={portal}
          label="Mode"
          triggerTitle="Change mode"
          trigger="Manual"
          items={[
            { id: 'a', label: 'Auto', checked: false, onSelect: () => onPick('a') },
            { id: 'm', label: 'Manual', checked: true, onSelect: () => onPick('m') },
            { id: 'b', label: 'Bypass', checked: false, disabled: true, hint: 'Off', onSelect: () => onPick('b') },
          ]}
        />
      </div>
      <div data-testid="other" style={{ overflow: 'auto' }} />
      <button type="button">after</button>
    </div>,
  );
  return { onPick, trigger: screen.getByRole('button', { name: 'Mode' }) };
}

describe('Menu (portal, pick-one)', () => {
  it('renders radio items in document.body, opens on the checked one, and picks on click', () => {
    const { onPick, trigger } = setup();
    expect(trigger.getAttribute('title')).toBe('Change mode');
    fireEvent.click(trigger);
    const menu = screen.getByRole('menu');
    expect(menu.parentElement).toBe(document.body);
    expect(document.activeElement?.textContent).toBe('Manual');
    // A press inside the portalled list is not an outside click.
    fireEvent.mouseDown(screen.getByRole('menuitemradio', { name: 'Auto' }));
    expect(screen.queryByRole('menu')).not.toBeNull();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Auto' }));
    expect(onPick).toHaveBeenCalledWith('a');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('stays open when another box scrolls (a streaming transcript); closes when the trigger moves', () => {
    const { trigger } = setup();
    fireEvent.click(trigger);
    fireEvent.scroll(screen.getByTestId('other'));
    expect(screen.queryByRole('menu')).not.toBeNull();
    fireEvent.scroll(screen.getByTestId('clip'));
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(trigger);
    fireEvent(window, new Event('resize'));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('Escape closes without bubbling; Tab returns focus to the trigger instead of <body>', () => {
    const { trigger } = setup();
    const onWindowKey = vi.fn();
    window.addEventListener('keydown', onWindowKey);
    fireEvent.click(trigger);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(onWindowKey).not.toHaveBeenCalled();
    fireEvent.click(trigger);
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    window.removeEventListener('keydown', onWindowKey);
  });
});

describe('menu hover highlight', () => {
  // `cn` is clsx (no tailwind-merge): an always-on bg-transparent would beat bg-selected in the CSS.
  const highlighted = (el: Element) => el.classList.contains('bg-selected') && !el.classList.contains('bg-transparent');

  it('Menu highlights the item under the pointer, and only that one', () => {
    const { trigger } = setup();
    fireEvent.click(trigger);
    const [auto, manual] = screen.getAllByRole('menuitemradio');
    fireEvent.mouseEnter(auto!);
    expect(highlighted(auto!)).toBe(true);
    expect(highlighted(manual!)).toBe(false);
    expect(manual!.classList.contains('bg-transparent')).toBe(true);
  });

  it('ContextMenu highlights the item under the pointer, and only that one', () => {
    render(
      <ContextMenu
        at={{ x: 10, y: 10 }}
        label="Actions"
        onClose={() => {}}
        items={[
          { id: 'cut', label: 'Cut', onSelect: () => {} },
          { id: 's', separator: true },
          { id: 'copy', label: 'Copy', onSelect: () => {} },
        ]}
      />,
    );
    const [cut, copy] = screen.getAllByRole('menuitem');
    expect(highlighted(cut!)).toBe(true);
    fireEvent.mouseEnter(copy!);
    expect(highlighted(copy!)).toBe(true);
    expect(highlighted(cut!)).toBe(false);
  });
});
