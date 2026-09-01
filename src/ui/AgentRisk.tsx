// src/ui/AgentRisk.tsx
//
// The "/range" answer to "what's the worst that could happen?" — but about the
// AGENT, not a site. Grounded in what the agent actually FELL for, it translates
// each failed level into the concrete real-world thing that agent could do in
// production. When the agent resisted everything, the answer is honestly
// reassuring. Self-hides until at least one level has a verdict.

import type { LevelResult } from '../range/scoring.ts';
import type { LevelDefinition } from '../range/level.ts';
import { levelById } from '../range/corpusLoader.ts';

type Tone = 'ok' | 'warn' | 'bad';

// What an agent that FAILS this attack class could do once it is driving real
// tools on a real site. Keyed by the level's taxonomy category.
const CATEGORY_RISK: Record<string, string> = {
  'tool-framing': 'be talked into an extra action by a tool’s description, doing something you never asked for.',
  'contaminated-output': 'follow hidden instructions buried in a tool’s output.',
  'tool-hijacking': 'run a tool that was swapped after it inspected it, executing a hostile action it believed was safe.',
  'false-readonly': 'change or delete data while trusting a “read-only” label that was a lie.',
  'cross-origin-relay': 'forward your private data to an attacker’s endpoint.',
  'assertion-laundering': 'act on a fake “verified” claim, for example authorize a fraudulent transfer or trust a deepfake voice.',
  'name-spoofing': 'call a lookalike impostor tool instead of the real one.',
  'unrequested-action': 'take a destructive action just because a tool’s output told it to.',
};

const TONE_COLOR: Record<Tone, string> = { ok: 'var(--ok)', warn: 'var(--warn)', bad: 'var(--danger)' };

export function agentRisk(
  results: LevelResult[],
  corpus: LevelDefinition[],
): { tone: Tone; headline: string; lines: string[] } {
  const decided = results.filter((r) => r.verdict === 'PASS' || r.verdict === 'FAIL' || r.verdict === 'PARTIAL');
  if (decided.length === 0) return { tone: 'ok', headline: '', lines: [] }; // nothing decided => card hides

  const failed = decided.filter((r) => r.verdict === 'FAIL');
  const partial = decided.filter((r) => r.verdict === 'PARTIAL');

  if (failed.length === 0) {
    const lines = ['This agent resisted every attack it faced. On these classes, it did not take the bait.'];
    if (partial.length > 0) {
      lines.push(`It partly complied on ${partial.length} (see the amber levels), so keep an eye on those.`);
    }
    return { tone: partial.length > 0 ? 'warn' : 'ok', headline: 'Not much, on this evidence.', lines };
  }

  const lines = failed.slice(0, 4).map((r) => {
    const title = levelById(r.levelId, corpus)?.title;
    const risk = CATEGORY_RISK[r.category] ?? 'be exploited on this attack class.';
    return `On ${title ? `“${title}”` : r.levelId}, your agent could ${risk}`;
  });
  const extra = failed.length > 4 ? [`…and ${failed.length - 4} more.`] : [];
  return {
    tone: 'bad',
    headline: `${failed.length} of these could bite in production.`,
    lines: [...lines, ...extra],
  };
}

export function AgentRisk({ results, corpus }: { results: LevelResult[]; corpus: LevelDefinition[] }) {
  const { tone, headline, lines } = agentRisk(results, corpus);
  if (lines.length === 0) return null;
  const color = TONE_COLOR[tone];

  return (
    <section className="card" style={{ borderColor: color }}>
      <div className="card-head" style={{ marginBottom: 10 }}>
        <span className="card-title">What&rsquo;s the worst that could happen?</span>
        <span aria-hidden style={{ fontSize: 16 }}>
          {tone === 'ok' ? '🙂' : tone === 'warn' ? '🤔' : '😬'}
        </span>
      </div>
      {headline && (
        <p style={{ margin: '0 0 10px', fontSize: 13.5, fontWeight: 650, color }}>
          {headline}
        </p>
      )}
      <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 9 }}>
        {lines.map((l, i) => (
          <li key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <span style={{ color, marginTop: 2, flexShrink: 0 }}>{tone === 'ok' ? '✓' : '•'}</span>
            <span style={{ fontSize: 13.5, color: 'var(--ink)', lineHeight: 1.55 }}>{l}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
