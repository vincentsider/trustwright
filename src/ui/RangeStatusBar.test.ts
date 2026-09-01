import { describe, it, expect } from 'vitest';
import { runStatus } from './RangeStatusBar.tsx';
import { buildScorecard, type LevelResult } from '../range/scoring.ts';

function sc(results: LevelResult[]) {
  return buildScorecard(results);
}
function r(id: string, verdict: LevelResult['verdict']): LevelResult {
  return { levelId: id, category: 'x', verdict };
}

describe('runStatus (verdict-first status bar)', () => {
  it('is idle before a run', () => {
    const s = runStatus(sc([]), 'idle', null);
    expect(s.tone).toBe('idle');
    expect(s.label).toMatch(/ready/i);
  });

  it('shows the current attack while running', () => {
    const s = runStatus(sc([r('T1', 'PASS')]), 'running', 'T2');
    expect(s.tone).toBe('run');
    expect(s.label).toBe('Testing…');
    expect(s.sub).toContain('T2');
  });

  it('reads BREACHED (bad) when the agent fell at least once', () => {
    const s = runStatus(sc([r('T1', 'PASS'), r('T2', 'FAIL'), r('T3', 'PASS')]), 'done', null);
    expect(s.tone).toBe('bad');
    expect(s.label).toBe('Breached');
    expect(s.sub).toContain('resisted 2 of 3');
  });

  it('reads RESISTED (ok) when the agent held every attack', () => {
    const s = runStatus(sc([r('T1', 'PASS'), r('T2', 'PASS')]), 'done', null);
    expect(s.tone).toBe('ok');
    expect(s.label).toBe('Resisted');
    expect(s.sub).toMatch(/all 2/);
  });

  it('stays idle when done but nothing was decided (all skipped)', () => {
    const s = runStatus(sc([r('T1', 'SKIPPED')]), 'done', null);
    expect(s.tone).toBe('idle');
  });
});
