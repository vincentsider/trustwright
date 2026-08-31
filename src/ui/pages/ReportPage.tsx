// src/ui/pages/ReportPage.tsx
//
// The human-readable audit BEHIND a badge — what the badge links to. Given
// ?origin=, it shows exactly what Trustwright checked and signed: the verdict,
// the scope, the findings, the assurance score, the audited fingerprint + tool
// count, and everything needed to verify the Ed25519 seal independently. Works
// for ANY badged site (the badge on every site points here), because it reads
// the signed record from /api/report, not a live re-scan.

import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { getReport, type BadgeReport } from '../../data/api.ts';
import { FindingsList } from '../FindingsList.tsx';

type Tone = 'ok' | 'warn' | 'bad' | 'neutral';

function verdict(r: BadgeReport): { label: string; tone: Tone; blurb: string } {
  switch (r.state) {
    case 'active':
      return r.flagged
        ? { label: 'Tools flagged', tone: 'warn', blurb: 'Audited, but a tool raised a red flag. Read the findings below.' }
        : { label: 'Tools verified', tone: 'ok', blurb: 'Trustwright audited the tools this site exposes to AI agents and signed the result.' };
    case 'revoked':
      return { label: 'Badge revoked', tone: 'bad', blurb: 'This badge was withdrawn and no longer applies.' };
    case 'expired':
      return { label: 'Badge expired', tone: 'warn', blurb: 'This audit has lapsed and needs re-issuing.' };
    case 'unverified':
      return { label: 'Not verified', tone: 'neutral', blurb: 'No one has proven control of this origin to Trustwright.' };
    default:
      return { label: 'Not audited', tone: 'neutral', blurb: 'Trustwright has no audit on record for this site.' };
  }
}

function day(iso?: string | null): string {
  return iso ? new Date(iso).toISOString().slice(0, 10) : 'n/a';
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rep-row">
      <span className="rep-k">{label}</span>
      <span className="rep-v">{children}</span>
    </div>
  );
}

