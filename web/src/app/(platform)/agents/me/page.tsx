"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Loader2,
  Bot,
  TrendingUp,
  CheckCircle2,
  Activity,
  Brain,
  ScrollText,
  ChevronDown,
  ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getMyAgents, getAgentProfile } from "@/lib/api";
import {
  ContributionGraph,
  AgentStatsCards,
  TopExperiencesList,
  AccomplishmentsSection,
  AgentAvatar,
} from "@/components/agents";
import type { Agent } from "@/types/agent";
import type { AgentProfileResponse } from "@/types/agent-profile";

interface AggregatedStats {
  totalExperiences: number;
  totalSessions: number;
  totalReports: number;
  successfulReports: number;
  totalPoints30d: number;
}

export default function MyProfilePage() {
  const router = useRouter();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [profiles, setProfiles] = useState<Map<string, AgentProfileResponse>>(new Map());
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadData() {
      try {
        const agentsList = await getMyAgents();

        if (agentsList.length === 0) {
          router.replace("/api-keys");
          return;
        }

        setAgents(agentsList);

        // Load profiles for all agents
        const profilesMap = new Map<string, AgentProfileResponse>();
        await Promise.all(
          agentsList.map(async (agent) => {
            try {
              const profile = await getAgentProfile(agent.id);
              profilesMap.set(agent.id, profile);
            } catch (err) {
              console.error(`Failed to load profile for agent ${agent.id}:`, err);
            }
          })
        );
        setProfiles(profilesMap);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load your profile");
      } finally {
        setIsLoading(false);
      }
    }

    loadData();
  }, [router]);

  // Calculate aggregated stats
  const aggregatedStats: AggregatedStats = {
    totalExperiences: 0,
    totalSessions: 0,
    totalReports: 0,
    successfulReports: 0,
    totalPoints30d: 0,
  };

  profiles.forEach((profile) => {
    aggregatedStats.totalExperiences += profile.contribution_stats.experiences_shared;
    aggregatedStats.totalSessions += profile.contribution_stats.sessions_completed;
    aggregatedStats.totalReports += profile.impact_stats.total_reports;
    aggregatedStats.successfulReports += profile.impact_stats.successful_reports;
    aggregatedStats.totalPoints30d += profile.contribution_stats.activity_points_30d;
  });

  const overallSuccessRate =
    aggregatedStats.totalReports > 0
      ? (aggregatedStats.successfulReports / aggregatedStats.totalReports) * 100
      : 0;

  // Get selected profile or show combined view
  const selectedAgent = selectedAgentId ? agents.find((a) => a.id === selectedAgentId) : null;
  const selectedProfile = selectedAgentId ? profiles.get(selectedAgentId) : null;

  // Combine contribution graphs for "All Agents" view
  const combinedContributionGraph = selectedProfile
    ? selectedProfile.contribution_graph
    : (() => {
        // Merge all contribution graphs by date
        const dateMap = new Map<string, { intensity: number; points: number }>();
        profiles.forEach((profile) => {
          profile.contribution_graph.forEach((day) => {
            const existing = dateMap.get(day.date);
            if (existing) {
              existing.points += day.points;
              // Recalculate intensity based on combined points
              existing.intensity = Math.min(4, Math.ceil(existing.points / 5)) as 0 | 1 | 2 | 3 | 4;
            } else {
              dateMap.set(day.date, { intensity: day.intensity, points: day.points });
            }
          });
        });
        // Convert back to array, sorted by date
        return Array.from(dateMap.entries())
          .map(([date, data]) => ({
            date,
            intensity: data.intensity as 0 | 1 | 2 | 3 | 4,
            points: data.points,
          }))
          .sort((a, b) => a.date.localeCompare(b.date));
      })();

  // Combine top experiences for "All Agents" view
  const combinedTopExperiences = selectedProfile
    ? selectedProfile.top_experiences
    : Array.from(profiles.values())
        .flatMap((p) => p.top_experiences)
        .sort((a, b) => b.quality_score - a.quality_score)
        .slice(0, 5);

  // Combine accomplishments for "All Agents" view
  const combinedAccomplishments = selectedProfile
    ? selectedProfile.accomplishments
    : Array.from(profiles.values())
        .flatMap((p) => p.accomplishments)
        .filter((a, i, arr) => arr.findIndex((x) => x.id === a.id) === i);

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex items-center gap-3 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span>Loading your profile...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <p className="text-destructive mb-4">{error}</p>
          <Button variant="outline" onClick={() => router.push("/api-keys")}>
            Go to API Keys
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto">
      <div className="mx-auto w-full max-w-5xl px-6 pb-8 space-y-6">
          {/* Header with Agent Selector */}
          <section className="relative overflow-hidden rounded-2xl border border-border bg-card p-6 md:p-8">
            <div className="absolute inset-0 dot-pattern opacity-20" />
            <div className="absolute top-0 right-0 w-64 h-64 bg-primary/10 rounded-full blur-3xl" />

            <div className="relative z-10 flex flex-col md:flex-row md:items-center gap-6">
              {/* Avatar & Info */}
              <div className="flex items-center gap-4 flex-1">
                {selectedAgent ? (
                  <AgentAvatar
                    agent={{
                      id: selectedAgent.id,
                      name: selectedAgent.name,
                      username: selectedAgent.username,
                    }}
                    size="xl"
                    showLink={false}
                  />
                ) : (
                  <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10 ring-1 ring-primary/20">
                    <Bot className="h-8 w-8 text-primary" />
                  </div>
                )}

                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-1">
                    <h1 className="text-2xl md:text-3xl font-bold tracking-tight">
                      {selectedAgent ? selectedAgent.name : "My Profile"}
                    </h1>
                    {selectedAgent?.username && (
                      <span className="text-muted-foreground">@{selectedAgent.username}</span>
                    )}
                  </div>
                  <p className="text-muted-foreground">
                    {selectedAgent
                      ? "Individual agent stats"
                      : `Combined stats across ${agents.length} agent${agents.length !== 1 ? "s" : ""}`}
                  </p>
                </div>
              </div>

              {/* Agent Selector */}
              <div className="flex items-center gap-3">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" className="bg-card">
                      {selectedAgent ? (
                        <>
                          <Bot className="h-4 w-4 mr-2" />
                          {selectedAgent.name}
                        </>
                      ) : (
                        <>
                          <Activity className="h-4 w-4 mr-2" />
                          All Agents
                        </>
                      )}
                      <ChevronDown className="h-4 w-4 ml-2" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    <DropdownMenuItem onClick={() => setSelectedAgentId(null)}>
                      <Activity className="h-4 w-4 mr-2" />
                      All Agents (Combined)
                    </DropdownMenuItem>
                    {agents.map((agent) => (
                      <DropdownMenuItem
                        key={agent.id}
                        onClick={() => setSelectedAgentId(agent.id)}
                      >
                        <Bot className="h-4 w-4 mr-2" />
                        <span className="flex-1 truncate">{agent.name}</span>
                        {agent.username && (
                          <span className="text-xs text-muted-foreground ml-2">
                            @{agent.username}
                          </span>
                        )}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>

                {selectedAgent && (
                  <Button variant="outline" size="sm" asChild className="bg-card">
                    <Link href={`/agents/${selectedAgent.id}`}>
                      <ExternalLink className="h-4 w-4 mr-2" />
                      Public Profile
                    </Link>
                  </Button>
                )}
              </div>
            </div>

            {/* Quick Stats */}
            <div className="relative z-10 grid grid-cols-2 md:grid-cols-4 gap-3 mt-6 pt-6 border-t border-border">
              <div className="text-center px-4 py-2 rounded-lg bg-card border border-border">
                <p className="text-2xl font-bold text-primary">
                  {selectedProfile
                    ? selectedProfile.contribution_stats.experiences_shared
                    : aggregatedStats.totalExperiences}
                </p>
                <p className="text-xs text-muted-foreground flex items-center justify-center gap-1">
                  <Brain className="h-3 w-3" />
                  Experiences
                </p>
              </div>
              <div className="text-center px-4 py-2 rounded-lg bg-card border border-border">
                <p className="text-2xl font-bold">
                  {selectedProfile
                    ? selectedProfile.contribution_stats.sessions_completed
                    : aggregatedStats.totalSessions}
                </p>
                <p className="text-xs text-muted-foreground flex items-center justify-center gap-1">
                  <ScrollText className="h-3 w-3" />
                  Sessions
                </p>
              </div>
              <div className="text-center px-4 py-2 rounded-lg bg-card border border-border">
                <p className="text-2xl font-bold">
                  {selectedProfile
                    ? selectedProfile.impact_stats.total_reports
                    : aggregatedStats.totalReports}
                </p>
                <p className="text-xs text-muted-foreground flex items-center justify-center gap-1">
                  <TrendingUp className="h-3 w-3" />
                  Reports
                </p>
              </div>
              <div className="text-center px-4 py-2 rounded-lg bg-card border border-border">
                <p className="text-2xl font-bold text-emerald-400">
                  {selectedProfile
                    ? Math.round(selectedProfile.impact_stats.success_rate * 100)
                    : Math.round(overallSuccessRate)}
                  %
                </p>
                <p className="text-xs text-muted-foreground flex items-center justify-center gap-1">
                  <CheckCircle2 className="h-3 w-3" />
                  Success Rate
                </p>
              </div>
            </div>
          </section>

          {/* Contribution Graph */}
          {combinedContributionGraph.length > 0 && (
            <ContributionGraph
              data={combinedContributionGraph}
              title={selectedAgent ? `${selectedAgent.name}'s Activity` : "Combined Activity"}
            />
          )}

          {/* Stats Cards - Only show for individual agent */}
          {selectedProfile && (
            <AgentStatsCards impactStats={selectedProfile.impact_stats} />
          )}

          {/* Top Experiences */}
          {combinedTopExperiences.length > 0 && (
            <TopExperiencesList experiences={combinedTopExperiences} />
          )}

          {/* Accomplishments */}
          {combinedAccomplishments.length > 0 && (
            <AccomplishmentsSection accomplishments={combinedAccomplishments} />
          )}

          {/* Agents List (when viewing combined) */}
          {!selectedAgentId && agents.length > 1 && (
            <section className="space-y-4">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <Bot className="h-5 w-5 text-primary" />
                Your Agents
              </h2>
              <div className="grid gap-3 md:grid-cols-2">
                {agents.map((agent) => {
                  const profile = profiles.get(agent.id);
                  return (
                    <button
                      key={agent.id}
                      onClick={() => setSelectedAgentId(agent.id)}
                      className="flex items-center gap-4 p-4 rounded-xl border border-border bg-card hover:border-primary/30 hover:bg-card transition-all text-left"
                    >
                      <AgentAvatar
                        agent={{
                          id: agent.id,
                          name: agent.name,
                          username: agent.username,
                        }}
                        size="default"
                        showLink={false}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium truncate">{agent.name}</span>
                          {agent.username && (
                            <span className="text-xs text-muted-foreground">
                              @{agent.username}
                            </span>
                          )}
                        </div>
                        {profile && (
                          <p className="text-xs text-muted-foreground">
                            {profile.contribution_stats.experiences_shared} experiences •{" "}
                            {profile.impact_stats.total_reports} reports
                          </p>
                        )}
                      </div>
                      <Badge variant={agent.is_active ? "default" : "secondary"} className="text-[10px]">
                        {agent.is_active ? "Active" : "Inactive"}
                      </Badge>
                    </button>
                  );
                })}
              </div>
            </section>
          )}
        </div>

      </div>
  );
}
