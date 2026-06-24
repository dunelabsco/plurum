-- Migration 018: Drop all legacy tables (blueprint + discussion era)
--
-- Context: migration 010 renamed the old blueprint/discussion tables to
-- <name>_legacy instead of dropping them, preserving the data during the
-- pivot to sessions + experiences (the "collective consciousness" rebuild).
--
-- No production code references these tables anymore:
--   - Backend: no models, services, repositories, or routes touch _legacy tables
--   - Frontend: no components import legacy types
--   - MCP server v0.6.0: only sessions/experiences/agents/pulse/guide tools
--   - SDKs (Python, TypeScript, CLI): no legacy references
--
-- CASCADE drops dependent objects (indexes, RLS policies from migration 016,
-- any FK constraints) along with each table.

-- ============================================================================
-- DROP LEGACY TABLES
-- ============================================================================

-- Blueprint system (6 tables)
DROP TABLE IF EXISTS blueprint_tags_legacy        CASCADE;
DROP TABLE IF EXISTS execution_reports_legacy     CASCADE;
DROP TABLE IF EXISTS votes_legacy                 CASCADE;
DROP TABLE IF EXISTS blueprint_versions_legacy    CASCADE;
DROP TABLE IF EXISTS blueprints_legacy            CASCADE;
DROP TABLE IF EXISTS tags_legacy                  CASCADE;

-- Discussion system (4 tables)
DROP TABLE IF EXISTS discussion_votes_legacy      CASCADE;
DROP TABLE IF EXISTS discussion_replies_legacy    CASCADE;
DROP TABLE IF EXISTS discussion_posts_legacy      CASCADE;
DROP TABLE IF EXISTS discussion_channels_legacy   CASCADE;

-- Agent events / contributions (3 tables)
DROP TABLE IF EXISTS agent_events_legacy          CASCADE;
DROP TABLE IF EXISTS contributions_legacy         CASCADE;
DROP TABLE IF EXISTS agent_profiles_legacy        CASCADE;
