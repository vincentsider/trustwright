// worker/corpus.ts
//
// The corpus delivery + entitlement surface — the server half of v2 monetization.
//   GET  /api/corpus?tier=premium   returns the PREMIUM attack specs, but ONLY to
//                                    a caller presenting a valid entitlement token.
//   GET  /api/corpus?tier=public    returns [] (public specs already ship in the
//                                    client bundle); provided for symmetry.
//   POST /api/corpus/grant          admin-only: mint an entitlement token (stubbed
//                                    billing — a Stripe webhook would call this).
//
// Specs are DATA. The client validates every spec it receives with the SAME
// validateSpec before interpreting it, so a gated premium spec is exactly as safe
// as a bundled one — no code is ever shipped.

import type { Env } from './types.ts';
import { jsonPublic } from './http.ts';
import { checkRate, clientIp } from './limits.ts';
import { getCorpusTier, insertCorpusEntitlement } from './audits.ts';
import { PREMIUM_SPECS } from './premiumCorpus.ts';
import { bytesToBase64, constantTimeEqual } from './crypto.ts';

function newCorpusToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const b64 = bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `corpus-${b64}`;
}

/** GET /api/corpus?tier=public|premium — premium requires a valid entitlement. */
export async function handleGetCorpus(req: Request, env: Env): Promise<Response> {
  if (!(await checkRate(env, `${clientIp(req)}:corpus`))) {
    return jsonPublic({ error: 'rate_limited' }, { status: 429, req });
  }
  const url = new URL(req.url);
  const tier = url.searchParams.get('tier') ?? 'public';
  if (tier === 'public') return jsonPublic({ tier: 'public', specs: [] }, { req });
  if (tier !== 'premium') return jsonPublic({ error: 'invalid tier' }, { status: 400, req });

  const token = req.headers.get('x-corpus-token') ?? url.searchParams.get('token') ?? '';
  if (!token) return jsonPublic({ error: 'entitlement_required' }, { status: 401, req });
  let granted: string | null;
  try {
    granted = await getCorpusTier(env, token);
  } catch {
    return jsonPublic({ error: 'lookup_failed' }, { status: 502, req });
  }
  if (granted !== 'premium') return jsonPublic({ error: 'not_entitled' }, { status: 403, req });
  return jsonPublic({ tier: 'premium', specs: PREMIUM_SPECS }, { req });
}

/** POST /api/corpus/grant { label?, days? } (admin) -> a new entitlement token. */
export async function handleGrantCorpus(req: Request, env: Env): Promise<Response> {
  const provided = req.headers.get('x-admin-token') ?? '';
  if (!env.ADMIN_TOKEN || !constantTimeEqual(provided, env.ADMIN_TOKEN)) {
    return jsonPublic({ error: 'forbidden' }, { status: 403, req });
  }
  const body = (await req.json().catch(() => ({}))) as { label?: unknown; days?: unknown };
  const days = Number(body?.days);
  const expires_at = Number.isFinite(days) && days > 0 ? new Date(Date.now() + days * 86_400_000).toISOString() : null;
  const label = typeof body?.label === 'string' ? body.label.slice(0, 200) : null;
  const token = newCorpusToken();
  try {
    await insertCorpusEntitlement(env, { token, tier: 'premium', label, expires_at });
  } catch {
    return jsonPublic({ error: 'persist_failed' }, { status: 502, req });
  }
  return jsonPublic({ token, tier: 'premium', expiresAt: expires_at }, { req });
}
