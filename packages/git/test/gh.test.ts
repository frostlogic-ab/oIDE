import { describe, expect, it } from 'vitest';
import { parsePrView, summarizeChecks } from '../src/gh.js';

/** CI checks on a PR (`statusCheckRollup` from `gh pr view --json`), counted for the tile's CI indicator. */

const run = (status: string, conclusion = '') => ({ __typename: 'CheckRun', name: 'x', status, conclusion });
const ctx = (state: string) => ({ __typename: 'StatusContext', context: 'ci/x', state });

describe('summarizeChecks', () => {
  it('is undefined without checks or for a value that is not a list', () => {
    expect(summarizeChecks([])).toBeUndefined();
    expect(summarizeChecks(undefined)).toBeUndefined();
    expect(summarizeChecks({ nope: 1 })).toBeUndefined();
  });

  it('is pending while a check run or a commit status has not finished', () => {
    expect(summarizeChecks([run('COMPLETED', 'SUCCESS'), run('IN_PROGRESS'), run('QUEUED'), ctx('PENDING'), ctx('SUCCESS')])).toEqual({ state: 'pending', total: 5, completed: 2, failed: 0 });
  });

  it('counts failures while others still run, and is failure once all finished', () => {
    expect(summarizeChecks([run('COMPLETED', 'FAILURE'), run('IN_PROGRESS')])).toEqual({ state: 'pending', total: 2, completed: 1, failed: 1 });
    expect(summarizeChecks([run('COMPLETED', 'TIMED_OUT'), run('COMPLETED', 'CANCELLED'), ctx('ERROR'), run('COMPLETED', 'SUCCESS')])).toEqual({ state: 'failure', total: 4, completed: 4, failed: 3 });
  });

  it('is success when all finished; skipped and neutral count as passed', () => {
    expect(summarizeChecks([run('COMPLETED', 'SUCCESS'), run('COMPLETED', 'SKIPPED'), run('COMPLETED', 'NEUTRAL'), ctx('SUCCESS')])).toEqual({ state: 'success', total: 4, completed: 4, failed: 0 });
  });

  it('skips items that are not objects', () => {
    expect(summarizeChecks([null, 'x', run('COMPLETED', 'SUCCESS')])).toEqual({ state: 'success', total: 1, completed: 1, failed: 0 });
  });
});

describe('parsePrView with checks', () => {
  it('adds the counted checks, and none when the rollup is empty', () => {
    const base = { state: 'OPEN', isDraft: false, number: 7, url: 'https://github.com/o/r/pull/7' };
    expect(parsePrView(JSON.stringify({ ...base, statusCheckRollup: [run('COMPLETED', 'SUCCESS'), run('IN_PROGRESS')] }))).toEqual({
      state: 'open',
      number: 7,
      url: base.url,
      checks: { state: 'pending', total: 2, completed: 1, failed: 0 },
    });
    expect(parsePrView(JSON.stringify({ ...base, statusCheckRollup: [] }))).toEqual({ state: 'open', number: 7, url: base.url });
  });
});
