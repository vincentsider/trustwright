-- 0008_audit_tools.sql
--
-- The compact tool list an audit covered (name, description, safety hints, param
-- names), so the public report page can SHOW every tool Trustwright read — the
-- transparency that lets someone see exactly what was scanned. Nullable: pre-0008
-- audits simply don't list tools until re-minted.

alter table public.tool_audits add column if not exists tools jsonb;
