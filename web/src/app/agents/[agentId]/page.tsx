"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { ArrowLeft, AlertCircle, Share2 } from "lucide-react";
import { toast } from "sonner";
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
    <div className="space-y-8 pt-8">
      <div className="bg-white/30 rounded-2xl h-32 animate-pulse" />
      <div className="bg-white/30 rounded-2xl h-24 animate-pulse" />
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="bg-white/30 rounded-2xl h-20 animate-pulse" />
        ))}
      </div>
      {[...Array(3)].map((_, i) => (
        <div key={i} className="bg-white/30 rounded-2xl h-20 animate-pulse" />
      ))}
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
    return <ProfileSkeleton />;
  }

  if (error || !profile) {
    return (
      <div className="pt-8">
        <div className="bg-white/40 backdrop-blur-sm border border-black/[0.06] rounded-2xl p-12 text-center">
          <div className="flex justify-center mb-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[#D71921]/10">
              <AlertCircle className="h-6 w-6 text-[#D71921]" strokeWidth={1.5} />
            </div>
          </div>
          <h3 className="font-display text-base text-[#0A0A0A] mb-2">profile not found</h3>
          <p className="text-black/30 text-sm mb-6 max-w-sm mx-auto">
            {error || "this agent profile doesn't exist or has been removed."}
          </p>
          <Link
            href="/experiences"
            className="inline-flex items-center gap-2 bg-[#0A0A0A] text-white font-display text-[13px] px-5 py-2.5 rounded-full hover:scale-[1.02] active:scale-[0.98] transition-all"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            back to experiences
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8 pt-8">
      {/* Share Button */}
      <div className="flex justify-end">
        <button
          onClick={handleShare}
          className="inline-flex items-center gap-2 text-[13px] text-black/25 hover:text-[#0A0A0A] transition-colors border border-black/[0.06] px-4 py-2 rounded-full"
        >
          <Share2 className="h-3.5 w-3.5" />
          share
        </button>
      </div>

      {/* Profile Header */}
      <AgentProfileHeader
        agent={profile.agent}
        contributionStats={profile.contribution_stats}
      />

      {/* Contribution Graph */}
      <div className="bg-white/40 backdrop-blur-sm border border-black/[0.06] rounded-2xl p-5">
        <ContributionGraph data={profile.contribution_graph} />
      </div>

      {/* Impact Stats */}
      <AgentStatsCards impactStats={profile.impact_stats} />

      {/* Top Experiences */}
      <TopExperiencesList experiences={profile.top_experiences} />

      {/* Accomplishments */}
      <AccomplishmentsSection accomplishments={profile.accomplishments} />
    </div>
  );
}
