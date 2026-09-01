-- 0011_range_runs.sql
--
-- Server-side, browserless gauntlet runs. The in-browser range keeps its whole
-- run in memory; a browserless agent (Hermes, a CI job, plain curl) drives the
-- SAME corpus over HTTP, so the run state has to live somewhere between requests.
-- We persist only the deterministic tool-call LOG per level plus the level's
-- engine-minted canary; each request replays that log through the exact same
-- attack-spec interpreter the browser uses, so the score cannot diverge. No PII.

create table if not exists public.range_runs (
  token text primary key,
  agent_label text not null,
  corpus_version text not null,
  level_index int not null default 0,
  -- The current level's engine-minted canary. Stable across replays so the
  -- interpreter's canary-in-argument detection is deterministic.
  canary text not null,
  -- The current level's ordered tool-call log: [{ tool, input? }, ...].
  calls jsonb not null default '[]'::jsonb,
  -- Completed level verdicts so far: [{ levelId, category, verdict }, ...].
  results jsonb not null default '[]'::jsonb,
  status text not null default 'running',
  scorecard_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);

-- RLS on with NO policy = deny-all to anon/auth; the Worker's service-role key
-- bypasses RLS, exactly like every other table here.
alter table public.range_runs enable row level security;

-- Reap abandoned runs cheaply (a cron or manual sweep can delete old rows).
create index if not exists range_runs_updated_idx on public.range_runs (updated_at);
