// src/ui/pages/ScanPage.tsx
//
// Mode 2, consumer side: paste any URL and get an UNSIGNED preview of its WebMCP
// tool surface. Built for two readers at once: a non-technical person who just
// wants to know "is this safe for my agent?", answered in plain language up top;
// and a developer or agent who wants the exact tools, findings and fingerprint,
// kept in full below. No ownership needed — a scan makes no claim on the site.

import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { scanUrl, type ScanResult, type AuditedTool, type ScanFinding } from '../../data/api.ts';
import { FindingsList, CHECK_LABEL } from '../FindingsList.tsx';

// Keys MUST match the exact error strings the Worker returns (worker/scan.ts,
// worker/browserScan.ts). An unmapped key falls through to the raw string.
const ERR: Record<string, string> = {
  scan_unavailable: 'Scanning is not switched on for this deployment yet.',
  scan_failed: "The browser couldn't finish reading that page. Try again.",
  scan_timeout: 'That page took too long to read. Try again in a moment.',
  nav_failed: "That page couldn't be opened (it may be down or blocking robots).",
  scan_bad_surface: 'That page exposes agent tools, but they were malformed.',
  blocked_host: 'That address is a private or internal host, which cannot be scanned.',
  scan_daily_cap: "Today's scan limit has been reached. Please try again tomorrow.",
  rate_limited: 'Too many scans just now. Give it a minute.',
  'invalid url': 'That does not look like a valid web address (include https://).',
};

const STEPS = ['Opening the page in a real browser', 'Reading the tools it offers agents', 'Checking each tool for red flags'];

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

type Tone = 'ok' | 'warn' | 'bad';

interface Verdict {
  tone: Tone;
  icon: string;
  headline: string;
  summary: string;
  meaning: string;
}

export function verdictOf(result: ScanResult): Verdict {
  const tools = result.toolsDetail ?? [];
  const readOnly = tools.filter((t) => t.readOnly).length;
  const canAct = tools.length - readOnly;
  const flagged = result.findings.filter((f) => f.verdict !== 'PASS');
  const failed = flagged.some((f) => f.verdict === 'FAIL');
  const tone: Tone = failed ? 'bad' : flagged.length > 0 ? 'warn' : 'ok';

  const site = hostOf(result.origin);
  const toolWord = result.tools === 1 ? 'tool' : 'tools';
  const parts = [`${site} offers your agent ${result.tools} ${toolWord}.`];
  if (tools.length) {
    if (canAct === 0) parts.push('All of them only read data; none can change anything.');
    else if (readOnly === 0) parts.push(`${canAct === 1 ? 'It can take an action' : 'They can take actions'}, not just read.`);
    else parts.push(`${readOnly} only read data, ${canAct} can take an action.`);
  }
  parts.push(flagged.length === 0 ? 'We found no red flags.' : `We flagged ${flagged.length} of them for a closer look.`);

  return {
    tone,
    icon: tone === 'bad' ? '⛔' : tone === 'warn' ? '⚠️' : '🛡️',
    headline: tone === 'bad' ? 'Be careful with this site' : tone === 'warn' ? 'Mostly fine, with a couple of things to check' : 'Looks safe for your agent',
    summary: parts.join(' '),
    meaning:
      tone === 'bad'
        ? 'An agent could be manipulated here. Review the red flags below before letting your agent act on this site.'
        : tone === 'warn'
          ? 'An agent can use this site, but should treat the flagged tools with extra care.'
          : 'An agent can use these tools with normal caution.',
  };
}

const TONE_COLOR: Record<Tone, string> = { ok: 'var(--ok)', warn: 'var(--warn)', bad: 'var(--danger)' };
const TONE_SOFT: Record<Tone, string> = { ok: 'var(--ok-soft)', warn: 'var(--warn-soft)', bad: 'var(--danger-soft)' };

/** A concrete, plain-language worst-case for one flagged finding, tied to the
 *  tool it came from. This is the "what could actually go wrong" translation of a
 *  technical check, not fear-mongering: for a clean, read-only site the answer is
 *  honestly reassuring. */
function scenarioFor(check: string, tool: string): string {
  switch (check) {
    case 'T1':
      return `${tool}'s description hides an instruction, so your agent could be talked into an action you never asked for.`;
    case 'T2':
      return `${tool} returns outside content that could carry hidden instructions your agent then follows.`;
    case 'T3':
      return `The tools here can change after your agent inspects them, so what it approved may not be what actually runs.`;
    case 'T5':
      return `${tool} is labelled read-only but can change data, so your agent might act while thinking it was only looking.`;
    case 'T6':
      return `${tool} takes an input that could send your data to another site.`;
    case 'T7':
      return `${tool} claims something was verified; an agent that believes the claim could act on a false assurance.`;
    default:
      return `${tool} raised a flag worth understanding before you let an agent use it.`;
  }
}

