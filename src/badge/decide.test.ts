import { describe, it, expect } from 'vitest';
import { decideBadge, displayWithGrace } from './decide.ts';

const active = (fp: string) => ({ state: 'active' as const, fingerprint: fp, assuranceScore: 0.9, signedAt: '2026-08-28T00:00:00Z' });

describe('decideBadge (honesty rules)', () => {
  it('active + matching live fingerprint -> verified (ok)', () => {
    const d = decideBadge(active('abc'), 'abc');
    expect(d.tone).toBe('ok');
    expect(d.label).toBe('tools verified');
  });

  it('active + MISMATCHED live fingerprint -> tools changed (warn, never ok)', () => {
    const d = decideBadge(active('abc'), 'xyz');
    expect(d.tone).toBe('warn');
    expect(d.label).toBe('tools changed');
    expect(d.sub).toContain('does not apply');
  });

  it('active + no host (null) -> signed "audited as of date", not a live claim, not scary', () => {
    const d = decideBadge(active('abc'), null);
    expect(d.tone).toBe('ok');
    expect(d.label).toBe('tools audited');
    expect(d.sub).toContain('as of 2026-08-28');
    expect(d.sub).not.toContain('match'); // does not claim a live check happened
  });

  it('active + FLAGGED (confirmed FAIL) + matching live -> tools flagged (warn, never green)', () => {
    const d = decideBadge({ ...active('abc'), flagged: true }, 'abc');
    expect(d.tone).toBe('warn');
    expect(d.label).toBe('tools flagged');
    expect(d.sub).toContain('red flag');
  });

  it('active + FLAGGED + no host -> tools flagged (warn), not a reassuring "audited"', () => {
    const d = decideBadge({ ...active('abc'), flagged: true }, null);
    expect(d.tone).toBe('warn');
    expect(d.label).toBe('tools flagged');
  });

  it('active + FLAGGED + MISMATCH -> integrity wins: tools changed', () => {
    const d = decideBadge({ ...active('abc'), flagged: true }, 'xyz');
    expect(d.label).toBe('tools changed');
    expect(d.tone).toBe('warn');
  });

  it('active + flagged:false is unchanged (still green verified)', () => {
    const d = decideBadge({ ...active('abc'), flagged: false }, 'abc');
    expect(d.tone).toBe('ok');
    expect(d.label).toBe('tools verified');
  });

  it('revoked -> bad', () => {
    expect(decideBadge({ state: 'revoked' }, 'abc').tone).toBe('bad');
  });

  it('expired -> warn', () => {
    expect(decideBadge({ state: 'expired' }, null).tone).toBe('warn');
  });

  it('unverified / none -> neutral, never ok', () => {
    expect(decideBadge({ state: 'unverified' }, null).tone).toBe('neutral');
    expect(decideBadge({ state: 'none' }, null).tone).toBe('neutral');
  });
});

describe('displayWithGrace (async-host grace window)', () => {
  it('during grace, a mismatch is NOT alarmed — shows the signed "tools audited"', () => {
    // A site whose tools have not finished registering: early live fingerprint
    // differs, but we must not cry "tools changed" while the host warms up.
    const d = displayWithGrace(active('abc'), 'xyz', false);
    expect(d.label).toBe('tools audited');
    expect(d.tone).toBe('ok');
  });

  it('after grace, a persistent mismatch IS trusted as a real change', () => {
    const d = displayWithGrace(active('abc'), 'xyz', true);
    expect(d.label).toBe('tools changed');
    expect(d.tone).toBe('warn');
  });

  it('a live MATCH shows verified immediately, even during grace (never downgrades green)', () => {
    const d = displayWithGrace(active('abc'), 'abc', false);
    expect(d.label).toBe('tools verified');
    expect(d.tone).toBe('ok');
  });

  it('no host yet during grace -> the same honest "tools audited" as decideBadge', () => {
    expect(displayWithGrace(active('abc'), null, false)).toEqual(decideBadge(active('abc'), null));
  });

  it('grace never masks a revoked/flagged state (only ever downgrades a "changed" alarm)', () => {
    // Flagged wins over a mismatch in decideBadge; grace must not turn it green.
    const d = displayWithGrace({ ...active('abc'), flagged: true }, 'abc', false);
    expect(d.label).toBe('tools flagged');
    expect(d.tone).toBe('warn');
  });
});
