-- Trust Engine Schema v2.3 (Hardened) - IDEMPOTENT VERSION
-- Key hardening:
--   1. Backfill + NOT NULL version_id with trigger validation
--   2. Audit trail constraint (verified_at/verified_by must match tier)
--   3. Per-version verification, risk scoring, environment constraints
--
-- This migration is idempotent - safe to re-run if partially executed.

BEGIN;

-- ============================================================
-- PART 1: Create verification_tier enum (if not exists)
-- ============================================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'verification_tier') THEN
        CREATE TYPE verification_tier AS ENUM (
            'self_reported',   -- Default: author claims it works
            'sandbox',         -- Tested in isolated environment
            'org_verified'     -- Verified by organization
        );
    END IF;
END $$;

-- ============================================================
-- PART 2: Add columns to blueprint_versions (if not exist)
-- ============================================================
DO $$
BEGIN
    -- verification_tier
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'blueprint_versions' AND column_name = 'verification_tier') THEN
        ALTER TABLE blueprint_versions ADD COLUMN verification_tier verification_tier NOT NULL DEFAULT 'self_reported';
    END IF;

    -- permissions_required
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'blueprint_versions' AND column_name = 'permissions_required') THEN
        ALTER TABLE blueprint_versions ADD COLUMN permissions_required TEXT[] DEFAULT '{}';
    END IF;

    -- risk_flags
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'blueprint_versions' AND column_name = 'risk_flags') THEN
        ALTER TABLE blueprint_versions ADD COLUMN risk_flags TEXT[] DEFAULT '{}';
    END IF;

    -- risk_score
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'blueprint_versions' AND column_name = 'risk_score') THEN
        ALTER TABLE blueprint_versions ADD COLUMN risk_score SMALLINT DEFAULT 0;
    END IF;

    -- environment_constraints
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'blueprint_versions' AND column_name = 'environment_constraints') THEN
        ALTER TABLE blueprint_versions ADD COLUMN environment_constraints JSONB DEFAULT '{}';
    END IF;

    -- verified_at
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'blueprint_versions' AND column_name = 'verified_at') THEN
        ALTER TABLE blueprint_versions ADD COLUMN verified_at TIMESTAMPTZ;
    END IF;

    -- verified_by
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'blueprint_versions' AND column_name = 'verified_by') THEN
        ALTER TABLE blueprint_versions ADD COLUMN verified_by UUID REFERENCES auth.users(id);
    END IF;

    -- verification_evidence
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'blueprint_versions' AND column_name = 'verification_evidence') THEN
        ALTER TABLE blueprint_versions ADD COLUMN verification_evidence JSONB;
    END IF;
END $$;

-- ============================================================
-- PART 3: Constraints on blueprint_versions (if not exist)
-- ============================================================

-- Risk score must be 0-100
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                   WHERE constraint_name = 'chk_risk_score_range' AND table_name = 'blueprint_versions') THEN
        ALTER TABLE blueprint_versions ADD CONSTRAINT chk_risk_score_range
            CHECK (risk_score >= 0 AND risk_score <= 100);
    END IF;
END $$;

-- Audit trail constraint: verified_at/verified_by must match tier
-- If self_reported: verified_at and verified_by MUST be NULL
-- If NOT self_reported: verified_at and verified_by MUST NOT be NULL
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                   WHERE constraint_name = 'chk_verification_audit_trail' AND table_name = 'blueprint_versions') THEN
        ALTER TABLE blueprint_versions ADD CONSTRAINT chk_verification_audit_trail
            CHECK (
                (verification_tier = 'self_reported' AND verified_at IS NULL AND verified_by IS NULL)
                OR
                (verification_tier != 'self_reported' AND verified_at IS NOT NULL AND verified_by IS NOT NULL)
            );
    END IF;
END $$;

