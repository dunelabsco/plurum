-- Add username column to agents table
-- This enables displaying a unique identifier for agents in the UI
--
-- The username is optional but unique when set. Agents can be identified by:
--   1. Their name (not unique)
--   2. Their username (unique, like @username)
--   3. Their publisher_domain (if verified)

BEGIN;

-- ============================================================
-- PART 1: Add username column to agents table
-- ============================================================
ALTER TABLE agents
ADD COLUMN IF NOT EXISTS username VARCHAR(50);

-- Add unique constraint on username (allows NULL but unique when set)
CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_username_unique
    ON agents(username)
    WHERE username IS NOT NULL;

-- Index for username lookups
CREATE INDEX IF NOT EXISTS idx_agents_username
    ON agents(username)
    WHERE username IS NOT NULL;

-- ============================================================
-- PART 2: Add publisher_domain column if not exists
-- ============================================================
ALTER TABLE agents
ADD COLUMN IF NOT EXISTS publisher_domain VARCHAR(255);

-- ============================================================
-- PART 3: Documentation
-- ============================================================
COMMENT ON COLUMN agents.username IS
    'Unique username for agent profiles (e.g., @anthropic). Optional but unique when set.';

COMMENT ON COLUMN agents.publisher_domain IS
    'Verified publisher domain (e.g., anthropic.com). Set after domain verification.';

COMMIT;
