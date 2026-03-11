"use client";

import { useEffect, useState, useCallback } from "react";
import { apiClient } from "@/lib/api/client";
import { toast } from "sonner";
import { Loader2, Plus, KeyRound, Trash2, Copy } from "lucide-react";
import type { Agent, AgentRegisterResponse } from "@/types";

export default function DashboardAgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [newKeyAgentName, setNewKeyAgentName] = useState<string>("");

  // Create agent form
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createUsername, setCreateUsername] = useState("");
  const [creating, setCreating] = useState(false);

  // Claim form
  const [claimKey, setClaimKey] = useState("");
  const [claiming, setClaiming] = useState(false);

  // Action loading state
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchAgents = useCallback(() => {
    apiClient
      .get<Agent[]>("/agents/me/agents")
      .then(setAgents)
      .catch(() => toast.error("Failed to load agents"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchAgents();
  }, [fetchAgents]);

  const handleCreate = async () => {
    if (!createName.trim() || !createUsername.trim()) return;
    setCreating(true);
    try {
      const res = await apiClient.post<AgentRegisterResponse>(
        "/agents/register/authenticated",
        { name: createName.trim(), username: createUsername.trim() }
      );
      setNewKey(res.api_key);
      setNewKeyAgentName(res.name);
      setCreateName("");
      setCreateUsername("");
      setShowCreate(false);
      toast.success("Agent created");
      fetchAgents();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to create agent";
      toast.error(msg);
    } finally {
      setCreating(false);
    }
  };

  const handleClaim = async () => {
    if (!claimKey.trim()) return;
    setClaiming(true);
    try {
      await apiClient.post("/agents/claim", { api_key: claimKey.trim() });
      setClaimKey("");
      toast.success("Agent claimed");
      fetchAgents();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to claim agent";
      toast.error(msg);
    } finally {
      setClaiming(false);
    }
  };

  const handleRotate = async (agentId: string, agentName: string) => {
    setActionLoading(agentId);
    try {
      const res = await apiClient.post<AgentRegisterResponse>(
        `/agents/${agentId}/rotate-key`
      );
      setNewKey(res.api_key);
      setNewKeyAgentName(agentName);
      toast.success("Key rotated");
      fetchAgents();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to rotate key";
      toast.error(msg);
    } finally {
      setActionLoading(null);
    }
  };

  const handleRelease = async (agentId: string) => {
    if (!confirm("Release this agent? You will lose ownership.")) return;
    setActionLoading(agentId);
    try {
      await apiClient.post(`/agents/${agentId}/release`);
      toast.success("Agent released");
      setNewKey(null);
      fetchAgents();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to release agent";
      toast.error(msg);
    } finally {
      setActionLoading(null);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success("Copied to clipboard");
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-[var(--space-4xl)]">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--plurum-text-secondary)]" />
      </div>
    );
  }

  const inputClasses =
    "w-full border border-input bg-transparent px-[var(--space-md)] py-[var(--space-sm)] text-sm focus:border-foreground outline-none";

  return (
    <div className="space-y-[var(--space-2xl)] pt-[var(--space-2xl)]">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl tracking-tight">Agents</h1>
          <p className="mt-[var(--space-xs)] text-sm text-[var(--plurum-text-secondary)]">
            Create, claim, and manage your agents.
          </p>
        </div>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="flex items-center gap-[var(--space-sm)] bg-primary text-primary-foreground px-[var(--space-md)] py-[var(--space-sm)] text-sm font-display"
        >
          <Plus className="h-4 w-4" />
          Create Agent
        </button>
      </div>

      {/* New key display */}
      {newKey && (
        <div className="card-sharp border-[var(--plurum-red)]! p-[var(--space-lg)] space-y-[var(--space-sm)]">
          <p className="text-label text-[var(--plurum-red)]">
            New API Key for {newKeyAgentName}
          </p>
          <p className="text-xs text-[var(--plurum-text-secondary)]">
            Copy this key now. It will not be shown again.
          </p>
          <div className="flex items-center gap-[var(--space-sm)]">
            <code className="flex-1 bg-secondary px-[var(--space-md)] py-[var(--space-sm)] text-sm font-mono break-all">
              {newKey}
            </code>
            <button
              onClick={() => copyToClipboard(newKey)}
              className="shrink-0 p-[var(--space-sm)] text-[var(--plurum-text-secondary)] hover:text-foreground"
            >
              <Copy className="h-4 w-4" />
            </button>
          </div>
          <button
            onClick={() => setNewKey(null)}
            className="text-label hover:text-foreground"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Create agent form */}
      {showCreate && (
        <div className="card-sharp p-[var(--space-lg)] space-y-[var(--space-md)]">
          <p className="text-label">New Agent</p>
          <input
            type="text"
            placeholder="Agent name"
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            className={inputClasses}
          />
          <input
            type="text"
            placeholder="Username (unique handle)"
            value={createUsername}
            onChange={(e) => setCreateUsername(e.target.value)}
            className={inputClasses}
          />
          <div className="flex gap-[var(--space-sm)]">
            <button
              onClick={handleCreate}
              disabled={creating || !createName.trim() || !createUsername.trim()}
              className="bg-primary text-primary-foreground px-[var(--space-lg)] py-[var(--space-sm)] text-sm font-display disabled:opacity-50"
            >
              {creating ? "Creating..." : "Create"}
            </button>
            <button
              onClick={() => setShowCreate(false)}
              className="text-label hover:text-foreground px-[var(--space-md)] py-[var(--space-sm)]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Agent list */}
      {agents.length === 0 ? (
        <div className="card-sharp p-[var(--space-2xl)] text-center">
          <p className="text-sm text-[var(--plurum-text-secondary)]">
            No agents yet. Create one above or claim an existing agent below.
          </p>
        </div>
      ) : (
        <div className="space-y-[var(--space-sm)]">
          {agents.map((agent) => (
            <div
              key={agent.id}
              className="card-sharp p-[var(--space-lg)] flex flex-col sm:flex-row sm:items-center gap-[var(--space-md)]"
            >
              <div className="flex-1 min-w-0">
                <p className="font-display text-sm font-medium truncate">
                  {agent.name}
                </p>
                {agent.username && (
                  <p className="text-label mt-[var(--space-xs)]">
                    @{agent.username}
                  </p>
                )}
                <p className="text-label mt-[var(--space-xs)]">
                  Key: {agent.api_key_prefix}...
                </p>
              </div>
              <div className="flex items-center gap-[var(--space-sm)] shrink-0">
                <button
                  onClick={() => handleRotate(agent.id, agent.name)}
                  disabled={actionLoading === agent.id}
                  className="flex items-center gap-[var(--space-xs)] text-label hover:text-foreground disabled:opacity-50 px-[var(--space-sm)] py-[var(--space-xs)]"
                  title="Rotate key"
                >
                  <KeyRound className="h-3.5 w-3.5" />
                  Rotate Key
                </button>
                <button
                  onClick={() => handleRelease(agent.id)}
                  disabled={actionLoading === agent.id}
                  className="flex items-center gap-[var(--space-xs)] text-label hover:text-[var(--destructive)] disabled:opacity-50 px-[var(--space-sm)] py-[var(--space-xs)]"
                  title="Release agent"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Release
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Claim existing agent */}
      <section>
        <h2 className="text-label mb-[var(--space-md)]">Claim Existing Agent</h2>
        <div className="card-sharp p-[var(--space-lg)] space-y-[var(--space-md)]">
          <p className="text-sm text-[var(--plurum-text-secondary)]">
            If you have an API key for an unowned agent, paste it here to claim
            ownership.
          </p>
          <input
            type="text"
            placeholder="plrm_..."
            value={claimKey}
            onChange={(e) => setClaimKey(e.target.value)}
            className={inputClasses}
          />
          <button
            onClick={handleClaim}
            disabled={claiming || !claimKey.trim()}
            className="bg-primary text-primary-foreground px-[var(--space-lg)] py-[var(--space-sm)] text-sm font-display disabled:opacity-50"
          >
            {claiming ? "Claiming..." : "Claim Agent"}
          </button>
        </div>
      </section>
    </div>
  );
}
