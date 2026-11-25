import { describe, expect, it } from 'vitest';
import { KvRepo, openStore } from '../src/index.js';

/** Settings › Privacy (ADR 0011): old settings files keep parsing, and nothing old counts as consent. */
describe('privacy settings migration', () => {
  it('loads a 0.1.x document (ui.telemetry: true) with telemetry still off and unasked', () => {
    const store = openStore(':memory:');
    try {
      new KvRepo(store.database, 'settings').set('global', {
        ui: { accent: '#7FC8A9', telemetry: true, crashReports: true },
        agents: { maxRunning: 5 },
      });
      const s = store.settings.get();
      expect(store.settings.loadErrors).toEqual([]);
      expect(s.ui.accent).toBe('#7FC8A9');
      expect(s.agents.maxRunning).toBe(5);
      expect(s.ui.crashReports).toBe(true);
      expect(s.privacy).toEqual({
        usageAnalytics: false,
        errorReports: false,
        consentAnswered: false,
        consentPromptsShown: 0,
      });
    } finally {
      store.close();
    }
  });

  it('a damaged privacy section is reset to off without touching the others', () => {
    const store = openStore(':memory:');
    try {
      new KvRepo(store.database, 'settings').set('global', {
        agents: { maxRunning: 6 },
        privacy: { usageAnalytics: 'yes please' },
      });
      const s = store.settings.get();
      expect(s.agents.maxRunning).toBe(6);
      expect(s.privacy.usageAnalytics).toBe(false);
      expect(store.settings.loadErrors.join(' ')).toMatch(/settings\.privacy/);
    } finally {
      store.close();
    }
  });

  it('saves and reloads the switches and consent bookkeeping', () => {
    const store = openStore(':memory:');
    try {
      store.settings.update({ privacy: { usageAnalytics: true, consentAnswered: true } });
      store.settings.update({ privacy: { consentPromptsShown: 1 } });
      expect(store.settings.get().privacy).toEqual({
        usageAnalytics: true,
        errorReports: false,
        consentAnswered: true,
        consentPromptsShown: 1,
      });
    } finally {
      store.close();
    }
  });
});
