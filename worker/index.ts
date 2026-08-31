// worker/index.ts
//
// The Trustwright Worker: one deploy that serves the static SPA and the /api/*
// surface. It holds every secret (Supabase service-role, detector key); the
// browser holds none. Each endpoint validates input, rate-limits by IP, and
// never leaks internal error detail.
//
// Routes:
//   GET  /api/health         liveness; warms the detector in the background
//   POST /api/scorecard      persist a completed run -> { id }
//   GET  /api/leaderboard    top runs (non-PII) -> { rows }
//   POST /api/lead           email opt-in for the report -> { ok }
//   POST /api/verify-audio   detector proxy (rate-limited + daily-capped)
//   *                        static assets (SPA)

import type { Env, ExecutionContext } from './types.ts';
import { json, preflight, reflectPreflight } from './http.ts';
import {
  handleVerifyOrigin,
  handleVerifyOriginConfirm,
  handleAudit,
  handleRevoke,
  handleBadge,
  handleReport,
  handlePubkey,
  handleManifest,
  handleGetManifest,
} from './badge.ts';
import { handleScan, handleAuditFromScan, handleAuditSelf, handleStats } from './scan.ts';
import { handleGetCorpus, handleGrantCorpus } from './corpus.ts';
import {
  fingerprintSurface,
  FINGERPRINT_ALGO,
  FINGERPRINT_GOLDEN_SURFACE,
  FINGERPRINT_GOLDEN_HASH,
} from '../src/range/fingerprint.ts';
import { validateScorecard, validateLead } from './validate.ts';
import { insertScorecard, insertLead, topScorecards, getScorecardById } from './supabase.ts';
import { sendReportEmail, isEmailConfigured } from './email.ts';
import { checkRate, underDailyCap, clientIp } from './limits.ts';
import { analyzeAudio, warmDetector, MAX_AUDIO_BYTES } from './detector.ts';
import { runOwnershipRecheck } from './maintenance.ts';
import { getOrigin } from './audits.ts';

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

async function handleScorecard(req: Request, env: Env): Promise<Response> {
  if (!(await checkRate(env, `${clientIp(req)}:scorecard`))) {
    return json({ error: 'rate_limited' }, { status: 429, req, env });
  }
  const parsed = validateScorecard(await readJson(req));
  if (!parsed.ok) return json({ error: parsed.error }, { status: 400, req, env });
  try {
    const { id } = await insertScorecard(env, parsed.value);
    return json({ id }, { req, env });
  } catch {
    return json({ error: 'persist_failed' }, { status: 502, req, env });
  }
}

async function handleLeaderboard(req: Request, env: Env): Promise<Response> {
  if (!(await checkRate(env, `${clientIp(req)}:leaderboard`))) {
    return json({ error: 'rate_limited' }, { status: 429, req, env });
  }
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get('limit') ?? '20');
  try {
    const rows = await topScorecards(env, Number.isFinite(limit) ? limit : 20);
    return json({ rows }, { req, env });
  } catch {
    return json({ error: 'query_failed' }, { status: 502, req, env });
  }
}

async function handleLead(req: Request, env: Env): Promise<Response> {
  if (!(await checkRate(env, `${clientIp(req)}:lead`))) {
    return json({ error: 'rate_limited' }, { status: 429, req, env });
  }
  const parsed = validateLead(await readJson(req));
  if (!parsed.ok) return json({ error: parsed.error }, { status: 400, req, env });
  try {
    await insertLead(env, parsed.value);
  } catch {
    return json({ error: 'persist_failed' }, { status: 502, req, env });
  }

  // Best-effort report email (only if configured AND we have a scorecard to send).
  // Never blocks or fails the capture: emailed reflects whether it actually sent.
  let emailed = false;
  if (isEmailConfigured(env) && parsed.value.scorecard_id) {
    try {
      const sc = await getScorecardById(env, parsed.value.scorecard_id);
      if (sc) emailed = await sendReportEmail(env, parsed.value.email, sc);
    } catch {
      emailed = false;
    }
  }
  return json({ ok: true, emailed }, { req, env });
}

