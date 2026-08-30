// worker/badge.ts
//
// Mode-2 endpoints: prove origin control, audit a surface (server RE-RUNS the
// exact same analyser + fingerprint the client would, so a self-report cannot
// fake a pass), sign the report with Ed25519, persist it, and serve the live
// badge state. The browser holds no key; every write is service-role + validated.

import type { Env, ExecutionContext } from './types.ts';
import { jsonPublic } from './http.ts';
import { checkRate, clientIp } from './limits.ts';
import {
  upsertOriginChallenge,
  getOrigin,
  setOriginVerified,
  insertAudit,
  getLatestAudit,
  revokeAudits,
  insertManifest,
  getLatestManifest,
} from './audits.ts';
import { newChallengeToken, normalizeOrigin, checkOriginControl } from './originVerify.ts';
import { signEd25519, keyId, isSigningConfigured } from './crypto.ts';
import { analyzeSurface } from '../src/range/mode2.ts';
import { fingerprintSurface, stableStringify, FINGERPRINT_ALGO } from '../src/range/fingerprint.ts';
import { buildSurfaceReport, sealSurfaceReport, scopeStatement } from '../src/range/surfaceReport.ts';

const FINGERPRINT_RE = /^[0-9a-f]{64}$/;

async function sha256hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}
import type { RegisteredTool } from '../src/webmcp/types.ts';

const MAX_TOOLS = 300;
const MAX_BODY_BYTES = 512 * 1024;

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Validate a self-reported tool surface into RegisteredTools, or null. */
export function validateTools(v: unknown): RegisteredTool[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_TOOLS) return null;
  const out: RegisteredTool[] = [];
  for (const item of v) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const t = item as Record<string, unknown>;
    if (typeof t.name !== 'string' || t.name.length < 1 || t.name.length > 128) return null;
    if (typeof t.description !== 'string' || t.description.length > 8000) return null;
    const tool: RegisteredTool = { name: t.name, description: t.description };
    if (t.inputSchema && typeof t.inputSchema === 'object' && !Array.isArray(t.inputSchema)) {
      // Bound the schema so a chunked body (no content-length) can't smuggle a
      // huge nested object past readJson into the fingerprint/DB.
      if (JSON.stringify(t.inputSchema).length > 8000) return null;
      tool.inputSchema = t.inputSchema as NonNullable<RegisteredTool['inputSchema']>;
    }
    if (t.annotations && typeof t.annotations === 'object' && !Array.isArray(t.annotations)) {
      tool.annotations = t.annotations as NonNullable<RegisteredTool['annotations']>;
    }
    if (typeof t.origin === 'string' && t.origin.length <= 2048) tool.origin = t.origin;
    out.push(tool);
  }
  return out;
}

async function readJson(req: Request): Promise<unknown> {
  const len = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(len) && len > MAX_BODY_BYTES) return undefined;
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

// ── Badge state ──────────────────────────────────────────────────────────────

export type BadgeState =
  | { origin: string; state: 'unverified' }
  | { origin: string; state: 'none' }
  | { origin: string; state: 'revoked'; signedAt: string }
  | { origin: string; state: 'expired'; fingerprint: string; signedAt: string }
  | {
      origin: string;
      state: 'active';
      fingerprint: string;
      /** Per-tool fingerprints of the sealed surface (sorted). The live badge
       *  verifies every one is still present; an added tool is tolerated. Null
       *  on pre-0007 audits, where the badge falls back to exact aggregate match. */
      toolFingerprints: string[] | null;
      assuranceScore: number | null;
      assuranceRung: number;
      /** True when the signed audit recorded a confirmed FAIL — the badge must
       *  not then show a reassuring green even though the fingerprint matches. */
      flagged: boolean;
      signedAt: string;
      reportSha256: string;
      signature: string;
      keyId: string;
    };

/** True if a stored findings blob contains at least one confirmed FAIL. */
export function hasFailFinding(findings: unknown): boolean {
  return (
    Array.isArray(findings) &&
    findings.some((f) => (f as { verdict?: unknown })?.verdict === 'FAIL')
  );
}

