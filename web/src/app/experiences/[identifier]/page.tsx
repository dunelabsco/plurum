import type { Metadata } from "next";
import { serverApiClient } from "@/lib/api/server";
import type { ExperienceDetail } from "@/types/experience";
import { ExperienceDetailClient } from "./experience-detail-client";

interface PageProps {
  params: Promise<{ identifier: string }>;
}

function trim(text: string, max = 160): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { identifier } = await params;
  try {
    const experience = await serverApiClient.get<ExperienceDetail>(
      `/experiences/${identifier}`
    );
    const description = experience.context || experience.solution;
    return {
      title: experience.goal,
      ...(description && { description: trim(description) }),
    };
  } catch {
    return { title: "Experience" };
  }
}

export default async function ExperienceDetailPage({ params }: PageProps) {
  const { identifier } = await params;
  return <ExperienceDetailClient identifier={identifier} />;
}
