// worker/monitor.ts
//
// Server-side badge-health monitor (migration 0010).
//
// A live badge can silently flip to "tools changed" the moment a site's WebMCP
// surface drifts from what was sealed — and today the FIRST party to notice is a
// random visitor whose agent reads the page. That is exactly what happened to
// trustwright.deepblocker.ai's own badge. This job closes that gap: on a daily
// cadence it re-scans each active badge's origin, compares the LIVE surface to
// the sealed one with the SAME subset rule the on-page badge uses
// (decideBadgeLive), records the result on the audit row, and emails the
// operator the moment a badge transitions into drift, recovers, or enters its
// expiry window — so the owner hears it from us, not from a customer.
//
// Two safety rails, mirroring the ownership re-check:
//   1. A momentarily unreachable origin (scan error, or a host that is simply
//      absent right now) is NEVER treated as drift — we only flip on a surface we
//      definitively read that is missing/altering a SEALED tool.
//   2. Alerts fire on TRANSITIONS only (drift begins, drift clears, expiry window
//      entered), computed against the previously-stored state, so a persistent
//      condition does not re-email every single day.

import type { Env } from './types.ts';
import { jsonPublic } from './http.ts';
import { checkRate, clientIp } from './limits.ts';
import {
  getActiveAuditsForMonitor,
  updateAuditHealth,
  type MonitorAuditRow,
} from './audits.ts';
import { scanWithBrowser } from './browserScan.ts';
import { validateTools } from './badge.ts';
import { fingerprintSurface, toolFingerprints } from '../src/range/fingerprint.ts';
import { sendBadgeAlertEmail, isAlertConfigured } from './email.ts';

import { constantTimeEqual } from './crypto.ts';

const DEFAULT_BATCH = 50;
const DEFAULT_WARN_DAYS = 7;
const CONCURRENCY = 3; // each check spends a paid browser session — keep it gentle
const DAY_MS = 86_400_000;

export type CheckOutcome = 'ok' | 'drift' | 'unreachable' | 'error';

export interface MonitorSummary {
  checked: number;
  ok: number;
  drift: number; // still/again drifted after this run
  newDrift: number; // transitioned INTO drift this run (alert-worthy)
  recovered: number; // transitioned OUT of drift this run
  expiringSoon: number; // entered the expiry-warning window this run
  unreachable: number; // could not read a surface (never flips drift)
  errors: number;
  alerts: string[]; // human-readable lines that were emailed (if configured)
  emailed: boolean; // an alert email was actually accepted by Postmark
  skipped?: string; // set when the whole run was a no-op (e.g. no BROWSER binding)
}

function batchSize(env: Env): number {
  const n = Number(env.MONITOR_BATCH ?? String(DEFAULT_BATCH));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 200) : DEFAULT_BATCH;
}

function warnDays(env: Env): number {
  const n = Number(env.MONITOR_EXPIRY_WARN_DAYS ?? String(DEFAULT_WARN_DAYS));
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_WARN_DAYS;
}

/**
 * Compare a freshly-scanned surface to the sealed one, using the same rule as
 * the on-page badge (src/badge/decide.ts): drift means a SEALED tool is gone or
 * altered. An added tool (a legitimately dynamic surface) is NOT drift. Pre-0007
 * audits with no per-tool hashes fall back to an exact aggregate match.
 */
export function isDrift(
  sealed: { fingerprint: string; toolFingerprints: string[] | null },
  live: { fingerprint: string; toolFingerprints: string[] },
): boolean {
  if (live.fingerprint === sealed.fingerprint) return false; // exact match, no drift
  if (!sealed.toolFingerprints || sealed.toolFingerprints.length === 0) {
    // No per-tool hashes to fall back on: only an exact aggregate match is clean.
    return true;
  }
  const liveSet = new Set(live.toolFingerprints);
  const sealedPresent = sealed.toolFingerprints.every((h) => liveSet.has(h));
  // Every audited tool still present (extras tolerated) => not drift.
  return !sealedPresent;
}

/** Re-scan ONE origin and classify it. Returns the outcome plus the live
 *  fingerprint (when a surface was read). Never throws. */
