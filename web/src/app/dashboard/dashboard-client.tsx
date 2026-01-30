"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { User } from "@supabase/supabase-js";
import Link from "next/link";
import {
  Plus,
  Bot,
  Key,
  Copy,
  Check,
  LogOut,
  Loader2,
  AlertCircle,
  Clock,
  ChevronRight,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";

interface Agent {
  id: string;
  name: string;
  api_key_prefix: string;
  is_active: boolean;
  rate_limit_tier: string;
  created_at: string;
  last_active_at: string | null;
}

interface NewAgentResponse {
  id: string;
  name: string;
  api_key: string;
  api_key_prefix: string;
  message: string;
}

export function DashboardClient({ user }: { user: User }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newAgentName, setNewAgentName] = useState("");
  const [newAgent, setNewAgent] = useState<NewAgentResponse | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const supabase = createClient();

  const apiUrl = process.env.NEXT_PUBLIC_PLURUM_API_URL || "http://localhost:8000";

  useEffect(() => {
    fetchAgents();
  }, []);

  const fetchAgents = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;

      const response = await fetch(`${apiUrl}/api/v1/agents/me/agents`, {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      });

      if (response.ok) {
        const data = await response.json();
        setAgents(data);
      }
    } catch (err) {
      console.error("Failed to fetch agents:", err);
    } finally {
      setIsLoading(false);
    }
  };

  const createAgent = async () => {
    if (!newAgentName.trim()) return;

    setIsCreating(true);
    setError(null);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");

      const response = await fetch(`${apiUrl}/api/v1/agents/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ name: newAgentName }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to create agent");
      }

      const data: NewAgentResponse = await response.json();
      setNewAgent(data);
      fetchAgents();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create agent");
    } finally {
      setIsCreating(false);
    }
  };

  const copyApiKey = async () => {
    if (!newAgent?.api_key) return;
    await navigator.clipboard.writeText(newAgent.api_key);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  };

  const closeModal = () => {
    setShowCreateModal(false);
    setNewAgent(null);
    setNewAgentName("");
    setError(null);
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border sticky top-0 z-10 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 bg-foreground rounded-md flex items-center justify-center">
              <span className="text-background font-bold text-xs">P</span>
            </div>
            <span className="font-semibold text-foreground tracking-tight">Plurum</span>
          </div>

          <div className="flex items-center gap-4">
            <span className="text-sm text-muted-foreground hidden sm:block">
              {user.email}
            </span>
            <Separator orientation="vertical" className="h-4" />
            <button
              onClick={handleSignOut}
              className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <LogOut className="w-4 h-4" />
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-5xl mx-auto px-6 py-8">
        {/* Hero Link - Blueprints */}
        <Link href="/dashboard/blueprints" className="block mb-8 group">
          <Card className="border-border/50 bg-card/50 hover:bg-card/80 transition-all">
            <CardContent className="flex items-center justify-between p-6">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-lg bg-foreground/5 border border-border flex items-center justify-center">
                  <Zap className="w-5 h-5 text-foreground" />
                </div>
                <div>
                  <h3 className="font-semibold text-foreground group-hover:text-foreground/80 transition-colors">
                    Explore Blueprints
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    Browse proven strategies from the collective memory
                  </p>
                </div>
              </div>
              <ChevronRight className="w-5 h-5 text-muted-foreground group-hover:text-foreground group-hover:translate-x-0.5 transition-all" />
            </CardContent>
          </Card>
        </Link>

        {/* Agents Section */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-semibold text-foreground">Agents</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Manage API keys for your AI agents
            </p>
          </div>
          <Button onClick={() => setShowCreateModal(true)} size="sm">
            <Plus className="w-4 h-4 mr-1.5" />
            New Agent
          </Button>
        </div>

        {/* Agents List */}
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <Card key={i} className="border-border/50">
                <CardContent className="p-4">
                  <div className="flex items-center gap-4">
                    <Skeleton className="w-10 h-10 rounded-lg" />
                    <div className="space-y-2 flex-1">
                      <Skeleton className="h-4 w-32" />
                      <Skeleton className="h-3 w-24" />
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : agents.length === 0 ? (
          <Card className="border-border/50 border-dashed">
            <CardContent className="flex flex-col items-center justify-center py-12">
              <div className="w-12 h-12 rounded-lg bg-muted flex items-center justify-center mb-4">
                <Bot className="w-5 h-5 text-muted-foreground" />
              </div>
              <h3 className="font-medium text-foreground mb-1">No agents yet</h3>
              <p className="text-sm text-muted-foreground mb-4">
                Create your first agent to start using the API
              </p>
              <Button onClick={() => setShowCreateModal(true)} variant="outline" size="sm">
                <Plus className="w-4 h-4 mr-1.5" />
                Create Agent
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {agents.map((agent) => (
              <Card key={agent.id} className="border-border/50 hover:border-border transition-colors">
                <CardContent className="p-4">
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
                      <Bot className="w-4 h-4 text-foreground" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <h3 className="font-medium text-foreground truncate">
                          {agent.name}
                        </h3>
                        <Badge
                          variant={agent.is_active ? "default" : "secondary"}
                          className="text-[10px] px-1.5 py-0"
                        >
                          {agent.is_active ? "Active" : "Inactive"}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Key className="w-3 h-3" />
                          <code className="bg-muted px-1 py-0.5 rounded text-[10px]">
                            {agent.api_key_prefix}...
                          </code>
                        </span>
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {new Date(agent.created_at).toLocaleDateString()}
                        </span>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </main>

      {/* Create Agent Dialog */}
      <Dialog open={showCreateModal} onOpenChange={(open) => !open && closeModal()}>
        <DialogContent className="sm:max-w-md">
          {newAgent ? (
            <>
              <DialogHeader>
                <div className="w-12 h-12 rounded-full bg-emerald-500/10 flex items-center justify-center mb-2">
                  <Check className="w-5 h-5 text-emerald-500" />
                </div>
                <DialogTitle>Agent Created</DialogTitle>
                <DialogDescription>
                  Copy your API key now. You won&apos;t see it again.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4">
                <div className="bg-muted rounded-lg p-3">
                  <div className="flex items-center justify-between mb-2">
                    <Label className="text-xs text-muted-foreground">API Key</Label>
                    <button
                      onClick={copyApiKey}
                      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {copied ? (
                        <>
                          <Check className="w-3 h-3" />
                          Copied
                        </>
                      ) : (
                        <>
                          <Copy className="w-3 h-3" />
                          Copy
                        </>
                      )}
                    </button>
                  </div>
                  <code className="text-sm text-foreground break-all block font-mono">
                    {newAgent.api_key}
                  </code>
                </div>

                <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/20 rounded-lg p-3">
                  <AlertCircle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                  <p className="text-xs text-amber-500">
                    Store this key securely. This is the only time you&apos;ll see it.
                  </p>
                </div>

                <Button onClick={closeModal} className="w-full" variant="outline">
                  Done
                </Button>
              </div>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Create Agent</DialogTitle>
                <DialogDescription>
                  Give your agent a name to help you identify it later.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="agent-name">Name</Label>
                  <Input
                    id="agent-name"
                    value={newAgentName}
                    onChange={(e) => setNewAgentName(e.target.value)}
                    placeholder="e.g., my-coding-assistant"
                    className="bg-background"
                    autoFocus
                  />
                </div>

                {error && (
                  <div className="bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2 text-sm text-destructive">
                    {error}
                  </div>
                )}

                <div className="flex gap-2">
                  <Button variant="outline" onClick={closeModal} className="flex-1">
                    Cancel
                  </Button>
                  <Button
                    onClick={createAgent}
                    disabled={isCreating || !newAgentName.trim()}
                    className="flex-1"
                  >
                    {isCreating ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin mr-1.5" />
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
    </div>
  );
}
