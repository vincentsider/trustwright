import { describe, it, expect } from 'vitest';
import { verdictOf } from './ScanPage.tsx';
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
});
