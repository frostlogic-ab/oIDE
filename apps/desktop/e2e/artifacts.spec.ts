import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from './app';

/**
 * Artifact editors in the built app (production CSP, file:// renderer, lazy chunks): edit a doc in
 * Monaco and save version 2; open a whiteboard in the embedded Excalidraw with its bundled fonts.
 */

let ctx: LaunchedApp;
type Invoke = (command: string, input: unknown) => Promise<unknown>;

test.beforeAll(async () => {
  ctx = await launchApp();
  const win = await ctx.app.browserWindow(ctx.page);
  await win.evaluate((w) => w.setContentSize(1440, 900));
});

test.afterAll(async () => {
  await ctx?.close();
});

const shots = join(import.meta.dirname, '../test-results');

test('edit a doc artifact in Monaco and save it as version 2', async () => {
  const { page } = ctx;
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Artifacts' })
    .or(page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Artifacts' }))
    .first()
    .click();
  await page.getByRole('button', { name: '+ New artifact' }).click();
  const dialog = page.getByRole('dialog', { name: 'New artifact' });
  // One creation flow: start from a link (the default), files, or blank.
  await expect(dialog.getByRole('radio', { name: 'A link' })).toHaveAttribute('aria-checked', 'true');
  await dialog.getByRole('textbox', { name: 'Link' }).fill('https://claude.ai/chat/0f8fad5b-d9cb-469f-a165-70867728950e');
  await expect(dialog.getByRole('alert')).toContainText('chat link, not an artifact link');
  await expect(dialog.getByRole('button', { name: 'Retrieve' })).toBeDisabled();
  await dialog.getByRole('radio', { name: 'Blank' }).click();
  await dialog.getByLabel('Title', { exact: true }).fill('E2E retry notes');
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: 'E2E retry notes', level: 2 })).toBeVisible();

  await page.getByRole('button', { name: 'Open', exact: true }).click();
  const viewer = page.getByRole('region', { name: 'E2E retry notes (open)' });
  await expect(viewer.getByText('Doc · Personal · v1')).toBeVisible();
  const editor = viewer.locator('.monaco-editor .view-lines');
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('# Retry policy\n\nBack off with **jitter**.\n');
  await expect(viewer.getByText('Unsaved changes')).toBeVisible();
  // Live preview beside the editor.
  await expect(
    viewer.getByRole('region', { name: 'Preview of E2E retry notes' }).locator('strong'),
  ).toHaveText('jitter');

  await page.keyboard.press('Control+s');
  await expect(viewer.getByText('Doc · Personal · v2')).toBeVisible();
  await expect(viewer.getByText('Unsaved changes')).toHaveCount(0);
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: join(shots, 'artifact-doc-editor.png') });

  // The store has version 2 with the edit, saved by the user.
  const id = await page.evaluate(async () => {
    const list = (await (window as unknown as { oide: { invoke: Invoke } }).oide.invoke(
      'artifacts.list',
      {},
    )) as Array<{ id: string; title: string }>;
    return list.find((a) => a.title === 'E2E retry notes')!.id;
  });
  const detail = (await page.evaluate(
    (i) => (window as unknown as { oide: { invoke: Invoke } }).oide.invoke('artifacts.get', { id: i }),
    id,
  )) as {
    meta: { version: number };
    content: string;
    versions: Array<{ version: number; author: string }>;
  };
  expect(detail.meta.version).toBe(2);
  expect(detail.content).toContain('Back off with **jitter**.');
  expect(detail.versions.map((v) => `${v.version}:${v.author}`)).toEqual(['2:user', '1:user']);

  // Back in the library, History lists v2.
  await viewer.getByRole('button', { name: 'Artifacts' }).click();
  await expect(page.getByRole('region', { name: 'History' }).getByText(/^v2 · edited by you/)).toBeVisible();
});

