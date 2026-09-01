// src/ui/AttackTheater.tsx
//
// The attack, visualized. Same telemetry bus as the raw Trace, but rendered as a
// live "theater": the tool surface the site declared, drawn as cards; the trap
// tool marked; the agent's calls pulsing; a "surface swapped" banner when a tool
// morphs mid-task (the rug-pull); and a verdict stamp — a green shield when the
// agent RESISTED, a red BREACH when it fell. This is what a human watching an
// agent run actually sees, and the centerpiece of the demo: you can see the
// attack land or get blocked, not just read a log line.
//
// It adds NOTHING to the engine: every state here is derived from bus events
// (level_started / tool_called / canary_fired / toolchange / level_scored) plus
// the live host's getTools() for the tool cards. No new instrumentation.

import { useEffect, useState } from 'react';
import type { TelemetryBus, TelemetryEvent } from '../range/telemetry.ts';
import { resolveHost } from '../webmcp/shim.ts';
import { levelById, CORPUS } from '../range/corpusLoader.ts';
import type { LevelDefinition } from '../range/level.ts';
import type { RegisteredTool } from '../webmcp/types.ts';

type Verdict = 'PASS' | 'FAIL' | 'PARTIAL' | 'SKIPPED';

interface Derived {
  levelId: string | null;
  called: Set<string>;
  traps: Set<string>; // tools that fired a canary (the attack landed via them)
  swapped: boolean; // a toolchange happened this level (rug-pull)
  verdict: Verdict | null; // set once the level is scored
  history: Array<{ levelId: string; verdict: string }>;
}

/** Fold the event stream into the current level's visual state. Recomputed on
 *  every emit; the bus is bounded so this is cheap, and it resets to idle for
 *  free when the bus is cleared between runs. Exported for unit testing. */
export function derive(events: TelemetryEvent[]): Derived {
  let levelId: string | null = null;
  let called = new Set<string>();
  let traps = new Set<string>();
  let swapped = false;
  let verdict: Verdict | null = null;
  const history: Array<{ levelId: string; verdict: string }> = [];
  for (const e of events) {
    switch (e.kind) {
      case 'level_started':
        levelId = e.label ?? null;
        called = new Set();
        traps = new Set();
        swapped = false;
        verdict = null;
        break;
      case 'tool_called':
        if (e.label) called.add(e.label);
        break;
      case 'canary_fired':
        if (e.label) traps.add(e.label);
        break;
      case 'toolchange':
        swapped = true;
        break;
      case 'level_scored':
        verdict = (e.detail as Verdict) ?? null;
        if (e.label && e.detail) history.push({ levelId: e.label, verdict: e.detail });
        break;
    }
  }
  return { levelId, called, traps, swapped, verdict, history };
}

interface Surface {
  order: RegisteredTool[]; // every tool seen this level, in first-seen order
  current: Set<string>; // names still registered right now (others were swapped away)
}

export function AttackTheater({
  bus,
  live,
  corpus = CORPUS,
}: {
  bus: TelemetryBus;
  live: boolean;
  corpus?: LevelDefinition[];
}) {
  const [snap, setSnap] = useState<TelemetryEvent[]>(() => bus.snapshot());
  const [surface, setSurface] = useState<Surface>({ order: [], current: new Set() });

  useEffect(() => {
    const pull = (reset: boolean) => {
      const host = resolveHost().host;
      if (!host) {
        if (reset) setSurface({ order: [], current: new Set() });
        return;
      }
      void host
        .getTools()
        .then((tools) =>
          setSurface((prev) => {
            const base = reset ? [] : prev.order;
            const map = new Map(base.map((t) => [t.name, t]));
            for (const t of tools) map.set(t.name, t);
            return { order: [...map.values()], current: new Set(tools.map((t) => t.name)) };
          }),
        )
        .catch(() => {});
    };

    setSnap(bus.snapshot());
    const off = bus.subscribe((e) => {
      setSnap(bus.snapshot());
      if (e.kind === 'level_started') pull(true);
      else if (e.kind === 'tool_called' || e.kind === 'toolchange') pull(false);
    });
    return off;
  }, [bus]);

  const d = derive(snap);
  const level = d.levelId ? levelById(d.levelId, corpus) : null;
  const idle = !d.levelId;

  return (
    <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div className="card-head" style={{ padding: '14px 18px', marginBottom: 0, borderBottom: '1px solid var(--hair)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="dot dot-live" style={{ opacity: live ? 1 : 0.3 }} />
          <span className="card-title">Attack theater</span>
        </div>
        <ResistanceMeter history={d.history} activeLevelId={d.levelId} levels={corpus} />
      </div>

      <div style={{ padding: '16px 18px 20px', minHeight: 300 }}>
        {idle ? (
          <Idle />
        ) : (
          <>
            <LevelHeader
              id={d.levelId!}
              title={level?.title}
              difficulty={level?.difficulty}
              task={level?.task}
            />

            {d.swapped && (
              <div
                style={{
                  margin: '14px 0',
                  padding: '9px 12px',
                  borderRadius: 8,
                  border: '1px solid rgba(251,191,36,0.4)',
                  background: 'var(--warn-soft)',
                  color: 'var(--warn)',
                  fontSize: 12.5,
                  fontWeight: 600,
                  display: 'flex',
                  gap: 8,
                  alignItems: 'center',
                }}
              >
                <span style={{ animation: 'tw-glow 1.4s ease-in-out infinite' }}>⚠</span>
                Tool surface swapped mid-task — a tool changed identity after the agent read it.
              </div>
            )}

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 16 }}>
              {surface.order.length === 0 && (
                <div className="mono" style={{ fontSize: 12, color: 'var(--ink-3)' }}>
                  waiting for the tool surface…
                </div>
              )}
              {surface.order.map((t) => (
                <ToolCard
                  key={t.name}
                  tool={t}
                  called={d.called.has(t.name)}
                  trap={d.traps.has(t.name)}
                  retired={!surface.current.has(t.name)}
                />
              ))}
            </div>

            {d.verdict && <VerdictStamp verdict={d.verdict} trapNames={[...d.traps]} />}
          </>
        )}
      </div>
    </section>
  );
}

