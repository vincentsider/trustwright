// src/ui/Controls.tsx
//
// Run controls. With a native WebMCP host, a real agent drives the range by
// calling the tools; these buttons run a simulated agent so you can watch the
// Trace and get a real scorecard without a model. The distinction is labelled
// honestly.

import { useState } from 'react';
import type { SessionStatus } from '../range/session.ts';
import { levelById } from '../range/corpusLoader.ts';

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
  const label = agentLabel.trim() || (nativeHost ? 'Connected agent' : 'Simulated agent');
  const currentTask = currentLevelId ? levelById(currentLevelId)?.task : undefined;

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

      <label style={{ fontSize: 12, color: 'var(--ink-3)', display: 'block', marginBottom: 6 }}>
        Agent label (appears on the scorecard)
      </label>
      <input
        className="field"
        placeholder="e.g. GPT-5.6 via ChatGPT"
        value={agentLabel}
        disabled={running}
        onChange={(e) => {
          setTouched(true);
          onAgentLabel(e.target.value);
        }}
        style={{ marginBottom: 14 }}
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
        {nativeHost
          ? 'A native WebMCP host is live. To test the real agent, tell it: “call start_run, do each task, and call complete_level between them.” The buttons run a simulated agent for a repeatable demo.'
          : 'No native WebMCP host detected, so these buttons run a simulated agent. Open in ChatGPT’s browser or flagged Chrome to drive with a real agent (ask it to call start_run).'}
        {touched && !agentLabel.trim() ? ` Using "${label}".` : ''}
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
