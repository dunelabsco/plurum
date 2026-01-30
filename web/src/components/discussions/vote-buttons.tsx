"use client";

import { useState } from "react";
import { ThumbsUp, ThumbsDown } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface VoteButtonsProps {
  upvotes: number;
  downvotes: number;
  onVote: (voteType: "up" | "down") => Promise<{ action: string }>;
  size?: "sm" | "md";
}

export function VoteButtons({
  upvotes: initialUpvotes,
  downvotes: initialDownvotes,
  onVote,
  size = "md",
}: VoteButtonsProps) {
  const [upvotes, setUpvotes] = useState(initialUpvotes);
  const [downvotes, setDownvotes] = useState(initialDownvotes);
  const [voting, setVoting] = useState(false);

  const handleVote = async (voteType: "up" | "down") => {
    if (voting) return;
    setVoting(true);

    // Optimistic update
    if (voteType === "up") {
      setUpvotes((prev) => prev + 1);
    } else {
      setDownvotes((prev) => prev + 1);
    }

    try {
      const result = await onVote(voteType);
      if (result.action === "removed") {
        // Vote was toggled off
        if (voteType === "up") {
          setUpvotes((prev) => Math.max(prev - 1, 0));
        } else {
          setDownvotes((prev) => Math.max(prev - 1, 0));
        }
      }
    } catch {
      // Revert optimistic update
      if (voteType === "up") {
        setUpvotes((prev) => Math.max(prev - 1, 0));
      } else {
        setDownvotes((prev) => Math.max(prev - 1, 0));
      }
      toast.error("Failed to vote. Please try again.");
    } finally {
      setVoting(false);
    }
  };

  const iconSize = size === "sm" ? "h-3 w-3" : "h-4 w-4";
  const textSize = size === "sm" ? "text-xs" : "text-sm";

  return (
    <div className="flex items-center gap-1">
      <button
        onClick={() => handleVote("up")}
        disabled={voting}
        className={cn(
          "flex items-center gap-1 rounded-md px-2 py-1 transition-colors",
          "hover:bg-emerald-400/10 hover:text-emerald-400",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          textSize
        )}
      >
        <ThumbsUp className={iconSize} />
        <span>{upvotes}</span>
      </button>
      <button
        onClick={() => handleVote("down")}
        disabled={voting}
        className={cn(
          "flex items-center gap-1 rounded-md px-2 py-1 transition-colors",
          "hover:bg-red-400/10 hover:text-red-400",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          textSize
        )}
      >
        <ThumbsDown className={iconSize} />
        <span>{downvotes}</span>
      </button>
    </div>
  );
}
