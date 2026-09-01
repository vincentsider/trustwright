// worker/range.ts
//
// The browserless gauntlet's HTTP surface. Any agent that can make an HTTP call
// (Hermes, a CI job, plain curl) drives the SAME corpus a browser WebMCP agent
// does. Three steps, mirroring the WebMCP tools start_run / (tool calls) /
// complete_level:
//
//   POST /api/range/start           { agentLabel } -> { token, level, tools }
//   POST /api/range/act             { token, tool, input? } -> { result, tools }
//   POST /api/range/complete_level  { token } -> next level, or the final scorecard
//   GET  /api/range/state?token=    -> current status (poll / resume)
//
// The verdict is scored server-side by replaying the agent's tool-call log
// through the identical attack-spec interpreter the browser uses, so a run over
// HTTP ranks on the very same leaderboard as one driven in a browser.

import type { Env } from './types.ts';
import { jsonPublic } from './http.ts';
import { checkRate, clientIp } from './limits.ts';
import { mintCanary } from '../src/range/canary.ts';
import { CORPUS_VERSION } from '../src/range/level.ts';
import { buildScorecard, summarize, type LevelResult } from '../src/range/scoring.ts';
import { LEVEL_COUNT, levelMeta, levelSurface, applyCall, scoreLevel } from './rangeEngine.ts';
import { createRun, getRun, updateRun, type LevelVerdict } from './rangeRuns.ts';
import { insertScorecard } from './supabase.ts';

const MAX_BODY_BYTES = 8 * 1024;
const MAX_CALLS_PER_LEVEL = 40; // a level needs a handful of calls; cap runaway logs
const MAX_INPUT_CHARS = 4000;
const MAX_LABEL = 120;

async function readJsonSmall(req: Request): Promise<unknown> {
  const len = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(len) && len > MAX_BODY_BYTES) return undefined;
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

/** Reject an empty or placeholder label so the leaderboard names a real model. */
function badLabel(label: string): boolean {
  return !label || /^(connected agent|agent|test|unknown|assistant|ai|bot|model)$/i.test(label);
}

const HINT =
  'For each tool you decide to use, POST /api/range/act { token, tool, input }. When you are done with this task, POST /api/range/complete_level { token } to be scored and get the next level.';

/** POST /api/range/start { agentLabel } -> open a run, arm level 1. */
export async function handleRangeStart(req: Request, env: Env): Promise<Response> {
  if (!(await checkRate(env, `${clientIp(req)}:range-start`))) {
    return jsonPublic({ error: 'rate_limited' }, { status: 429, req });
  }
  const body = (await readJsonSmall(req)) as { agentLabel?: unknown } | undefined;
  const label = typeof body?.agentLabel === 'string' ? body.agentLabel.trim().slice(0, MAX_LABEL) : '';
  if (badLabel(label)) {
    return jsonPublic(
      {
        error: 'agentLabel_required',
        message:
          'Set agentLabel to your exact model and how you are connected, e.g. "GPT-5.6 via ChatGPT" or "Claude Opus 4.5 via Hermes". This names you on the public leaderboard.',
      },
      { status: 400, req },
    );
  }

  const token = crypto.randomUUID();
  const canary = mintCanary();
  try {
    await createRun(env, { token, agent_label: label, corpus_version: CORPUS_VERSION, canary });
  } catch {
    return jsonPublic({ error: 'persist_failed' }, { status: 502, req });
  }
  const tools = await levelSurface(0, canary);
  return jsonPublic(
    {
      token,
      agent: label,
      corpusVersion: CORPUS_VERSION,
      totalLevels: LEVEL_COUNT,
      level: levelMeta(0),
      tools: tools ?? [],
      next: HINT,
    },
    { req },
  );
}

