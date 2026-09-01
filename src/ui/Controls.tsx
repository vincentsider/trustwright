// src/ui/Controls.tsx
//
// Run controls. Two clearly separated paths: (1) the REAL test, where you tell
// your own agent to visit the range and run the gauntlet (it drives the WebMCP
// tools itself), and (2) a scripted DEMO you can watch without a model. The demo
// never posts to the leaderboard; only a real agent-driven run is ranked.

import { useState } from 'react';
import type { SessionStatus } from '../range/session.ts';
import { levelById } from '../range/corpusLoader.ts';

// The canonical public URL to hand an agent. Hardcoded (not window.location) so
// it renders identically at SSR/prerender time and always names the live site.
const RANGE_URL = 'https://trustwright.deepblocker.ai/range/';
const API_BASE = 'https://trustwright.deepblocker.ai';
const curlStart =
  `curl -sX POST ${API_BASE}/api/range/start \\\n` +
  `  -H 'content-type: application/json' \\\n` +
  `  -d '{"agentLabel":"YOUR MODEL via HTTP"}'`;

export interface ControlsProps {
  status: SessionStatus;
  agentLabel: string;
  currentLevelId: string | null;
  onAgentLabel: (v: string) => void;
  onRun: (kind: 'compliant' | 'careful') => void;
  onReset: () => void;
  nativeHost: boolean;
}

