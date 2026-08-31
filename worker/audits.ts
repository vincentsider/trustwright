// worker/audits.ts
//
// PostgREST access for Mode-2 origin verification + signed surface audits.
// Service-role only (Worker-side); every value written is validated first.

import type { Env } from './types.ts';

function sbHeaders(env: Env, extra?: Record<string, string>): Record<string, string> {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}
function sbUrl(env: Env, path: string): string {
  return `${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${path}`;
}

export interface OriginRow {
  origin: string;
  challenge_token: string;
  verified_at: string | null;
}

/** Create or refresh an origin's challenge token (keeps verified_at as-is). */
export async function upsertOriginChallenge(env: Env, origin: string, token: string): Promise<void> {
  const resp = await fetch(sbUrl(env, 'origins?on_conflict=origin'), {
    method: 'POST',
    headers: sbHeaders(env, { Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify({ origin, challenge_token: token }),
  });
  if (!resp.ok) throw new Error(`origins upsert failed: ${resp.status}`);
}

export async function getOrigin(env: Env, origin: string): Promise<OriginRow | null> {
  const q = `origins?origin=eq.${encodeURIComponent(origin)}&select=origin,challenge_token,verified_at&limit=1`;
  const resp = await fetch(sbUrl(env, q), { headers: sbHeaders(env) });
  if (!resp.ok) return null;
  const rows = (await resp.json()) as OriginRow[];
  return rows[0] ?? null;
}

export async function setOriginVerified(env: Env, origin: string): Promise<void> {
  const now = new Date().toISOString();
  const resp = await fetch(sbUrl(env, `origins?origin=eq.${encodeURIComponent(origin)}`), {
    method: 'PATCH',
    headers: sbHeaders(env, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ verified_at: now, proof_last_ok: now }),
  });
  if (!resp.ok) throw new Error(`origin verify failed: ${resp.status}`);
}

export interface RecheckRow {
  origin: string;
  challenge_token: string;
  verified_at: string | null;
  proof_last_ok: string | null;
}

/** Verified origins to re-check, oldest proof_last_ok first. */
export async function getVerifiedOriginsForRecheck(env: Env, limit: number): Promise<RecheckRow[]> {
  const capped = Math.max(1, Math.min(limit, 200));
  const q =
    'origins?verified_at=not.is.null&select=origin,challenge_token,verified_at,proof_last_ok' +
    `&order=proof_last_ok.asc.nullsfirst&limit=${capped}`;
  const resp = await fetch(sbUrl(env, q), { headers: sbHeaders(env) });
  if (!resp.ok) return [];
  return (await resp.json()) as RecheckRow[];
}

/** Record that the ownership proof was seen present now. */
export async function touchProofOk(env: Env, origin: string): Promise<void> {
  await fetch(sbUrl(env, `origins?origin=eq.${encodeURIComponent(origin)}`), {
    method: 'PATCH',
    headers: sbHeaders(env, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ proof_last_ok: new Date().toISOString() }),
  });
}

/** Un-verify an origin (ownership proof gone past grace). */
export async function unverifyOrigin(env: Env, origin: string): Promise<void> {
  await fetch(sbUrl(env, `origins?origin=eq.${encodeURIComponent(origin)}`), {
    method: 'PATCH',
    headers: sbHeaders(env, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ verified_at: null, proof_last_ok: null }),
  });
}

export interface AuditInsert {
  origin: string;
  fingerprint: string;
  tool_fingerprints?: string[] | null;
  tools?: unknown;
  findings: unknown;
  assurance_score: number | null;
  assurance_rung: number;
  report_sha256: string;
  signature: string;
  key_id: string;
  expires_at?: string | null;
}

export async function insertAudit(env: Env, row: AuditInsert): Promise<{ id: string }> {
  const resp = await fetch(sbUrl(env, 'tool_audits'), {
    method: 'POST',
    headers: sbHeaders(env, { Prefer: 'return=representation' }),
    body: JSON.stringify(row),
  });
  if (!resp.ok) throw new Error(`tool_audits insert failed: ${resp.status}`);
  const rows = (await resp.json()) as Array<{ id: string }>;
  const first = rows[0];
  if (!first) throw new Error('tool_audits insert returned no row');
  return { id: first.id };
}