/** POST /api/range/act { token, tool, input? } -> run one tool call, return the new surface. */
export async function handleRangeAct(req: Request, env: Env): Promise<Response> {
  if (!(await checkRate(env, `${clientIp(req)}:range-act`))) {
    return jsonPublic({ error: 'rate_limited' }, { status: 429, req });
  }
  const body = (await readJsonSmall(req)) as { token?: unknown; tool?: unknown; input?: unknown } | undefined;
  const token = typeof body?.token === 'string' ? body.token : '';
  const tool = typeof body?.tool === 'string' ? body.tool : '';
  if (!token || !tool) return jsonPublic({ error: 'token_and_tool_required' }, { status: 400, req });

  let input: Record<string, unknown> | undefined;
  if (body?.input !== undefined) {
    if (!body.input || typeof body.input !== 'object' || Array.isArray(body.input)) {
      return jsonPublic({ error: 'input_must_be_object' }, { status: 400, req });
    }
    if (JSON.stringify(body.input).length > MAX_INPUT_CHARS) {
      return jsonPublic({ error: 'input_too_large' }, { status: 413, req });
    }
    input = body.input as Record<string, unknown>;
  }

  const run = await getRun(env, token);
  if (!run) return jsonPublic({ error: 'unknown_token' }, { status: 404, req });
  if (run.status !== 'running') return jsonPublic({ error: 'run_complete' }, { status: 409, req });
  if (run.calls.length >= MAX_CALLS_PER_LEVEL) {
    return jsonPublic({ error: 'too_many_calls', message: 'Call complete_level to move on.' }, { status: 429, req });
  }

  const res = await applyCall(run.level_index, run.canary, run.calls, { tool, ...(input ? { input } : {}) });
  if (!res.ok) {
    if (res.error === 'no_such_tool') {
      return jsonPublic(
        { error: 'no_such_tool', message: `No tool "${tool}" on this level right now.`, tools: res.tools ?? [] },
        { status: 400, req },
      );
    }
    return jsonPublic({ error: 'no_level' }, { status: 500, req });
  }

  try {
    await updateRun(env, token, { calls: [...run.calls, { tool, ...(input ? { input } : {}) }] });
  } catch {
    return jsonPublic({ error: 'persist_failed' }, { status: 502, req });
  }

  return jsonPublic(
    {
      result: res.result,
      tools: res.tools,
      toolsChanged: res.toolsChanged,
      level: levelMeta(run.level_index),
      next: 'Make another tool call, or POST /api/range/complete_level { token } when done with this task.',
    },
    { req },
  );
}

/** POST /api/range/complete_level { token } -> score this level, arm the next, or finish. */
export async function handleRangeComplete(req: Request, env: Env): Promise<Response> {
  if (!(await checkRate(env, `${clientIp(req)}:range-complete`))) {
    return jsonPublic({ error: 'rate_limited' }, { status: 429, req });
  }
  const body = (await readJsonSmall(req)) as { token?: unknown } | undefined;
  const token = typeof body?.token === 'string' ? body.token : '';
  if (!token) return jsonPublic({ error: 'token_required' }, { status: 400, req });

  const run = await getRun(env, token);
  if (!run) return jsonPublic({ error: 'unknown_token' }, { status: 404, req });
  if (run.status !== 'running') return jsonPublic({ error: 'run_complete' }, { status: 409, req });

  const meta = levelMeta(run.level_index);
  if (!meta) return jsonPublic({ error: 'no_level' }, { status: 500, req });
  const verdict = await scoreLevel(run.level_index, run.canary, run.calls);
  const results: LevelVerdict[] = [...run.results, { levelId: meta.id, category: meta.category, verdict }];

  const nextIndex = run.level_index + 1;
  if (nextIndex < LEVEL_COUNT) {
    const nextCanary = mintCanary();
    try {
      await updateRun(env, token, { level_index: nextIndex, canary: nextCanary, calls: [], results });
    } catch {
      return jsonPublic({ error: 'persist_failed' }, { status: 502, req });
    }
    const tools = await levelSurface(nextIndex, nextCanary);
    return jsonPublic(
      {
        done: false,
        scored: { levelId: meta.id, verdict },
        level: levelMeta(nextIndex),
        tools: tools ?? [],
        next: HINT,
      },
      { req },
    );
  }

  // Final level scored: build the scorecard and post it to the same leaderboard.
  const sc = buildScorecard(results as LevelResult[]);
  let scorecardId: string | null = null;
  try {
    const inserted = await insertScorecard(env, {
      agent_label: run.agent_label,
      corpus_version: run.corpus_version,
      decided: sc.decided,
      resisted: sc.resisted,
      partial: sc.partial,
      fell: sc.fell,
      resistance_score: sc.resistanceScore,
      results,
    });
    scorecardId = inserted.id;
  } catch {
    scorecardId = null; // scoring still returns; leaderboard post is best-effort
  }
  try {
    await updateRun(env, token, {
      results,
      status: 'done',
      ...(scorecardId ? { scorecard_id: scorecardId } : {}),
      finished_at: new Date().toISOString(),
    });
  } catch {
    /* the run is scored regardless of the status write */
  }

  return jsonPublic(
    {
      done: true,
      agent: run.agent_label,
      summary: summarize(sc, run.agent_label),
      resistanceScore: sc.resistanceScore,
      resisted: sc.resisted,
      partial: sc.partial,
      fell: sc.fell,
      decided: sc.decided,
      results,
      scorecardId,
      leaderboard: scorecardId !== null,
    },
    { req },
  );
}

/** GET /api/range/state?token= -> current status, for polling or resuming. */
export async function handleRangeState(req: Request, env: Env): Promise<Response> {
  const token = new URL(req.url).searchParams.get('token') ?? '';
  if (!token) return jsonPublic({ error: 'token_required' }, { status: 400, req });
  const run = await getRun(env, token);
  if (!run) return jsonPublic({ error: 'unknown_token' }, { status: 404, req });
  return jsonPublic(
    {
      status: run.status,
      agent: run.agent_label,
      totalLevels: LEVEL_COUNT,
      level: run.status === 'running' ? levelMeta(run.level_index) : null,
      results: run.results,
    },
    { req },
  );
}
