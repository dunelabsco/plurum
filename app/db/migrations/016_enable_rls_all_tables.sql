-- Migration 016: Enable RLS on all tables and fix permissive policies
-- Supabase security advisory: tables without RLS are accessible via anon key
--
-- Problem: 7 new tables (sessions, session_entries, experiences, outcome_reports,
-- experience_votes, session_contributions, inbox_events) have NO RLS at all.
-- Additionally, existing tables use FOR ALL USING (true) without role scoping,
-- which grants access to anon/authenticated roles — not just service_role.
--
-- Fix: Enable RLS everywhere, scope all policies to service_role only.
-- The backend uses the service_role key and is the only authorized data path.
-- Frontend uses the anon key for auth only (Supabase Auth), never for direct table access.
--
-- NOTE: Old tables were renamed to _legacy suffix in migration 010.

-- ============================================================================
-- STEP 1: Enable RLS on new tables that are missing it
-- ============================================================================

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE experiences ENABLE ROW LEVEL SECURITY;
ALTER TABLE outcome_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE experience_votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_contributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox_events ENABLE ROW LEVEL SECURITY;

-- Also enable on agent_contribution_events (missed in earlier migrations)
ALTER TABLE agent_contribution_events ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- STEP 2: Create service_role-only policies for new tables
-- ============================================================================

CREATE POLICY "Service role full access" ON sessions
    FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access" ON session_entries
    FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access" ON experiences
    FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access" ON outcome_reports
    FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access" ON experience_votes
    FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access" ON session_contributions
    FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access" ON inbox_events
    FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access" ON agent_contribution_events
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================================================
-- STEP 3: Fix agents table — drop overly permissive policy and replace
-- with service_role-scoped one (agents was NOT renamed to _legacy)
-- ============================================================================

DROP POLICY IF EXISTS "Service role full access" ON agents;
CREATE POLICY "Service role full access" ON agents
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================================================
-- STEP 4: Fix legacy tables — these were renamed from their original names
-- in migration 010. RLS policies followed the rename.
-- ============================================================================

-- blueprints_legacy (was blueprints)
DROP POLICY IF EXISTS "Service role full access" ON blueprints_legacy;
CREATE POLICY "Service role full access" ON blueprints_legacy
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- blueprint_versions_legacy (was blueprint_versions)
DROP POLICY IF EXISTS "Service role full access" ON blueprint_versions_legacy;
CREATE POLICY "Service role full access" ON blueprint_versions_legacy
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- blueprint_tags_legacy (was blueprint_tags)
DROP POLICY IF EXISTS "Service role full access" ON blueprint_tags_legacy;
CREATE POLICY "Service role full access" ON blueprint_tags_legacy
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- execution_reports_legacy (was execution_reports)
DROP POLICY IF EXISTS "Service role full access" ON execution_reports_legacy;
CREATE POLICY "Service role full access" ON execution_reports_legacy
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- votes_legacy (was votes)
DROP POLICY IF EXISTS "Service role full access" ON votes_legacy;
CREATE POLICY "Service role full access" ON votes_legacy
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- tags_legacy (was tags)
DROP POLICY IF EXISTS "Service role full access" ON tags_legacy;
CREATE POLICY "Service role full access" ON tags_legacy
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- discussion_channels_legacy (was discussion_channels)
DROP POLICY IF EXISTS "Service role full access" ON discussion_channels_legacy;
CREATE POLICY "Service role full access" ON discussion_channels_legacy
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- discussion_posts_legacy (was discussion_posts)
DROP POLICY IF EXISTS "Service role full access" ON discussion_posts_legacy;
CREATE POLICY "Service role full access" ON discussion_posts_legacy
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- discussion_replies_legacy (was discussion_replies)
DROP POLICY IF EXISTS "Service role full access" ON discussion_replies_legacy;
CREATE POLICY "Service role full access" ON discussion_replies_legacy
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- discussion_votes_legacy (was discussion_votes)
DROP POLICY IF EXISTS "Service role full access" ON discussion_votes_legacy;
CREATE POLICY "Service role full access" ON discussion_votes_legacy
    FOR ALL TO service_role USING (true) WITH CHECK (true);