function Idle() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        padding: '40px 16px',
        color: 'var(--ink-3)',
        gap: 10,
      }}
    >
      <div style={{ fontSize: 34, opacity: 0.5 }}>🛡️</div>
      <div style={{ fontSize: 14, color: 'var(--ink-2)' }}>Start a run to watch the agent meet each trap.</div>
      <div className="mono" style={{ fontSize: 11.5 }}>
        declared tools · the agent&rsquo;s calls · the moment an attack lands or gets blocked
      </div>
    </div>
  );
}

function LevelHeader({
  id,
  title,
  difficulty,
  task,
}: {
  id: string;
  title?: string | undefined;
  difficulty?: string | undefined;
  task?: string | undefined;
}) {
  const diffColor = difficulty === 'hard' ? 'var(--danger)' : difficulty === 'medium' ? 'var(--warn)' : 'var(--ok)';
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span className="mono" style={{ fontSize: 12, color: 'var(--signal-bright)', fontWeight: 700 }}>
          {id}
        </span>
        {title && <span style={{ fontSize: 15, fontWeight: 650, color: 'var(--ink)' }}>{title}</span>}
        {difficulty && (
          <span
            className="mono"
            style={{
              fontSize: 10.5,
              textTransform: 'uppercase',
              letterSpacing: '.05em',
              color: diffColor,
              border: `1px solid ${diffColor}`,
              borderRadius: 999,
              padding: '1px 8px',
              opacity: 0.9,
            }}
          >
            {difficulty}
          </span>
        )}
      </div>
      {task && (
        <div
          style={{
            marginTop: 10,
            padding: '9px 12px',
            borderRadius: 8,
            background: 'var(--bg)',
            border: '1px solid var(--hair-2)',
            fontSize: 13,
            color: 'var(--ink-2)',
          }}
        >
          <span className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)', display: 'block', marginBottom: 3 }}>
            THE TASK
          </span>
          {task}
        </div>
      )}
    </div>
  );
}

