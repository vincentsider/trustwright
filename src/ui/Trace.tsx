// src/ui/Trace.tsx
//
// The centerpiece: a live console of what the agent actually did, streamed from
// the telemetry bus. Honest tool calls read cyan; a fired canary (an attack
// landing) reads red-team rose with a glow. This is the "declared vs observed"
// view — the site declares tools, and here you watch what the agent does with
// them.
//
// Performance: subscribes once, keeps a bounded local buffer, renders the most
// recent slice, and auto-scrolls only when the user is already at the bottom.

import { useEffect, useRef, useState } from 'react';
import type { TelemetryBus, TelemetryEvent } from '../range/telemetry.ts';

const RENDER_CAP = 140; // the bus holds 500; we only ever paint the recent tail

const KIND_LABEL: Record<TelemetryEvent['kind'], string> = {
  tool_registered: 'REGISTER',
  tool_unregistered: 'UNREGISTER',
  tool_called: 'CALL',
  tool_result: 'RESULT',
  toolchange: 'TOOLCHANGE',
  canary_fired: 'CANARY',
  level_started: 'LEVEL',
  level_scored: 'VERDICT',
  note: 'NOTE',
};

export function Trace({ bus, live }: { bus: TelemetryBus; live: boolean }) {
  const [events, setEvents] = useState<TelemetryEvent[]>(() => bus.snapshot());
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  useEffect(() => {
    // Re-snapshot on every emit. The bus is bounded (<=500) and runs emit only a
    // handful of events, so this is cheap AND stays correct across a clear()/reset
    // (a fresh run empties the bus and the Trace follows it down to zero).
    setEvents(bus.snapshot());
    const off = bus.subscribe(() => setEvents(bus.snapshot()));
    return off;
  }, [bus]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [events]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  return (
    <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div className="card-head" style={{ padding: '14px 18px', marginBottom: 0, borderBottom: '1px solid var(--hair)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="dot dot-live" style={{ opacity: live ? 1 : 0.3 }} />
          <span className="card-title">Live trace: declared &rarr; observed</span>
        </div>
        <span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>
          {events.length} events
        </span>
      </div>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        style={{
          height: 420,
          overflowY: 'auto',
          padding: '12px 10px',
          background: 'linear-gradient(180deg, rgba(6,182,212,0.03), transparent 120px)',
        }}
      >
        {events.length === 0 && (
          <div className="mono" style={{ color: 'var(--ink-3)', fontSize: 12, padding: 16 }}>
            Idle. Start a run to stream tool calls here.
          </div>
        )}
        {events.slice(-RENDER_CAP).map((e) => (
          <Row key={e.seq} e={e} />
        ))}
      </div>
    </section>
  );
}

function Row({ e }: { e: TelemetryEvent }) {
  const hostile = !!e.hostile;
  const isVerdict = e.kind === 'level_scored';
  const accent = hostile
    ? 'var(--red-team)'
    : e.kind === 'tool_called'
      ? 'var(--signal-bright)'
      : e.kind === 'level_started'
        ? 'var(--ink-2)'
        : 'var(--ink-3)';

  return (
    <div
      className="mono"
      style={{
        display: 'grid',
        gridTemplateColumns: '52px 92px 1fr',
        gap: 10,
        alignItems: 'baseline',
        fontSize: 12,
        padding: '5px 8px',
        borderRadius: 6,
        animation: 'rowin 0.18s ease',
        background: hostile ? 'var(--danger-soft)' : 'transparent',
        boxShadow: hostile ? '0 0 0 1px rgba(244,63,94,0.25)' : 'none',
        marginBottom: 2,
      }}
    >
      <span style={{ color: 'var(--ink-3)' }}>{String(e.t).padStart(4, '0')}ms</span>
      <span style={{ color: accent, fontWeight: 600 }}>{KIND_LABEL[e.kind]}</span>
      <span style={{ color: hostile ? 'var(--red-team)' : 'var(--ink)' }}>
        {e.label && <b style={{ fontWeight: 600 }}>{e.label}</b>}
        {e.label && (e.detail || isVerdict) ? '  ' : ''}
        {isVerdict ? (
          <span style={{ color: verdictColor(e.detail) }}>{e.detail}</span>
        ) : (
          <span style={{ color: hostile ? 'var(--red-team)' : 'var(--ink-2)' }}>{e.detail}</span>
        )}
        {hostile && <span style={{ color: 'var(--red-team)' }}>{'  ← attack landed'}</span>}
      </span>
    </div>
  );
}

function verdictColor(v?: string): string {
  if (v === 'PASS') return 'var(--ok)';
  if (v === 'FAIL') return 'var(--danger)';
  if (v === 'PARTIAL') return 'var(--warn)';
  return 'var(--ink-3)';
}
