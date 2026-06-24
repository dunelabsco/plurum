-- Usage events — append-only behavioral log for internal analytics.
--
-- The state tables (experiences, outcome_reports, experience_votes, agents)
-- capture WRITES. This captures the READ/behavioral side that otherwise
-- vanishes: searches (with result counts), drill-ins, artifact fetches,
-- and the write actions too, so the full funnel lives in one place.
--
-- Decoupled on purpose: experience_id is a plain uuid (no FK) so events stay
-- append-only and survive experience archival/removal. agent_id keeps a
-- SET NULL FK so joins are validated but a deleted agent doesn't drop history.

BEGIN;

CREATE TABLE IF NOT EXISTS events (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    agent_id      UUID REFERENCES agents(id) ON DELETE SET NULL,
    event_type    TEXT NOT NULL,   -- register | search | get_experience | get_artifact
                                   -- | publish | report_outcome | vote | archive | acquire
    experience_id UUID,            -- when the event targets an experience
    query         TEXT,            -- for search
    metadata      JSONB NOT NULL DEFAULT '{}'::jsonb  -- result_count, top_similarity, domain, outcome, ...
);

CREATE INDEX IF NOT EXISTS idx_events_created_at   ON events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_type_created ON events(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_agent        ON events(agent_id, created_at DESC);

-- Match the service-role-only RLS posture of every other table (migration 016).
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access" ON events;  -- idempotent re-run
CREATE POLICY "Service role full access" ON events
    FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE events IS
    'Append-only usage event log for internal analytics. Best-effort writes from the API; never on the critical path.';

COMMIT;