async function checkOne(env: Env, row: MonitorAuditRow): Promise<{ outcome: CheckOutcome; liveFingerprint: string | null }> {
  let scan;
  try {
    scan = await scanWithBrowser(env, row.origin);
  } catch {
    return { outcome: 'error', liveFingerprint: null };
  }
  // A scan error, no host, or an empty surface is "could not verify" — NOT drift.
  // (The on-page badge shows the signed state when it cannot read live tools.)
  if (scan.host === 'error' || scan.host === 'none' || scan.tools.length === 0) {
    return { outcome: 'unreachable', liveFingerprint: null };
  }
  const tools = validateTools(scan.tools);
  if (!tools) return { outcome: 'unreachable', liveFingerprint: null };

  let liveFingerprint: string;
  let liveToolFps: string[];
  try {
    liveFingerprint = await fingerprintSurface(tools);
    liveToolFps = await toolFingerprints(tools);
  } catch {
    return { outcome: 'error', liveFingerprint: null };
  }
  const drift = isDrift(
    { fingerprint: row.fingerprint, toolFingerprints: row.tool_fingerprints },
    { fingerprint: liveFingerprint, toolFingerprints: liveToolFps },
  );
  return { outcome: drift ? 'drift' : 'ok', liveFingerprint };
}

/** Days-until-expiry as a whole number, or null if no/invalid expiry. */
function daysUntil(expiresAt: string | null, nowMs: number): number | null {
  if (!expiresAt) return null;
  const t = Date.parse(expiresAt);
  if (!Number.isFinite(t)) return null;
  return Math.ceil((t - nowMs) / DAY_MS);
}

/**
 * Re-scan a batch of active badges, record health, and email the operator on any
 * state transition. `nowMs` is injectable for deterministic tests. Pure
 * orchestration over the data-access + scan helpers so it unit-tests with a
 * mocked Env.
 */
