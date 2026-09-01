import { describe, it, expect } from 'vitest';
import { toAuditedTools } from './scan.ts';
import type { RegisteredTool } from '../src/webmcp/types.ts';

function t(over: Partial<RegisteredTool> & { name: string }): RegisteredTool {
  return { description: '', ...over };
}

describe('toAuditedTools', () => {
  it('excludes Trustwright\'s own injected verify tool', () => {
    const out = toAuditedTools([t({ name: 'search' }), t({ name: 'trustwright_verify_badge' })]);
    expect(out.map((x) => x.name)).toEqual(['search']);
  });

  it('reads the read-only and untrusted hints', () => {
    const out = toAuditedTools([
      t({ name: 'read', annotations: { readOnlyHint: true } }),
      t({ name: 'act', annotations: { untrustedContentHint: true } }),
    ]);
    expect(out[0]).toMatchObject({ name: 'read', readOnly: true, untrusted: false });
    expect(out[1]).toMatchObject({ name: 'act', readOnly: false, untrusted: true });
  });

  it('extracts input property names (capped at 40)', () => {
    const props: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) props[`p${i}`] = { type: 'string' };
    const out = toAuditedTools([t({ name: 'x', inputSchema: { type: 'object', properties: props } })]);
    expect(out[0]?.params).toHaveLength(40);
    expect(out[0]?.params?.[0]).toBe('p0');
  });

  it('caps a very long description to bound the response', () => {
    const out = toAuditedTools([t({ name: 'x', description: 'a'.repeat(5000) })]);
    const desc = out[0]?.description ?? '';
    expect(desc.length).toBeLessThanOrEqual(601); // 600 + the ellipsis
    expect(desc.endsWith('…')).toBe(true);
  });

  it('leaves a normal description untouched', () => {
    const out = toAuditedTools([t({ name: 'x', description: 'Look up an order.' })]);
    expect(out[0]?.description).toBe('Look up an order.');
  });
});
