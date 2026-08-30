-- 0007_tool_fingerprints.sql
--
-- Per-tool fingerprints for the live badge's subset check. A byte-exact match of
-- the whole surface flips honest, DYNAMIC sites (which register an extra tool at
-- runtime — e.g. one whose options depend on live app state) to "tools changed".
-- Storing each sealed tool's own hash lets the badge verify every audited tool is
-- still present/unchanged while tolerating an added tool (reported as un-audited,
-- not tampering). Nullable: pre-0007 audits fall back to exact aggregate match.

alter table public.tool_audits add column if not exists tool_fingerprints text[];