export async function runBadgeMonitor(env: Env, nowMs: number = Date.now()): Promise<MonitorSummary> {
  const summary: MonitorSummary = {
    checked: 0, ok: 0, drift: 0, newDrift: 0, recovered: 0,
    expiringSoon: 0, unreachable: 0, errors: 0, alerts: [], emailed: false,
  };

  // Without Browser Rendering we cannot read a live surface, so there is nothing
  // to compare. Fail soft (record nothing) rather than misreport every badge.
  if (!env.BROWSER) {
    summary.skipped = 'no_browser_binding';
    return summary;
  }

  const rows = await getActiveAuditsForMonitor(env, batchSize(env));
  const warn = warnDays(env);
  const nowIso = new Date(nowMs).toISOString();

  // The alert lines, split so the digest can lead with the most urgent group.
  const driftLines: string[] = [];
  const recoverLines: string[] = [];
  const expiryLines: string[] = [];

  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      const row = rows[i];
      if (!row) return;

      // Skip rows already past expiry — those read as "expired", not drift, and
      // need a re-mint, not a scan. (getActiveAuditsForMonitor only filters out
      // revoked rows; an expired-but-not-revoked row can still appear.)
      const expDays = daysUntil(row.expires_at, nowMs);
      if (expDays !== null && expDays <= 0) {
        summary.checked++;
        continue;
      }

      const { outcome, liveFingerprint } = await checkOne(env, row);
      summary.checked++;

      const wasDrifted = row.drift_detected_at != null;

      if (outcome === 'drift') {
        summary.drift++;
        // Preserve the ORIGINAL onset time across successive drifted runs.
        const driftAt = wasDrifted ? (row.drift_detected_at as string) : nowIso;
        if (!wasDrifted) {
          summary.newDrift++;
          driftLines.push(`${row.origin} — an audited tool changed; the badge now shows "tools changed".`);
        }
        await updateAuditHealth(env, row.id, {
          last_checked_at: nowIso,
          last_live_fingerprint: liveFingerprint,
          drift_detected_at: driftAt,
        });
      } else if (outcome === 'ok') {
        summary.ok++;
        if (wasDrifted) {
          summary.recovered++;
          recoverLines.push(`${row.origin} — recovered; the audited tools match again and the badge is green.`);
        }
        await updateAuditHealth(env, row.id, {
          last_checked_at: nowIso,
          last_live_fingerprint: liveFingerprint,
          drift_detected_at: null,
        });
      } else {
        // unreachable / error: record the check but touch NEITHER the drift flag
        // nor the stored live fingerprint — a transient failure must not clear a
        // real drift nor invent one.
        if (outcome === 'error') summary.errors++;
        else summary.unreachable++;
        if (wasDrifted) summary.drift++; // still counts as currently-drifted
        await updateAuditHealth(env, row.id, { last_checked_at: nowIso });
      }

      // Expiry warning — independent of the scan outcome. Fire ONCE, on the run
      // that first crosses into the warning window, using the previously-stored
      // last_checked_at to detect the transition (so it does not re-email daily).
      if (warn > 0 && row.expires_at) {
        const expMs = Date.parse(row.expires_at);
        if (Number.isFinite(expMs) && expMs > nowMs) {
          const threshold = expMs - warn * DAY_MS;
          const nowInWindow = nowMs >= threshold;
          const prevMs = row.last_checked_at ? Date.parse(row.last_checked_at) : null;
          const prevInWindow = prevMs !== null && Number.isFinite(prevMs) && prevMs >= threshold;
          if (nowInWindow && !prevInWindow) {
            summary.expiringSoon++;
            const d = expDays ?? Math.ceil((expMs - nowMs) / DAY_MS);
            expiryLines.push(
              `${row.origin} — badge expires ${row.expires_at.slice(0, 10)} (in ${d} day${d === 1 ? '' : 's'}); re-mint to keep it green.`,
            );
          }
        }
      }
    }
  }
  const poolSize = Math.min(CONCURRENCY, Math.max(rows.length, 0));
  const pool = Array.from({ length: poolSize }, () => worker());
  await Promise.all(pool);

  summary.alerts = [...driftLines, ...expiryLines, ...recoverLines];

  // One digest email per run, only when something actually transitioned.
  if (summary.alerts.length > 0 && isAlertConfigured(env)) {
    const parts: string[] = [];
    if (summary.newDrift > 0) parts.push(`${summary.newDrift} changed`);
    if (summary.expiringSoon > 0) parts.push(`${summary.expiringSoon} expiring`);
    if (summary.recovered > 0) parts.push(`${summary.recovered} recovered`);
    const subject = `Trustwright badge alert — ${parts.join(', ')}`;
    const intro =
      summary.newDrift > 0
        ? 'A badge surface changed since it was sealed. Until it is re-minted, the on-page badge shows "tools changed" to visitors.'
        : summary.expiringSoon > 0
          ? 'A badge is approaching expiry.'
          : 'Badge health update.';
    summary.emailed = await sendBadgeAlertEmail(env, { subject, intro, lines: summary.alerts });
  }

  return summary;
}

/**
 * POST /api/monitor/run -> run the badge monitor now and return its summary.
 * Admin-gated (it drives paid browser scans and can send email); also the way an
 * operator verifies alert delivery end-to-end. Runs synchronously so the caller
 * sees the result — the active-badge set is small.
 */
export async function handleMonitorRun(req: Request, env: Env): Promise<Response> {
  const provided = req.headers.get('x-admin-token') ?? '';
  if (!env.ADMIN_TOKEN || !constantTimeEqual(provided, env.ADMIN_TOKEN)) {
    return jsonPublic({ error: 'forbidden' }, { status: 403, req });
  }
  if (!(await checkRate(env, `${clientIp(req)}:monitor`))) {
    return jsonPublic({ error: 'rate_limited' }, { status: 429, req });
  }
  // ?test=1 -> send a single synthetic alert so the operator can confirm Postmark
  // delivery end-to-end without waiting for a real drift. Admin-gated already.
  if (new URL(req.url).searchParams.get('test') === '1') {
    if (!isAlertConfigured(env)) return jsonPublic({ error: 'alerts_not_configured' }, { status: 503, req });
    const emailed = await sendBadgeAlertEmail(env, {
      subject: 'Trustwright badge alert — delivery test',
      intro: 'This is a delivery test of the badge-health alert channel. No badge has actually changed.',
      lines: ['If you are reading this, Postmark alerts from the Trustwright monitor are working.'],
    });
    return jsonPublic({ test: true, emailed }, { req });
  }
  try {
    const summary = await runBadgeMonitor(env);
    return jsonPublic(summary, { req });
  } catch {
    return jsonPublic({ error: 'monitor_failed' }, { status: 502, req });
  }
}
