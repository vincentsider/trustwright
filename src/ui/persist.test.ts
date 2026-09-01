import { describe, it, expect } from 'vitest';
import { shouldSaveRun, rankEligible } from './persist.ts';

describe('shouldSaveRun', () => {
  it('saves a finished run once', () => {
    expect(shouldSaveRun('done', 'run-1', null, false)).toBe(true);
  });

  it('does not save the same run twice', () => {
    expect(shouldSaveRun('done', 'run-1', 'run-1', false)).toBe(false);
  });

  it('saves a new run even after a previous one saved', () => {
    expect(shouldSaveRun('done', 'run-2', 'run-1', false)).toBe(true);
  });

  it('does not save while a save is already in flight', () => {
    expect(shouldSaveRun('done', 'run-1', null, true)).toBe(false);
  });

  it('does not save a run that is not done', () => {
    expect(shouldSaveRun('running', 'run-1', null, false)).toBe(false);
    expect(shouldSaveRun('idle', 'run-1', null, false)).toBe(false);
  });
});

describe('rankEligible', () => {
  it('ranks an agent-driven run against the official corpus', () => {
    expect(rankEligible('agent', 0)).toBe(true);
  });

  it('never ranks the scripted demo', () => {
    expect(rankEligible('demo', 0)).toBe(false);
    expect(rankEligible(null, 0)).toBe(false);
  });

  it('never ranks a run that included a user-authored level', () => {
    // A self-written, trivially-passable level must not inflate the public score.
    expect(rankEligible('agent', 1)).toBe(false);
    expect(rankEligible('agent', 3)).toBe(false);
  });
});
