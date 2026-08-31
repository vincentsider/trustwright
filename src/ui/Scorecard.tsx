// src/ui/Scorecard.tsx
//
// The result panel: the Agent Resistance Score, the shareable one-liner, and a
// per-level breakdown with the verdict and (for a fail) what to fix.

import { useEffect, useRef, useState } from 'react';
import type { Scorecard as ScorecardData } from '../range/scoring.ts';
import { summarize } from '../range/scoring.ts';
import { levelById } from '../range/corpusLoader.ts';

function pct(score: number | null): string {
  return score === null ? 'n/a' : `${Math.round(score * 100)}%`;
}

function VerdictPill({ verdict }: { verdict: string }) {
  const cls =
    verdict === 'PASS'
      ? 'pill pill-pass'
      : verdict === 'FAIL'
        ? 'pill pill-fail'
        : verdict === 'PARTIAL'
          ? 'pill pill-partial'
          : 'pill pill-idle';
  return <span className={cls}>{verdict}</span>;
}

export function Scorecard({
  scorecard,
  agentLabel,
  onDownloadReport,
}: {
  scorecard: ScorecardData;
  agentLabel: string;
  onDownloadReport?: (() => void) | undefined;
}) {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const label = agentLabel || 'this agent';
  const line = summarize(scorecard, label);

  // Clear the "Copied" reset timer on unmount so it never fires setState on a
  // gone component (matches CodeBlock).
  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(line + '. Tested with Trustwright');
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard may be unavailable; ignore */
    }
  };

  const hasResults = scorecard.results.length > 0;

  return (
    <section className="card">
      <div className="card-head">
        <span className="card-title">Scorecard</span>
        {hasResults && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost" style={{ padding: '5px 10px', fontSize: 12 }} onClick={copy}>
              {copied ? 'Copied' : 'Copy result'}
            </button>
            {onDownloadReport && (
              <button
                className="btn btn-ghost"
                style={{ padding: '5px 10px', fontSize: 12 }}
                onClick={onDownloadReport}
              >
                Sealed report
              </button>
            )}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 14 }}>
        <div
          className="mono"
          style={{
            fontSize: 34,
            fontWeight: 600,
            color: scoreColor(scorecard.resistanceScore),
            lineHeight: 1,
            minWidth: 84,
          }}
        >
          {pct(scorecard.resistanceScore)}
        </div>
        <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.4 }}>
          {hasResults ? line : 'Run the gauntlet to score this agent.'}
        </div>
      </div>

      {hasResults && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {scorecard.results.map((r) => {
            const def = levelById(r.levelId);
            const failed = r.verdict === 'FAIL';
            return (
              <div
                key={r.levelId}
                style={{
                  border: '1px solid var(--hair)',
                  borderRadius: 10,
                  padding: '10px 12px',
                  background: 'var(--surface-2)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>
                    <span className="mono" style={{ color: 'var(--ink-3)' }}>
                      {r.levelId}
                    </span>{' '}
                    {def?.title ?? r.category}
                  </span>
                  <VerdictPill verdict={r.verdict} />
                </div>
                {failed && def && (
                  <div style={{ fontSize: 12, color: 'var(--ink-2)', marginTop: 6, lineHeight: 1.45 }}>
                    <span style={{ color: 'var(--red-team)' }}>Fell for it. </span>
                    {def.mitigation}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function scoreColor(score: number | null): string {
  if (score === null) return 'var(--ink-3)';
  if (score >= 0.8) return 'var(--ok)';
  if (score >= 0.5) return 'var(--warn)';
  return 'var(--danger)';
}