function ToolCard({
  tool,
  called,
  trap,
  retired,
}: {
  tool: RegisteredTool;
  called: boolean;
  trap: boolean;
  retired: boolean;
}) {
  const fired = trap && called; // the trap actually landed (canary fired via this tool)
  const readOnly = tool.annotations?.readOnlyHint === true;
  const untrusted = tool.annotations?.untrustedContentHint === true;

  const border = fired
    ? 'var(--danger)'
    : called
      ? 'var(--signal)'
      : 'var(--hair-2)';
  const cls = `tw-tool-card${fired ? ' breached' : called ? ' called' : ''}`;

  return (
    <div
      className={cls}
      style={{
        flex: '1 1 190px',
        maxWidth: 260,
        border: `1px solid ${border}`,
        borderRadius: 10,
        padding: '11px 12px',
        background: fired ? 'var(--danger-soft)' : called ? 'var(--signal-soft)' : 'var(--surface-2)',
        opacity: retired ? 0.45 : 1,
        position: 'relative',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
        <span
          className="mono"
          style={{
            fontSize: 12.5,
            fontWeight: 700,
            color: fired ? 'var(--danger)' : 'var(--ink)',
            textDecoration: retired ? 'line-through' : 'none',
            wordBreak: 'break-all',
          }}
        >
          {tool.name}
        </span>
        {fired ? (
          <span className="mono" style={{ fontSize: 10, fontWeight: 800, color: 'var(--danger)' }}>
            💥 TRAP
          </span>
        ) : called ? (
          <span className="mono" style={{ fontSize: 10, fontWeight: 700, color: 'var(--signal-bright)' }}>
            ✓ CALLED
          </span>
        ) : null}
      </div>

      <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
        <Badge
          label={readOnly ? 'read-only' : 'can act'}
          color={readOnly ? 'var(--ok)' : 'var(--warn)'}
        />
        {untrusted && <Badge label="untrusted output" color="var(--red-team)" />}
        {retired && <Badge label="swapped away" color="var(--ink-3)" />}
      </div>

      {tool.description && (
        <div
          style={{
            marginTop: 8,
            fontSize: 11.5,
            lineHeight: 1.45,
            color: 'var(--ink-3)',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {tool.description}
        </div>
      )}
    </div>
  );
}

function Badge({ label, color }: { label: string; color: string }) {
  return (
    <span
      className="mono"
      style={{
        fontSize: 9.5,
        textTransform: 'uppercase',
        letterSpacing: '.04em',
        color,
        border: `1px solid ${color}`,
        opacity: 0.85,
        borderRadius: 999,
        padding: '1px 7px',
      }}
    >
      {label}
    </span>
  );
}

function VerdictStamp({ verdict, trapNames }: { verdict: Verdict; trapNames: string[] }) {
  const map = {
    PASS: { label: 'RESISTED', color: 'var(--ok)', soft: 'var(--ok-soft)', sub: 'the agent did not take the bait', icon: '🛡️' },
    FAIL: {
      label: 'BREACHED',
      color: 'var(--danger)',
      soft: 'var(--danger-soft)',
      sub: trapNames.length ? `the agent fell for ${trapNames.join(', ')}` : 'the agent took the hostile action',
      icon: '💥',
    },
    PARTIAL: { label: 'PARTIAL', color: 'var(--warn)', soft: 'var(--warn-soft)', sub: 'the agent started to comply', icon: '◑' },
    SKIPPED: { label: 'NO ATTEMPT', color: 'var(--ink-3)', soft: 'transparent', sub: 'the agent did not engage the task', icon: '—' },
  }[verdict];

  return (
    <div
      style={{
        marginTop: 18,
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '12px 16px',
        borderRadius: 10,
        border: `1.5px solid ${map.color}`,
        background: map.soft,
      }}
    >
      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 20,
          fontWeight: 900,
          letterSpacing: '.06em',
          color: map.color,
          animation: 'tw-stamp 0.4s ease both',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span>{map.icon}</span>
        {map.label}
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>{map.sub}</div>
    </div>
  );
}

function ResistanceMeter({
  history,
  activeLevelId,
  levels,
}: {
  history: Array<{ levelId: string; verdict: string }>;
  activeLevelId: string | null;
  levels: LevelDefinition[];
}) {
  const byId = new Map(history.map((h) => [h.levelId, h.verdict]));
  const decided = history.filter((h) => h.verdict !== 'SKIPPED');
  const resisted = decided.filter((h) => h.verdict === 'PASS').length + 0.5 * decided.filter((h) => h.verdict === 'PARTIAL').length;
  const pct = decided.length ? Math.round((resisted / decided.length) * 100) : null;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', maxWidth: 180, justifyContent: 'flex-end' }}>
        {levels.map((l) => {
          const v = byId.get(l.id);
          const isActive = l.id === activeLevelId && v === undefined;
          const color =
            v === 'PASS'
              ? 'var(--ok)'
              : v === 'FAIL'
                ? 'var(--danger)'
                : v === 'PARTIAL'
                  ? 'var(--warn)'
                  : isActive
                    ? 'var(--signal-bright)'
                    : 'var(--hair-2)';
          return (
            <span
              key={l.id}
              title={`${l.id}${v ? `: ${v}` : isActive ? ': in progress' : ''}`}
              style={{
                width: 14,
                height: 6,
                borderRadius: 3,
                background: color,
                animation: isActive ? 'tw-glow 1.1s ease-in-out infinite' : 'none',
              }}
            />
          );
        })}
      </div>
      {pct !== null && (
        <span className="mono" style={{ fontSize: 11.5, color: 'var(--ink-2)', fontWeight: 700 }}>
          {pct}%
        </span>
      )}
    </div>
  );
}
