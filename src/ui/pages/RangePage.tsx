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
import type { LevelDefinition } from '../../range/level.ts';
import { shouldSaveRun, rankEligible } from '../persist.ts';
import type { HostSource } from '../../webmcp/types.ts';
import { Trace } from '../Trace.tsx';
import { AttackTheater } from '../AttackTheater.tsx';
import { Scorecard } from '../Scorecard.tsx';
import { Controls } from '../Controls.tsx';
import { Leaderboard } from '../Leaderboard.tsx';
import { LeadCapture } from '../LeadCapture.tsx';
import { BringYourOwnAttack } from '../BringYourOwnAttack.tsx';
import { AgentRisk } from '../AgentRisk.tsx';
import { RangeStatusBar } from '../RangeStatusBar.tsx';

const HOST_LABEL: Record<HostSource, string> = {
  document: 'native · document.modelContext',
  navigator: 'native · navigator.modelContext',
  polyfill: 'polyfill · dev fallback',
  none: 'no host',
};

export function RangePage() {
  const session = useMemo(() => new RangeSession(), []);
  const [state, setState] = useState<SessionState>(session.getState());
  const [scorecardId, setScorecardId] = useState<string | null>(null);
  const [leaderboardKey, setLeaderboardKey] = useState(0);
  const savingRef = useRef(false);
  const lastSavedKeyRef = useRef<string | null>(null);

  const source = hostSource();
  const nativeHost = source === 'document' || source === 'navigator';

  const [premiumCount, setPremiumCount] = useState(0);
  // Raw specs added on top of the bundled public corpus: fetched premium specs
  // and any the visitor pastes via "Bring your own attack". One source of truth,
  // rebuilt into the running corpus below.
  const [extraSpecs, setExtraSpecs] = useState<unknown[]>([]);
  const [byoaIds, setByoaIds] = useState<string[]>([]);
  const [corpusLevels, setCorpusLevels] = useState<LevelDefinition[]>(CORPUS);
  // Setup (how-to-run + bring-your-own-attack) is pre-run, not live status. Open
  // by default so a first visitor sees how to start; auto-collapses once a run
  // begins so the live dashboard owns the viewport.
  const [setupOpen, setSetupOpen] = useState(true);

  useEffect(() => session.subscribe(setState), [session]);

  // Premium corpus: if the visitor carries an entitlement token (?corpus_token=…
  // or a saved one), fetch the gated premium specs and add them. Public specs
  // always run; premium is purely additive. The token is remembered so a
  // returning entitled visitor keeps the extra levels.
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
      window.localStorage.setItem('trustwright_corpus_token', token);
      setExtraSpecs((prev) => [...prev, ...specs]);
    });
    return () => {
      cancelled = true;
    };
  }, [session]);

  // Rebuild the running corpus from public + extra specs whenever the extras
  // change. Never mid-run (setCorpus is a no-op while running, and the level
  // index must not shift under an armed level). buildFullCorpus re-validates and
  // dedupes, so a bad or duplicate spec is dropped, never trusted.
  useEffect(() => {
    if (state.status === 'running') return;
    const full = buildFullCorpus(extraSpecs);
    session.setCorpus(full);
    setCorpusLevels(full);
    setPremiumCount(Math.max(0, full.length - CORPUS.length));
  }, [extraSpecs, session, state.status]);

  const addSpec = (spec: unknown) => {
    setExtraSpecs((prev) => [...prev, spec]);
    const id = (spec as { id?: unknown }).id;
    if (typeof id === 'string') setByoaIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
  };

  // Tear the session down on unmount: dispose any level still armed on the global
  // WebMCP host and clear the telemetry bus, so navigating away mid agent-run
  // leaves nothing registered and nothing holding the old bus/buffer alive.
  useEffect(() => () => session.reset(), [session]);

  useEffect(() => {
    const runKey = session.generatedAt();
    if (!shouldSaveRun(state.status, runKey, lastSavedKeyRef.current, savingRef.current)) return;
    // Only a real agent-driven run against the OFFICIAL corpus is ranked: the
    // scripted demo never posts, and neither does a run that included a
    // user-authored "bring your own attack" level (which could be trivially
    // passable and inflate the public score).
    if (!rankEligible(session.getRunKind(), byoaIds.length)) return;
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
  }, [state.status, state.results, session, byoaIds.length]);

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

  // Collapse the setup panel the moment a run starts, so the live view owns the
  // screen (an agent-driven run flips status to 'running').
  useEffect(() => {
    if (state.status === 'running') setSetupOpen(false);
  }, [state.status]);

  const onGetReport = () => {
    if (typeof document !== 'undefined') document.getElementById('range-report')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const scorecard = session.scorecard();

  const downloadReport = async () => {
    const label = state.agentLabel || 'agent';
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
      <header className="cx-head" style={{ marginBottom: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <p className="cx-kick" style={{ marginBottom: 2 }}>Mode 1 · test an agent</p>
            <h1 className="cx-title" style={{ margin: 0 }}>Put your agent on the range.</h1>
          </div>
          <span style={{ display: 'inline-flex', gap: 8, flexShrink: 0 }}>
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
                style={{ background: 'rgba(34,211,238,.14)', color: '#67e8f9', border: '1px solid rgba(34,211,238,.3)' }}
              >
                <span className="dot" style={{ background: 'currentColor' }} />
                +{premiumCount} extra {premiumCount === 1 ? 'level' : 'levels'}
              </span>
            )}
          </span>
        </div>
        <p className="cx-sub" style={{ marginTop: 6, marginBottom: 0 }}>
          Run it through a corpus of real tool-surface attacks and watch, live, what gets through.
        </p>
      </header>

      {/* Verdict-first status bar: "is my agent passing?" pinned at the top. */}
      <div style={{ marginTop: 6 }}>
        <RangeStatusBar
          scorecard={scorecard}
          status={state.status}
          agentLabel={state.agentLabel}
          corpus={corpusLevels}
          currentLevelId={state.currentLevelId}
          onGetReport={onGetReport}
        />
      </div>

      {/* Setup — how to run + bring your own attack. Collapsible; pre-run, not
          live status, so it yields the viewport once a run starts. */}
      <section id="range-setup" className="card" style={{ marginTop: 18 }}>
        <div
          className="card-head"
          style={{ cursor: 'pointer', marginBottom: setupOpen ? undefined : 0 }}
          role="button"
          tabIndex={0}
          onClick={() => setSetupOpen((o) => !o)}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setSetupOpen((o) => !o)}
        >
          <span className="card-title">Run a test</span>
          <span className="mono" style={{ fontSize: 11, color: 'var(--signal-bright)' }}>
            {setupOpen ? 'hide' : 'how to run · bring your own attack'}
          </span>
        </div>
        {setupOpen && (
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <Controls
              status={state.status}
              onReset={() => {
                session.reset();
                setScorecardId(null);
              }}
              nativeHost={nativeHost}
            />
            <BringYourOwnAttack
              onAdd={addSpec}
              disabled={state.status === 'running'}
              addedIds={byoaIds}
              existingIds={[...new Set([...corpusLevels.map((l) => l.id), ...byoaIds])]}
            />
          </div>
        )}
      </section>

      {state.status === 'idle' ? (
        /* Before a run there is nothing live to show, so the empty theater /
           trace / scorecard are NOT rendered. Just the leaderboard: real data,
           and a reason to test your own agent. */
        <div style={{ marginTop: 18 }}>
          <Leaderboard refreshKey={leaderboardKey} />
        </div>
      ) : (
        <>
          {/* Two balanced columns, both filled top-to-bottom. Left (hero): the
              live theater with the full scorecard beneath it. Right: the raw
              trace, the plain-language consequence, and the leaderboard. */}
          <div className="grid-main" style={{ marginTop: 18 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              <AttackTheater bus={session.bus} live={state.status === 'running'} corpus={corpusLevels} />
              <Scorecard
                scorecard={scorecard}
                agentLabel={state.agentLabel}
                onDownloadReport={state.status === 'done' ? downloadReport : undefined}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              <Trace bus={session.bus} live={state.status === 'running'} />
              <AgentRisk results={scorecard.results} corpus={corpusLevels} />
              <Leaderboard refreshKey={leaderboardKey} />
            </div>
          </div>

          {/* The report / lead capture, once there is a result. */}
          <div id="range-report" style={{ marginTop: 18 }}>
            {state.status === 'done' && (
              <LeadCapture agentLabel={state.agentLabel} scorecardId={scorecardId} />
            )}
          </div>
        </>
      )}
    </div>
  );
}
