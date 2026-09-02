// src/ui/RangeStatusBar.tsx
//
// Verdict-first status bar: the one thing every visitor came to learn — "is my
// agent passing?" — pinned at the top so it never scrolls away. It promotes the
// scorecard's headline (a status pill + a level stepper + the resistance score)
// to always-visible, and carries the report CTA so it is no longer lost at the
// bottom. Grounded in the dashboard + progressive-disclosure research: one
// dominant result object, KPIs capped, color always paired with an icon/label.

import type { Scorecard as ScorecardData, LevelResult } from '../range/scoring.ts';
import type { LevelDefinition } from '../range/level.ts';

export type StatusTone = 'idle' | 'run' | 'ok' | 'bad';

export interface RunStatus {
  tone: StatusTone;
  label: string;
  sub: string;
}

/** Pure: derive the headline status from the run. Tested. */
export function runStatus(
  scorecard: ScorecardData,
  status: 'idle' | 'running' | 'done',
  currentLevelId: string | null,
): RunStatus {
  if (status === 'running') {
    return { tone: 'run', label: 'Testing…', sub: currentLevelId ? `attack ${currentLevelId} in progress` : 'starting…' };
  }
  if (status === 'done' && scorecard.decided > 0) {
    if (scorecard.fell > 0) {
      return { tone: 'bad', label: 'Breached', sub: `resisted ${scorecard.resisted} of ${scorecard.decided} attacks` };
    }
    return { tone: 'ok', label: 'Resisted', sub: `held off all ${scorecard.decided} attacks` };
  }
  return { tone: 'idle', label: 'Ready to test', sub: 'point your agent at this page and run the gauntlet' };
}

const TONE_COLOR: Record<StatusTone, string> = {
  idle: 'var(--ink-3)',
  run: 'var(--signal-bright)',
  ok: 'var(--ok)',
  bad: 'var(--danger)',
};
const TONE_ICON: Record<StatusTone, string> = { idle: '○', run: '◍', ok: '🛡️', bad: '💥' };

export function RangeStatusBar({
  scorecard,
  status,
  agentLabel,
  corpus,
  currentLevelId,
  onGetReport,
}: {
  scorecard: ScorecardData;
  status: 'idle' | 'running' | 'done';
  agentLabel: string;
  corpus: LevelDefinition[];
  currentLevelId: string | null;
  onGetReport: () => void;
}) {
  const s = runStatus(scorecard, status, currentLevelId);
  const color = TONE_COLOR[s.tone];
  const pctStr = scorecard.resistanceScore == null ? '—' : `${Math.round(scorecard.resistanceScore * 100)}%`;
  const byId = new Map(scorecard.results.map((r: LevelResult) => [r.levelId, r.verdict]));
  const done = status === 'done' && scorecard.decided > 0;

  return (
    <section
      className="card"
      style={{
        borderColor: s.tone === 'idle' ? undefined : color,
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 18,
        padding: '14px 18px',
        position: 'sticky',
        top: 8,
        zIndex: 5,
      }}
    >
      {/* Status pill + who is being tested */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: '1 1 260px', minWidth: 0 }}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            fontFamily: 'var(--mono)',
            fontWeight: 800,
            fontSize: 15,
            letterSpacing: '.03em',
            color,
            border: `1.5px solid ${color}`,
            borderRadius: 999,
            padding: '5px 13px',
            whiteSpace: 'nowrap',
          }}
        >
          <span style={{ animation: s.tone === 'run' ? 'tw-glow 1.1s ease-in-out infinite' : 'none' }}>{TONE_ICON[s.tone]}</span>
          {s.label}
        </span>
        <span style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, color: 'var(--ink)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {agentLabel || 'your agent'}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>{s.sub}</div>
        </span>
      </div>

      {/* Level stepper */}
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', flex: '2 1 240px', justifyContent: 'center' }}>
        {corpus.map((l) => {
          const v = byId.get(l.id);
          const active = l.id === currentLevelId && v === undefined;
          const c =
            v === 'PASS' ? 'var(--ok)' : v === 'FAIL' ? 'var(--danger)' : v === 'PARTIAL' ? 'var(--warn)' : active ? 'var(--signal-bright)' : 'var(--hair-2)';
          const glyph = v === 'PASS' ? '✓' : v === 'FAIL' ? '✕' : v === 'PARTIAL' ? '◑' : '';
          return (
            <span
              key={l.id}
              className="tw-step"
              style={{
                position: 'relative',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                minWidth: 22,
                height: 20,
                padding: '0 6px',
                borderRadius: 6,
                fontFamily: 'var(--mono)',
                fontSize: 10,
                fontWeight: 700,
                color: v || active ? c : 'var(--ink-3)',
                border: `1px solid ${c}`,
                background: v ? `color-mix(in srgb, ${c} 12%, transparent)` : 'transparent',
                animation: active ? 'tw-glow 1.1s ease-in-out infinite' : 'none',
                cursor: 'help',
              }}
            >
              {l.id}
              {glyph && <span style={{ marginLeft: 3 }}>{glyph}</span>}
              <span className="tw-step-tip" role="tooltip">
                <b style={{ color: 'var(--ink)' }}>
                  {l.id} · {l.title}
                </b>
                {v && <span style={{ color: c, fontWeight: 700 }}> · {v}</span>}
                <span style={{ display: 'block', marginTop: 4, color: 'var(--ink-3)' }}>{l.brief}</span>
              </span>
            </span>
          );
        })}
      </div>

      {/* Resistance KPI + actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flex: '0 0 auto' }}>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontFamily: 'var(--mono)', fontWeight: 800, fontSize: 26, lineHeight: 1, color: s.tone === 'idle' ? 'var(--ink-2)' : color }}>
            {pctStr}
          </div>
          <div style={{ fontSize: 10.5, color: 'var(--ink-3)', letterSpacing: '.04em' }}>RESISTANCE</div>
        </div>
        {done && (
          <button className="btn btn-primary" style={{ padding: '7px 13px', fontSize: 12.5 }} onClick={onGetReport}>
            Get the full report
          </button>
        )}
      </div>
    </section>
  );
}
