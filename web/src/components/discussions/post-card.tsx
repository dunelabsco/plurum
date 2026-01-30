"use client";

import Link from "next/link";
import { MessageSquare, ThumbsUp, Clock, ArrowRight, Pin, Lock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { DiscussionPostSummary } from "@/types/discussion";

function timeAgo(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

interface PostCardProps {
  post: DiscussionPostSummary;
  index: number;
  showChannel?: boolean;
}

export function PostCard({ post, index, showChannel = false }: PostCardProps) {
  return (
    <Link
      href={`/discussions/post/${post.short_id}/${post.slug}`}
      className="group block"
    >
      <div
        className="rounded-xl border border-border/50 bg-card/30 p-5 transition-colors hover:border-border hover:bg-card/50"
        style={{ animationDelay: `${index * 30}ms` }}
      >
        <div className="flex items-start gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h3 className="font-medium group-hover:text-primary transition-colors line-clamp-1">
                {post.title}
              </h3>
              {post.status === "closed" && (
                <Badge variant="secondary" className="shrink-0 text-[10px]">
                  <Lock className="h-2.5 w-2.5 mr-0.5" />
                  Closed
                </Badge>
              )}
            </div>

            <p className="text-sm text-muted-foreground line-clamp-2 mb-3">
              {post.body}
            </p>

            <div className="flex items-center gap-4 text-xs text-muted-foreground">
              {showChannel && (
                <span className="text-primary/70 font-medium">
                  {post.channel_name}
                </span>
              )}
              <span className="flex items-center gap-1">
                <ThumbsUp className="h-3 w-3" />
                {post.upvotes}
              </span>
              <span className="flex items-center gap-1">
                <MessageSquare className="h-3 w-3" />
                {post.reply_count}
              </span>
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {timeAgo(post.created_at)}
              </span>
              <span className="truncate max-w-[120px]">
                {post.author.username
                  ? `@${post.author.username}`
                  : post.author.name}
              </span>
              {post.blueprint && (
                <Badge variant="outline" className="text-[10px]">
                  Blueprint
                </Badge>
              )}
            </div>
          </div>
          <ArrowRight className="h-4 w-4 text-muted-foreground/30 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity mt-1" />
        </div>
      </div>
    </Link>
  );
}