-- ============================================================
-- PART 4: Add columns to execution_reports (if not exist)
-- ============================================================
DO $$
BEGIN
    -- version_id (nullable first, will be made NOT NULL after backfill)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'execution_reports' AND column_name = 'version_id') THEN
        ALTER TABLE execution_reports ADD COLUMN version_id UUID REFERENCES blueprint_versions(id);
    END IF;

    -- env_fingerprint
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'execution_reports' AND column_name = 'env_fingerprint') THEN
        ALTER TABLE execution_reports ADD COLUMN env_fingerprint JSONB;
    END IF;

    -- error_signature
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'execution_reports' AND column_name = 'error_signature') THEN
        ALTER TABLE execution_reports ADD COLUMN error_signature TEXT;
    END IF;

    -- cost_usd
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'execution_reports' AND column_name = 'cost_usd') THEN
        ALTER TABLE execution_reports ADD COLUMN cost_usd NUMERIC(10, 6);
    END IF;
END $$;

-- ============================================================
-- PART 5: Backfill version_id from blueprints.current_version_id
-- (Only updates rows where version_id IS NULL)
-- ============================================================
UPDATE execution_reports er
SET version_id = b.current_version_id
FROM blueprints b
WHERE er.blueprint_id = b.id
  AND er.version_id IS NULL;

-- ============================================================
-- PART 5b: Guard - fail if any rows still have NULL version_id
-- (Only check if there are any execution_reports with NULL version_id)
-- ============================================================
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM execution_reports WHERE version_id IS NULL) THEN
        RAISE EXCEPTION 'Backfill failed: execution_reports.version_id still NULL for some rows. Manual intervention required.';
    END IF;
END $$;

-- ============================================================
-- PART 6: Make version_id NOT NULL after backfill (idempotent)
-- ============================================================
DO $$
BEGIN
    -- Check if column is already NOT NULL
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'execution_reports'
          AND column_name = 'version_id'
          AND is_nullable = 'YES'
    ) THEN
        ALTER TABLE execution_reports ALTER COLUMN version_id SET NOT NULL;
    END IF;
END $$;

-- ============================================================
-- PART 7: Trigger to validate version_id belongs to blueprint_id
-- ============================================================
CREATE OR REPLACE FUNCTION validate_execution_report_version()
RETURNS TRIGGER AS $$
DECLARE
    version_blueprint_id UUID;
BEGIN
    -- Get the blueprint_id for this version
    SELECT blueprint_id INTO version_blueprint_id
    FROM blueprint_versions
    WHERE id = NEW.version_id;

    -- Check if it matches
    IF version_blueprint_id IS NULL THEN
        RAISE EXCEPTION 'version_id % does not exist', NEW.version_id;
    END IF;

    IF version_blueprint_id != NEW.blueprint_id THEN
        RAISE EXCEPTION 'version_id % does not belong to blueprint_id %. Version belongs to blueprint %',
            NEW.version_id, NEW.blueprint_id, version_blueprint_id;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop and recreate trigger to ensure latest version
DROP TRIGGER IF EXISTS trg_validate_execution_report_version ON execution_reports;
CREATE TRIGGER trg_validate_execution_report_version
    BEFORE INSERT OR UPDATE ON execution_reports
    FOR EACH ROW
    EXECUTE FUNCTION validate_execution_report_version();

-- ============================================================
-- PART 8: Add publisher_domain to agents (if not exists)
-- ============================================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'agents' AND column_name = 'publisher_domain') THEN
        ALTER TABLE agents ADD COLUMN publisher_domain TEXT;
    END IF;
END $$;

-- ============================================================
-- PART 9: Indexes for efficient querying (IF NOT EXISTS)
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_blueprint_versions_verification_tier
    ON blueprint_versions(verification_tier);
CREATE INDEX IF NOT EXISTS idx_blueprint_versions_verified
    ON blueprint_versions(verification_tier)
    WHERE verification_tier IN ('sandbox', 'org_verified');
