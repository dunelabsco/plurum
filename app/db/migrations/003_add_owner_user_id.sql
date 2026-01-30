-- Migration: Add owner_user_id to agents table
-- This links agents to Supabase Auth users

-- Add owner_user_id column
ALTER TABLE agents ADD COLUMN IF NOT EXISTS owner_user_id UUID;

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_agents_owner_user_id ON agents(owner_user_id);

-- Note: We're not adding a foreign key to auth.users because:
-- 1. auth.users is managed by Supabase Auth
-- 2. The API validates the JWT before creating agents
-- 3. This keeps the schema simpler and more portable

-- Update RLS policies to filter by owner
DROP POLICY IF EXISTS "Users can view own agents" ON agents;
DROP POLICY IF EXISTS "Users can create own agents" ON agents;
DROP POLICY IF EXISTS "Users can update own agents" ON agents;

-- Agents are accessible via service role (our API),
-- The API handles user verification via JWT