async function handleVerifyAudio(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // Reject an oversized upload BEFORE anything else (cheap DoS guard; also avoids
  // spending a rate-limit or daily-cap slot on a request we will not process).
  const declaredLen = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLen) && declaredLen > MAX_AUDIO_BYTES + 4096) {
    return json({ error: 'audio_too_large' }, { status: 413, req, env });
  }
  if (!(await checkRate(env, `${clientIp(req)}:verify`))) {
    return json({ error: 'rate_limited' }, { status: 429, req, env });
  }
  const cap = Number(env.DETECTOR_DAILY_CAP ?? '500');
  if (!(await underDailyCap(env, 'verify', Number.isFinite(cap) ? cap : 500))) {
    return json({ status: 'unavailable', reason: 'daily_cap' }, { status: 503, req, env });
  }

  // Read the uploaded audio (multipart) with a hard size guard.
  let audio: Blob | null = null;
  try {
    const form = await req.formData();
    const file = form.get('audio');
    if (file instanceof Blob) audio = file;
  } catch {
    return json({ error: 'bad_upload' }, { status: 400, req, env });
  }
  if (!audio || audio.size === 0) return json({ error: 'no_audio' }, { status: 400, req, env });
  if (audio.size > MAX_AUDIO_BYTES) return json({ error: 'audio_too_large' }, { status: 413, req, env });

  const result = await analyzeAudio(env, audio);
  // Keep the container warm for the next caller regardless of this outcome.
  ctx.waitUntil(warmDetector(env));
  return json(result, { req, env });
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    // Mode-2 endpoints are the public product surface: any audited site calls
    // them cross-origin, so they use permissive (reflected) CORS.
    const MODE2 = new Set([
      '/api/verify-origin',
      '/api/verify-origin/confirm',
      '/api/audit',
      '/api/audit/revoke',
      '/api/audit/from-scan',
      '/api/audit/self',
      '/api/scan',
      '/api/badge',
      '/api/pubkey',
      '/api/manifest',
      '/api/corpus',
    ]);

    if (req.method === 'OPTIONS') {
      return MODE2.has(url.pathname) ? reflectPreflight(req) : preflight(req, env);
    }

    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/health' && req.method === 'GET') {
        ctx.waitUntil(warmDetector(env));
        return json({ ok: true, service: 'trustwright' }, { req, env });
      }
      // Fingerprint drift sentinel: the DEPLOYED worker recomputes the golden
      // surface and reports whether it still matches the pin. badge.js imports
      // the same module, so a mismatch here means the two bundles have drifted
      // (Bug 2). A monitor can poll this after every deploy.
      if (url.pathname === '/api/fingerprint-selftest' && req.method === 'GET') {
        const actual = await fingerprintSurface(FINGERPRINT_GOLDEN_SURFACE);
        return json(
          {
            algo: FINGERPRINT_ALGO,
            expected: FINGERPRINT_GOLDEN_HASH,
            actual,
            ok: actual === FINGERPRINT_GOLDEN_HASH,
          },
          { req, env, status: actual === FINGERPRINT_GOLDEN_HASH ? 200 : 500 },
        );
      }
      if (url.pathname === '/api/corpus' && req.method === 'GET') return handleGetCorpus(req, env);
      if (url.pathname === '/api/corpus/grant' && req.method === 'POST') return handleGrantCorpus(req, env);
      if (url.pathname === '/api/scorecard' && req.method === 'POST') return handleScorecard(req, env);
      if (url.pathname === '/api/leaderboard' && req.method === 'GET') return handleLeaderboard(req, env);
      if (url.pathname === '/api/lead' && req.method === 'POST') return handleLead(req, env);
      if (url.pathname === '/api/verify-audio' && req.method === 'POST') {
        return handleVerifyAudio(req, env, ctx);
      }
      // Mode 2 (badge).
      if (url.pathname === '/api/verify-origin' && req.method === 'POST') return handleVerifyOrigin(req, env);
      if (url.pathname === '/api/verify-origin/confirm' && req.method === 'POST') return handleVerifyOriginConfirm(req, env);
      if (url.pathname === '/api/audit' && req.method === 'POST') return handleAudit(req, env);
      if (url.pathname === '/api/audit/revoke' && req.method === 'POST') return handleRevoke(req, env);
      if (url.pathname === '/api/audit/from-scan' && req.method === 'POST') return handleAuditFromScan(req, env);
      if (url.pathname === '/api/audit/self' && req.method === 'POST') return handleAuditSelf(req, env);
      if (url.pathname === '/api/scan' && req.method === 'POST') return handleScan(req, env, ctx);
      if (url.pathname === '/api/stats' && req.method === 'GET') return handleStats(req, env);
      if (url.pathname === '/api/badge' && req.method === 'GET') return handleBadge(req, env);
      if (url.pathname === '/api/report' && req.method === 'GET') return handleReport(req, env);
      if (url.pathname === '/api/pubkey' && req.method === 'GET') return handlePubkey(req, env);
      if (url.pathname === '/api/manifest' && req.method === 'POST') return handleManifest(req, env);
      if (url.pathname === '/api/manifest' && req.method === 'GET') return handleGetManifest(req, env);
      return json({ error: 'not_found' }, { status: 404, req, env });
    }

    // Ownership-proof file for THIS worker's own origin(s) — dogfooding: it lets
    // trustwright.deepblocker.ai prove control of itself so it can carry its own
    // badge, and keeps the hourly re-check from revoking it. Serves the stored
    // challenge_token for `https://<host>` as text/plain; 404 if none. Only the
    // origins this worker serves can be answered here, so it grants nothing to
    // anyone else.
    if (url.pathname === '/.well-known/trustwright-challenge.txt' && req.method === 'GET') {
      const o = await getOrigin(env, `https://${url.host}`);
      if (o?.challenge_token) {
        return new Response(o.challenge_token, {
          headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
        });
      }
      return new Response('not found', { status: 404 });
    }

    // Everything else is the SPA. not_found_handling=single-page-application
    // in wrangler.toml serves index.html for client-side routes. The WebMCP
    // origin-trial token is attached via public/_headers (the asset server serves
    // static files directly, bypassing this handler, so a header set here would
    // not reach them).
    if (env.ASSETS) return env.ASSETS.fetch(req);
    return new Response('Not found', { status: 404 });
  },

  // Cron dispatch (wrangler [triggers] crons). Branch on the pattern so each
  // schedule does exactly its own job:
  //   "*/3 * * * *"  detector keep-warm (never cold in the judging window)
  //   "17 * * * *"   hourly ownership re-check (revoke badges whose proof left)
  async scheduled(event: { cron?: string }, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event?.cron === '17 * * * *') {
      ctx.waitUntil(runOwnershipRecheck(env).then(() => undefined));
      return;
    }
    ctx.waitUntil(warmDetector(env));
  },
};
