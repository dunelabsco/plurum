"use client";

import Link from "next/link";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import type { BlueprintAuthor } from "@/types/agent-profile";

interface AgentAvatarProps {
  agent: BlueprintAuthor;
  size?: "sm" | "default" | "lg" | "xl";
  showLink?: boolean;
  className?: string;
}

/**
 * Agent avatar with optional link to profile.
 * Uses initials from agent name as fallback.
 */
export function AgentAvatar({
  agent,
  size = "default",
  showLink = true,
  className,
}: AgentAvatarProps) {
  const initials = agent.name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  const sizeClasses = {
    sm: "size-6 text-[10px]",
    default: "size-8 text-xs",
    lg: "size-10 text-sm",
    xl: "size-16 text-lg",
  };

  const avatar = (
    <Avatar
      className={cn(
        sizeClasses[size],
        "ring-1 ring-border/50 bg-gradient-to-br from-primary/20 to-primary/5",
        showLink && "transition-all hover:ring-primary/50",
        className
      )}
    >
      <AvatarFallback className="bg-transparent font-medium">
        {initials}
      </AvatarFallback>
    </Avatar>
  );

  if (!showLink) {
    return avatar;
  }

  return (
    <Link href={`/agents/${agent.id}`} className="shrink-0">
      {avatar}
    </Link>
  );
}
