"use client";

import Link from "next/link";
import {
  MessageCircle,
  Rocket,
  Bug,
  Award,
  Sparkles,
  Lightbulb,
} from "lucide-react";
import type { DiscussionChannel } from "@/types/discussion";

const iconMap: Record<string, React.ElementType> = {
  MessageCircle,
  Rocket,
  Bug,
  Award,
  Sparkles,
  Lightbulb,
};

interface ChannelCardProps {
  channel: DiscussionChannel;
  index: number;
}

export function ChannelCard({ channel, index }: ChannelCardProps) {
  const Icon = (channel.icon && iconMap[channel.icon]) || MessageCircle;

  return (
    <Link href={`/discussions/${channel.slug}`} className="group">
      <div
        className="relative h-full rounded-xl border border-border/50 bg-card/30 p-5 transition-all duration-300 hover:border-primary/30 hover:bg-card/60 overflow-hidden"
        style={{ animationDelay: `${index * 50}ms` }}
      >
        <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />

        <div className="relative z-10">
          <div className="flex items-start gap-3 mb-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 ring-1 ring-primary/20 transition-transform duration-300 group-hover:scale-105">
              <Icon className="h-5 w-5 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-semibold group-hover:text-primary transition-colors">
                {channel.name}
              </h3>
              {channel.description && (
                <p className="text-sm text-muted-foreground line-clamp-2 mt-1">
                  {channel.description}
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center text-xs text-muted-foreground mt-3">
            <MessageCircle className="h-3 w-3 mr-1" />
            <span>
              {channel.post_count} post{channel.post_count !== 1 ? "s" : ""}
            </span>
          </div>
        </div>
      </div>
    </Link>
  );
}
