// worker/types.ts
//
// Minimal ambient declarations for the Cloudflare-specific bindings the Worker
// uses. Declaring them here (rather than pulling in @cloudflare/workers-types)
// keeps the Worker typechecking under the same DOM-lib tsconfig as the browser
// code, with no Request/Response/fetch type clashes.

import type { BrowserWorker } from '@cloudflare/puppeteer';

/** Cloudflare Rate Limiting binding (wrangler [[ratelimits]]). */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** A subset of Workers KV, enough for the detector daily-cap counter. */
export interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
}

/** Static-assets fetcher binding. */
export interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

/** The slice of ExecutionContext we use. */
export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

/** Everything the Worker reads from its environment. Secrets are marked. */
export interface Env {
  // Vars (wrangler [vars]) — not secret.
  SUPABASE_URL: string;
  ALLOWED_ORIGINS?: string; // comma-separated; empty = same-origin only
  DEEPFAKE_ROUTER_URL?: string;
  DETECTOR_DAILY_CAP?: string; // integer as string
  SCAN_DAILY_CAP?: string; // global daily ceiling on /api/scan browser launches, default 500
  // Mode 2 (badge). Public/non-secret.
  TRUSTWRIGHT_PUBKEY?: string; // Ed25519 public key (spki, base64) — safe to publish
  TRUSTWRIGHT_KEY_ID?: string; // which key signed (default "k1")
  BADGE_TTL_DAYS?: string; // audit expiry, default 90
  OWNERSHIP_GRACE_DAYS?: string; // days a proof may be absent before revoke, default 3
  RECHECK_BATCH?: string; // max origins re-checked per cron tick, default 25
  MONITOR_BATCH?: string; // max badges re-scanned per monitor tick, default 50
  MONITOR_EXPIRY_WARN_DAYS?: string; // warn this many days before a badge expires, default 7

  // Secrets (wrangler secret put) — NEVER in wrangler.toml or the repo.
  SUPABASE_SERVICE_ROLE_KEY: string;
  DEEPFAKE_API_KEY?: string;
  // Email delivery (optional). Both must be set to actually send a report email;
  // without them, a lead is captured and emailed:false is returned.
  RESEND_API_KEY?: string;
  RESEND_FROM?: string; // e.g. "Trustwright <reports@deepblocker.ai>"
  // Operator alerts via Postmark (badge drift / revoke / near-expiry). Both the
  // server token and a destination address must be set to actually send; without
  // them the monitor still runs and records health, it just does not email.
  POSTMARK_SERVER_API_KEY?: string; // Postmark server token (X-Postmark-Server-Token)
  POSTMARK_FROM?: string; // verified sender, default "Trustwright <shield@deepblocker.ai>"
  ALERT_EMAIL?: string; // where badge-health alerts go (e.g. the operator)
  // Mode 2 signing + admin (secrets).
  ED25519_PRIVATE_KEY?: string; // PKCS8, base64 — signs badges/reports
  ADMIN_TOKEN?: string; // gates the WRITE ops: /api/audit/from-scan, /api/audit/revoke, /api/corpus/grant
  STATS_TOKEN?: string; // READ-ONLY: gates /api/stats only (least privilege for the dashboard); ADMIN_TOKEN also works
  // (The Chrome WebMCP origin-trial token is served via public/_headers, not here —
  //  the asset server bypasses the Worker for static files.)

  // Bindings.
  RATE_LIMITER?: RateLimiter;
  DAILY?: KVNamespace;
  ASSETS?: Fetcher;
  // Cloudflare Browser Rendering (wrangler [browser]). Present only when the
  // binding is configured (needs the Workers Paid plan). When absent, /api/scan
  // fails closed (503).
  BROWSER?: BrowserWorker;
}
