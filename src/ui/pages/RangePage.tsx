// src/ui/pages/RangePage.tsx
//
// Mode 1: the WebMCP assurance range. Owns one RangeSession, registers the
// agent-facing control tools once, streams the live Trace as the centerpiece,
// and shows the scorecard, leaderboard and report opt-in alongside. (Moved here
// unchanged from the former single-page App when the site gained navigation.)

import { useEffect, useMemo, useRef, useState } from 'react';
import { RangeSession, type SessionState } from '../../range/session.ts';
import { registerControlTools } from '../../range/controlTools.ts';
import { hostSource, isWebMcpAvailable } from '../../webmcp/shim.ts';
import { buildReport, sealReport } from '../../range/report.ts';
import { saveScorecard, fetchPremiumCorpus } from '../../data/api.ts';
import { buildFullCorpus, CORPUS } from '../../range/corpusLoader.ts';
import { shouldSaveRun } from '../persist.ts';
import type { HostSource } from '../../webmcp/types.ts';
import { Trace } from '../Trace.tsx';
import { Scorecard } from '../Scorecard.tsx';
import { Controls } from '../Controls.tsx';
import { Leaderboard } from '../Leaderboard.tsx';
import { LeadCapture } from '../LeadCapture.tsx';

const HOST_LABEL: Record<HostSource, string> = {
  document: 'native · document.modelContext',
  navigator: 'native · navigator.modelContext',
  polyfill: 'polyfill · dev fallback',
  none: 'no host',
};

export function RangePage() {
  const session = useMemo(() => new RangeSession(), []);
  const [state, setState] = useState<SessionState>(session.getState());
  const [agentLabel, setAgentLabel] = useState('');
  const [scorecardId, setScorecardId] = useState<string | null>(null);
  const [leaderboardKey, setLeaderboardKey] = useState(0);
  const savingRef = useRef(false);
  const lastSavedKeyRef = useRef<string | null>(null);

  const source = hostSource();
  const nativeHost = source === 'document' || source === 'navigator';

  const [premiumCount, setPremiumCount] = useState(0);

  useEffect(() => session.subscribe(setState), [session]);

  // Premium corpus: if the visitor carries an entitlement token (?corpus_token=…
  // or a saved one), fetch the gated premium specs and add them to this session's
  // corpus. Public specs always run; premium is purely additive. The token is
  // remembered so a returning entitled visitor keeps the extra levels.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get('corpus_token');
    const token = fromUrl || window.localStorage.getItem('trustwright_corpus_token') || '';
    // A token in the URL is a bearer credential: strip it from the address bar (so
    // it does not linger in history or leak via the Referer header) — it is kept
    // in localStorage below.
    if (fromUrl) {
      params.delete('corpus_token');
      const qs = params.toString();
      window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash);
    }
    if (!token) return;
    let cancelled = false;
    void fetchPremiumCorpus(token).then((specs) => {
      if (cancelled || specs.length === 0) return;
      const full = buildFullCorpus(specs);
      const added = full.length - CORPUS.length; // count LEVELS actually added (post-validate/dedup)
      if (added <= 0) return;
      window.localStorage.setItem('trustwright_corpus_token', token);
      session.setCorpus(full);
      setPremiumCount(added);
    });
    return () => {
      cancelled = true;
    };
  }, [session]);

  // Tear the session down on unmount: dispose any level still armed on the global
  // WebMCP host and clear the telemetry bus, so navigating away mid agent-run
  // leaves nothing registered and nothing holding the old bus/buffer alive.
  useEffect(() => () => session.reset(), [session]);

  useEffect(() => {
    const runKey = session.generatedAt();
    if (!shouldSaveRun(state.status, runKey, lastSavedKeyRef.current, savingRef.current)) return;
    // Only agent-driven runs are ranked. The scripted demo (either button, on any
    // host, whatever its label) never touches the public leaderboard.
    if (session.getRunKind() !== 'agent') return;
    savingRef.current = true;
    lastSavedKeyRef.current = runKey;
    const label = session.getState().agentLabel || 'agent';
    void (async () => {
      try {
        const id = await saveScorecard(session.scorecard(), label, session.corpusVersion);
        setScorecardId(id);
        if (id) setLeaderboardKey((k) => k + 1);
      } finally {
        savingRef.current = false;
      }
    })();
  }, [state.status, state.results, session]);

  useEffect(() => {
    let dispose: (() => void) | undefined;
    let cancelled = false;
    registerControlTools(session).then((d) => {
      if (cancelled) d();
      else dispose = d;
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [session]);

  const run = async (kind: 'compliant' | 'careful') => {
    if (state.status === 'running' || savingRef.current) return;
    setScorecardId(null);
    const label = agentLabel.trim() || (nativeHost ? 'Connected agent' : 'Simulated agent');
    await session.run(kind, label);
  };

  const scorecard = session.scorecard();

  const downloadReport = async () => {
    const label = state.agentLabel || agentLabel || 'agent';
    const sealed = await sealReport(
      buildReport(session.scorecard(), label, session.corpusVersion, session.generatedAt()),
    );
    const blob = new Blob([JSON.stringify({ sha256: sealed.sha256, report: sealed.report }, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `trustwright-report-${sealed.sha256.slice(0, 8)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return (
    <div className="page console">
      <header className="cx-head">
        <p className="cx-kick">Mode 1 · test an agent</p>
        <h1 className="cx-title">Put your agent on the range.</h1>
        <p className="cx-sub">
          Run it through a corpus of real tool-surface attacks and watch, live, what gets through. Every payload is an
          inert marker, never a real exploit.
        </p>
        <p style={{ marginTop: 18 }}>
          <span
            className="pill"
            style={{
              background: isWebMcpAvailable() ? 'rgba(34,211,238,.14)' : 'rgba(251,91,118,.16)',
              color: isWebMcpAvailable() ? '#67e8f9' : '#ffb3ba',
              border: '1px solid ' + (isWebMcpAvailable() ? 'rgba(34,211,238,.3)' : 'rgba(251,91,118,.32)'),
            }}
          >
            <span className="dot" style={{ background: 'currentColor' }} />
            {HOST_LABEL[source]}
          </span>
          {premiumCount > 0 && (
            <span
              className="pill"
              style={{ marginLeft: 8, background: 'rgba(34,211,238,.14)', color: '#67e8f9', border: '1px solid rgba(34,211,238,.3)' }}
            >
              <span className="dot" style={{ background: 'currentColor' }} />
              +{premiumCount} premium {premiumCount === 1 ? 'level' : 'levels'}
            </span>
          )}
        </p>
      </header>

      <div className="grid-main">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <Controls
            status={state.status}
            agentLabel={agentLabel}
            currentLevelId={state.currentLevelId}
            onAgentLabel={setAgentLabel}
            onRun={run}
            onReset={() => {
              session.reset();
              setScorecardId(null);
            }}
            nativeHost={nativeHost}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <Leaderboard refreshKey={leaderboardKey} />
          <Scorecard
            scorecard={scorecard}
            agentLabel={state.agentLabel || agentLabel}
            onDownloadReport={state.status === 'done' ? downloadReport : undefined}
          />
          {/* The live trace sits right under the scorecard so a run is visible
              immediately, without scrolling past the (tall) controls panel. */}
          <Trace bus={session.bus} live={state.status === 'running'} />
          {state.status === 'done' && (
            <LeadCapture agentLabel={state.agentLabel || agentLabel} scorecardId={scorecardId} />
          )}
        </div>
      </div>
    </div>
  );
}