/** The "what's the worst that could happen" answer: up to three concrete
 *  scenarios from the flagged findings (worst first), or, if nothing was flagged,
 *  a capability-based line (reassuring when everything is read-only). */
export function worstCase(result: ScanResult): { tone: Tone; lines: string[] } {
  const tools = result.toolsDetail ?? [];
  const flagged = result.findings.filter((f) => f.verdict !== 'PASS');
  const sorted = [...flagged].sort((a, b) => (b.verdict === 'FAIL' ? 1 : 0) - (a.verdict === 'FAIL' ? 1 : 0));

  const seen = new Set<string>();
  const lines: string[] = [];
  for (const f of sorted) {
    const line = scenarioFor(f.check, f.toolName ?? 'A tool');
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
    if (lines.length >= 3) break;
  }

  if (lines.length === 0) {
    const canAct = tools.filter((t) => !t.readOnly);
    if (canAct.length === 0) {
      return {
        tone: 'ok',
        lines: ['Not much. Every tool here only reads data, so even a tricked agent could look but not change or send anything.'],
      };
    }
    const names = canAct.slice(0, 3).map((t) => t.name).join(', ');
    return {
      tone: 'warn',
      lines: [
        `Nothing jumped out, but ${canAct.length} tool${canAct.length === 1 ? '' : 's'} can take an action (${names}). The worst case depends on those being used as intended, so let your agent act deliberately.`,
      ],
    };
  }

  return { tone: flagged.some((f) => f.verdict === 'FAIL') ? 'bad' : 'warn', lines };
}

function ScoreRing({ score, tone }: { score: number; tone: Tone }) {
  const r = 30;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(1, score));
  return (
    <svg width="76" height="76" viewBox="0 0 76 76" style={{ flexShrink: 0 }} aria-hidden>
      <circle cx="38" cy="38" r={r} fill="none" stroke="var(--hair-2)" strokeWidth="7" />
      <circle
        cx="38"
        cy="38"
        r={r}
        fill="none"
        stroke={TONE_COLOR[tone]}
        strokeWidth="7"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - pct)}
        transform="rotate(-90 38 38)"
        style={{ transition: 'stroke-dashoffset .8s ease' }}
      />
      <text x="38" y="42" textAnchor="middle" fontSize="17" fontWeight="800" fill="var(--ink)" fontFamily="var(--mono)">
        {Math.round(pct * 100)}
      </text>
    </svg>
  );
}

function ToolCard({ tool, findings }: { tool: AuditedTool; findings: ScanFinding[] }) {
  const flags = findings.filter((f) => f.toolName === tool.name && f.verdict !== 'PASS');
  const worst = flags.some((f) => f.verdict === 'FAIL') ? 'bad' : flags.length > 0 ? 'warn' : 'ok';
  const border = worst === 'bad' ? 'var(--danger)' : worst === 'warn' ? 'var(--warn)' : 'var(--hair-2)';

  return (
    <div style={{ border: `1px solid ${border}`, borderRadius: 10, padding: '13px 14px', background: 'var(--surface-2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <span className="mono" style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)', wordBreak: 'break-all' }}>
          {tool.name}
        </span>
        <span style={{ display: 'inline-flex', gap: 6 }}>
          <Tag label={tool.readOnly ? 'reads data' : 'can act'} color={tool.readOnly ? 'var(--ok)' : 'var(--warn)'} />
          {tool.untrusted && <Tag label="untrusted output" color="var(--red-team)" />}
        </span>
      </div>

      {tool.description && (
        <p style={{ margin: '9px 0 0', fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.5 }}>{tool.description}</p>
      )}

      <p style={{ margin: '9px 0 0', fontSize: 12, color: 'var(--ink-3)', lineHeight: 1.5 }}>
        {tool.readOnly
          ? 'An agent can look this up without changing anything.'
          : 'An agent can use this to take an action, so it should do so deliberately.'}
      </p>

      {(tool.params?.length ?? 0) > 0 && (
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 10 }}>
          <span className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)' }}>inputs:</span>
          {(tool.params ?? []).slice(0, 12).map((p) => (
            <span key={p} className="mono" style={{ fontSize: 10.5, color: 'var(--ink-2)', background: 'var(--bg)', border: '1px solid var(--hair-2)', borderRadius: 6, padding: '1px 6px' }}>
              {p}
            </span>
          ))}
        </div>
      )}

      {flags.map((f, i) => (
        <p
          key={`${f.check}-${i}`}
          style={{
            margin: '10px 0 0',
            fontSize: 12,
            lineHeight: 1.5,
            color: worst === 'bad' ? 'var(--danger)' : 'var(--warn)',
            background: TONE_SOFT[worst as Tone],
            border: `1px solid ${border}`,
            borderRadius: 8,
            padding: '7px 10px',
          }}
        >
          <b>{f.verdict === 'FAIL' ? '⚠ Red flag: ' : 'Worth a look: '}</b>
          {CHECK_LABEL[f.check] ?? f.check}
          {f.evidence ? ` — ${f.evidence}` : ''}
        </p>
      ))}
    </div>
  );
}