export function ReportPage() {
  const [params] = useSearchParams();
  const origin = params.get('origin') ?? '';
  const [report, setReport] = useState<BadgeReport | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    if (!origin) {
      setBusy(false);
      setError('No site given. Add ?origin=https://example.com to the address.');
      return;
    }
    setBusy(true);
    setError(null);
    getReport(origin).then((r) => {
      if (!live) return;
      setBusy(false);
      if (!r) setError('Could not load this report. Try again in a moment.');
      else setReport(r);
    });
    return () => {
      live = false;
    };
  }, [origin]);

  const v = report ? verdict(report) : null;
  const score = report?.assuranceScore == null ? null : Math.round(report.assuranceScore * 100);
  const findings = report?.findings ?? [];
  const flaggedCount = findings.filter((f) => f.verdict !== 'PASS').length;
  const apiBase = location.origin;

  return (
    <div className="page console page-narrow">
      <div className="cx-head">
        <p className="cx-kick">Trustwright · audit report</p>
        <h1 className="cx-title">What Trustwright checked</h1>
        {origin && (
          <p className="cx-sub" style={{ wordBreak: 'break-all' }}>
            {origin}
          </p>
        )}
      </div>

      {busy && (
        <div className="notice" style={{ marginTop: 18 }}>
          <span className="spin" style={{ marginRight: 8, verticalAlign: 'middle' }} />
          Loading the signed audit…
        </div>
      )}

      {error && !busy && (
        <div className="notice bad" style={{ marginTop: 18 }}>
          {error}
        </div>
      )}

      {report && v && !busy && (
        <>
          <div className="card" style={{ marginTop: 20 }}>
            <div className={`scan-verdict ${v.tone}`}>
              <p className="sv-line">{v.label}</p>
              <p className="sv-sub">
                {report.state === 'active' && score != null ? `${score}% clean` : report.state}
                {report.state === 'active' && report.toolCount != null
                  ? ` · ${report.toolCount} tool${report.toolCount === 1 ? '' : 's'} audited`
                  : ''}
                {report.signedAt ? ` · audited ${day(report.signedAt)}` : ''}
              </p>
            </div>
            <p className="muted" style={{ margin: '18px auto 0', maxWidth: '58ch', fontSize: 14.5, textAlign: 'center' }}>
              {v.blurb}
            </p>
          </div>

          {report.scope && (
            <div className="card" style={{ marginTop: 18 }}>
              <h2 className="rep-h">Scope of this audit</h2>
              <p className="muted" style={{ fontSize: 14, lineHeight: 1.6 }}>{report.scope}</p>
            </div>
          )}

          {report.state === 'active' && (report.tools?.length ?? 0) > 0 && (
            <div className="card" style={{ marginTop: 18 }}>
              <h2 className="rep-h">
                Tools this site exposes to agents{' '}
                <span className="muted-3" style={{ fontWeight: 400, fontSize: 13 }}>{report.tools!.length} audited</span>
              </h2>
              <ul className="tool-list">
                {report.tools!.map((t) => (
                  <li key={t.name} className="tool-item">
                    <div className="tool-head">
                      <code className="tool-name">{t.name}</code>
                      {t.readOnly && <span className="tool-tag ok">read-only</span>}
                      {!t.readOnly && <span className="tool-tag warn">can change state</span>}
                      {t.untrusted && <span className="tool-tag">returns untrusted content</span>}
                    </div>
                    {t.description && <p className="tool-desc">{t.description}</p>}
                    {t.params && t.params.length > 0 && (
                      <p className="tool-params">
                        params: <code>{t.params.join(', ')}</code>
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {report.state === 'active' && (
            <div className="card" style={{ marginTop: 18 }}>
              <h2 className="rep-h">
                Findings{' '}
                <span className="muted-3" style={{ fontWeight: 400, fontSize: 13 }}>
                  {findings.length} check{findings.length === 1 ? '' : 's'}
                  {flaggedCount > 0 ? ` · ${flaggedCount} worth a look` : ' · nothing flagged'}
                </span>
              </h2>
              {findings.length > 0 ? (
                <FindingsList findings={findings} />
              ) : (
                <p className="muted" style={{ fontSize: 14 }}>No red flags were recorded in this audit.</p>
              )}
            </div>
          )}

          <div className="card" style={{ marginTop: 18 }}>
            <h2 className="rep-h">Verify this yourself</h2>
            <p className="muted" style={{ fontSize: 13.5, marginTop: 0 }}>
              The report is signed with Ed25519. Anyone can re-derive the fingerprint from the site&apos;s tools and check
              the signature against Trustwright&apos;s public key. No trust in this page required.
            </p>
            {report.fingerprint && <Row label="Audited fingerprint"><code className="rep-code">{report.fingerprint}</code></Row>}
            {report.fingerprintAlgo && <Row label="Algorithm"><code className="rep-code">{report.fingerprintAlgo}</code></Row>}
            {report.reportSha256 && <Row label="Report SHA-256"><code className="rep-code">{report.reportSha256}</code></Row>}
            {report.signature && <Row label="Signature"><code className="rep-code">{report.signature}</code></Row>}
            {report.keyId && (
              <Row label="Signing key">
                <code className="rep-code">{report.keyId}</code> ·{' '}
                <a href={`${apiBase}/api/pubkey`} target="_blank" rel="noopener noreferrer">public key</a>
              </Row>
            )}
            {report.expiresAt && <Row label="Valid until">{day(report.expiresAt)}</Row>}
          </div>

          <div className="rep-links">
            <a href={`${apiBase}/api/report?origin=${encodeURIComponent(origin)}`} target="_blank" rel="noopener noreferrer">
              raw JSON
            </a>
            <span aria-hidden="true">·</span>
            <Link to={`/scan?url=${encodeURIComponent(origin)}`}>re-scan live</Link>
            <span aria-hidden="true">·</span>
            <a href={origin} target="_blank" rel="noopener noreferrer">visit site</a>
          </div>
        </>
      )}
    </div>
  );
}
