// src/ui/Leaderboard.tsx
//
// Anonymous cross-agent leaderboard, read from the Worker. Absent gracefully:
// when no backend is configured (local dev) it simply isn't shown.

import { useEffect, useState } from 'react';
import { getLeaderboard, persistenceEnabled, type LeaderboardEntry } from '../data/api.ts';

function pct(v: number | null): string {
  return v === null ? 'n/a' : `${Math.round(v * 100)}%`;
}

export function Leaderboard({ refreshKey }: { refreshKey: number }) {
  const [rows, setRows] = useState<LeaderboardEntry[] | null>(null);

  useEffect(() => {
    if (!persistenceEnabled()) {
      setRows(null);
      return;
    }
    let alive = true;
    getLeaderboard(10).then((r) => {
      if (alive) setRows(r);
    });
    return () => {
      alive = false;
    };
  }, [refreshKey]);

  if (!persistenceEnabled()) return null;

  return (
    <section className="card">
      <div className="card-head">
        <span className="card-title">Leaderboard</span>
        <span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>
          top agents
        </span>
      </div>
      {rows === null ? (
        <div className="mono" style={{ fontSize: 12, color: 'var(--ink-3)' }}>
          loading…
        </div>
      ) : rows.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>
          No runs yet. Be the first to post a score.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.map((r, i) => (
            <div
              key={`${r.agent_label}-${r.created_at}-${i}`}
              style={{
                display: 'grid',
                gridTemplateColumns: '20px 1fr auto',
                gap: 10,
                alignItems: 'center',
                fontSize: 13,
              }}
            >
              <span className="mono" style={{ color: 'var(--ink-3)' }}>
                {i + 1}
              </span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {r.agent_label}
              </span>
              <span className="mono" style={{ color: 'var(--signal)', fontWeight: 600 }}>
                {pct(r.resistance_score)}
                <span style={{ color: 'var(--ink-3)', fontWeight: 400 }}>
                  {'  '}
                  {r.resisted}/{r.decided}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