CREATE INDEX IF NOT EXISTS idx_blueprint_versions_permissions
    ON blueprint_versions USING GIN (permissions_required);
CREATE INDEX IF NOT EXISTS idx_blueprint_versions_risk_flags
    ON blueprint_versions USING GIN (risk_flags);
CREATE INDEX IF NOT EXISTS idx_blueprint_versions_environment_constraints
    ON blueprint_versions USING GIN (environment_constraints);
CREATE INDEX IF NOT EXISTS idx_blueprint_versions_verified_at
    ON blueprint_versions(verified_at)
    WHERE verified_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_execution_reports_version_id
    ON execution_reports(version_id);
CREATE INDEX IF NOT EXISTS idx_execution_reports_env_fingerprint
    ON execution_reports USING GIN (env_fingerprint);
CREATE INDEX IF NOT EXISTS idx_execution_reports_error_signature
    ON execution_reports(error_signature)
    WHERE error_signature IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agents_publisher_domain
    ON agents(publisher_domain)
    WHERE publisher_domain IS NOT NULL;

-- ============================================================
-- PART 10: Documentation comments
-- ============================================================
COMMENT ON COLUMN blueprint_versions.verification_tier IS
    'Trust level per version: self_reported < sandbox < org_verified. Write-protected.';
COMMENT ON COLUMN blueprint_versions.permissions_required IS
    'Required permissions (validated against enum): fs_read, fs_write, network, shell, env_vars, credentials';
COMMENT ON COLUMN blueprint_versions.risk_flags IS
    'Risk indicators (validated against enum): destructive, shell_exec, network_egress, credential_access, fs_write, env_modify';
COMMENT ON COLUMN blueprint_versions.risk_score IS
    'Computed: 10*len(unique_permissions) + 20*len(unique_risk_flags), clamped 0-100';
COMMENT ON COLUMN blueprint_versions.environment_constraints IS
    'Required environment: {os[], runtime, min_version, dependencies[]}';
COMMENT ON COLUMN blueprint_versions.verified_at IS
    'When verification_tier was upgraded. NULL iff self_reported (enforced by constraint)';
COMMENT ON COLUMN blueprint_versions.verified_by IS
    'Admin who upgraded tier. NULL iff self_reported (enforced by constraint)';
COMMENT ON COLUMN blueprint_versions.verification_evidence IS
    'Evidence: {method, sandbox_run_id, notes}';
COMMENT ON COLUMN execution_reports.version_id IS
    'Pinned version (NOT NULL, validated by trigger to match blueprint_id)';
COMMENT ON COLUMN execution_reports.env_fingerprint IS
    'Observed runtime: {os, runtime, version, arch, dependencies}';
COMMENT ON COLUMN execution_reports.error_signature IS
    'Normalized error pattern for grouping failures';
COMMENT ON COLUMN execution_reports.cost_usd IS
    'Token/compute cost in USD';
COMMENT ON COLUMN agents.publisher_domain IS
    'Verified domain for org_verified blueprints';
COMMENT ON CONSTRAINT chk_verification_audit_trail ON blueprint_versions IS
    'Ensures verified_at/verified_by are NULL iff self_reported';
COMMENT ON TRIGGER trg_validate_execution_report_version ON execution_reports IS
    'Ensures version_id belongs to the same blueprint as blueprint_id';

-- ============================================================
-- PART 11: Update hybrid_search_blueprints to return version_id and trust fields
-- ============================================================

