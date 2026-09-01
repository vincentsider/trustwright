// worker/rangeRuns.ts
//
// PostgREST access for the browserless gauntlet's run state (table range_runs).
// Service-role only; the browser/agent never touches Supabase. A run holds only
// the deterministic tool-call LOG for the current level plus that level's canary
// and the verdicts decided so far — no PII.

import type { Env } from './types.ts';
import type { RangeCall } from './rangeEngine.ts';

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

export interface LevelVerdict {
  levelId: string;
  category: string;
  verdict: string;
  // All-string fields + index signature so a LevelVerdict[] is a valid JSON value
  // for the scorecards.results column without a cast.
  [k: string]: string;
}

export interface RangeRun {
  token: string;
  agent_label: string;
  corpus_version: string;
  level_index: number;
  canary: string;
  calls: RangeCall[];
  results: LevelVerdict[];
  status: 'running' | 'done';
  scorecard_id: string | null;
}

export interface NewRun {
  token: string;
  agent_label: string;
  corpus_version: string;
  canary: string;
}

/** Create a new run row. Throws on a non-2xx. */
export async function createRun(env: Env, row: NewRun): Promise<void> {
  const resp = await fetch(sbUrl(env, 'range_runs'), {
    method: 'POST',
    headers: sbHeaders(env, { Prefer: 'return=minimal' }),
    body: JSON.stringify({
      token: row.token,
      agent_label: row.agent_label,
      corpus_version: row.corpus_version,
      canary: row.canary,
      level_index: 0,
      calls: [],
      results: [],
      status: 'running',
    }),
  });
  if (!resp.ok) throw new Error(`range_runs insert failed: ${resp.status}`);
}

/** Load one run by token, or null if it is missing. */
export async function getRun(env: Env, token: string): Promise<RangeRun | null> {
  const q =
    `range_runs?token=eq.${encodeURIComponent(token)}` +
    '&select=token,agent_label,corpus_version,level_index,canary,calls,results,status,scorecard_id&limit=1';
  const resp = await fetch(sbUrl(env, q), { headers: sbHeaders(env) });
  if (!resp.ok) return null;
  const rows = (await resp.json()) as RangeRun[];
  return rows[0] ?? null;
}

/** Patch a run (partial). Best-effort caller decides which fields to send. */
export async function updateRun(
  env: Env,
  token: string,
  patch: Partial<Pick<RangeRun, 'level_index' | 'canary' | 'calls' | 'results' | 'status' | 'scorecard_id'>> & {
    finished_at?: string;
  },
): Promise<void> {
  const resp = await fetch(sbUrl(env, `range_runs?token=eq.${encodeURIComponent(token)}`), {
    method: 'PATCH',
    headers: sbHeaders(env, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
  if (!resp.ok) throw new Error(`range_runs update failed: ${resp.status}`);
}
