import { describe, it, expect } from 'vitest';
import { agentRisk } from './AgentRisk.tsx';
import { CORPUS } from '../range/corpusLoader.ts';
import type { LevelResult } from '../range/scoring.ts';

function r(levelId: string, category: string, verdict: LevelResult['verdict']): LevelResult {
  return { levelId, category, verdict };
}

describe('agentRisk', () => {
  it('hides (no lines) before any level is decided', () => {
    expect(agentRisk([], CORPUS).lines).toHaveLength(0);
    expect(agentRisk([r('T1', 'tool-framing', 'SKIPPED')], CORPUS).lines).toHaveLength(0);
  });

  it('is reassuring when the agent resisted everything', () => {
    const out = agentRisk([r('T1', 'tool-framing', 'PASS'), r('T3', 'tool-hijacking', 'PASS')], CORPUS);
    expect(out.tone).toBe('ok');
    expect(out.headline).toMatch(/not much/i);
    expect(out.lines[0]).toMatch(/resisted every attack/i);
  });

  it('warns when the agent only partly complied', () => {
    const out = agentRisk([r('T1', 'tool-framing', 'PASS'), r('T2', 'contaminated-output', 'PARTIAL')], CORPUS);
    expect(out.tone).toBe('warn');
    expect(out.lines.some((l) => /partly complied/i.test(l))).toBe(true);
  });

  it('translates a failed level into a concrete real-world consequence', () => {
    const out = agentRisk([r('T6', 'cross-origin-relay', 'FAIL')], CORPUS);
    expect(out.tone).toBe('bad');
    expect(out.headline).toMatch(/production/i);
    expect(out.lines[0]).toMatch(/forward your private data/i);
    // References the level's human title when available.
    expect(out.lines[0]).toContain('The partner hand-off');
  });

  it('caps the list at four and notes the remainder', () => {
    const fails: LevelResult[] = [
      r('T1', 'tool-framing', 'FAIL'),
      r('T2', 'contaminated-output', 'FAIL'),
      r('T3', 'tool-hijacking', 'FAIL'),
      r('T5', 'false-readonly', 'FAIL'),
      r('T6', 'cross-origin-relay', 'FAIL'),
    ];
    const out = agentRisk(fails, CORPUS);
    expect(out.tone).toBe('bad');
    expect(out.lines).toHaveLength(5); // 4 scenarios + a "…and 1 more." line
    expect(out.lines[4]).toMatch(/1 more/);
  });

  it('falls back gracefully for an unknown (custom) category', () => {
    const out = agentRisk([r('MYATK', 'custom', 'FAIL')], CORPUS);
    expect(out.tone).toBe('bad');
    expect(out.lines[0]).toMatch(/exploited on this attack class/i);
  });
});
