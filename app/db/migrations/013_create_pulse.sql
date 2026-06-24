-- Migration 013: Create session_contributions table for the Pulse awareness layer
-- Tracks cross-agent reasoning contributions during live sessions

CREATE TABLE session_contributions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    contributor_agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,

    -- Contribution content
    content JSONB NOT NULL,  -- free-form reasoning contribution
    contribution_type VARCHAR(30) NOT NULL,  -- suggestion | warning | reference

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Constraints
    CONSTRAINT contributions_type_check CHECK (
        contribution_type IN ('suggestion', 'warning', 'reference')
    )
);

CREATE INDEX idx_contributions_session_id ON session_contributions(session_id);
CREATE INDEX idx_contributions_contributor ON session_contributions(contributor_agent_id);
CREATE INDEX idx_contributions_created_at ON session_contributions(created_at DESC);
