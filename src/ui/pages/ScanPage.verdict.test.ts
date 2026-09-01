import { describe, it, expect } from 'vitest';
import { verdictOf, worstCase } from './ScanPage.tsx';
import type { ScanResult, AuditedTool, ScanFinding } from '../../data/api.ts';

function tool(name: string, readOnly: boolean, untrusted = false): AuditedTool {
  return { name, description: `${name} does a thing`, readOnly, untrusted, params: [] };
}

function result(tools: AuditedTool[], findings: ScanFinding[] = [], assuranceScore = 1): ScanResult {
  return {
    url: 'https://x.example/',
    origin: 'https://x.example',
    host: 'native',
    tools: tools.length,
    toolsDetail: tools,
    findings,
    assuranceScore,
    signed: false,
    scannedAt: '2026-09-01T00:00:00Z',
    note: '',
  };
}

const fail: ScanFinding = { toolName: 'act', check: 'T5', verdict: 'FAIL', layer: 'x' };
const partial: ScanFinding = { toolName: 'read', check: 'T2', verdict: 'PARTIAL', layer: 'x' };

describe('verdictOf (plain-language scan summary)', () => {
  it('is "safe" (ok) with read-only tools and no flags', () => {
    const v = verdictOf(result([tool('read_a', true), tool('read_b', true)]));
    expect(v.tone).toBe('ok');
    expect(v.headline).toMatch(/safe/i);
    expect(v.summary).toContain('x.example offers your agent 2 tools');
    expect(v.summary).toContain('only read data');
    expect(v.summary).toContain('no red flags');
  });

  it('is "warn" when there is a non-failing flag', () => {
    const v = verdictOf(result([tool('read', true)], [partial]));
    expect(v.tone).toBe('warn');
    expect(v.summary).toContain('flagged 1');
  });

  it('is "bad" when a finding FAILs', () => {
    const v = verdictOf(result([tool('act', false)], [fail]));
    expect(v.tone).toBe('bad');
    expect(v.headline).toMatch(/careful/i);
    expect(v.meaning).toMatch(/manipulated|red flags/i);
  });

  it('describes a mix of read-only and acting tools', () => {
    const v = verdictOf(result([tool('read', true), tool('act', false)]));
    expect(v.summary).toContain('1 only read data, 1 can take an action');
  });

  it('describes an all-acting surface', () => {
    const v = verdictOf(result([tool('act', false)]));
    expect(v.summary).toContain('take an action');
  });

  it('counts the AUDITED tools, not the raw count (badged sites carry an extra verify tool)', () => {
    // A badged site reports tools:3 raw, but toolsDetail excludes the injected
    // trustwright_verify_badge, so we must say "2 tools", matching the cards.
    const r = { ...result([tool('a', true), tool('b', true)]), tools: 3 };
    const v = verdictOf(r);
    expect(v.summary).toContain('offers your agent 2 tools');
    expect(v.summary).not.toContain('3 tools');
  });
});

describe('worstCase', () => {
  it('is reassuring when every tool is read-only and clean', () => {
    const w = worstCase(result([tool('read_a', true), tool('read_b', true)]));
    expect(w.tone).toBe('ok');
    expect(w.lines).toHaveLength(1);
    expect(w.lines[0]).toMatch(/only reads data|look but not change/i);
  });

  it('warns about acting tools even with no flags', () => {
    const w = worstCase(result([tool('read', true), tool('run_task', false)]));
    expect(w.tone).toBe('warn');
    expect(w.lines[0]).toContain('run_task');
  });

  it('gives a concrete off-site-relay scenario for a T6 flag', () => {
    const relay: ScanFinding = { toolName: 'run_task', check: 'T6', verdict: 'FAIL', layer: 'x' };
    const w = worstCase(result([tool('run_task', false)], [relay]));
    expect(w.tone).toBe('bad');
    expect(w.lines[0]).toContain('run_task');
    expect(w.lines[0]).toMatch(/send your data to another site/i);
  });

  it('lists worst (FAIL) scenarios before softer ones, capped at 3, deduped', () => {
    const findings: ScanFinding[] = [
      { toolName: 'a', check: 'T2', verdict: 'PARTIAL', layer: 'x' },
      { toolName: 'b', check: 'T5', verdict: 'FAIL', layer: 'x' },
      { toolName: 'c', check: 'T1', verdict: 'PARTIAL', layer: 'x' },
      { toolName: 'd', check: 'T6', verdict: 'PARTIAL', layer: 'x' },
    ];
    const w = worstCase(result([tool('b', false)], findings));
    expect(w.tone).toBe('bad');
    expect(w.lines).toHaveLength(3);
    expect(w.lines[0]).toContain('b'); // the FAIL comes first
    expect(w.lines[0]).toMatch(/read-only but can change data/i);
  });
});