export interface AuditRow {
  id: string;
  origin: string;
  fingerprint: string;
  tool_fingerprints: string[] | null;
  tools: unknown;
  findings: unknown;
  assurance_score: number | null;
  assurance_rung: number;
  report_sha256: string;
  signature: string;
  key_id: string;
  signed_at: string;
  expires_at: string | null;
  revoked_at: string | null;
}

/** The most recent audit for an origin (any state). */
export async function getLatestAudit(env: Env, origin: string): Promise<AuditRow | null> {
  const q =
    `tool_audits?origin=eq.${encodeURIComponent(origin)}` +
    '&select=id,origin,fingerprint,tool_fingerprints,tools,findings,assurance_score,assurance_rung,report_sha256,signature,key_id,signed_at,expires_at,revoked_at' +
    '&order=signed_at.desc&limit=1';
  const resp = await fetch(sbUrl(env, q), { headers: sbHeaders(env) });
  if (!resp.ok) return null;
  const rows = (await resp.json()) as AuditRow[];
  return rows[0] ?? null;
}

// ── Badge-health monitor (0010) ──────────────────────────────────────────────

export interface MonitorAuditRow {
  id: string;
  origin: string;
  fingerprint: string;
  tool_fingerprints: string[] | null;
  expires_at: string | null;
  last_checked_at: string | null;
  drift_detected_at: string | null;
}

/** Active audits to re-scan for drift: one non-revoked row per origin (the newest,
 *  since supersede revokes the rest), oldest-checked first so a capped batch
 *  rotates through every badge over successive runs. Already-expired audits are
 *  left to the caller to skip. */
export async function getActiveAuditsForMonitor(env: Env, limit: number): Promise<MonitorAuditRow[]> {
  const capped = Math.max(1, Math.min(limit, 200));
  const q =
    'tool_audits?revoked_at=is.null' +
    '&select=id,origin,fingerprint,tool_fingerprints,expires_at,last_checked_at,drift_detected_at' +
    `&order=last_checked_at.asc.nullsfirst&limit=${capped}`;
  const resp = await fetch(sbUrl(env, q), { headers: sbHeaders(env) });
  if (!resp.ok) return [];
  return (await resp.json()) as MonitorAuditRow[];
}

/** Record a monitor check on one audit: when it was last checked, the live
 *  fingerprint we saw, and the drift transition (set drift_detected_at when drift
 *  BEGINS, clear it when the surface recovers). Never throws — health tracking
 *  must not break the monitor loop. */
export async function updateAuditHealth(
  env: Env,
  id: string,
  patch: { last_checked_at: string; last_live_fingerprint?: string | null; drift_detected_at?: string | null },
): Promise<void> {
  try {
    await fetch(sbUrl(env, `tool_audits?id=eq.${encodeURIComponent(id)}`), {
      method: 'PATCH',
      headers: sbHeaders(env, { Prefer: 'return=minimal' }),
      body: JSON.stringify(patch),
    });
  } catch {
    /* health tracking is best-effort */
  }
}

export interface ManifestInsert {
  origin: string;
  fingerprint: string;
  manifest: unknown;
  manifest_sha256: string;
  signature: string;
  key_id: string;
}

export async function insertManifest(env: Env, row: ManifestInsert): Promise<void> {
  const resp = await fetch(sbUrl(env, 'manifests'), {
    method: 'POST',
    headers: sbHeaders(env, { Prefer: 'return=minimal' }),
    body: JSON.stringify(row),
  });
  if (!resp.ok) throw new Error(`manifests insert failed: ${resp.status}`);
}

export async function getLatestManifest(
  env: Env,
  origin: string,
): Promise<{ fingerprint: string; manifest: unknown; manifest_sha256: string; signature: string; key_id: string; signed_at: string } | null> {
  const q =
    `manifests?origin=eq.${encodeURIComponent(origin)}` +
    '&select=fingerprint,manifest,manifest_sha256,signature,key_id,signed_at&order=signed_at.desc&limit=1';
  const resp = await fetch(sbUrl(env, q), { headers: sbHeaders(env) });
  if (!resp.ok) return null;
  const rows = (await resp.json()) as Array<{
    fingerprint: string;
    manifest: unknown;
    manifest_sha256: string;
    signature: string;
    key_id: string;
    signed_at: string;
  }>;
  return rows[0] ?? null;
}

