// src/ui/pages/AuditWizard.tsx
//
// Mode 2, publisher side: the guided, no-code path for a site operator to earn a
// live badge. Three steps mirror the honest trust model:
//   1. Prove domain ownership (well-known file OR DNS TXT; Trustwright fetches it).
//   2. Trustwright scans the site itself, re-derives, and signs the badge.
//   3. Copy one line to display the live, self-verifying badge.
// Each step unlocks only when the prior one genuinely succeeds server-side.

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { requestVerification, confirmVerification, createBadge, type VerifyInstructions } from '../../data/api.ts';
import { CodeBlock } from '../CodeBlock.tsx';
import { FindingsList } from '../FindingsList.tsx';
import type { ScanFinding } from '../../data/api.ts';

function parseTarget(input: string): { origin: string; url: string } | null {
  const raw = input.trim();
  if (!raw) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return { origin: u.origin, url: u.toString() };
  } catch {
    return null;
  }
}

type BadgeDone = { origin: string; expiresAt: string; findings: ScanFinding[]; fingerprint?: string };

export function AuditWizard() {
  const apiBase = location.origin;
  const [siteInput, setSiteInput] = useState('');
  const target = useMemo(() => parseTarget(siteInput), [siteInput]);

  const [token, setToken] = useState<string | null>(null);
  const [instructions, setInstructions] = useState<VerifyInstructions | null>(null);
  const [verified, setVerified] = useState<string | null>(null); // the verified origin
  const [badge, setBadge] = useState<BadgeDone | null>(null);

  const [busy, setBusy] = useState<'' | 'req' | 'confirm' | 'mint'>('');
  const [note, setNote] = useState<{ kind: 'warn' | 'bad' | 'ok'; text: string } | null>(null);

  const getCode = async () => {
    if (!target) return;
    setBusy('req');
    setNote(null);
    const { ok, data } = await requestVerification(target.origin);
    setBusy('');
    if (!ok || !data?.token) {
      setNote({ kind: 'bad', text: data?.error ?? 'Could not start verification. Check the address and try again.' });
      return;
    }
    setToken(data.token);
    setInstructions(data.instructions);
  };

  const check = async () => {
    if (!target) return;
    setBusy('confirm');
    setNote(null);
    const { status, data } = await confirmVerification(target.origin);
    setBusy('');
    if (data?.verified) {
      setVerified(target.origin);
      setNote({ kind: 'ok', text: `Ownership of ${target.origin} confirmed. Continue to step 2.` });
    } else if (status === 0) {
      setNote({ kind: 'bad', text: 'Could not reach Trustwright. Check your connection and try again.' });
    } else {
      setNote({
        kind: 'warn',
        text: `Not verified yet. We couldn't find the code at ${target.origin}. Publish it exactly (the file at ${instructions?.wellKnown.path ?? '/.well-known/trustwright-challenge.txt'}, OR the ${instructions?.dns.record ?? '_trustwright'} DNS TXT record), give DNS a minute to propagate, then check again.`,
      });
    }
  };

  const mint = async () => {
    if (!target) return;
    setBusy('mint');
    setNote(null);
    const { ok, status, data } = await createBadge(target.url);
    setBusy('');
    if (ok && data?.origin) {
      const fp = data.report?.fingerprint;
      setBadge({
        origin: data.origin,
        expiresAt: data.expiresAt,
        findings: data.report?.findings ?? [],
        ...(fp ? { fingerprint: fp } : {}),
      });
      return;
    }
    const msg =
      status === 422
        ? "Trustwright opened your page but found no agent tools an outside visitor can see. Make sure your WebMCP tools register on page load (external script, not blocked by your CSP)."
        : status === 403
          ? 'That origin is not verified yet. Finish step 1 first.'
          : data?.error ?? 'The scan could not complete. Try again in a moment.';
    setNote({ kind: 'bad', text: msg });
  };

  const step1Done = !!verified;
  const step2Done = !!badge;
  const embed =
    `<script src="${apiBase}/badge.js"\n        data-origin="${verified ?? 'https://your-site.com'}"></script>`;

  return (
    <div className="page console page-narrow">
      <div className="cx-head">
        <p className="cx-kick">Mode 2 · get a badge</p>
        <h1 className="cx-title">Earn your Trustwright badge.</h1>
        <p className="cx-sub">
          Three steps, no code beyond pasting one line at the end. Trustwright reads your tools itself and signs the
          result, so you can&apos;t fake a pass, and neither can we.
        </p>
      </div>

      {/* Site address */}
      <div className="card" style={{ marginBottom: 20 }}>
        <label className="card-title" htmlFor="site" style={{ display: 'block', marginBottom: 8 }}>
          Your site address
        </label>
        <input
          id="site"
          className="field"
          placeholder="https://your-site.com"
          value={siteInput}
          onChange={(e) => {
            setSiteInput(e.target.value);
            // Editing the address resets the flow.
            setToken(null);
            setInstructions(null);
            setVerified(null);
            setBadge(null);
            setNote(null);
          }}
          inputMode="url"
          autoCapitalize="none"
          spellCheck={false}
          disabled={busy !== ''}
        />
        <p className="muted-3" style={{ fontSize: 12.5, margin: '8px 0 0' }}>
          The page that offers your agent tools. We derive your domain from it.
          {target && <> Domain: <span className="mono" style={{ color: 'var(--ink-2)' }}>{target.origin}</span></>}
        </p>
        {siteInput.trim() !== '' && !target && (
          <p style={{ fontSize: 12.5, margin: '6px 0 0', color: '#ffb3ba' }}>
            That doesn&apos;t look like a valid web address. Use the form{' '}
            <span className="mono">https://your-site.com</span> (check for typos like a double colon
            <span className="mono"> :// </span>).
          </p>
        )}
      </div>

      <div className="steps">
        {/* Step 1: ownership */}
        <div className={`step ${step1Done ? 'done' : target ? 'active' : 'locked'}`}>
          <div className="stepnum">{step1Done ? '✓' : '1'}</div>
          <div className="step-body">
            <h3>Prove you own the domain</h3>
            {!step1Done && (
              <>
                <p className="muted" style={{ marginTop: 0 }}>
                  We give you a one-time code. Publish it either way below, then let Trustwright fetch it.
                </p>
                {!token ? (
                  <button className="btn btn-primary" onClick={getCode} disabled={!target || busy !== ''}>
                    {busy === 'req' ? 'Getting your code…' : 'Get my verification code'}
                  </button>
                ) : (
                  instructions && (
                    <div>
                      <p className="muted" style={{ marginBottom: 4 }}>
                        <strong>Option A, a file.</strong> Serve this exact text at{' '}
                        <span className="mono" style={{ fontSize: 12 }}>{instructions.wellKnown.path}</span>:
                      </p>
                      <CodeBlock code={instructions.wellKnown.content} label="verification token" />
                      <p className="muted" style={{ margin: '10px 0 4px' }}>
                        <strong>Option B, a DNS record.</strong> Add a TXT record{' '}
                        <span className="mono" style={{ fontSize: 12 }}>{instructions.dns.record}</span> with value:
                      </p>
                      <CodeBlock code={instructions.dns.value} label="DNS TXT value" />
                      <div className="row" style={{ marginTop: 12 }}>
                        <button className="btn btn-primary" onClick={check} disabled={busy !== ''}>
                          {busy === 'confirm' ? 'Checking…' : "I've published it, check now"}
                        </button>
                      </div>
                    </div>
                  )
                )}
                {/* Feedback for get-code / check, shown right here at the button
                    (not far down the page) so the user always sees what happened. */}
                {note && (
                  <div className={`notice ${note.kind}`} style={{ marginTop: 14 }}>
                    {note.text}
                  </div>
                )}
              </>
            )}
            {step1Done && (
              <p className="muted" style={{ margin: 0, color: 'var(--ok)' }}>
                Verified: <span className="mono">{verified}</span>
              </p>
            )}
          </div>
        </div>

        {/* Step 2: scan + sign */}
        <div className={`step ${step2Done ? 'done' : step1Done ? 'active' : 'locked'}`}>
          <div className="stepnum">{step2Done ? '✓' : '2'}</div>
          <div className="step-body">
            <h3>Let Trustwright check your tools</h3>
            {!step2Done && (
              <>
                <p className="muted" style={{ marginTop: 0 }}>
                  Trustwright opens your page in a real browser, reads your agent tools, analyses them, and signs
                  the report. This mints your badge.
                </p>
                <button className="btn btn-primary" onClick={mint} disabled={!step1Done || busy !== ''}>
                  {busy === 'mint' ? 'Scanning & signing…' : 'Scan my site & create my badge'}
                </button>
              </>
            )}
            {step2Done && badge && (
              <div>
                <p className="muted" style={{ marginTop: 0, color: 'var(--ok)' }}>
                  Badge minted for <span className="mono">{badge.origin}</span> · valid until{' '}
                  {new Date(badge.expiresAt).toLocaleDateString()}.
                </p>
                <FindingsList findings={badge.findings} />
              </div>
            )}
          </div>
        </div>

        {/* Step 3: embed */}
        <div className={`step ${step2Done ? 'active' : 'locked'}`}>
          <div className="stepnum">3</div>
          <div className="step-body">
            <h3>Display your badge</h3>
            <p className="muted" style={{ marginTop: 0 }}>
              Paste this line into your page's HTML (anywhere you want the badge to appear). It re-checks your
              live tools on every load, so it always tells the truth.
            </p>
            <CodeBlock code={embed} label="badge embed" />
            <p className="muted-3" style={{ fontSize: 12.5 }}>
              Want dark mode or a compact size? See <Link to="/embed">badge options & live preview</Link>.
            </p>
          </div>
        </div>
      </div>

      {/* Once ownership is proven, step 1's inline note is gone; show mint-step
          feedback here (avoids showing the same note twice). */}
      {note && step1Done && (
        <div className={`notice ${note.kind}`} style={{ marginTop: 18 }}>
          {note.text}
        </div>
      )}
    </div>
  );
}
