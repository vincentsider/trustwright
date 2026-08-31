// worker/maintenance.ts
//
// Scheduled ownership re-check (implementation-plan item 8).
//
// A public badge is only trustworthy while the site still controls the origin
// it was issued to. Once verified, a site could quietly remove the proof (or
// lose the domain) and keep flashing a green badge. This job re-fetches the
// ownership proof for each verified origin on a cadence and, if the proof is
// gone, un-verifies the origin AND revokes its live audits.
//
// Two safety rails against false revocation:
//   1. Tri-state probe (probeControl): a momentarily *unreachable* origin is
//      never treated as proof-removed — only a definitively reachable origin
//      that no longer serves the token counts as "absent".
//   2. Grace window (OWNERSHIP_GRACE_DAYS): even an "absent" proof is tolerated
//      until it has been continuously absent for the grace period, measured
//      from proof_last_ok (the last time we positively saw it). A single bad
//      deploy that drops the file for an hour cannot revoke anyone.
//
// Expiry itself needs no cron: computeBadgeState treats an audit past
// expires_at as expired at read time. This job is purely the ownership guard.

import type { Env } from './types.ts';
import {
  getVerifiedOriginsForRecheck,
  touchProofOk,
  unverifyOrigin,
  revokeAudits,
  type RecheckRow,
} from './audits.ts';
import { probeControl } from './originVerify.ts';
import { sendBadgeAlertEmail, isAlertConfigured } from './email.ts';

const DEFAULT_GRACE_DAYS = 3;
const DEFAULT_BATCH = 25;
const CONCURRENCY = 5;
const DAY_MS = 86_400_000;

export interface RecheckSummary {
  checked: number;
  ok: number; // proof still present -> proof_last_ok refreshed
  revoked: number; // proof gone past grace -> unverified + audits revoked
  withinGrace: number; // proof absent but still inside the grace window
  unreachable: number; // transient failure -> left untouched
  errors: number;
}

function graceMs(env: Env): number {
  const n = Number(env.OWNERSHIP_GRACE_DAYS ?? String(DEFAULT_GRACE_DAYS));
  return (Number.isFinite(n) && n >= 0 ? n : DEFAULT_GRACE_DAYS) * DAY_MS;
}

function batchSize(env: Env): number {
  const n = Number(env.RECHECK_BATCH ?? String(DEFAULT_BATCH));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 200) : DEFAULT_BATCH;
}

/** Milliseconds since the proof was last seen present, using proof_last_ok and
 *  falling back to verified_at. Returns null if neither is a valid timestamp
 *  (in which case we do NOT revoke — we have no reference time to trust). */
function elapsedSinceLastOk(row: RecheckRow, nowMs: number): number | null {
  const ref = row.proof_last_ok ?? row.verified_at;
  if (!ref) return null;
  const t = Date.parse(ref);
  return Number.isFinite(t) ? nowMs - t : null;
}

async function recheckOne(env: Env, row: RecheckRow, nowMs: number, grace: number): Promise<keyof RecheckSummary> {
  let status: 'present' | 'absent' | 'unreachable';
  try {
    status = await probeControl(row.origin, row.challenge_token);
  } catch {
    return 'errors';
  }

  if (status === 'present') {
    try {
      await touchProofOk(env, row.origin);
      return 'ok';
    } catch {
      return 'errors';
    }
  }

  if (status === 'unreachable') return 'unreachable';

  // status === 'absent': revoke only once the proof has been gone longer than
  // the grace window (measured from the last time we saw it present).
  const elapsed = elapsedSinceLastOk(row, nowMs);
  if (elapsed === null || elapsed <= grace) return 'withinGrace';

  try {
    await unverifyOrigin(env, row.origin);
    await revokeAudits(env, { origin: row.origin });
    return 'revoked';
  } catch {
    return 'errors';
  }
}

/**
 * Re-check ownership for a batch of verified origins. Pure orchestration over
 * the data-access + probe helpers so it is unit-testable with a mocked Env.
 * `nowMs` is injectable for deterministic tests; defaults to wall clock.
 */
export async function runOwnershipRecheck(env: Env, nowMs: number = Date.now()): Promise<RecheckSummary> {
  const summary: RecheckSummary = { checked: 0, ok: 0, revoked: 0, withinGrace: 0, unreachable: 0, errors: 0 };
  const rows = await getVerifiedOriginsForRecheck(env, batchSize(env));
  if (rows.length === 0) return summary;

  const grace = graceMs(env);
  const revokedOrigins: string[] = [];
  // Bounded concurrency: a shared cursor hands each worker the next row. Caps
  // parallel subrequests (Workers has a per-invocation subrequest budget) while
  // still overlapping the 8s-timeout probes.
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      const row = rows[i];
      if (!row) return;
      const bucket = await recheckOne(env, row, nowMs, grace);
      summary.checked++;
      summary[bucket]++;
      if (bucket === 'revoked') revokedOrigins.push(row.origin);
    }
  }
  const pool = Array.from({ length: Math.min(CONCURRENCY, rows.length) }, () => worker());
  await Promise.all(pool);

  // A revocation is the most consequential badge event — the site lost its green
  // seal because its ownership proof went away. Tell the operator (best-effort;
  // never let an email failure change the re-check outcome).
  if (revokedOrigins.length > 0 && isAlertConfigured(env)) {
    try {
      await sendBadgeAlertEmail(env, {
        subject: `Trustwright badge alert — ${revokedOrigins.length} revoked`,
        intro:
          'A badge was revoked because its ownership proof (the /.well-known/trustwright-challenge.txt file or DNS TXT record) has been missing past the grace window.',
        lines: revokedOrigins.map(
          (o) => `${o} — badge revoked; restore the ownership proof and re-verify to reinstate it.`,
        ),
      });
    } catch {
      /* alerting is best-effort */
    }
  }
  return summary;
}
