
import { describe as d2, expect as e2, it as i2 } from 'vitest';
import { isValidPermissionRule } from '@oide/protocol';
import { suggestRule as sr } from './rules.js';

d2('rule injection', () => {
  i2('never suggests a rule that could widen into several', () => {
    e2(sr('Bash', { command: 'npm test) Bash(*' })).toBeUndefined();
    e2(sr('Bash', { command: 'npm test, Edit' })).toBeUndefined();
    e2(sr('Bash', { command: 'npm:*' })).toBeUndefined();
    e2(sr('Bash', { command: 'npm test' })).toBe('Bash(npm test)');
  });
  i2('validates rules before they reach --allowedTools', () => {
    e2(isValidPermissionRule('Bash(npm test)')).toBe(true);
    e2(isValidPermissionRule('Bash(npm run:*)')).toBe(true);
    e2(isValidPermissionRule('mcp__pg__db_schema')).toBe(true);
    e2(isValidPermissionRule('Read(src/**)')).toBe(true);
    e2(isValidPermissionRule('Bash(*)')).toBe(false);
    e2(isValidPermissionRule('Bash(x) Bash(*)')).toBe(false);
    e2(isValidPermissionRule('Bash(a),Edit')).toBe(false);
  });
});
