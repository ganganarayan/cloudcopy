import { describe, expect, it } from 'vitest';
import { JOB_STATES, isLegalJobTransition } from '@cloudcopy/shared';

describe('job state machine', () => {
  it('allows the happy path', () => {
    expect(isLegalJobTransition('queued', 'preparing')).toBe(true);
    expect(isLegalJobTransition('preparing', 'scanning')).toBe(true);
    expect(isLegalJobTransition('scanning', 'planning')).toBe(true);
    expect(isLegalJobTransition('planning', 'running')).toBe(true);
    expect(isLegalJobTransition('running', 'completed')).toBe(true);
  });

  it('allows pause/resume and retry loops', () => {
    expect(isLegalJobTransition('running', 'paused')).toBe(true);
    expect(isLegalJobTransition('paused', 'running')).toBe(true);
    expect(isLegalJobTransition('running', 'retrying')).toBe(true);
    expect(isLegalJobTransition('retrying', 'running')).toBe(true);
    expect(isLegalJobTransition('failed', 'retrying')).toBe(true);
  });

  it('blocks transitions out of terminal states', () => {
    for (const to of JOB_STATES) {
      expect(isLegalJobTransition('completed', to)).toBe(false);
      expect(isLegalJobTransition('cancelled', to)).toBe(false);
    }
  });

  it('blocks skipping the planner', () => {
    expect(isLegalJobTransition('queued', 'running')).toBe(false);
    expect(isLegalJobTransition('scanning', 'running')).toBe(false);
  });
});