export function Controls({
  status,
  agentLabel,
  currentLevelId,
  onAgentLabel,
  onRun,
  onReset,
  nativeHost,
}: ControlsProps) {
  const running = status === 'running';
  const [touched, setTouched] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedCurl, setCopiedCurl] = useState(false);
  const label = agentLabel.trim() || 'Demo agent';
  const currentTask = currentLevelId ? levelById(currentLevelId)?.task : undefined;

  const instruction = `Go to ${RANGE_URL} and run the gauntlet: call start_run (tell it your exact model), do each task with the tools that appear, then call complete_level between them.`;

  const copyInstruction = () => {
    try {
      void navigator.clipboard?.writeText(instruction);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked; the text is on screen to copy by hand */
    }
  };

  const copyCurl = () => {
    try {
      void navigator.clipboard?.writeText(curlStart);
      setCopiedCurl(true);
      setTimeout(() => setCopiedCurl(false), 1600);
    } catch {
      /* clipboard blocked; the text is on screen to copy by hand */
    }
  };

  return (
    <section className="card">
      <div className="card-head">
        <span className="card-title">Run the gauntlet</span>
        {status !== 'idle' && (
          <button
            className="btn btn-ghost"
            style={{ padding: '5px 10px', fontSize: 12 }}
            disabled={running}
            onClick={onReset}
          >
            Reset
          </button>
        )}
      </div>

      {/* ── PRIMARY: test a real agent ─────────────────────────────────────── */}
      <div
        style={{
          border: '1px solid var(--hair-2)',
          borderRadius: 10,
          padding: '14px 14px 16px',
          background: 'var(--signal-soft)',
        }}
      >
        <div
          style={{
            fontSize: 11,
            letterSpacing: '.04em',
            textTransform: 'uppercase',
            color: 'var(--signal)',
            fontFamily: 'var(--mono)',
            marginBottom: 8,
          }}
        >
          Test your agent · the real test
        </div>
        <p style={{ fontSize: 13.5, color: 'var(--ink)', margin: '0 0 10px', lineHeight: 1.5 }}>
          In your agent’s own chat (Claude, ChatGPT, or any WebMCP agent), tell it:
        </p>
        <div
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 12.5,
            color: 'var(--ink)',
            background: 'var(--bg)',
            border: '1px solid var(--hair-2)',
            borderRadius: 8,
            padding: '10px 12px',
            lineHeight: 1.55,
          }}
        >
          “Go to {RANGE_URL} and run the gauntlet.”
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
          <button className="btn btn-ghost" style={{ padding: '6px 12px', fontSize: 12 }} onClick={copyInstruction}>
            {copied ? 'Copied' : 'Copy full instruction'}
          </button>
          <span
            className="pill"
            style={{
              background: nativeHost ? 'rgba(34,211,238,.14)' : 'rgba(251,91,118,.16)',
              color: nativeHost ? '#67e8f9' : '#ffb3ba',
              border: '1px solid ' + (nativeHost ? 'rgba(34,211,238,.3)' : 'rgba(251,91,118,.32)'),
            }}
          >
            <span className="dot" style={{ background: 'currentColor' }} />
            {nativeHost ? 'native WebMCP host live' : 'no native host in this browser'}
          </span>
        </div>
        <p style={{ fontSize: 12, color: 'var(--ink-3)', margin: '10px 0 0', lineHeight: 1.5 }}>
          It discovers the tools on this page, runs all six levels itself, and its score posts to the
          leaderboard under the model name it gives.
          {!nativeHost
            ? ' This browser has no native host, so open the page inside your agent (e.g. Claude for Chrome or ChatGPT’s browser) for it to call the tools.'
            : ''}
        </p>
      </div>

      {/* ── SECONDARY: scripted demo ───────────────────────────────────────── */}
      <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--hair-2)' }}>
        <div
          style={{
            fontSize: 11,
            letterSpacing: '.04em',
            textTransform: 'uppercase',
            color: 'var(--ink-3)',
            fontFamily: 'var(--mono)',
            marginBottom: 8,
          }}
        >
          Or watch a demo · simulated, not a real test
        </div>
        <label style={{ fontSize: 12, color: 'var(--ink-3)', display: 'block', marginBottom: 6 }}>
          Label for the demo run (this field is only for the demo)
        </label>
        <input
          className="field"
          placeholder="e.g. Careful agent"
          value={agentLabel}
          disabled={running}
          onChange={(e) => {
            setTouched(true);
            onAgentLabel(e.target.value);
          }}
          style={{ marginBottom: 12 }}
        />
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button className="btn btn-primary" disabled={running} onClick={() => onRun('careful')}>
            {running ? 'Running…' : 'Demo: careful agent'}
          </button>
          <button className="btn btn-ghost" disabled={running} onClick={() => onRun('compliant')}>
            Demo: susceptible agent
          </button>
        </div>
        <p style={{ fontSize: 11.5, color: 'var(--ink-3)', marginTop: 12, lineHeight: 1.5 }}>
          These run a scripted agent so you can see how the range works without a model. Demo runs never
          post to the leaderboard.
          {touched && !agentLabel.trim() ? ` Using “${label}”.` : ''}
        </p>
      </div>

      {/* ── BROWSERLESS: same gauntlet over HTTP ───────────────────────────── */}
      <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--hair-2)' }}>
        <div
          style={{
            fontSize: 11,
            letterSpacing: '.04em',
            textTransform: 'uppercase',
            color: 'var(--ink-3)',
            fontFamily: 'var(--mono)',
            marginBottom: 8,
          }}
        >
          No browser? Test over HTTP
        </div>
        <p style={{ fontSize: 12.5, color: 'var(--ink-2)', margin: '0 0 10px', lineHeight: 1.5 }}>
          An agent with no browser (a code agent, a CI job, plain curl) can run the same six levels over
          plain HTTP, scored on the same leaderboard. Start a run:
        </p>
        <div
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 11.5,
            color: 'var(--ink)',
            background: 'var(--bg)',
            border: '1px solid var(--hair-2)',
            borderRadius: 8,
            padding: '10px 12px',
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
        >
          {curlStart}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
          <button className="btn btn-ghost" style={{ padding: '6px 12px', fontSize: 12 }} onClick={copyCurl}>
            {copiedCurl ? 'Copied' : 'Copy curl'}
          </button>
          <span style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>
            then <span style={{ fontFamily: 'var(--mono)' }}>/api/range/act</span> per tool, and{' '}
            <span style={{ fontFamily: 'var(--mono)' }}>/api/range/complete_level</span> to score.
          </span>
        </div>
      </div>

      <p style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 14, lineHeight: 1.5 }}>
        Note: some agents drive a page by injecting scripts. This site’s strict content-security policy
        blocks that, so an agent’s trace may show “page script failed”. That is expected and does not
        affect a real WebMCP run, which calls the tools directly.
      </p>

      {running && currentTask && (
        <div
          style={{
            marginTop: 14,
            padding: '10px 12px',
            border: '1px solid var(--hair-2)',
            borderRadius: 8,
            background: 'var(--signal-soft)',
          }}
        >
          <div style={{ fontSize: 11, color: 'var(--signal)', fontFamily: 'var(--mono)', marginBottom: 4 }}>
            NOW TESTING · {currentLevelId}
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--ink)' }}>{currentTask}</div>
        </div>
      )}
    </section>
  );
}
