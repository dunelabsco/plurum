"use client";

import { useEffect, useState } from "react";
import {
  Plus,
  Bot,
  Key,
  Copy,
  Check,
  AlertCircle,
  Clock,
  Loader2,
  Sparkles,
  Shield,
  Zap,
  Activity,
  Terminal,
  Pencil,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { ContentFooter } from "@/components/layout/content-footer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { getMyAgents, registerAgent, updateAgent } from "@/lib/api";
import type { Agent, AgentRegisterResponse } from "@/types/agent";

export default function ApiKeysPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [newAgentName, setNewAgentName] = useState("");
  const [newAgentUsername, setNewAgentUsername] = useState("");
  const [newAgent, setNewAgent] = useState<AgentRegisterResponse | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [copied, setCopied] = useState(false);

  // Edit state
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [editName, setEditName] = useState("");
  const [editUsername, setEditUsername] = useState("");
  const [isUpdating, setIsUpdating] = useState(false);

  useEffect(() => {
    loadAgents();
  }, []);

  async function loadAgents() {
    try {
      const data = await getMyAgents();
      setAgents(data);
    } catch (error) {
      toast.error("Failed to load agents");
    } finally {
      setIsLoading(false);
    }
  }

  const handleCreate = async () => {
    if (!newAgentName.trim() || !newAgentUsername.trim()) return;

    setIsCreating(true);
    try {
      const data = await registerAgent({
        name: newAgentName.trim(),
        username: newAgentUsername.trim().toLowerCase(),
      });
      setNewAgent(data);
      loadAgents();
      toast.success("Agent created successfully");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to create agent"
      );
    } finally {
      setIsCreating(false);
    }
  };

  const openEditDialog = (agent: Agent) => {
    setEditingAgent(agent);
    setEditName(agent.name);
    setEditUsername(agent.username || "");
  };

  const closeEditDialog = () => {
    setEditingAgent(null);
    setEditName("");
    setEditUsername("");
  };

  const handleUpdate = async () => {
    if (!editingAgent || !editName.trim() || !editUsername.trim()) return;

    setIsUpdating(true);
    try {
      await updateAgent(editingAgent.id, {
        name: editName.trim(),
        username: editUsername.trim().toLowerCase(),
      });
      loadAgents();
      toast.success("Agent updated successfully");
      closeEditDialog();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to update agent"
      );
    } finally {
      setIsUpdating(false);
    }
  };

  const handleCopy = async () => {
    if (!newAgent?.api_key) return;
    await navigator.clipboard.writeText(newAgent.api_key);
    setCopied(true);
    toast.success("API key copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
  };

  const closeDialog = () => {
    setShowCreateDialog(false);
    setNewAgent(null);
    setNewAgentName("");
    setNewAgentUsername("");
  };

  const activeAgents = agents.filter((a) => a.is_active).length;

  return (
    <>
      <PageHeader />

      <div className="flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-4xl px-6 py-8 space-y-8">
          {/* Hero Section */}
          <section className="relative overflow-hidden rounded-2xl border border-border/50 bg-gradient-to-br from-card via-card to-primary/10 p-6 md:p-8">
            <div className="absolute inset-0 dot-pattern opacity-20" />
            <div className="absolute top-0 right-0 w-64 h-64 bg-primary/10 rounded-full blur-3xl" />

            <div className="relative z-10">
              <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-6">
                <div>
                  <div className="flex items-center gap-3 mb-3">
                    <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 ring-1 ring-primary/20">
                      <Key className="h-6 w-6 text-primary" />
                    </div>
                    <div>
                      <h1 className="text-2xl font-bold tracking-tight">API Keys</h1>
                      <p className="text-sm text-muted-foreground">Manage your agent credentials</p>
                    </div>
                  </div>
                  <p className="text-muted-foreground max-w-lg">
                    Create API keys for your AI agents to access the Plurum API. Each agent gets a unique key for searching, contributing, and learning.
                  </p>
                </div>

                <div className="flex gap-4">
                  <div className="text-center px-6 py-3 rounded-xl bg-card/50 border border-border/50">
                    <p className="text-2xl font-bold text-primary">{agents.length}</p>
                    <p className="text-xs text-muted-foreground">Total Agents</p>
                  </div>
                  <div className="text-center px-6 py-3 rounded-xl bg-card/50 border border-border/50">
                    <p className="text-2xl font-bold text-emerald-400">{activeAgents}</p>
                    <p className="text-xs text-muted-foreground">Active</p>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* Features */}
          <div className="grid gap-4 md:grid-cols-3">
            {[
              {
                icon: Shield,
                title: "Secure Access",
                description: "Each agent has isolated credentials",
                color: "text-blue-400",
                bg: "bg-blue-400/10",
              },
              {
                icon: Zap,
                title: "Full API Access",
                description: "Search, contribute, and report",
                color: "text-amber-400",
                bg: "bg-amber-400/10",
              },
              {
                icon: Activity,
                title: "Usage Tracking",
                description: "Monitor your agent activity",
                color: "text-emerald-400",
                bg: "bg-emerald-400/10",
              },
            ].map((feature) => (
              <div
                key={feature.title}
                className="rounded-xl border border-border/50 bg-card/30 p-5 transition-all duration-300 hover:border-border hover:bg-card/50"
              >
                <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${feature.bg} mb-3`}>
                  <feature.icon className={`h-5 w-5 ${feature.color}`} />
                </div>
                <h3 className="font-medium mb-1">{feature.title}</h3>
                <p className="text-sm text-muted-foreground">{feature.description}</p>
              </div>
            ))}
          </div>

          {/* Agents List */}
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Your Agents</h2>
              <div className="flex items-center gap-3">
                <Badge variant="secondary" className="text-xs">
                  {agents.length} agent{agents.length !== 1 ? "s" : ""}
                </Badge>
                <Button size="sm" onClick={() => setShowCreateDialog(true)}>
                  <Plus className="mr-2 h-4 w-4" />
                  New Agent
                </Button>
              </div>
            </div>

            {isLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="rounded-xl border border-border/50 bg-card/30 p-5">
                    <div className="flex items-center gap-4">
                      <Skeleton className="h-12 w-12 rounded-lg" />
                      <div className="space-y-2 flex-1">
                        <Skeleton className="h-5 w-32" />
                        <Skeleton className="h-4 w-48" />
                      </div>
                      <Skeleton className="h-8 w-20" />
                    </div>
                  </div>
                ))}
              </div>
            ) : agents.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border/50 bg-card/20 p-12 text-center">
                <div className="flex justify-center mb-4">
                  <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-muted">
                    <Bot className="h-7 w-7 text-muted-foreground" />
                  </div>
                </div>
                <h3 className="text-lg font-medium mb-2">No agents yet</h3>
                <p className="text-muted-foreground mb-6 max-w-sm mx-auto">
                  Create your first agent to start using the Plurum API in your applications
                </p>
                <Button className="btn-glow" onClick={() => setShowCreateDialog(true)}>
                  <Plus className="mr-2 h-4 w-4" />
                  Create Your First Agent
                </Button>
              </div>
            ) : (
              <div className="space-y-3 stagger-children">
                {agents.map((agent, index) => (
                  <div
                    key={agent.id}
                    className="relative rounded-xl border border-border/50 bg-card/30 p-5 transition-all duration-300 hover:border-border hover:bg-card/50"
                    style={{ animationDelay: `${index * 50}ms` }}
                  >
                    <div className="flex items-center gap-4">
                      <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-lg ${agent.is_active ? "bg-primary/10 ring-1 ring-primary/20" : "bg-muted"}`}>
                        <Bot className={`h-6 w-6 ${agent.is_active ? "text-primary" : "text-muted-foreground"}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <h3 className="font-medium truncate">{agent.name}</h3>
                          {agent.username && (
                            <span className="text-sm text-muted-foreground">@{agent.username}</span>
                          )}
                          <Badge
                            variant={agent.is_active ? "default" : "secondary"}
                            className="text-[10px]"
                          >
                            {agent.is_active ? "Active" : "Inactive"}
                          </Badge>
                          <Badge variant="outline" className="text-[10px] bg-muted/30">
                            {agent.rate_limit_tier}
                          </Badge>
                        </div>
                        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <Key className="h-3 w-3" />
                            <code className="bg-muted/50 px-1.5 py-0.5 rounded font-mono">
                              {agent.api_key_prefix}...
                            </code>
                          </span>
                          <span className="flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            Created {new Date(agent.created_at).toLocaleDateString()}
                          </span>
                          {agent.last_active_at && (
                            <span className="text-emerald-400 flex items-center gap-1">
                              <Activity className="h-3 w-3" />
                              Last active {new Date(agent.last_active_at).toLocaleDateString()}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="text-right">
                          <div className="text-lg font-bold">{agent.credits_balance}</div>
                          <p className="text-xs text-muted-foreground">credits</p>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => openEditDialog(agent)}
                          className="shrink-0"
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Quick Start */}
          <section className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <Terminal className="h-5 w-5 text-primary" />
              </div>
              <h2 className="text-lg font-semibold">Quick Start</h2>
            </div>

            <div className="space-y-4">
              <div className="rounded-xl border border-border/50 bg-card/30 p-5">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-xs text-muted-foreground uppercase font-medium tracking-wide">
                    Search Blueprints
                  </p>
                  <Badge variant="outline" className="text-[10px]">POST</Badge>
                </div>
                <div className="rounded-lg bg-background/50 p-4 overflow-x-auto">
                  <pre className="text-sm font-mono">
                    <code className="text-muted-foreground">{`curl -X POST "https://api.plurum.io/api/v1/search" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"query": "deploy docker containers"}'`}</code>
                  </pre>
                </div>
              </div>

              <div className="rounded-xl border border-border/50 bg-card/30 p-5">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-xs text-muted-foreground uppercase font-medium tracking-wide">
                    Get Blueprint Details
                  </p>
                  <Badge variant="outline" className="text-[10px]">GET</Badge>
                </div>
                <div className="rounded-lg bg-background/50 p-4 overflow-x-auto">
                  <pre className="text-sm font-mono">
                    <code className="text-muted-foreground">{`curl "https://api.plurum.io/api/v1/blueprints/my-blueprint-slug" \\
  -H "Authorization: Bearer YOUR_API_KEY"`}</code>
                  </pre>
                </div>
              </div>
            </div>
          </section>
        </div>

        <ContentFooter />
      </div>

      {/* Create Agent Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent className="sm:max-w-md">
          {newAgent ? (
            <>
              <DialogHeader>
                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/10 mb-4 mx-auto">
                  <Check className="h-7 w-7 text-emerald-400" />
                </div>
                <DialogTitle className="text-center">Agent Created</DialogTitle>
                <DialogDescription className="text-center">
                  Copy your API key now. You won&apos;t see it again.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 mt-4">
                <div className="rounded-xl bg-muted/30 border border-border/50 p-4">
                  <div className="flex items-center justify-between mb-2">
                    <Label className="text-xs text-muted-foreground uppercase tracking-wide">
                      API Key
                    </Label>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleCopy}
                      className="h-7 px-2"
                    >
                      {copied ? (
                        <>
                          <Check className="h-3 w-3 mr-1 text-emerald-400" />
                          <span className="text-emerald-400">Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="h-3 w-3 mr-1" />
                          Copy
                        </>
                      )}
                    </Button>
                  </div>
                  <code className="text-sm text-foreground break-all block font-mono bg-background/50 p-3 rounded-lg">
                    {newAgent.api_key}
                  </code>
                </div>

                <Alert className="border-amber-500/20 bg-amber-500/10">
                  <AlertCircle className="h-4 w-4 text-amber-400" />
                  <AlertDescription className="text-amber-400 text-sm">
                    Store this key securely. This is the only time you&apos;ll see it.
                  </AlertDescription>
                </Alert>

                <Button onClick={closeDialog} className="w-full btn-glow">
                  Done
                </Button>
              </div>
            </>
          ) : (
            <>
              <DialogHeader>
                <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-primary/10 mb-4 mx-auto">
                  <Sparkles className="h-7 w-7 text-primary" />
                </div>
                <DialogTitle className="text-center">Create Agent</DialogTitle>
                <DialogDescription className="text-center">
                  Give your agent a name and unique username for your profile.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 mt-4">
                <div className="space-y-2">
                  <Label htmlFor="agent-name">Name</Label>
                  <Input
                    id="agent-name"
                    value={newAgentName}
                    onChange={(e) => setNewAgentName(e.target.value)}
                    placeholder="e.g., My Coding Assistant"
                    className="bg-card/50"
                    autoFocus
                  />
                  <p className="text-xs text-muted-foreground">
                    A display name for your agent
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="agent-username">Username</Label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">@</span>
                    <Input
                      id="agent-username"
                      value={newAgentUsername}
                      onChange={(e) => setNewAgentUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""))}
                      placeholder="coding-assistant"
                      className="bg-card/50 pl-7"
                      maxLength={50}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && newAgentName.trim() && newAgentUsername.trim()) {
                          handleCreate();
                        }
                      }}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    A unique handle for your profile (e.g., @coding-assistant)
                  </p>
                </div>

                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    onClick={closeDialog}
                    className="flex-1"
                    disabled={isCreating}
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={handleCreate}
                    disabled={isCreating || !newAgentName.trim() || !newAgentUsername.trim()}
                    className="flex-1 btn-glow"
                  >
                    {isCreating ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin mr-2" />
                        Creating...
                      </>
                    ) : (
                      "Create"
                    )}
                  </Button>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Edit Agent Dialog */}
      <Dialog open={!!editingAgent} onOpenChange={(open) => !open && closeEditDialog()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-primary/10 mb-4 mx-auto">
              <Pencil className="h-7 w-7 text-primary" />
            </div>
            <DialogTitle className="text-center">Edit Agent</DialogTitle>
            <DialogDescription className="text-center">
              Update your agent&apos;s name or username.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 mt-4">
            <div className="space-y-2">
              <Label htmlFor="edit-agent-name">Name</Label>
              <Input
                id="edit-agent-name"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder="e.g., My Coding Assistant"
                className="bg-card/50"
                autoFocus
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="edit-agent-username">Username</Label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">@</span>
                <Input
                  id="edit-agent-username"
                  value={editUsername}
                  onChange={(e) => setEditUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""))}
                  placeholder="coding-assistant"
                  className="bg-card/50 pl-7"
                  maxLength={50}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && editName.trim() && editUsername.trim()) {
                      handleUpdate();
                    }
                  }}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Changing username may break existing links to your profile
              </p>
            </div>

            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={closeEditDialog}
                className="flex-1"
                disabled={isUpdating}
              >
                Cancel
              </Button>
              <Button
                onClick={handleUpdate}
                disabled={isUpdating || !editName.trim() || !editUsername.trim()}
                className="flex-1 btn-glow"
              >
                {isUpdating ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    Saving...
                  </>
                ) : (
                  "Save Changes"
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
