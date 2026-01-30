"use client";

import { useState } from "react";
import { CheckCircle2, Reply, Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { VoteButtons } from "./vote-buttons";
import { ReplyEditor } from "./reply-editor";
import { voteOnReply, createReply } from "@/lib/api/discussions";
import type { DiscussionReply } from "@/types/discussion";
import { cn } from "@/lib/utils";

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

interface ReplyThreadProps {
  replies: DiscussionReply[];
  postShortId: string;
  postStatus: string;
  onReplyCreated?: () => void;
}

export function ReplyThread({
  replies,
  postShortId,
  postStatus,
  onReplyCreated,
}: ReplyThreadProps) {
  return (
    <div className="space-y-0">
      {replies.map((reply) => (
        <ReplyItem
          key={reply.id}
          reply={reply}
          postShortId={postShortId}
          postStatus={postStatus}
          onReplyCreated={onReplyCreated}
        />
      ))}
    </div>
  );
}

interface ReplyItemProps {
  reply: DiscussionReply;
  postShortId: string;
  postStatus: string;
  onReplyCreated?: () => void;
}

function ReplyItem({
  reply,
  postShortId,
  postStatus,
  onReplyCreated,
}: ReplyItemProps) {
  const [showReplyEditor, setShowReplyEditor] = useState(false);
  const canReply = postStatus === "active" && reply.depth < 5;

  const handleReplySubmit = async (body: string) => {
    await createReply(postShortId, {
      body,
      parent_reply_id: reply.id,
    });
    setShowReplyEditor(false);
    onReplyCreated?.();
  };

  return (
    <div
      className={cn(
        "border-l-2 border-border/30",
        reply.depth > 0 && "ml-6"
      )}
    >
      <div className="py-4 pl-4">
        {/* Reply header */}
        <div className="flex items-center gap-2 mb-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">
            {reply.author.username
              ? `@${reply.author.username}`
              : reply.author.name}
          </span>
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {timeAgo(reply.created_at)}
          </span>
          {reply.is_solution && (
            <Badge
              variant="default"
              className="text-[10px] bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
            >
              <CheckCircle2 className="h-3 w-3 mr-0.5" />
              Solution
            </Badge>
          )}
        </div>

        {/* Reply body */}
        <div className="text-sm leading-relaxed mb-2 whitespace-pre-wrap">
          {reply.body}
        </div>

        {/* Reply actions */}
        <div className="flex items-center gap-2">
          <VoteButtons
            upvotes={reply.upvotes}
            downvotes={reply.downvotes}
            onVote={(voteType) => voteOnReply(reply.id, voteType)}
            size="sm"
          />
          {canReply && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setShowReplyEditor(!showReplyEditor)}
            >
              <Reply className="h-3 w-3 mr-1" />
              Reply
            </Button>
          )}
        </div>

        {/* Inline reply editor */}
        {showReplyEditor && (
          <div className="mt-3">
            <ReplyEditor
              onSubmit={handleReplySubmit}
              onCancel={() => setShowReplyEditor(false)}
              placeholder="Write a reply..."
            />
          </div>
        )}
      </div>

      {/* Nested children */}
      {reply.children.length > 0 && (
        <ReplyThread
          replies={reply.children}
          postShortId={postShortId}
          postStatus={postStatus}
          onReplyCreated={onReplyCreated}
        />
      )}
    </div>
  );
}
