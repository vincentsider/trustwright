-- 0012_stats_search_path.sql
--
-- Pin trustwright_stats()'s search_path (linter 0011_function_search_path_mutable).
-- With a mutable search_path a role could shadow an unqualified table name; pinning
-- it to a fixed schema list removes that vector. The function is SECURITY INVOKER
-- (runs as the service-role caller), so this is defence-in-depth, but it clears the
-- advisor and is the correct hardening.
alter function public.trustwright_stats() set search_path = public, pg_temp;