-- Drop and recreate the function with trust fields
DROP FUNCTION IF EXISTS hybrid_search_blueprints;

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
    current_version_id UUID,
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
    tags TEXT[],
    -- Trust Engine fields from the SAME version used for search
    verification_tier verification_tier,
    risk_score SMALLINT,
    permissions_required TEXT[],
    risk_flags TEXT[],
    environment_constraints JSONB
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
        b.current_version_id,  -- Return the version_id
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
        )::TEXT[] AS tags,
        -- Trust Engine fields from the SAME version (bv) used for search
        bv.verification_tier,
        bv.risk_score,
        bv.permissions_required,
        bv.risk_flags,
        bv.environment_constraints
    FROM combined c
    JOIN blueprints b ON b.id = c.id
    JOIN blueprint_versions bv ON bv.id = b.current_version_id
    WHERE c.rrf_score > 0
    ORDER BY c.rrf_score DESC
    LIMIT match_count;
END;
$$;

COMMENT ON FUNCTION hybrid_search_blueprints IS
'Hybrid search combining vector similarity and keyword matching using Reciprocal Rank Fusion (RRF).
Returns version_id and trust fields (verification_tier, risk_score, permissions_required, risk_flags, environment_constraints) from the SAME version used for search.
Parameters:
- query_text: The search query for keyword matching
- query_embedding: The vector embedding for semantic search
- match_count: Maximum results to return
- status_filter: Blueprint statuses to include
- vector_weight: Weight for vector search in RRF (default 0.5)
- keyword_weight: Weight for keyword search in RRF (default 0.5)
- rrf_k: RRF constant, typically 60';

-- ============================================================
-- PART 12: Update search_blueprints to return trust fields
-- ============================================================

DROP FUNCTION IF EXISTS search_blueprints;

CREATE OR REPLACE FUNCTION search_blueprints(
    query_embedding vector(1536),
    match_threshold float DEFAULT 0.3,
    match_count int DEFAULT 10,
    status_filter text[] DEFAULT ARRAY['published'],
    exclude_blueprint_id uuid DEFAULT NULL,
    exclude_agent_id uuid DEFAULT NULL
)
RETURNS TABLE (
    id uuid,
    slug text,
    current_version_id uuid,
    title text,
    goal_description text,
    status text,
    is_public boolean,
    execution_count int,
    success_count int,
    failure_count int,
    success_rate numeric,
    upvotes int,
    downvotes int,
    score numeric,
    created_by_agent_id uuid,
    created_at timestamptz,
    updated_at timestamptz,
    similarity float,
    tags text[],
    -- Trust Engine fields
    verification_tier verification_tier,
    risk_score smallint,
    permissions_required text[],
    risk_flags text[],
    environment_constraints jsonb
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        b.id,
        b.slug::text,
        b.current_version_id,
        bv.title::text,
        bv.goal_description::text,
        b.status::text,
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
        1 - (bv.embedding <=> query_embedding) AS similarity,
        COALESCE(
            (
                SELECT array_agg(t.name)
                FROM blueprint_tags bt
                JOIN tags t ON t.id = bt.tag_id
                WHERE bt.blueprint_id = b.id
            ),
            ARRAY[]::text[]
        ) AS tags,
        -- Trust Engine fields from the SAME version
        bv.verification_tier,
        bv.risk_score,
        bv.permissions_required,
        bv.risk_flags,
        bv.environment_constraints
    FROM blueprints b
    JOIN blueprint_versions bv ON bv.id = b.current_version_id
    WHERE
        b.status::text = ANY(status_filter)
        AND b.is_public = true
        AND bv.embedding IS NOT NULL
        AND (exclude_blueprint_id IS NULL OR b.id != exclude_blueprint_id)
        AND (exclude_agent_id IS NULL OR b.created_by_agent_id != exclude_agent_id)
        AND 1 - (bv.embedding <=> query_embedding) > match_threshold
    ORDER BY similarity DESC
    LIMIT match_count;
END;
$$;

GRANT EXECUTE ON FUNCTION search_blueprints TO authenticated;
GRANT EXECUTE ON FUNCTION search_blueprints TO service_role;
GRANT EXECUTE ON FUNCTION hybrid_search_blueprints TO authenticated;
GRANT EXECUTE ON FUNCTION hybrid_search_blueprints TO service_role;

COMMIT;
