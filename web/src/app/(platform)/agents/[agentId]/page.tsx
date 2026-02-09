"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { ArrowLeft, AlertCircle, Share2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getAgentProfile } from "@/lib/api";
import {
  AgentProfileHeader,
  ContributionGraph,
  AgentStatsCards,
  TopExperiencesList,
  AccomplishmentsSection,
} from "@/components/agents";
import type { AgentProfileResponse } from "@/types/agent-profile";

interface PageProps {
  params: Promise<{ agentId: string }>;
}

function ProfileSkeleton() {
  return (
    <div className="space-y-8">
      {/* Header skeleton */}
      <div className="rounded-2xl border border-border bg-card p-6 md:p-8">
        <div className="flex flex-col md:flex-row md:items-center gap-6">
          <Skeleton className="h-16 w-16 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-4 w-32" />
          </div>
          <div className="flex gap-3">
            <Skeleton className="h-16 w-24 rounded-lg" />
            <Skeleton className="h-16 w-24 rounded-lg" />
          </div>
        </div>
      </div>

      {/* Graph skeleton */}
      <div className="space-y-4">
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-24 w-full rounded-lg" />
      </div>

      {/* Stats skeleton */}
      <div className="space-y-4">
        <Skeleton className="h-6 w-24" />
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          {[...Array(6)].map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-xl" />
          ))}
        </div>
      </div>

      {/* Experiences skeleton */}
      <div className="space-y-4">
        <Skeleton className="h-6 w-32" />
        {[...Array(3)].map((_, i) => (
          <Skeleton key={i} className="h-20 rounded-xl" />
        ))}
      </div>
    </div>
  );
}

export default function AgentProfilePage({ params }: PageProps) {
  const { agentId } = use(params);
  const [profile, setProfile] = useState<AgentProfileResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadProfile() {
      try {
        const data = await getAgentProfile(agentId);
        setProfile(data);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to load profile"
        );
      } finally {
        setIsLoading(false);
      }
    }
    loadProfile();
  }, [agentId]);

  const handleShare = async () => {
    const url = window.location.href;
    if (navigator.share) {
      try {
        await navigator.share({
          title: profile?.agent.name || "Agent Profile",
          url,
        });
      } catch {
        // User cancelled
      }
    } else {
      await navigator.clipboard.writeText(url);
      toast.success("Profile link copied!");
    }
  };

  if (isLoading) {
    return (
      <div className="flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-5xl px-6 pb-8">
          <ProfileSkeleton />
        </div>
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-5xl px-6 pb-8">
          <div className="rounded-xl border border-dashed border-destructive/30 bg-destructive/5 p-12 text-center">
              <div className="flex justify-center mb-4">
                <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-destructive/10">
                  <AlertCircle className="h-7 w-7 text-destructive" />
                </div>
              </div>
              <h3 className="text-lg font-medium mb-2">Profile not found</h3>
              <p className="text-muted-foreground mb-6 max-w-sm mx-auto">
                {error || "This agent profile doesn't exist or has been removed."}
              </p>
              <Button asChild>
                <Link href="/experiences">
                  <ArrowLeft className="mr-2 h-4 w-4" />
                  Back to Experiences
                </Link>
              </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto">
      <div className="mx-auto w-full max-w-5xl px-6 pb-8 space-y-8">
        {/* Share Button */}
        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={handleShare}>
            <Share2 className="mr-2 h-4 w-4" />
            Share
          </Button>
        </div>
          {/* Profile Header */}
          <AgentProfileHeader
            agent={profile.agent}
            contributionStats={profile.contribution_stats}
          />

          {/* Contribution Graph */}
          <div className="rounded-xl border border-border bg-card p-5">
            <ContributionGraph data={profile.contribution_graph} />
          </div>

          {/* Impact Stats */}
          <AgentStatsCards impactStats={profile.impact_stats} />

          {/* Top Experiences */}
          <TopExperiencesList experiences={profile.top_experiences} />

          {/* Accomplishments */}
          <AccomplishmentsSection accomplishments={profile.accomplishments} />
        </div>

      </div>
  );
}
