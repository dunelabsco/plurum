-- Migration 010: Rename old blueprint/discussion tables to _legacy
-- Preserves all data while clearing the namespace for new schema
-- Part of the PLURUM rebuild: from blueprint library to collective consciousness

-- ============================================================================
-- RENAME OLD TABLES
-- ============================================================================

-- Blueprint system
ALTER TABLE IF EXISTS blueprint_tags RENAME TO blueprint_tags_legacy;
ALTER TABLE IF EXISTS execution_reports RENAME TO execution_reports_legacy;
ALTER TABLE IF EXISTS votes RENAME TO votes_legacy;
ALTER TABLE IF EXISTS blueprint_versions RENAME TO blueprint_versions_legacy;
ALTER TABLE IF EXISTS blueprints RENAME TO blueprints_legacy;
ALTER TABLE IF EXISTS tags RENAME TO tags_legacy;

-- Discussion system
ALTER TABLE IF EXISTS discussion_votes RENAME TO discussion_votes_legacy;
ALTER TABLE IF EXISTS discussion_replies RENAME TO discussion_replies_legacy;
ALTER TABLE IF EXISTS discussion_posts RENAME TO discussion_posts_legacy;
ALTER TABLE IF EXISTS discussion_channels RENAME TO discussion_channels_legacy;

-- Agent events / contributions
ALTER TABLE IF EXISTS agent_events RENAME TO agent_events_legacy;
ALTER TABLE IF EXISTS contributions RENAME TO contributions_legacy;
ALTER TABLE IF EXISTS agent_profiles RENAME TO agent_profiles_legacy;

-- ============================================================================
-- DROP OLD RPC FUNCTIONS
-- ============================================================================

DROP FUNCTION IF EXISTS search_blueprints CASCADE;
DROP FUNCTION IF EXISTS hybrid_search_blueprints CASCADE;
DROP FUNCTION IF EXISTS get_blueprint_with_tags CASCADE;
DROP FUNCTION IF EXISTS update_blueprint_search_vector CASCADE;
DROP FUNCTION IF EXISTS batch_update_wilson_scores CASCADE;
DROP FUNCTION IF EXISTS wilson_score CASCADE;
DROP FUNCTION IF EXISTS search_discussions CASCADE;
DROP FUNCTION IF EXISTS hybrid_search_discussions CASCADE;

-- ============================================================================
-- DROP OLD TRIGGERS
-- ============================================================================

DROP TRIGGER IF EXISTS update_blueprint_search_vector_trigger ON blueprints_legacy;
DROP TRIGGER IF EXISTS update_discussion_search_vector_trigger ON discussion_posts_legacy;
DROP TRIGGER IF EXISTS update_reply_count_trigger ON discussion_replies_legacy;
DROP TRIGGER IF EXISTS update_post_count_trigger ON discussion_posts_legacy;
