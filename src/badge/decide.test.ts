import { describe, it, expect } from 'vitest';
import { decideBadge, decideBadgeLive, displayWithGrace, displayWithGraceLive, type LiveCheck } from './decide.ts';

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

describe('decideBadgeLive (subset check — dynamic surfaces)', () => {
  const on = (o: Partial<LiveCheck & { exact: boolean; sealedPresent: boolean; extras: number }>): LiveCheck =>
    ({ host: true, exact: false, sealedPresent: false, extras: 0, ...o }) as LiveCheck;

  it('exact whole-surface match -> tools verified', () => {
    const d = decideBadgeLive(active('abc'), on({ exact: true, sealedPresent: true }));
    expect(d.label).toBe('tools verified');
    expect(d.tone).toBe('ok');
    expect(d.sub).toContain('match');
  });

  it('audited tools all present + EXTRA tools added -> still verified, discloses the extras', () => {
    const d = decideBadgeLive(active('abc'), on({ exact: false, sealedPresent: true, extras: 2 }));
    expect(d.label).toBe('tools verified');
    expect(d.tone).toBe('ok');
    expect(d.sub).toContain('audited tools intact');
    expect(d.sub).toContain('2 tools added since audit');
  });

  it('one added tool -> singular wording', () => {
    const d = decideBadgeLive(active('abc'), on({ sealedPresent: true, extras: 1 }));
    expect(d.sub).toContain('1 tool added since audit');
    expect(d.sub).not.toContain('1 tools');
  });

  it('an audited tool MISSING/changed -> tools changed (warn, never green)', () => {
    const d = decideBadgeLive(active('abc'), on({ exact: false, sealedPresent: false, extras: 0 }));
    expect(d.label).toBe('tools changed');
    expect(d.tone).toBe('warn');
    expect(d.sub).toContain('does not apply');
  });

  it('no host -> the signed "tools audited", never an alarm', () => {
    const d = decideBadgeLive(active('abc'), { host: false });
    expect(d.label).toBe('tools audited');
    expect(d.tone).toBe('ok');
  });

  it('flagged wins even when the subset is intact (never green over a confirmed FAIL)', () => {
    const d = decideBadgeLive({ ...active('abc'), flagged: true }, on({ sealedPresent: true, extras: 3 }));
    expect(d.label).toBe('tools flagged');
    expect(d.tone).toBe('warn');
  });

  it('flagged + a missing audited tool -> integrity wins: tools changed', () => {
    const d = decideBadgeLive({ ...active('abc'), flagged: true }, on({ sealedPresent: false }));
    expect(d.label).toBe('tools changed');
  });

  it('displayWithGraceLive suppresses "tools changed" during the grace window', () => {
    const missing = on({ sealedPresent: false });
    expect(displayWithGraceLive(active('abc'), missing, false).label).toBe('tools audited');
    expect(displayWithGraceLive(active('abc'), missing, true).label).toBe('tools changed');
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