test('a whiteboard opens in Excalidraw with bundled fonts and no CSP violations', async () => {
  const { page } = ctx;
  const violations: string[] = [];
  page.on('console', (m) => /Content Security Policy|esm\.sh/.test(m.text()) && violations.push(m.text()));
  const failed: string[] = [];
  page.on('requestfailed', (r) => failed.push(`${r.url()} ${r.failure()?.errorText ?? ''}`));

  await page.getByRole('button', { name: '+ New artifact' }).click();
  const dialog = page.getByRole('dialog', { name: 'New artifact' });
  // The dialog keeps the last "Start from" choice (Blank, from the test above); pick it anyway.
  await dialog.getByRole('radio', { name: 'Blank' }).click();
  await dialog.getByLabel('Title', { exact: true }).fill('E2E board');
  await dialog
    .getByRole('radio', { name: 'Whiteboard' })
    .or(dialog.getByRole('button', { name: 'Whiteboard' }))
    .first()
    .click();
  await dialog.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  const viewer = page.getByRole('region', { name: 'E2E board (open)' });
  await expect(viewer.locator('.excalidraw canvas').first()).toBeVisible({ timeout: 20_000 });

  // Draw a rectangle with the keyboard tool shortcut and save it as v2.
  const box = (await viewer.locator('.excalidraw').boundingBox())!;
  await page.keyboard.press('r');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 160, box.y + box.height / 2 + 90, { steps: 6 });
  await page.mouse.up();
  await expect(viewer.getByText('Unsaved changes')).toBeVisible();
  await viewer.getByRole('button', { name: 'Save' }).click();
  await expect(viewer.getByText('Whiteboard · Personal · v2')).toBeVisible();
  await page.screenshot({ path: join(shots, 'artifact-whiteboard-editor.png') });

  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    const faces = [...document.fonts].filter((f) => f.family === 'Excalifont' || f.family === 'Assistant');
    return {
      loaded: faces.filter((f) => f.status === 'loaded').length,
      error: faces.filter((f) => f.status === 'error').length,
      asset: (window as unknown as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH,
    };
  });
  expect(fonts.asset).toMatch(/^file:\/\/.*\/excalidraw-assets\/$/);
  expect(fonts.loaded).toBeGreaterThan(0);
  expect(fonts.error).toBe(0);
  expect(violations).toEqual([]);
  expect(failed.filter((f) => /woff2|esm\.sh/.test(f))).toEqual([]);
});

test('a claude.ai link alone is refused and creates nothing', async () => {
  const { page } = ctx;
  const out = await page.evaluate(async () => {
    const oide = (window as unknown as { oide: { invoke: Invoke } }).oide;
    const before = ((await oide.invoke('artifacts.list', {})) as unknown[]).length;
    let error = '';
    try {
      await oide.invoke('artifacts.import', { url: 'https://claude.ai/artifact/NFaggV4JC9X6prTgKhobKm' });
    } catch (e) {
      error = (e as Error).message;
    }
    let chat = '';
    try {
      await oide.invoke('artifacts.import', { url: 'https://claude.ai/chat/0f8fad5b-d9cb-469f-a165-70867728950e', content: '<p>x</p>' });
    } catch (e) {
      chat = (e as Error).message;
    }
    const after = ((await oide.invoke('artifacts.list', {})) as unknown[]).length;
    return { before, after, error, chat };
  });
  expect(out.error).toMatch(/invalid_input.*Paste the artifact's code/);
  expect(out.chat).toMatch(/chat link/);
  expect(out.after).toBe(out.before);
});

test('a pasted claude.ai React design renders offline in the preview frame', async () => {
  const { page } = ctx;
  const violations: string[] = [];
  page.on('console', (m) => /Content Security Policy/.test(m.text()) && violations.push(m.text()));
  const jsx = [
    "import React, { useState } from 'react';",
    "import { Camera } from 'lucide-react';",
    '',
    'export default function Pricing() {',
    '  const [n] = useState(3);',
    '  return (',
    '    <div className="p-4">',
    '      <Camera size={20} />',
    '      <h1 className="text-red-500">Plans {n}</h1>',
    '    </div>',
    '  );',
    '}',
    '',
  ].join('\n');
  const { url, entry } = await page.evaluate(async (content) => {
    const oide = (window as unknown as { oide: { invoke: Invoke } }).oide;
    const meta = (await oide.invoke('artifacts.import', { url: 'https://claude.ai/artifact/NFaggV4JC9X6prTgKhobKm', content })) as { id: string; entry: string };
    const { url } = (await oide.invoke('artifacts.previewUrl', { id: meta.id })) as { url: string };
    return { url, entry: meta.entry };
  }, jsx);
  expect(entry).toBe('App.jsx');
  // The same frame the Artifacts screen uses: sandboxed, opaque origin.
  await page.evaluate((src) => {
    const f = document.createElement('iframe');
    f.id = 'e2e-react-preview';
    f.setAttribute('sandbox', 'allow-scripts');
    f.src = src;
    f.style.cssText = 'position:fixed;right:0;bottom:0;width:480px;height:320px;background:#fff;z-index:99999';
    document.body.appendChild(f);
  }, url);
  const frame = page.frameLocator('#e2e-react-preview');
  await expect(frame.getByRole('heading', { name: 'Plans 3' })).toBeVisible({ timeout: 20_000 });
  await expect(frame.locator('svg.lucide-camera')).toHaveCount(1);
  // Tailwind's browser build styled the utility class offline.
  await expect(frame.getByRole('heading', { name: 'Plans 3' })).not.toHaveCSS('color', 'rgb(0, 0, 0)');
  await page.screenshot({ path: join(shots, 'artifact-react-preview.png') });
  await page.evaluate(() => document.getElementById('e2e-react-preview')?.remove());
  expect(violations).toEqual([]);
});
