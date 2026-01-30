-- Migration 003: Architecture Upgrades
-- 1. Add short_id for hybrid URL structure
-- 2. Add full-text search support for hybrid search
-- 3. Remove heavy triggers for background processing

-- ============================================================================
-- PART 1: HYBRID SLUGS (Add short_id)
-- ============================================================================

-- Add short_id column to blueprints
ALTER TABLE blueprints
ADD COLUMN IF NOT EXISTS short_id VARCHAR(12) UNIQUE;

-- Generate short_ids for existing blueprints using nanoid-like approach
-- Uses base64url alphabet (A-Za-z0-9_-)
CREATE OR REPLACE FUNCTION generate_short_id(length INTEGER DEFAULT 8)
RETURNS TEXT AS $$
DECLARE
    chars TEXT := 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    result TEXT := '';
    i INTEGER;
BEGIN
    FOR i IN 1..length LOOP
        result := result || substr(chars, floor(random() * length(chars) + 1)::INTEGER, 1);
    END LOOP;
    RETURN result;
END;
$$ LANGUAGE plpgsql;

-- Backfill existing blueprints with short_ids
DO $$
DECLARE
    bp RECORD;
    new_short_id TEXT;
    collision_count INTEGER;
BEGIN
    FOR bp IN SELECT id FROM blueprints WHERE short_id IS NULL LOOP
        LOOP
            new_short_id := generate_short_id(8);
            SELECT COUNT(*) INTO collision_count
            FROM blueprints WHERE short_id = new_short_id;
            EXIT WHEN collision_count = 0;
        END LOOP;
        UPDATE blueprints SET short_id = new_short_id WHERE id = bp.id;
    END LOOP;
END $$;

-- Now make short_id NOT NULL
ALTER TABLE blueprints
ALTER COLUMN short_id SET NOT NULL;

-- Create index for fast lookups
CREATE INDEX IF NOT EXISTS idx_blueprints_short_id ON blueprints(short_id);

-- Function to auto-generate short_id on insert
CREATE OR REPLACE FUNCTION generate_blueprint_short_id()
RETURNS TRIGGER AS $$
DECLARE
    new_short_id TEXT;
    collision_count INTEGER;
BEGIN
    IF NEW.short_id IS NULL THEN
        LOOP
            new_short_id := generate_short_id(8);
            SELECT COUNT(*) INTO collision_count
            FROM blueprints WHERE short_id = new_short_id;
            EXIT WHEN collision_count = 0;
        END LOOP;
        NEW.short_id := new_short_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_generate_short_id
    BEFORE INSERT ON blueprints
    FOR EACH ROW EXECUTE FUNCTION generate_blueprint_short_id();

-- ============================================================================
-- PART 2: HYBRID SEARCH (Full-text search support)
-- ============================================================================

-- Add tsvector column for full-text search
ALTER TABLE blueprint_versions
ADD COLUMN IF NOT EXISTS search_vector tsvector;

-- Create GIN index for fast full-text search
CREATE INDEX IF NOT EXISTS idx_blueprint_versions_search_vector
ON blueprint_versions USING GIN(search_vector);