/** The current badge state for an origin — what the embed and the hub consult. */
export async function computeBadgeState(env: Env, origin: string): Promise<BadgeState> {
  const o = await getOrigin(env, origin);
  if (!o || !o.verified_at) return { origin, state: 'unverified' };
  // Audit + manifest are independent; fetch them together.
  const [a, m] = await Promise.all([getLatestAudit(env, origin), getLatestManifest(env, origin)]);
  if (!a) return { origin, state: 'none' };
  if (a.revoked_at) return { origin, state: 'revoked', signedAt: a.signed_at };
  if (a.expires_at && new Date(a.expires_at).getTime() < Date.now()) {
    return { origin, state: 'expired', fingerprint: a.fingerprint, signedAt: a.signed_at };
  }
  // A manifest only elevates the rung when it is bound to THIS audited surface
  // (its fingerprint matches), so a stale/mismatched manifest can't inflate it.
  const rung = m && m.fingerprint === a.fingerprint ? Math.max(a.assurance_rung, 1) : a.assurance_rung;
  return {
    origin,
    state: 'active',
    fingerprint: a.fingerprint,
    toolFingerprints: a.tool_fingerprints ?? null,
    assuranceScore: a.assurance_score,
    assuranceRung: rung,
    flagged: hasFailFinding(a.findings),
    signedAt: a.signed_at,
    reportSha256: a.report_sha256,
    signature: a.signature,
    keyId: a.key_id,
  };
}

// ── Handlers ─────────────────────────────────────────────────────────────────

/** POST /api/verify-origin { origin } -> issue a challenge token. */
export async function handleVerifyOrigin(req: Request, env: Env): Promise<Response> {
  if (!(await checkRate(env, `${clientIp(req)}:verify-origin`))) {
    return jsonPublic({ error: 'rate_limited' }, { status: 429, req });
  }
  const body = await readJson(req);
  const origin = normalizeOrigin((body as { origin?: unknown })?.origin);
  if (!origin) return jsonPublic({ error: 'invalid origin' }, { status: 400, req });
  const token = newChallengeToken();
  try {
    await upsertOriginChallenge(env, origin, token);
  } catch {
    return jsonPublic({ error: 'persist_failed' }, { status: 502, req });
  }
  return jsonPublic(
    {
      origin,
      token,
      instructions: {
        wellKnown: { path: '/.well-known/trustwright-challenge.txt', content: token },
        dns: { record: `_trustwright.${new URL(origin).host}`, type: 'TXT', value: token },
        confirm: 'POST /api/verify-origin/confirm { origin } once one is in place',
      },
    },
    { req },
  );
}

/** POST /api/verify-origin/confirm { origin } -> check the proof, mark verified. */
export async function handleVerifyOriginConfirm(req: Request, env: Env): Promise<Response> {
  if (!(await checkRate(env, `${clientIp(req)}:verify-confirm`))) {
    return jsonPublic({ error: 'rate_limited' }, { status: 429, req });
  }
  const body = await readJson(req);
  const origin = normalizeOrigin((body as { origin?: unknown })?.origin);
  if (!origin) return jsonPublic({ error: 'invalid origin' }, { status: 400, req });
  const o = await getOrigin(env, origin);
  if (!o) return jsonPublic({ error: 'request a challenge first' }, { status: 400, req });
  if (o.verified_at) return jsonPublic({ origin, verified: true }, { req });
  const ok = await checkOriginControl(origin, o.challenge_token);
  if (!ok) return jsonPublic({ origin, verified: false, error: 'challenge not found' }, { status: 200, req });
  try {
    await setOriginVerified(env, origin);
  } catch {
    return jsonPublic({ error: 'persist_failed' }, { status: 502, req });
  }
  return jsonPublic({ origin, verified: true }, { req });
}

