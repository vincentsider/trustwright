// worker/scan.ts
//
// Self-serve URL scan (item 10) + operator audit-from-scan (item 11).
//
// The scan runs INSIDE the Worker via Cloudflare Browser Rendering (see
// ./browserScan.ts): a managed headless Chromium opens the URL, the page's own
// JS runs, and we read document.modelContext.getTools(). The browser is an
// OBSERVER only: the Worker re-validates the tools and RE-DERIVES the
// fingerprint + findings itself, exactly as it does for an SDK self-report.
// Two endpoints, two trust levels:
//
//   POST /api/scan            public, best-effort, returns an UNSIGNED preview.
//                             A scan never mints a badge — no ownership proof.
//   POST /api/audit/self      self-serve: signs a scanned surface for an origin
//                             the caller has already PROVEN they own. This is the
//                             non-technical operator's one-click "create my badge"
//                             (ownership proof is the gate; rate-limited).
//   POST /api/audit/from-scan admin-gated variant for Trustwright operators.
//
// This keeps the founding rule intact: a signature exists only behind proven
// origin control; everything else is an observation, labelled as such.

import type { Env, ExecutionContext } from './types.ts';
import { jsonPublic } from './http.ts';
import { checkRate, underDailyCap, clientIp } from './limits.ts';
import { validateTools } from './badge.ts';
import { getOrigin, insertAudit, supersedePriorAudits, logScanEvent, getStats } from './audits.ts';
import { signEd25519, keyId, isSigningConfigured, constantTimeEqual } from './crypto.ts';
import { scanWithBrowser } from './browserScan.ts';
import { isBlockedHostname } from './netguard.ts';
import { analyzeSurface } from '../src/range/mode2.ts';
import { fingerprintSurface, toolFingerprints, RESERVED_TOOL_NAMES } from '../src/range/fingerprint.ts';
import { buildSurfaceReport, sealSurfaceReport } from '../src/range/surfaceReport.ts';
import type { RegisteredTool } from '../src/webmcp/types.ts';

const MAX_URL_LEN = 2048;

/** Compact, display-safe view of the audited tools: what an agent would see and
 *  the two hints that decide read-vs-act and trusted-vs-untrusted. Excludes
 *  Trustwright's own injected verify tool (matches the fingerprinted set). */
export interface AuditedTool {
  name: string;
  description: string;
  readOnly: boolean;
  untrusted: boolean;
  params: string[];
}

const TOOL_DESC_MAX = 600; // display cap; bounds the scan response for a hostile 300-tool page

export function toAuditedTools(tools: RegisteredTool[]): AuditedTool[] {
  return tools
    .filter((t) => !RESERVED_TOOL_NAMES.has(t.name))
    .map((t) => {
      const props =
        t.inputSchema && typeof t.inputSchema === 'object' ? (t.inputSchema as { properties?: unknown }).properties : undefined;
      const desc = typeof t.description === 'string' ? t.description : '';
      return {
        name: t.name,
        description: desc.length > TOOL_DESC_MAX ? desc.slice(0, TOOL_DESC_MAX) + '…' : desc,
        readOnly: (t.annotations as { readOnlyHint?: unknown } | undefined)?.readOnlyHint === true,
        untrusted: (t.annotations as { untrustedContentHint?: unknown } | undefined)?.untrustedContentHint === true,
        params: props && typeof props === 'object' ? Object.keys(props as Record<string, unknown>).slice(0, 40) : [],
      };
    });
}

/** Validate a scan target into { url, origin }, or null. http(s) only. */
function validateTarget(input: unknown): { url: string; origin: string } | null {
  if (typeof input !== 'string' || input.length === 0 || input.length > MAX_URL_LEN) return null;
  try {
    const u = new URL(input);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    // SSRF: refuse literal internal/loopback/link-local targets at the door.
    // Redirects and DNS names are re-checked in browserScan (hostIsPublic +
    // per-request abort), since input-only validation is bypassable by a 30x.
    if (isBlockedHostname(u.hostname)) return null;
    return { url: u.toString(), origin: u.origin };
  } catch {
    return null;
  }
}

const SCAN_NOTE =
  'External scan: enumerated from an out-of-band headless browser, limited to what an unauthenticated visitor can see. ' +
  'This is NOT a verified badge — heuristic findings are indicative only, and a signed badge requires proven origin control.';

