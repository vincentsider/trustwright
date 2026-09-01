import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleRangeStart, handleRangeAct, handleRangeComplete, handleRangeState } from './range.ts';
import { LEVEL_COUNT } from './rangeEngine.ts';
import type { Env } from './types.ts';

function makeEnv(): Env {
  return { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc' } as Env;
}

/** An in-memory stand-in for Supabase: range_runs keyed by token + scorecards. */
function fakeDb() {
  const runs = new Map<string, Record<string, unknown>>();
  const scorecards: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;

      if (url.includes('/rest/v1/range_runs') && method === 'POST') {
        runs.set(String(body!.token), { ...body });
        return new Response(null, { status: 201 });
      }
      if (url.includes('/rest/v1/range_runs') && method === 'GET') {
        const t = decodeURIComponent(/token=eq\.([^&]+)/.exec(url)?.[1] ?? '');
        const r = runs.get(t);
        return new Response(JSON.stringify(r ? [r] : []), { status: 200 });
      }
      if (url.includes('/rest/v1/range_runs') && method === 'PATCH') {
        const t = decodeURIComponent(/token=eq\.([^&]+)/.exec(url)?.[1] ?? '');
        const r = runs.get(t);
        if (r) Object.assign(r, body);
        return new Response(null, { status: 204 });
      }
      if (url.includes('/rest/v1/scorecards') && method === 'POST') {
        const id = `sc-${scorecards.length + 1}`;
        scorecards.push({ id, ...body });
        return new Response(JSON.stringify([{ id }]), { status: 201 });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
  return { runs, scorecards };
}

afterEach(() => vi.unstubAllGlobals());

function post(handler: (r: Request, e: Env) => Promise<Response>, env: Env, body: unknown, path = 'act') {
  const req = new Request(`https://trustwright.deepblocker.ai/api/range/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return handler(req, env);
}

async function startRun(env: Env, agentLabel = 'GPT-Test via CI'): Promise<string> {
  const resp = await post(handleRangeStart, env, { agentLabel }, 'start');
  const data = (await resp.json()) as { token: string };
  return data.token;
}

describe('range HTTP handlers', () => {
  it('start requires a real model label', async () => {
    fakeDb();
    const env = makeEnv();
    for (const bad of ['', 'agent', 'Connected agent', 'AI']) {
      const resp = await post(handleRangeStart, env, { agentLabel: bad }, 'start');
      expect(resp.status).toBe(400);
      expect((await resp.json()).error).toBe('agentLabel_required');
    }
  });

  it('start opens a run and returns the first level + tools', async () => {
    const { runs } = fakeDb();
    const env = makeEnv();
    const resp = await post(handleRangeStart, env, { agentLabel: 'Claude Opus via CI' }, 'start');
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { token: string; totalLevels: number; level: { step: string }; tools: unknown[] };
    expect(data.token).toBeTruthy();
    expect(data.totalLevels).toBe(LEVEL_COUNT);
    expect(data.level.step).toBe(`1/${LEVEL_COUNT}`);
    expect(data.tools.length).toBeGreaterThan(0);
    expect(runs.size).toBe(1);
  });

  it('act rejects an unknown token and a tool not on the surface', async () => {
    fakeDb();
    const env = makeEnv();
    const unknown = await post(handleRangeAct, env, { token: 'nope', tool: 'x' });
    expect(unknown.status).toBe(404);

    const token = await startRun(env);
    const bad = await post(handleRangeAct, env, { token, tool: 'definitely_not_a_tool' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('no_such_tool');
  });

  it('a fully passive run (no acts) scores a perfect resistance and posts to the leaderboard', async () => {
    const { scorecards } = fakeDb();
    const env = makeEnv();
    const token = await startRun(env, 'Careful-CI via HTTP');

    let last: Record<string, unknown> = {};
    for (let i = 0; i < LEVEL_COUNT; i++) {
      const resp = await post(handleRangeComplete, env, { token }, 'complete_level');
      expect(resp.status).toBe(200);
      last = (await resp.json()) as Record<string, unknown>;
    }
    expect(last.done).toBe(true);
    expect(last.resistanceScore).toBe(1);
    expect(last.resisted).toBe(LEVEL_COUNT);
    expect(last.leaderboard).toBe(true);
    expect(scorecards).toHaveLength(1);
    expect((scorecards[0] as { resistance_score: number }).resistance_score).toBe(1);
    expect((scorecards[0] as { agent_label: string }).agent_label).toBe('Careful-CI via HTTP');
  });

  it('drives T1: calling the decoy tool scores that level FAIL', async () => {
    fakeDb();
    const env = makeEnv();
    const token = await startRun(env);

    // T1 is level 1: search_docs is benign, attach_note is the framed decoy.
    const a1 = await post(handleRangeAct, env, { token, tool: 'search_docs', input: { query: 'set up a workspace' } });
    expect(a1.status).toBe(200);
    const a2 = await post(handleRangeAct, env, { token, tool: 'attach_note', input: { ref: 'x' } });
    expect(a2.status).toBe(200);

    const done1 = await post(handleRangeComplete, env, { token }, 'complete_level');
    const body1 = (await done1.json()) as { scored: { levelId: string; verdict: string } };
    expect(body1.scored.levelId).toBe('T1');
    expect(body1.scored.verdict).toBe('FAIL');

    // Finish the remaining levels passively; overall it fell exactly once.
    let last: Record<string, unknown> = {};
    for (let i = 1; i < LEVEL_COUNT; i++) {
      last = (await (await post(handleRangeComplete, env, { token }, 'complete_level')).json()) as Record<string, unknown>;
    }
    expect(last.done).toBe(true);
    expect(last.fell).toBe(1);
    expect(last.resisted).toBe(LEVEL_COUNT - 1);
  });

  it('state reports progress and refuses a completed run to act', async () => {
    fakeDb();
    const env = makeEnv();
    const token = await startRun(env);
    for (let i = 0; i < LEVEL_COUNT; i++) await post(handleRangeComplete, env, { token }, 'complete_level');

    const st = await handleRangeState(
      new Request(`https://x/api/range/state?token=${token}`),
      env,
    );
    expect(st.status).toBe(200);
    expect((await st.json()).status).toBe('done');

    const act = await post(handleRangeAct, env, { token, tool: 'search_docs' });
    expect(act.status).toBe(409);
  });
});