/** POST /api/audit { origin, tools, resample? } -> signed Assurance Report. */
export async function handleAudit(req: Request, env: Env): Promise<Response> {
  if (!(await checkRate(env, `${clientIp(req)}:audit`))) {
    return jsonPublic({ error: 'rate_limited' }, { status: 429, req });
  }
  if (!isSigningConfigured(env)) return jsonPublic({ error: 'signing_unavailable' }, { status: 503, req });

  const body = await readJson(req);
  if (!body || typeof body !== 'object') return jsonPublic({ error: 'invalid body' }, { status: 400, req });
  const b = body as Record<string, unknown>;
  const origin = normalizeOrigin(b.origin);
  if (!origin) return jsonPublic({ error: 'invalid origin' }, { status: 400, req });

  // In-page requirement: the request must come FROM the origin being audited.
  const reqOrigin = req.headers.get('Origin');
  if (!reqOrigin || normalizeOrigin(reqOrigin) !== origin) {
    return jsonPublic({ error: 'audit must be initiated from the audited origin' }, { status: 403, req });
  }

  // Domain-control requirement: the origin must have proven ownership.
  const o = await getOrigin(env, origin);
  if (!o || !o.verified_at) {
    return jsonPublic({ error: 'origin not verified — complete /api/verify-origin first' }, { status: 403, req });
  }

  const tools = validateTools(b.tools);
  if (!tools) return jsonPublic({ error: 'invalid tools' }, { status: 400, req });
  const resample = b.resample !== undefined ? validateTools(b.resample) : null;
  if (b.resample !== undefined && !resample) return jsonPublic({ error: 'invalid resample' }, { status: 400, req });

  // The Worker RE-DERIVES the fingerprint + findings (does not trust the client's).
  const fingerprint = await fingerprintSurface(tools);
  const audit = await analyzeSurface(tools, { origin, ...(resample ? { resample } : {}) });
  const ttlDays = Number(env.BADGE_TTL_DAYS ?? '90');
  const expiresAt = new Date(Date.now() + (Number.isFinite(ttlDays) ? ttlDays : 90) * 86400_000).toISOString();
  const report = buildSurfaceReport(audit, fingerprint, origin, new Date().toISOString(), 0);
  const sealed = await sealSurfaceReport(report);
  const signature = await signEd25519(env, sealed.canonical);

  try {
    await insertAudit(env, {
      origin,
      fingerprint,
      findings: report.findings,
      assurance_score: report.assuranceScore,
      assurance_rung: report.assuranceRung,
      report_sha256: sealed.sha256,
      signature,
      key_id: keyId(env),
      expires_at: expiresAt,
    });
  } catch {
    return jsonPublic({ error: 'persist_failed' }, { status: 502, req });
  }

  return jsonPublic(
    { report: sealed.report, sha256: sealed.sha256, signature, keyId: keyId(env), expiresAt },
    { req },
  );
}

/** GET /api/badge?origin=... -> live badge state (also serves check_badge for the hub). */
export async function handleBadge(req: Request, env: Env): Promise<Response> {
  const origin = normalizeOrigin(new URL(req.url).searchParams.get('origin'));
  if (!origin) return jsonPublic({ error: 'invalid origin' }, { status: 400, req });
  try {
    return jsonPublic(await computeBadgeState(env, origin), { req });
  } catch {
    return jsonPublic({ error: 'lookup_failed' }, { status: 502, req });
  }
}

/**
 * GET /api/report?origin= -> the FULL, human-readable audit behind the badge:
 * verdict, what was audited (scope), the findings, the assurance score, the
 * signed fingerprint + per-tool count, and everything needed to verify the seal
 * independently (Ed25519 signature, key id, report SHA-256, public key). This is
 * what the badge links to so anyone — on any badged site — can see exactly what
 * Trustwright checked and why to trust it. Read-only, public, no ownership needed.
 */
export async function handleReport(req: Request, env: Env): Promise<Response> {
  const origin = normalizeOrigin(new URL(req.url).searchParams.get('origin'));
  if (!origin) return jsonPublic({ error: 'invalid origin' }, { status: 400, req });
  try {
    const o = await getOrigin(env, origin);
    if (!o || !o.verified_at) return jsonPublic({ origin, state: 'unverified' as const }, { req });
    const a = await getLatestAudit(env, origin);
    if (!a) return jsonPublic({ origin, state: 'none' as const }, { req });
    const state = a.revoked_at
      ? 'revoked'
      : a.expires_at && new Date(a.expires_at).getTime() < Date.now()
        ? 'expired'
        : 'active';
    return jsonPublic(
      {
        origin,
        state,
        fingerprint: a.fingerprint,
        toolCount: Array.isArray(a.tool_fingerprints) ? a.tool_fingerprints.length : null,
        assuranceScore: a.assurance_score,
        assuranceRung: a.assurance_rung,
        flagged: hasFailFinding(a.findings),
        findings: Array.isArray(a.findings) ? a.findings : [],
        scope: scopeStatement(a.signed_at, a.fingerprint),
        signedAt: a.signed_at,
        expiresAt: a.expires_at,
        reportSha256: a.report_sha256,
        signature: a.signature,
        keyId: a.key_id,
        fingerprintAlgo: FINGERPRINT_ALGO,
      },
      { req },
    );
  } catch {
    return jsonPublic({ error: 'lookup_failed' }, { status: 502, req });
  }
}