/** POST /api/scan { url } -> unsigned external preview of a page's tool surface. */
export async function handleScan(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  if (!(await checkRate(env, `${clientIp(req)}:scan`))) {
    return jsonPublic({ error: 'rate_limited' }, { status: 429, req });
  }
  if (!env.BROWSER) return jsonPublic({ error: 'scan_unavailable' }, { status: 503, req });

  const body = await readJsonSmall(req);
  const target = validateTarget((body as { url?: unknown })?.url);
  if (!target) return jsonPublic({ error: 'invalid url' }, { status: 400, req });

  // Global daily ceiling on the ONE unauthenticated browser entrypoint. Each
  // scan launches a paid Browser Rendering session; a per-IP limit alone lets a
  // distributed abuser (or a viral moment) run up an unbounded bill. Enforced
  // only when the KV counter is bound (it is, in prod) — best-effort so a
  // KV-less deploy still scans; the per-IP limit and SSRF guard always apply.
  // The ownership-gated mint paths are not capped — they are self-limiting.
  if (env.DAILY) {
    const cap = Number(env.SCAN_DAILY_CAP ?? '500');
    if (!(await underDailyCap(env, 'scan', Number.isFinite(cap) ? cap : 500))) {
      return jsonPublic({ error: 'scan_daily_cap' }, { status: 503, req });
    }
  }

  const scan = await scanWithBrowser(env, target.url);
  if (scan.host === 'error') {
    return jsonPublic({ error: scan.error ?? 'scan_failed' }, { status: 502, req });
  }
  // Count this completed scan for success metrics (best-effort, off the response path).
  const logScan = logScanEvent(env, target.origin);
  if (ctx) ctx.waitUntil(logScan);
  else void logScan;
  const scannedAt = new Date().toISOString();
  if (scan.host === 'none') {
    return jsonPublic(
      { url: target.url, origin: target.origin, host: 'none', tools: 0, findings: [], signed: false, scannedAt, note: 'No WebMCP host was found at this URL.' },
      { req },
    );
  }

  // A host that is present but registers zero tools is a valid, honest result —
  // not a malformed surface. Report it as tools:0 (like host:'none'), not a 502.
  if (scan.tools.length === 0) {
    return jsonPublic(
      { url: target.url, origin: target.origin, host: scan.host, tools: 0, findings: [], signed: false, scannedAt, note: 'This page exposes a WebMCP host but registered no agent tools.' },
      { req },
    );
  }

  const tools = validateTools(scan.tools);
  if (!tools) return jsonPublic({ error: 'scan_bad_surface' }, { status: 502, req });

  // Untrusted transport: re-derive everything the Worker would sign, but do NOT
  // sign and do NOT persist. A scan yields an observation, never a credential.
  const fingerprint = await fingerprintSurface(tools);
  const audit = await analyzeSurface(tools, { origin: target.origin });
  const report = buildSurfaceReport(audit, fingerprint, target.origin, scannedAt, 0);

  return jsonPublic(
    {
      url: target.url,
      origin: target.origin,
      host: scan.host,
      tools: tools.length,
      toolsDetail: toAuditedTools(tools),
      fingerprint,
      findings: report.findings,
      assuranceScore: report.assuranceScore,
      signed: false,
      scannedAt,
      note: SCAN_NOTE,
    },
    { req },
  );
}

/** Scan a verified origin, re-derive, sign, and persist the audit. Shared by the
 *  self-serve and admin mint paths. Returns a Response (success or error). The
 *  caller has ALREADY enforced the gate (ownership proof and/or admin token). */