// ── Premium corpus entitlements (gates /api/corpus?tier=premium) ─────────────

/** The tier a bearer token grants, or null if unknown/expired. */
export async function getCorpusTier(env: Env, token: string): Promise<string | null> {
  const q = `corpus_entitlements?token=eq.${encodeURIComponent(token)}&select=tier,expires_at&limit=1`;
  const resp = await fetch(sbUrl(env, q), { headers: sbHeaders(env) });
  if (!resp.ok) return null;
  const rows = (await resp.json()) as Array<{ tier: string; expires_at: string | null }>;
  const row = rows[0];
  if (!row) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;
  return row.tier;
}

/** Issue a corpus entitlement token (admin flow / stubbed billing). */
export async function insertCorpusEntitlement(
  env: Env,
  row: { token: string; tier: string; label?: string | null; expires_at?: string | null },
): Promise<void> {
  const resp = await fetch(sbUrl(env, 'corpus_entitlements'), {
    method: 'POST',
    headers: sbHeaders(env, { Prefer: 'return=minimal' }),
    body: JSON.stringify(row),
  });
  if (!resp.ok) throw new Error(`corpus_entitlements insert failed: ${resp.status}`);
}

/**
 * Supersede prior audits when a fresh one is minted: revoke every OTHER
 * non-revoked audit for the origin, leaving exactly one active row (the new
 * one). Best-effort and failure-safe by construction — the caller inserts the
 * new active audit FIRST, so if this revoke fails the origin still has a valid
 * live badge (plus some stale rows), never none. The badge reader
 * (getLatestAudit, order signed_at desc) already ignores the stale rows; this
 * just keeps the table honest (one active audit per origin).
 */
export async function supersedePriorAudits(env: Env, origin: string, keepId: string): Promise<void> {
  const filter = `origin=eq.${encodeURIComponent(origin)}&id=neq.${encodeURIComponent(keepId)}&revoked_at=is.null`;
  await fetch(sbUrl(env, `tool_audits?${filter}`), {
    method: 'PATCH',
    headers: sbHeaders(env, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ revoked_at: new Date().toISOString() }),
  });
}

/** Best-effort log of a consumer scan, for success metrics. No PII — just the
 *  (public) scanned origin + a timestamp. Never throws: a metrics write must not
 *  break the scan it is measuring. */
export async function logScanEvent(env: Env, origin: string, kind = 'scan'): Promise<void> {
  try {
    await fetch(sbUrl(env, 'scan_events'), {
      method: 'POST',
      headers: sbHeaders(env, { Prefer: 'return=minimal' }),
      body: JSON.stringify({ origin, kind }),
    });
  } catch {
    /* metrics are best-effort */
  }
}

/** The aggregated success dashboard (one RPC): badges + sites, verification,
 *  scans, agent tests, leads. Service-role only. */
export async function getStats(env: Env): Promise<unknown> {
  const resp = await fetch(sbUrl(env, 'rpc/trustwright_stats'), {
    method: 'POST',
    headers: sbHeaders(env),
    body: '{}',
  });
  if (!resp.ok) throw new Error(`stats rpc failed: ${resp.status}`);
  return await resp.json();
}

/** Revoke every audit for an origin (or one id). Returns rows affected count is not tracked. */
export async function revokeAudits(env: Env, opts: { origin?: string; id?: string }): Promise<void> {
  const filter = opts.id
    ? `id=eq.${encodeURIComponent(opts.id)}`
    : opts.origin
      ? `origin=eq.${encodeURIComponent(opts.origin)}`
      : null;
  if (!filter) throw new Error('revoke needs an origin or id');
  const resp = await fetch(sbUrl(env, `tool_audits?${filter}&revoked_at=is.null`), {
    method: 'PATCH',
    headers: sbHeaders(env, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ revoked_at: new Date().toISOString() }),
  });
  if (!resp.ok) throw new Error(`revoke failed: ${resp.status}`);
}
