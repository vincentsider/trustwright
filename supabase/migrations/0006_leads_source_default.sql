-- 0006_leads_source_default.sql
--
-- Rebrand cleanup: the leads.source column defaulted to the old product name
-- 'tripwire'. The worker always sets source explicitly ('trustwright' in
-- worker/validate.ts), so this default was never actually written — this just
-- removes the last stale brand string from the schema itself.

alter table public.leads alter column source set default 'trustwright';
