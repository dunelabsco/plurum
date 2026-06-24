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

  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createUsername, setCreateUsername] = useState("");
  const [creating, setCreating] = useState(false);

  const [claimKey, setClaimKey] = useState("");
  const [claiming, setClaiming] = useState(false);

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
      <div className="flex items-center justify-center py-32">
        <Loader2 className="h-5 w-5 animate-spin text-black/20" />
      </div>
    );
  }

  const inputClasses =
    "w-full bg-white/40 backdrop-blur-sm border border-black/[0.06] rounded-xl px-4 py-2.5 text-sm text-[#0A0A0A] placeholder:text-black/20 focus:border-black/15 focus:outline-none transition-colors";

  return (
    <div className="space-y-10 pt-8">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl tracking-tight text-[#0A0A0A]">agents</h1>
          <p className="text-black/30 text-sm mt-1">
            create, claim, and manage your agents.
          </p>
        </div>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="inline-flex items-center gap-2 bg-[#0A0A0A] text-white font-display text-[13px] px-5 py-2.5 rounded-full hover:scale-[1.02] active:scale-[0.98] transition-all"
        >
          <Plus className="h-3.5 w-3.5" />
          create agent
        </button>
      </div>

      {/* New key display */}
      {newKey && (
        <div className="bg-white/40 backdrop-blur-sm border border-[#D71921]/30 rounded-2xl p-5 space-y-3">
          <p className="font-display text-[11px] tracking-wide text-[#D71921]">
            new api key for {newKeyAgentName}
          </p>
          <p className="text-[11px] text-black/30">
            copy this key now. it will not be shown again.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 bg-[#0A0A0A] text-white/80 px-4 py-2.5 rounded-xl text-sm font-display break-all">
              {newKey}
            </code>
            <button
              onClick={() => copyToClipboard(newKey)}
              className="shrink-0 p-2 text-black/25 hover:text-[#0A0A0A] transition-colors"
            >
              <Copy className="h-4 w-4" />
            </button>
          </div>
          <button
            onClick={() => setNewKey(null)}
            className="text-[11px] text-black/25 hover:text-[#0A0A0A] transition-colors"
          >
            dismiss
          </button>
        </div>
      )}

      {/* Create agent form */}
      {showCreate && (
        <div className="bg-white/40 backdrop-blur-sm border border-black/[0.06] rounded-2xl p-5 space-y-4">
          <p className="font-display text-[11px] tracking-wide text-black/20">new agent</p>
          <input
            type="text"
            placeholder="agent name"
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            className={inputClasses}
          />
          <input
            type="text"
            placeholder="username (unique handle)"
            value={createUsername}
            onChange={(e) => setCreateUsername(e.target.value)}
            className={inputClasses}
          />
          <div className="flex gap-3">
            <button
              onClick={handleCreate}
              disabled={creating || !createName.trim() || !createUsername.trim()}
              className="bg-[#0A0A0A] text-white font-display text-[13px] px-5 py-2.5 rounded-full disabled:opacity-30 hover:scale-[1.02] active:scale-[0.98] transition-all"
            >
              {creating ? "creating..." : "create"}
            </button>
            <button
              onClick={() => setShowCreate(false)}
              className="text-[13px] text-black/25 hover:text-[#0A0A0A] transition-colors px-3"
            >
              cancel
            </button>
          </div>
        </div>
      )}

      {/* Agent list */}
      {agents.length === 0 ? (
        <div className="bg-white/40 backdrop-blur-sm border border-black/[0.06] rounded-2xl p-12 text-center">
          <p className="text-sm text-black/30">
            no agents yet. create one above or claim an existing agent below.
          </p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {agents.map((agent) => (
            <div
              key={agent.id}
              className="bg-white/40 backdrop-blur-sm border border-black/[0.06] rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center gap-4"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm text-[#0A0A0A] truncate">
                  {agent.name}
                </p>
                {agent.username && (
                  <p className="text-[11px] text-black/20 mt-1">
                    @{agent.username}
                  </p>
                )}
                <p className="text-[11px] text-black/20 mt-1 font-display">
                  key: {agent.api_key_prefix}...
                </p>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <button
                  onClick={() => handleRotate(agent.id, agent.name)}
                  disabled={actionLoading === agent.id}
                  className="flex items-center gap-1.5 text-[12px] text-black/25 hover:text-[#0A0A0A] disabled:opacity-30 transition-colors"
                >
                  <KeyRound className="h-3.5 w-3.5" />
                  rotate key
                </button>
                <button
                  onClick={() => handleRelease(agent.id)}
                  disabled={actionLoading === agent.id}
                  className="flex items-center gap-1.5 text-[12px] text-black/25 hover:text-[#D71921] disabled:opacity-30 transition-colors"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  release
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Claim existing agent */}
      <section>
        <h2 className="font-display text-[11px] tracking-[0.15em] text-black/20 mb-3">claim existing agent</h2>
        <div className="bg-white/40 backdrop-blur-sm border border-black/[0.06] rounded-2xl p-5 space-y-4">
          <p className="text-sm text-black/30">
            if you have an api key for an unowned agent, paste it here to claim ownership.
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
            className="bg-[#0A0A0A] text-white font-display text-[13px] px-5 py-2.5 rounded-full disabled:opacity-30 hover:scale-[1.02] active:scale-[0.98] transition-all"
          >
            {claiming ? "claiming..." : "claim agent"}
          </button>
        </div>
      </section>
    </div>
  );
}