async function mintScannedAudit(req: Request, env: Env, target: { url: string; origin: string }): Promise<Response> {
  const scan = await scanWithBrowser(env, target.url);
  if (scan.host === 'error') return jsonPublic({ error: scan.error ?? 'scan_failed' }, { status: 502, req });
  if (scan.host === 'none') return jsonPublic({ error: 'no_webmcp_host' }, { status: 422, req });
  const tools = validateTools(scan.tools);
  if (!tools) return jsonPublic({ error: 'scan_bad_surface' }, { status: 502, req });

  const fingerprint = await fingerprintSurface(tools);
  const toolFps = await toolFingerprints(tools);
  // Compact list of the audited tools, for the public report page to SHOW what
  // was scanned. Descriptions are already capped by the scanner.
  const auditedTools = toAuditedTools(tools);
  const audit = await analyzeSurface(tools, { origin: target.origin });
  const ttlDays = Number(env.BADGE_TTL_DAYS ?? '90');
  const expiresAt = new Date(Date.now() + (Number.isFinite(ttlDays) ? ttlDays : 90) * 86_400_000).toISOString();
  const report = buildSurfaceReport(audit, fingerprint, target.origin, new Date().toISOString(), 0, toolFps);
  const sealed = await sealSurfaceReport(report);
  const signature = await signEd25519(env, sealed.canonical);

  let inserted: { id: string };
  try {
    inserted = await insertAudit(env, {
      origin: target.origin,
      fingerprint,
      tool_fingerprints: toolFps,
      tools: auditedTools,
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
  // Exactly one active audit per origin: revoke the ones this mint replaced.
  // Best-effort AFTER the insert, so a failure here never leaves the origin
  // without a live badge (the new active row already exists).
  try {
    await supersedePriorAudits(env, target.origin, inserted.id);
  } catch {
    /* stale rows are harmless — getLatestAudit still returns the new one */
  }

  return jsonPublic(
    { origin: target.origin, source: 'scan', host: scan.host, report: sealed.report, sha256: sealed.sha256, signature, keyId: keyId(env), expiresAt },
    { req },
  );
}

/** POST /api/audit/self { url } -> self-serve signed audit for an origin the
 *  caller has PROVEN they own. Ownership proof is the only gate (plus a rate
 *  limit); no admin token. This is the operator's one-click "create my badge". */
export async function handleAuditSelf(req: Request, env: Env): Promise<Response> {
  if (!(await checkRate(env, `${clientIp(req)}:audit-self`))) {
    return jsonPublic({ error: 'rate_limited' }, { status: 429, req });
  }
  if (!isSigningConfigured(env)) return jsonPublic({ error: 'signing_unavailable' }, { status: 503, req });
  if (!env.BROWSER) return jsonPublic({ error: 'scan_unavailable' }, { status: 503, req });

  const body = await readJsonSmall(req);
  const target = validateTarget((body as { url?: unknown })?.url);
  if (!target) return jsonPublic({ error: 'invalid url' }, { status: 400, req });

  const o = await getOrigin(env, target.origin);
  if (!o || !o.verified_at) {
    return jsonPublic({ error: 'origin not verified — complete /api/verify-origin first' }, { status: 403, req });
  }
  return mintScannedAudit(req, env, target);
}

/** GET /api/stats -> aggregated success metrics (badges + sites, verification,
 *  scans, agent tests, leads). Admin-gated: it reveals business metrics. */
export async function handleStats(req: Request, env: Env): Promise<Response> {
  if (!(await checkRate(env, `${clientIp(req)}:stats`))) {
    return jsonPublic({ error: 'rate_limited' }, { status: 429, req });
  }
  // Least privilege: the read-only STATS_TOKEN unlocks the dashboard; the more
  // powerful ADMIN_TOKEN (which also mints/revokes badges) still works for the
  // operator. A stolen dashboard token can therefore only READ counts.
  const provided = req.headers.get('x-admin-token') ?? '';
  const ok =
    (!!env.STATS_TOKEN && constantTimeEqual(provided, env.STATS_TOKEN)) ||
    (!!env.ADMIN_TOKEN && constantTimeEqual(provided, env.ADMIN_TOKEN));
  if (!ok) return jsonPublic({ error: 'forbidden' }, { status: 403, req });
  try {
    return jsonPublic(await getStats(env), { req });
  } catch {
    return jsonPublic({ error: 'stats_failed' }, { status: 502, req });
  }
}

/** POST /api/audit/from-scan { url } -> admin-gated variant for Trustwright operators. */
export async function handleAuditFromScan(req: Request, env: Env): Promise<Response> {
  const provided = req.headers.get('x-admin-token') ?? '';
  if (!env.ADMIN_TOKEN || !constantTimeEqual(provided, env.ADMIN_TOKEN)) {
    return jsonPublic({ error: 'forbidden' }, { status: 403, req });
  }
  if (!isSigningConfigured(env)) return jsonPublic({ error: 'signing_unavailable' }, { status: 503, req });
  if (!env.BROWSER) return jsonPublic({ error: 'scan_unavailable' }, { status: 503, req });

  const body = await readJsonSmall(req);
  const target = validateTarget((body as { url?: unknown })?.url);
  if (!target) return jsonPublic({ error: 'invalid url' }, { status: 400, req });

  const o = await getOrigin(env, target.origin);
  if (!o || !o.verified_at) {
    return jsonPublic({ error: 'origin not verified — complete /api/verify-origin first' }, { status: 403, req });
  }
  return mintScannedAudit(req, env, target);
}

const MAX_BODY_BYTES = 8 * 1024;
async function readJsonSmall(req: Request): Promise<unknown> {
  const len = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(len) && len > MAX_BODY_BYTES) return undefined;
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}
