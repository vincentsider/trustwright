// src/ui/Controls.tsx
//
// How to run the range. One honest path: tell your own agent to visit the range
// and run the gauntlet (it drives the WebMCP tools itself, in a browser), or run
// the identical gauntlet over plain HTTP if the agent has no browser. Both post
// to the same leaderboard under the model name the agent gives.

import { useState } from 'react';
import type { SessionStatus } from '../range/session.ts';

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
  onReset: () => void;
  nativeHost: boolean;
}

export function Controls({ status, onReset, nativeHost }: ControlsProps) {
  const [copied, setCopied] = useState(false);
  const [copiedCurl, setCopiedCurl] = useState(false);

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
          <button className="btn btn-ghost" style={{ padding: '5px 10px', fontSize: 12 }} onClick={onReset}>
            Reset
          </button>
        )}
      </div>

      {/* ── Test a real agent (in a browser) ───────────────────────────────── */}
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
          Test your agent in a browser
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
          It discovers the tools on this page, runs all the levels itself, and its score posts to the
          leaderboard under the model name it gives.
          {!nativeHost
            ? ' This browser has no native host, so open the page inside your agent (e.g. Claude for Chrome or ChatGPT’s browser) for it to call the tools.'
            : ''}
        </p>
      </div>

      {/* ── Or test over HTTP (no browser) ─────────────────────────────────── */}
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
          An agent with no browser (a code agent, a CI job, plain curl) can run the same levels over plain
          HTTP, scored on the same leaderboard. Start a run:
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

      <div
        style={{
          fontSize: 11.5,
          color: 'var(--ink-3)',
          marginTop: 14,
          lineHeight: 1.55,
          borderTop: '1px solid var(--hair-2)',
          paddingTop: 12,
        }}
      >
        <div style={{ fontWeight: 600, color: 'var(--ink-2)', marginBottom: 4 }}>How agents reach the tools</div>
        <ul style={{ margin: 0, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <li>
            A <b>native WebMCP agent</b> (e.g. ChatGPT desktop) calls <span style={{ fontFamily: 'var(--mono)' }}>document.modelContext</span>{' '}
            directly. Nothing is injected, so it just works.
          </li>
          <li>
            An agent that <b>injects a script</b> to reach the tools is blocked by this site’s strict content-security
            policy by design (you may see “page script failed”). Use the HTTP path instead.
          </li>
          <li>
            The HTTP path even runs from <b>inside the page</b> via same-origin{' '}
            <span style={{ fontFamily: 'var(--mono)' }}>fetch</span>, so a browser agent whose own network egress is
            sandboxed can still complete a run.
          </li>
        </ul>
      </div>
    </section>
  );
}