/** POST /api/manifest { origin, fingerprint, manifest } -> signed behaviour manifest (rung 1). */
export async function handleManifest(req: Request, env: Env): Promise<Response> {
  if (!(await checkRate(env, `${clientIp(req)}:manifest`))) {
    return jsonPublic({ error: 'rate_limited' }, { status: 429, req });
  }
  if (!isSigningConfigured(env)) return jsonPublic({ error: 'signing_unavailable' }, { status: 503, req });

  const body = await readJson(req);
  if (!body || typeof body !== 'object') return jsonPublic({ error: 'invalid body' }, { status: 400, req });
  const b = body as Record<string, unknown>;
  const origin = normalizeOrigin(b.origin);
  if (!origin) return jsonPublic({ error: 'invalid origin' }, { status: 400, req });

  const reqOrigin = req.headers.get('Origin');
  if (!reqOrigin || normalizeOrigin(reqOrigin) !== origin) {
    return jsonPublic({ error: 'manifest must be published from the origin' }, { status: 403, req });
  }
  const o = await getOrigin(env, origin);
  if (!o || !o.verified_at) return jsonPublic({ error: 'origin not verified' }, { status: 403, req });

  const fingerprint = typeof b.fingerprint === 'string' && FINGERPRINT_RE.test(b.fingerprint) ? b.fingerprint : null;
  if (!fingerprint) return jsonPublic({ error: 'invalid fingerprint' }, { status: 400, req });
  if (!b.manifest || typeof b.manifest !== 'object' || Array.isArray(b.manifest)) {
    return jsonPublic({ error: 'manifest must be an object' }, { status: 400, req });
  }
  if (JSON.stringify(b.manifest).length > 32000) {
    return jsonPublic({ error: 'manifest too large' }, { status: 413, req });
  }

  // Sign the canonical {origin, fingerprint, manifest}. Trustwright attests the site
  // MADE these claims and binds them to the surface — it does not prove them true.
  const canonical = stableStringify({ origin, fingerprint, manifest: b.manifest });
  const manifestSha256 = await sha256hex(canonical);
  const signature = await signEd25519(env, canonical);

  try {
    await insertManifest(env, {
      origin,
      fingerprint,
      manifest: b.manifest,
      manifest_sha256: manifestSha256,
      signature,
      key_id: keyId(env),
    });
  } catch {
    return jsonPublic({ error: 'persist_failed' }, { status: 502, req });
  }
  return jsonPublic({ origin, fingerprint, manifestSha256, signature, keyId: keyId(env) }, { req });
}

/** GET /api/manifest?origin=... -> the latest signed manifest, or null. */
export async function handleGetManifest(req: Request, env: Env): Promise<Response> {
  const origin = normalizeOrigin(new URL(req.url).searchParams.get('origin'));
  if (!origin) return jsonPublic({ error: 'invalid origin' }, { status: 400, req });
  try {
    const m = await getLatestManifest(env, origin);
    return jsonPublic(m ? { origin, ...m } : { origin, manifest: null }, { req });
  } catch {
    return jsonPublic({ error: 'lookup_failed' }, { status: 502, req });
  }
}

/** GET /api/pubkey -> the Ed25519 public key, for offline verification. */
export function handlePubkey(req: Request, env: Env): Response {
  return jsonPublic(
    { keyId: keyId(env), alg: 'Ed25519', format: 'spki', publicKey: env.TRUSTWRIGHT_PUBKEY ?? null },
    { req },
  );
}

/** POST /api/audit/revoke { origin | id } -> admin-gated revocation. */
export async function handleRevoke(req: Request, env: Env): Promise<Response> {
  const provided = req.headers.get('x-admin-token') ?? '';
  if (!env.ADMIN_TOKEN || !timingSafeEqual(provided, env.ADMIN_TOKEN)) {
    return jsonPublic({ error: 'forbidden' }, { status: 403, req });
  }
  const body = await readJson(req);
  const b = (body ?? {}) as Record<string, unknown>;
  const origin = typeof b.origin === 'string' ? normalizeOrigin(b.origin) : null;
  const id = typeof b.id === 'string' ? b.id : null;
  if (!origin && !id) return jsonPublic({ error: 'origin or id required' }, { status: 400, req });
  try {
    await revokeAudits(env, { ...(origin ? { origin } : {}), ...(id ? { id } : {}) });
  } catch {
    return jsonPublic({ error: 'revoke_failed' }, { status: 502, req });
  }
  return jsonPublic({ ok: true }, { req });
}

// Keep ctx importable for symmetry with other handlers (not needed today).
export type { ExecutionContext };
