// src/ui/pages/StatsPage.tsx
//
// Admin success dashboard (/stats): how many sites asked for a badge (and which),
// how many people scanned a site, how many tested an agent, plus the leads count.
// Gated by the admin token, entered once and kept in localStorage — the token is
// only ever sent as the x-admin-token header, never in the URL.

import { useCallback, useEffect, useState } from 'react';
import { getStats, type StatsData } from '../../data/api.ts';

const TOKEN_KEY = 'tw_admin_token';

function Tile({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="stat-tile">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

export function StatsPage() {
  const [token, setToken] = useState<string>(() => localStorage.getItem(TOKEN_KEY) ?? '');
  const [input, setInput] = useState('');
  const [data, setData] = useState<StatsData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (t: string) => {
    if (!t) return;
    setBusy(true);
    setError(null);
    const { ok, status, data: d } = await getStats(t);
    setBusy(false);
    if (ok && d) {
      setData(d);
    } else if (status === 403) {
      setError('That admin token was rejected.');
      setData(null);
      localStorage.removeItem(TOKEN_KEY);
      setToken('');
    } else {
      setError('Could not load stats. Try again.');
    }
  }, []);

  useEffect(() => {
    if (token) void load(token);
  }, [token, load]);

  const saveToken = (e: React.FormEvent) => {
    e.preventDefault();
    const t = input.trim();
    if (!t) return;
    localStorage.setItem(TOKEN_KEY, t);
    setToken(t);
    setInput('');
  };

  const s = data;
  return (
    <div className="page console page-narrow">
      <div className="cx-head">
        <p className="cx-kick">Trustwright · admin</p>
        <h1 className="cx-title">Success dashboard</h1>
        {token && (
          <p className="cx-sub">
            Live counts from the audit database.{' '}
            <button
              type="button"
              className="linklike"
              onClick={() => void load(token)}
              style={{ background: 'none', border: 0, color: 'var(--signal-bright)', cursor: 'pointer', padding: 0, font: 'inherit' }}
            >
              {busy ? 'refreshing…' : 'refresh'}
            </button>
          </p>
        )}
      </div>

      {!token && (
        <form onSubmit={saveToken} className="card" style={{ marginTop: 20 }}>
          <h2 className="rep-h">Enter your admin token</h2>
          <p className="muted" style={{ fontSize: 13.5, marginTop: 0 }}>
            The same token used for operator endpoints. Stored only in this browser; sent only as a header.
          </p>
          <div className="row" style={{ marginTop: 8 }}>
            <input
              className="field"
              style={{ flex: '1 1 320px' }}
              type="password"
              placeholder="admin token"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <button className="btn btn-primary" type="submit" disabled={!input.trim()}>
              View
            </button>
          </div>
          {error && <p className="notice bad" style={{ marginTop: 14 }}>{error}</p>}
        </form>
      )}

      {token && error && !s && <div className="notice bad" style={{ marginTop: 18 }}>{error}</div>}
      {token && busy && !s && (
        <div className="notice" style={{ marginTop: 18 }}>
          <span className="spin" style={{ marginRight: 8, verticalAlign: 'middle' }} />
          Loading…
        </div>
      )}

      {s && (
        <>
          <div className="stat-grid" style={{ marginTop: 20 }}>
            <Tile label="Sites with a live badge" value={s.badges.active} sub={`${s.badges.everMinted} ever minted`} />
            <Tile label="Site scans" value={s.scans.total} sub={`${s.scans.last7d} in the last 7 days`} />
            <Tile label="Agent tests" value={s.agentTests.total} sub={s.agentTests.avgResistance != null ? `avg ${Math.round(s.agentTests.avgResistance * 100)}% resistance` : ''} />
            <Tile label="Leads (emails) captured" value={s.leads} />
          </div>

          <div className="card" style={{ marginTop: 18 }}>
            <h2 className="rep-h">Sites with a badge <span className="muted-3" style={{ fontWeight: 400, fontSize: 13 }}>{s.badges.sites.length}</span></h2>
            {s.badges.sites.length > 0 ? (
              <ul className="tool-list">
                {s.badges.sites.map((site) => (
                  <li key={site} className="stat-row">
                    <a href={`/report?origin=${encodeURIComponent(site)}`} target="_blank" rel="noopener noreferrer">{site}</a>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted" style={{ fontSize: 14 }}>No badges yet.</p>
            )}
          </div>

          <div className="card" style={{ marginTop: 18 }}>
            <h2 className="rep-h">
              Most-scanned sites{' '}
              <span className="muted-3" style={{ fontWeight: 400, fontSize: 13 }}>{s.scans.uniqueSites} unique · {s.scans.total} scans</span>
            </h2>
            {s.scans.topSites.length > 0 ? (
              <ul className="tool-list">
                {s.scans.topSites.map((t) => (
                  <li key={t.origin} className="stat-row">
                    <span style={{ wordBreak: 'break-all' }}>{t.origin}</span>
                    <span className="stat-count">{t.scans}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted" style={{ fontSize: 14 }}>No scans recorded yet (tracking started with this deploy).</p>
            )}
          </div>

          <div className="card" style={{ marginTop: 18 }}>
            <h2 className="rep-h">Verification funnel</h2>
            <div className="rep-row"><span className="rep-k">Started proof</span><span className="rep-v">{s.verification.started}</span></div>
            <div className="rep-row"><span className="rep-k">Verified</span><span className="rep-v">{s.verification.verified}</span></div>
            <div className="rep-row"><span className="rep-k">Got a badge</span><span className="rep-v">{s.badges.everMinted}</span></div>
          </div>

          <p className="muted-3" style={{ fontSize: 12, textAlign: 'center', marginTop: 18 }}>
            as of {new Date(s.generatedAt).toLocaleString()}
          </p>
        </>
      )}
    </div>
  );
}