function WorstCase({ result }: { result: ScanResult }) {
  const { tone, lines } = worstCase(result);
  const color = TONE_COLOR[tone];
  return (
    <div className="card" style={{ borderColor: color }}>
      <div className="card-head" style={{ marginBottom: 12 }}>
        <span className="card-title">What&rsquo;s the worst that could happen?</span>
        <span aria-hidden style={{ fontSize: 16 }}>
          {tone === 'ok' ? '🙂' : tone === 'warn' ? '🤔' : '😬'}
        </span>
      </div>
      <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {lines.map((l, i) => (
          <li key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <span style={{ color, marginTop: 2, flexShrink: 0 }}>{tone === 'ok' ? '✓' : '•'}</span>
            <span style={{ fontSize: 13.5, color: 'var(--ink)', lineHeight: 1.55 }}>{l}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Tag({ label, color }: { label: string; color: string }) {
  return (
    <span
      className="mono"
      style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.04em', color, border: `1px solid ${color}`, opacity: 0.9, borderRadius: 999, padding: '1px 8px' }}
    >
      {label}
    </span>
  );
}

export function ScanPage() {
  const [params] = useSearchParams();
  const [url, setUrl] = useState(params.get('url') ?? '');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(0);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showTech, setShowTech] = useState(false);

  // Advance the loading steps so "opening a browser" feels real. Caps at the last
  // step until the scan actually returns.
  useEffect(() => {
    if (!busy) return;
    setStep(0);
    const id = setInterval(() => setStep((s) => Math.min(s + 1, STEPS.length - 1)), 1400);
    return () => clearInterval(id);
  }, [busy]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setShowTech(false);
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const { ok, data } = await scanUrl(withScheme);
    setBusy(false);
    if (!ok || !data) {
      setError(ERR[data?.error ?? 'scan_failed'] ?? data?.error ?? ERR.scan_failed!);
      return;
    }
    setResult(data);
  };

  return (
    <div className="page console page-narrow">
      <div className="cx-head">
        <p className="cx-kick">Mode 2 · scan a site</p>
        <h1 className="cx-title">Is this site safe for your agent?</h1>
        <p className="cx-sub">
          Paste a web address. Trustwright opens it in a real browser, reads the tools it hands to AI agents, and tells
          you in plain language what they can do. A look, not a certificate. A signed badge needs the owner (
          <Link to="/badge">get a badge</Link>).
        </p>
      </div>

      <form onSubmit={submit} className="row" style={{ marginBottom: 8 }}>
        <input
          className="field"
          style={{ flex: '1 1 420px' }}
          placeholder="https://example.com"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          inputMode="url"
          autoCapitalize="none"
          spellCheck={false}
        />
        <button className="btn btn-primary" type="submit" disabled={busy || !url.trim()}>
          {busy ? 'Scanning…' : 'Scan'}
        </button>
      </form>
      <p className="muted-3" style={{ fontSize: 12.5, marginTop: 0 }}>
        Try the demo surface:{' '}
        <button
          type="button"
          className="linklike"
          onClick={() => setUrl(`${location.origin}/demo-webmcp`)}
          style={{ background: 'none', border: 0, color: 'var(--signal-bright)', cursor: 'pointer', padding: 0, font: 'inherit' }}
        >
          {location.origin}/demo-webmcp
        </button>
      </p>

      {busy && (
        <div className="card" style={{ marginTop: 18 }}>
          {STEPS.map((label, i) => (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 2px', opacity: i <= step ? 1 : 0.4 }}>
              {i < step ? (
                <span style={{ color: 'var(--ok)', fontWeight: 700 }}>✓</span>
              ) : i === step ? (
                <span className="spin" style={{ width: 14, height: 14 }} />
              ) : (
                <span style={{ width: 14, height: 14, borderRadius: 999, border: '1px solid var(--hair-2)', display: 'inline-block' }} />
              )}
              <span style={{ fontSize: 13.5, color: i <= step ? 'var(--ink)' : 'var(--ink-3)' }}>{label}</span>
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="notice bad" style={{ marginTop: 18 }}>
          {error}
        </div>
      )}

      {result && !busy && (
        <div style={{ marginTop: 24, display: 'flex', flexDirection: 'column', gap: 18 }}>
          {result.host === 'none' || result.tools === 0 ? (
            <div className="card">
              <div className="scan-verdict warn">
                <p className="sv-line">No agent tools found.</p>
                <p className="sv-sub">{hostOf(result.origin)} · nothing an outside visitor can read</p>
                <p className="muted" style={{ margin: '16px auto 0', maxWidth: '52ch', fontSize: 14.5 }}>
                  Either this site hands no tools to AI agents, or it only exposes them inside a native agent host
                  (ChatGPT&apos;s browser, flagged Chrome), where an external scan cannot see them. Nothing to worry
                  about either way.
                </p>
              </div>
            </div>
          ) : (
            <ScanResultView result={result} showTech={showTech} onToggleTech={() => setShowTech((v) => !v)} />
          )}
        </div>
      )}
    </div>
  );
}

function ScanResultView({ result, showTech, onToggleTech }: { result: ScanResult; showTech: boolean; onToggleTech: () => void }) {
  const v = verdictOf(result);
  const tools = result.toolsDetail ?? [];

  return (
    <>
      {/* Plain-language verdict */}
      <div className="card" style={{ borderColor: TONE_COLOR[v.tone] }}>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 76,
              height: 76,
              borderRadius: 16,
              background: TONE_SOFT[v.tone],
              fontSize: 34,
              flexShrink: 0,
            }}
          >
            {v.icon}
          </div>
          <div style={{ flex: '1 1 260px' }}>
            <div style={{ fontSize: 19, fontWeight: 750, color: TONE_COLOR[v.tone] }}>{v.headline}</div>
            <p style={{ margin: '6px 0 0', fontSize: 14, color: 'var(--ink)', lineHeight: 1.5 }}>{v.summary}</p>
          </div>
          {result.assuranceScore != null && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
              <ScoreRing score={result.assuranceScore} tone={v.tone} />
              <span className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)' }}>% clean</span>
            </div>
          )}
        </div>
        <p style={{ margin: '14px 0 0', fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.5, borderTop: '1px solid var(--hair)', paddingTop: 12 }}>
          <b>What this means: </b>
          {v.meaning}
        </p>
      </div>

      {/* What's the worst that could happen */}
      <WorstCase result={result} />

      {/* The tools, visualized */}
      {tools.length > 0 && (
        <div className="card">
          <div className="card-head">
            <span className="card-title">What an agent can do here</span>
            <span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>
              {tools.length} tool{tools.length === 1 ? '' : 's'}
            </span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12, marginTop: 4 }}>
            {tools.map((t) => (
              <ToolCard key={t.name} tool={t} findings={result.findings} />
            ))}
          </div>
        </div>
      )}

      {/* Technical details, for developers and agents */}
      <div className="card">
        <div
          className="card-head"
          style={{ cursor: 'pointer', marginBottom: showTech ? undefined : 0 }}
          role="button"
          tabIndex={0}
          onClick={onToggleTech}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onToggleTech()}
        >
          <span className="card-title">Technical details</span>
          <span className="mono" style={{ fontSize: 11, color: 'var(--signal-bright)' }}>{showTech ? 'hide' : 'for developers and agents'}</span>
        </div>
        {showTech && (
          <div style={{ marginTop: 6 }}>
            <FindingsList findings={result.findings} />
            <div className="rep-row" style={{ marginTop: 14 }}>
              <span className="rep-k">Host</span>
              <span className="rep-v mono">{result.host}</span>
            </div>
            {result.fingerprint && (
              <div className="rep-row">
                <span className="rep-k">Fingerprint</span>
                <span className="rep-v mono" style={{ wordBreak: 'break-all' }}>{result.fingerprint}</span>
              </div>
            )}
            <div className="rep-row">
              <span className="rep-k">Signed</span>
              <span className="rep-v mono">no (a scan is an unsigned preview)</span>
            </div>
            <div className="rep-row">
              <span className="rep-k">Scanned</span>
              <span className="rep-v mono">{new Date(result.scannedAt).toLocaleString()}</span>
            </div>
            <p className="notice" style={{ marginTop: 14, fontSize: 12.5 }}>{result.note}</p>
          </div>
        )}
      </div>
    </>
  );
}
