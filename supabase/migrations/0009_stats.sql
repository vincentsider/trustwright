-- 0009_stats.sql
--
-- Success metrics for Trustwright. Two pieces:
--   1. scan_events — a lightweight log of every consumer scan (/api/scan), so we
--      can count how many scans ran and which sites were checked. No IP/PII, just
--      the (public) scanned origin + a timestamp. RLS deny-all (service-role only).
--   2. trustwright_stats() — one function that returns the whole dashboard as JSON
--      (badges + which sites, verification funnel, scans, agent tests, leads), so
--      the admin /api/stats endpoint is a single call.

create table if not exists public.scan_events (
  id uuid primary key default gen_random_uuid(),
  origin text not null,
  kind text not null default 'scan',
  created_at timestamptz not null default now()
);
alter table public.scan_events enable row level security; -- deny-all; the Worker uses the service role
create index if not exists scan_events_created_at_idx on public.scan_events (created_at desc);
create index if not exists scan_events_origin_idx on public.scan_events (origin);

create or replace function public.trustwright_stats()
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'generatedAt', now(),
    'badges', jsonb_build_object(
      'active', (select count(distinct origin) from tool_audits where revoked_at is null and (expires_at is null or expires_at > now())),
      'everMinted', (select count(distinct origin) from tool_audits),
      'sites', (
        select coalesce(jsonb_agg(o order by o), '[]'::jsonb)
        from (select distinct origin as o from tool_audits where revoked_at is null and (expires_at is null or expires_at > now())) s
      )
    ),
    'verification', jsonb_build_object(
      'started', (select count(*) from origins),
      'verified', (select count(*) from origins where verified_at is not null)
    ),
    'scans', jsonb_build_object(
      'total', (select count(*) from scan_events where kind = 'scan'),
      'last7d', (select count(*) from scan_events where kind = 'scan' and created_at > now() - interval '7 days'),
      'uniqueSites', (select count(distinct origin) from scan_events where kind = 'scan'),
      'topSites', (
        select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb)
        from (select origin, count(*)::int as scans from scan_events where kind = 'scan' group by origin order by count(*) desc limit 12) t
      )
    ),
    'agentTests', jsonb_build_object(
      'total', (select count(*) from scorecards),
      'last7d', (select count(*) from scorecards where created_at > now() - interval '7 days'),
      'avgResistance', (select round(avg(resistance_score)::numeric, 3) from scorecards)
    ),
    'leads', (select count(*) from leads)
  );
$$;
