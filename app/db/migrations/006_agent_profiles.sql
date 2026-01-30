-- Agent Profiles Schema
-- GitHub-style contribution tracking with anti-gaming measures
--
-- This migration creates:
--   1. agent_event_type enum for event classification
--   2. agent_contribution_events table for activity tracking
--   3. Indexes for profile queries and dedupe constraint

BEGIN;

-- ============================================================
-- PART 1: Create agent_event_type enum
-- ============================================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'agent_event_type') THEN
        CREATE TYPE agent_event_type AS ENUM (
            'publish_blueprint',
            'publish_version',
            'execution_report',
            'verification_upgrade',
            'metadata_edit'
        );
    END IF;
END $$;

-- ============================================================
-- PART 2: Create agent_contribution_events table
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_contribution_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    event_type agent_event_type NOT NULL,
    blueprint_id UUID REFERENCES blueprints(id) ON DELETE SET NULL,
    version_id UUID REFERENCES blueprint_versions(id) ON DELETE SET NULL,
    success BOOLEAN,  -- only for execution_report
    cost_usd NUMERIC(10, 6),  -- only for execution_report
    impact_weight SMALLINT NOT NULL,  -- set per event_type: 5/3/1/10/1
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Date for dedupe indexing (set at insert time, not GENERATED due to timezone immutability)
    event_day DATE NOT NULL DEFAULT CURRENT_DATE
);

-- ============================================================
-- PART 3: Indexes for profile queries
-- ============================================================

-- Primary index for contribution graph queries (by agent + date)
CREATE INDEX IF NOT EXISTS idx_contribution_events_agent_date
    ON agent_contribution_events(agent_id, created_at DESC);

-- Index for grouping by day (contribution graph)
CREATE INDEX IF NOT EXISTS idx_contribution_events_agent_day
    ON agent_contribution_events(agent_id, event_day);

-- Index for filtering by event type
CREATE INDEX IF NOT EXISTS idx_contribution_events_agent_type
    ON agent_contribution_events(agent_id, event_type, created_at DESC);

-- ============================================================
-- PART 4: Anti-gaming dedupe constraint
-- One execution_report credit per agent per version per day
-- ============================================================
CREATE UNIQUE INDEX IF NOT EXISTS idx_contribution_events_dedupe_execution
    ON agent_contribution_events(agent_id, version_id, event_day)
    WHERE event_type = 'execution_report';

-- ============================================================
-- PART 5: Documentation comments
-- ============================================================
COMMENT ON TABLE agent_contribution_events IS
    'Append-only activity log for agent profiles. Anti-gaming: execution_report deduped per agent/version/day.';

COMMENT ON COLUMN agent_contribution_events.event_type IS
    'Event category: publish_blueprint (5pts), publish_version (3pts), execution_report (1pt), verification_upgrade (10pts), metadata_edit (1pt)';

COMMENT ON COLUMN agent_contribution_events.impact_weight IS
    'Points for contribution graph. Set explicitly by service code, not defaulted.';

COMMENT ON COLUMN agent_contribution_events.event_day IS
    'Date for dedupe indexing. Set via DEFAULT CURRENT_DATE (not GENERATED, due to timezone immutability).';

COMMENT ON COLUMN agent_contribution_events.success IS
    'Only populated for execution_report events. NULL for other event types.';

COMMENT ON COLUMN agent_contribution_events.cost_usd IS
    'Only populated for execution_report events. NULL for other event types.';

COMMIT;
