-- 0010_badge_monitor.sql
--
-- Server-side badge monitoring. A daily job re-scans each active badge's origin
-- and compares the live tool fingerprint to the sealed one, so a drift ("tools
-- changed") is detected WITHOUT waiting for a visitor to load the page. These
-- columns record the last check and whether the badge is currently drifted; the
-- job alerts the operator by email on the transition into drift.

alter table public.tool_audits add column if not exists last_checked_at timestamptz;
alter table public.tool_audits add column if not exists last_live_fingerprint text;
alter table public.tool_audits add column if not exists drift_detected_at timestamptz;

-- Extend the stats dashboard with per-origin badge health.
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
    'badgeHealth', (
      select coalesce(jsonb_agg(row_to_json(h) order by (h.drift_detected_at is not null) desc, h.origin), '[]'::jsonb)
      from (
        select origin,
               left(fingerprint, 12) as fingerprint,
               (drift_detected_at is not null) as drifted,
               last_checked_at,
               expires_at
        from tool_audits
        where revoked_at is null and (expires_at is null or expires_at > now())
      ) h
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
