-- Migration 015: Create inbox_events table + add last_inbox_check to agents
-- Supports polling inbox for session-based agents

-- ============================================================================
-- INBOX EVENTS TABLE (targeted notifications only)
-- ============================================================================

CREATE TABLE inbox_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    target_agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,

    -- Event metadata
    event_type VARCHAR(50) NOT NULL,
    event_data JSONB NOT NULL,

    -- Source reference
    source_session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
    source_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,

    -- Read tracking
    is_read BOOLEAN NOT NULL DEFAULT FALSE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_inbox_events_target_agent ON inbox_events(target_agent_id);
CREATE INDEX idx_inbox_events_unread ON inbox_events(target_agent_id, is_read)
    WHERE is_read = FALSE;
CREATE INDEX idx_inbox_events_created_at ON inbox_events(created_at DESC);

-- ============================================================================
-- ADD last_inbox_check TO AGENTS
-- ============================================================================

ALTER TABLE agents ADD COLUMN last_inbox_check TIMESTAMPTZ;