-- Function to update search vector
CREATE OR REPLACE FUNCTION update_blueprint_search_vector()
RETURNS TRIGGER AS $$
BEGIN
    NEW.search_vector :=
        setweight(to_tsvector('english', COALESCE(NEW.title, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(NEW.goal_description, '')), 'B') ||
        setweight(to_tsvector('english', COALESCE(NEW.strategy, '')), 'C');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-update search vector
CREATE TRIGGER trigger_update_search_vector
    BEFORE INSERT OR UPDATE OF title, goal_description, strategy
    ON blueprint_versions
    FOR EACH ROW EXECUTE FUNCTION update_blueprint_search_vector();

-- Backfill search vectors for existing versions
UPDATE blueprint_versions SET
    search_vector =
        setweight(to_tsvector('english', COALESCE(title, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(goal_description, '')), 'B') ||
        setweight(to_tsvector('english', COALESCE(strategy, '')), 'C')
WHERE search_vector IS NULL;

-- ============================================================================
-- HYBRID SEARCH FUNCTION (Vector + Keyword with RRF)
-- ============================================================================

CREATE OR REPLACE FUNCTION hybrid_search_blueprints(
    query_text TEXT,
    query_embedding vector(1536),
    match_count INT DEFAULT 10,
    status_filter TEXT[] DEFAULT ARRAY['published'],
    vector_weight FLOAT DEFAULT 0.5,
    keyword_weight FLOAT DEFAULT 0.5,
    rrf_k INT DEFAULT 60  -- RRF constant (typically 60)
)
RETURNS TABLE (
    id UUID,
    short_id TEXT,
    slug TEXT,
    title TEXT,
    goal_description TEXT,
    status TEXT,
    is_public BOOLEAN,
    execution_count INTEGER,
    success_count INTEGER,
    failure_count INTEGER,
    success_rate DECIMAL,
    upvotes INTEGER,
    downvotes INTEGER,
    score DECIMAL,
    created_by_agent_id UUID,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ,
    similarity FLOAT,
    keyword_rank FLOAT,
    combined_score FLOAT,
    tags TEXT[]
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    WITH
    -- Vector search results with rank
    vector_results AS (
        SELECT
            b.id,
            1 - (bv.embedding <=> query_embedding) AS vec_similarity,
            ROW_NUMBER() OVER (ORDER BY bv.embedding <=> query_embedding) AS vec_rank
        FROM blueprints b
        JOIN blueprint_versions bv ON bv.id = b.current_version_id
        WHERE
            b.status::TEXT = ANY(status_filter)
            AND b.is_public = true
            AND bv.embedding IS NOT NULL
        ORDER BY bv.embedding <=> query_embedding
        LIMIT match_count * 3
    ),

    -- Keyword search results with rank
    keyword_results AS (
        SELECT
            b.id,
            ts_rank_cd(bv.search_vector, websearch_to_tsquery('english', query_text)) AS kw_rank,
            ROW_NUMBER() OVER (
                ORDER BY ts_rank_cd(bv.search_vector, websearch_to_tsquery('english', query_text)) DESC
            ) AS kw_position
        FROM blueprints b
        JOIN blueprint_versions bv ON bv.id = b.current_version_id
        WHERE
            b.status::TEXT = ANY(status_filter)
            AND b.is_public = true
            AND bv.search_vector @@ websearch_to_tsquery('english', query_text)
        ORDER BY kw_rank DESC
        LIMIT match_count * 3
    ),

    -- Combine with Reciprocal Rank Fusion (RRF)
    combined AS (
        SELECT
            COALESCE(v.id, k.id) AS id,
            COALESCE(v.vec_similarity, 0) AS similarity,
            COALESCE(k.kw_rank, 0) AS keyword_rank,
            -- RRF formula: sum of 1/(k + rank) for each ranking
            (
                CASE WHEN v.vec_rank IS NOT NULL
                     THEN vector_weight * (1.0 / (rrf_k + v.vec_rank))
                     ELSE 0
                END +
                CASE WHEN k.kw_position IS NOT NULL
                     THEN keyword_weight * (1.0 / (rrf_k + k.kw_position))
                     ELSE 0
                END
            ) AS rrf_score
        FROM vector_results v
        FULL OUTER JOIN keyword_results k ON v.id = k.id
    )

    SELECT
        b.id,
        b.short_id::TEXT,
        b.slug::TEXT,
        bv.title::TEXT,
        bv.goal_description::TEXT,
        b.status::TEXT,
        b.is_public,
        b.execution_count,
        b.success_count,
        b.failure_count,
        b.success_rate,
        b.upvotes,
        b.downvotes,
        b.score,
        b.created_by_agent_id,
        b.created_at,
        b.updated_at,
        c.similarity::FLOAT,
        c.keyword_rank::FLOAT,
        c.rrf_score::FLOAT AS combined_score,
        COALESCE(
            (
                SELECT array_agg(t.name::TEXT)
                FROM blueprint_tags bt
                JOIN tags t ON t.id = bt.tag_id
                WHERE bt.blueprint_id = b.id
            ),
            ARRAY[]::TEXT[]
        )::TEXT[] AS tags
    FROM combined c
    JOIN blueprints b ON b.id = c.id
    JOIN blueprint_versions bv ON bv.id = b.current_version_id
    WHERE c.rrf_score > 0
    ORDER BY c.rrf_score DESC
    LIMIT match_count;
END;
$$;

-- ============================================================================
-- PART 3: REMOVE HEAVY TRIGGERS (Background score processing)
-- ============================================================================

-- Drop the vote triggers that update score synchronously
DROP TRIGGER IF EXISTS trigger_update_votes_on_insert ON votes;
DROP TRIGGER IF EXISTS trigger_update_votes_on_update ON votes;
DROP TRIGGER IF EXISTS trigger_update_votes_on_delete ON votes;

-- Create a simpler trigger that only updates counts (not Wilson score)
CREATE OR REPLACE FUNCTION update_vote_counts_only()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE blueprints SET
            upvotes = CASE WHEN NEW.vote_type = 'up' THEN upvotes + 1 ELSE upvotes END,
            downvotes = CASE WHEN NEW.vote_type = 'down' THEN downvotes + 1 ELSE downvotes END,
            updated_at = NOW()
        WHERE id = NEW.blueprint_id;
        RETURN NEW;

    ELSIF TG_OP = 'UPDATE' AND OLD.vote_type != NEW.vote_type THEN
        UPDATE blueprints SET
            upvotes = CASE
                WHEN NEW.vote_type = 'up' THEN upvotes + 1
                WHEN OLD.vote_type = 'up' THEN upvotes - 1
                ELSE upvotes
            END,
            downvotes = CASE
                WHEN NEW.vote_type = 'down' THEN downvotes + 1
                WHEN OLD.vote_type = 'down' THEN downvotes - 1
                ELSE downvotes
            END,
            updated_at = NOW()
        WHERE id = NEW.blueprint_id;
        RETURN NEW;

    ELSIF TG_OP = 'DELETE' THEN
        UPDATE blueprints SET
            upvotes = CASE WHEN OLD.vote_type = 'up' THEN upvotes - 1 ELSE upvotes END,
            downvotes = CASE WHEN OLD.vote_type = 'down' THEN downvotes - 1 ELSE downvotes END,
            updated_at = NOW()
        WHERE id = OLD.blueprint_id;
        RETURN OLD;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Create lightweight triggers for vote counts only
CREATE TRIGGER trigger_update_vote_counts_insert
    AFTER INSERT ON votes
    FOR EACH ROW EXECUTE FUNCTION update_vote_counts_only();

CREATE TRIGGER trigger_update_vote_counts_update
    AFTER UPDATE ON votes
    FOR EACH ROW EXECUTE FUNCTION update_vote_counts_only();

CREATE TRIGGER trigger_update_vote_counts_delete
    AFTER DELETE ON votes
    FOR EACH ROW EXECUTE FUNCTION update_vote_counts_only();

-- Add tracking columns for background processing
ALTER TABLE blueprints
ADD COLUMN IF NOT EXISTS score_updated_at TIMESTAMPTZ DEFAULT NOW();

ALTER TABLE blueprints
ADD COLUMN IF NOT EXISTS needs_score_update BOOLEAN DEFAULT FALSE;

-- Index for finding blueprints needing score updates
CREATE INDEX IF NOT EXISTS idx_blueprints_needs_score_update
ON blueprints(needs_score_update) WHERE needs_score_update = true;

-- Function to mark blueprint for score update (called by triggers)
CREATE OR REPLACE FUNCTION mark_blueprint_for_score_update()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE blueprints
    SET needs_score_update = true
    WHERE id = COALESCE(NEW.blueprint_id, OLD.blueprint_id);
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- Trigger on votes to mark for update
CREATE TRIGGER trigger_mark_score_update_on_vote
    AFTER INSERT OR UPDATE OR DELETE ON votes
    FOR EACH ROW EXECUTE FUNCTION mark_blueprint_for_score_update();

-- Trigger on execution_reports to mark for update
CREATE TRIGGER trigger_mark_score_update_on_execution
    AFTER INSERT ON execution_reports
    FOR EACH ROW EXECUTE FUNCTION mark_blueprint_for_score_update();

-- ============================================================================
-- BATCH SCORE UPDATE FUNCTION (Called by cron job)
-- ============================================================================

CREATE OR REPLACE FUNCTION batch_update_wilson_scores(batch_size INT DEFAULT 100)
RETURNS TABLE (
    updated_count INT,
    blueprint_ids UUID[]
)
LANGUAGE plpgsql
AS $$
DECLARE
    affected_ids UUID[];
BEGIN
    -- Get blueprints needing updates
    SELECT array_agg(id) INTO affected_ids
    FROM (
        SELECT id FROM blueprints
        WHERE needs_score_update = true
        ORDER BY updated_at DESC
        LIMIT batch_size
    ) sub;

    -- Update Wilson scores
    UPDATE blueprints b
    SET
        score = wilson_score(b.upvotes, b.downvotes),
        score_updated_at = NOW(),
        needs_score_update = false
    WHERE b.id = ANY(affected_ids);

    RETURN QUERY SELECT
        COALESCE(array_length(affected_ids, 1), 0)::INT,
        COALESCE(affected_ids, ARRAY[]::UUID[]);
END;
$$;

-- ============================================================================
-- HELPER: Get blueprint by short_id or slug
-- ============================================================================

CREATE OR REPLACE FUNCTION get_blueprint_by_identifier(identifier TEXT)
RETURNS TABLE (
    id UUID,
    short_id TEXT,
    slug TEXT,
    current_version_id UUID,
    created_by_agent_id UUID,
    execution_count INTEGER,
    success_count INTEGER,
    failure_count INTEGER,
    success_rate DECIMAL,
    upvotes INTEGER,
    downvotes INTEGER,
    score DECIMAL,
    status TEXT,
    is_public BOOLEAN,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
BEGIN
    -- Try short_id first (faster, indexed)
    RETURN QUERY
    SELECT
        b.id,
        b.short_id::TEXT,
        b.slug::TEXT,
        b.current_version_id,
        b.created_by_agent_id,
        b.execution_count,
        b.success_count,
        b.failure_count,
        b.success_rate,
        b.upvotes,
        b.downvotes,
        b.score,
        b.status::TEXT,
        b.is_public,
        b.created_at,
        b.updated_at
    FROM blueprints b
    WHERE b.short_id = identifier OR b.slug = identifier
    LIMIT 1;
END;
$$;

-- ============================================================================
-- COMMENT: Summary of changes
-- ============================================================================

COMMENT ON FUNCTION hybrid_search_blueprints IS
'Hybrid search combining vector similarity and keyword matching using Reciprocal Rank Fusion (RRF).
Parameters:
- query_text: The search query for keyword matching
- query_embedding: The vector embedding for semantic search
- match_count: Maximum results to return
- status_filter: Blueprint statuses to include
- vector_weight: Weight for vector search in RRF (default 0.5)
- keyword_weight: Weight for keyword search in RRF (default 0.5)
- rrf_k: RRF constant, typically 60';

COMMENT ON FUNCTION batch_update_wilson_scores IS
'Background job function to update Wilson scores for blueprints marked as needing updates.
Should be called periodically (e.g., every 10 minutes) by a cron job or scheduler.';

COMMENT ON FUNCTION get_blueprint_by_identifier IS
'Lookup blueprint by either short_id (8-char) or slug. Short_id is tried first for performance.';
