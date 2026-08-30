// src/ui/pages/ScanPage.tsx
//
// Mode 2, consumer side: paste any URL and get an UNSIGNED preview of its WebMCP
// tool surface + red flags. This is the "an agent (or you) checks a site" path —
// no ownership needed, because it makes no claim on the site's behalf.

import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { scanUrl, type ScanResult } from '../../data/api.ts';
import { FindingsList } from '../FindingsList.tsx';

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
  rate_limited: 'Too many scans just now — give it a minute.',
  'invalid url': 'That does not look like a valid web address (include https://).',
};

export function ScanPage() {
  const [params] = useSearchParams();
  const [url, setUrl] = useState(params.get('url') ?? '');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
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
        <h1 className="cx-title">Scan any site&apos;s agent tools.</h1>
        <p className="cx-sub">
          Paste a web address. Trustwright opens it in a real browser, reads the tools it hands to AI agents, and shows
          you what they really say. A look, not a certificate — a signed badge needs the owner (
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
        <div className="notice" style={{ marginTop: 18 }}>
          <span className="spin" style={{ marginRight: 8, verticalAlign: 'middle' }} />
          Opening the page in a browser and reading its tools — this can take a few seconds.
        </div>
      )}

      {error && (
        <div className="notice bad" style={{ marginTop: 18 }}>
          {error}
        </div>
      )}

      {result && !busy && (
        <div className="card" style={{ marginTop: 24 }}>
          {result.host === 'none' ? (
            <div className="scan-verdict warn">
              <p className="sv-line">No agent tools found.</p>
              <p className="sv-sub">{result.origin} · nothing an outside visitor can read</p>
              <p className="muted" style={{ margin: '16px auto 0', maxWidth: '52ch', fontSize: 14.5 }}>
                Some sites only expose their tools inside a native agent host (ChatGPT&apos;s browser, flagged
                Chrome), where an external scan cannot see them.
              </p>
            </div>
          ) : (
            (() => {
              const flagged = result.findings.filter((f) => f.verdict !== 'PASS').length;
              const failed = result.findings.some((f) => f.verdict === 'FAIL');
              const tone = failed ? 'bad' : flagged > 0 ? 'warn' : 'ok';
              return (
                <div>
                  <div className={`scan-verdict ${tone}`}>
                    <p className="sv-line">
                      {flagged === 0
                        ? 'No red flags.'
                        : `${flagged} thing${flagged === 1 ? '' : 's'} worth a look.`}
                    </p>
                    <p className="sv-sub">
                      {result.origin} · {result.tools} tool{result.tools === 1 ? '' : 's'} read · host {result.host}
                    </p>
                  </div>
                  <FindingsList findings={result.findings} />
                  {result.fingerprint && <p className="fp-row">fingerprint {result.fingerprint}</p>}
                  <p className="notice" style={{ marginTop: 16, fontSize: 12.5 }}>{result.note}</p>
                </div>
              );
            })()
          )}
        </div>
      )}
    </div>
  );
}
