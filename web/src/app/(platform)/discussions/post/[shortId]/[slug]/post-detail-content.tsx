"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  MessageSquare,
  Clock,
  Lock,
  Trash2,
  MoreHorizontal,
  BookOpen,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { ContentFooter } from "@/components/layout/content-footer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { VoteButtons, ReplyThread, ReplyEditor } from "@/components/discussions";
import {
  getDiscussionPost,
  deleteDiscussionPost,
  voteOnPost,
  createReply,
} from "@/lib/api/discussions";
import type { DiscussionPostDetail } from "@/types/discussion";

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

interface PostDetailContentProps {
  initialPost: DiscussionPostDetail;
  shortId: string;
}

export function PostDetailContent({
  initialPost,
  shortId,
}: PostDetailContentProps) {
  const router = useRouter();
  const [post, setPost] = useState(initialPost);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const refreshPost = useCallback(async () => {
    try {
      const updated = await getDiscussionPost(shortId);
      setPost(updated);
    } catch {
      // Ignore refresh errors
    }
  }, [shortId]);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deleteDiscussionPost(shortId);
      toast.success("Post deleted");
      router.push("/discussions");
    } catch {
      toast.error("Failed to delete post");
      setDeleting(false);
    }
  };

  const handleTopLevelReply = async (body: string) => {
    await createReply(shortId, { body });
    refreshPost();
  };

  return (
    <>
      <PageHeader />

      <div className="flex-1 flex flex-col overflow-auto">
        <div className="flex-1 mx-auto w-full max-w-4xl px-6 py-8">
          {/* Breadcrumb */}
          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-6">
            <Link
              href="/discussions"
              className="hover:text-foreground transition-colors"
            >
              Discussions
            </Link>
            <span>/</span>
            <Link
              href={`/discussions/${post.channel_slug}`}
              className="hover:text-foreground transition-colors"
            >
              {post.channel_name}
            </Link>
            <span>/</span>
            <span className="text-foreground truncate max-w-[200px]">
              {post.title}
            </span>
          </div>

          {/* Post Header */}
          <div className="mb-6">
            <div className="flex items-start justify-between gap-4 mb-3">
              <h1 className="text-2xl font-bold tracking-tight">
                {post.title}
              </h1>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="shrink-0">
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    className="text-destructive"
                    onClick={() => setShowDeleteDialog(true)}
                  >
                    <Trash2 className="h-4 w-4 mr-2" />
                    Delete Post
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <span className="font-medium text-foreground">
                {post.author.username
                  ? `@${post.author.username}`
                  : post.author.name}
              </span>
              <Badge variant="outline" className="text-[10px]">
                {post.channel_name}
              </Badge>
              <span className="flex items-center gap-1">
                <Clock className="h-3.5 w-3.5" />
                {timeAgo(post.created_at)}
              </span>
              {post.status === "closed" && (
                <Badge
                  variant="secondary"
                  className="text-[10px]"
                >
                  <Lock className="h-2.5 w-2.5 mr-0.5" />
                  Closed
                </Badge>
              )}
            </div>
          </div>

          {/* Post Body */}
          <div className="rounded-xl border border-border/50 bg-card/30 p-6 mb-6">
            <div className="prose prose-sm prose-invert max-w-none whitespace-pre-wrap">
              {post.body}
            </div>
          </div>

          {/* Post Actions */}
          <div className="flex items-center justify-between mb-8">
            <div className="flex items-center gap-4">
              <VoteButtons
                upvotes={post.upvotes}
                downvotes={post.downvotes}
                onVote={(voteType) => voteOnPost(shortId, voteType)}
              />
              <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <MessageSquare className="h-4 w-4" />
                {post.reply_count} repl{post.reply_count !== 1 ? "ies" : "y"}
              </span>
            </div>

            {post.blueprint && (
              <Link
                href={`/blueprints/${post.blueprint.short_id}/${post.blueprint.slug}`}
                className="flex items-center gap-2 text-sm text-primary hover:underline"
              >
                <BookOpen className="h-4 w-4" />
                {post.blueprint.title}
              </Link>
            )}
          </div>

          {/* Reply Editor (top-level) */}
          {post.status === "active" && (
            <div className="mb-8">
              <h3 className="text-sm font-medium mb-3">Add a Reply</h3>
              <ReplyEditor
                onSubmit={handleTopLevelReply}
                placeholder="Share your thoughts..."
              />
            </div>
          )}

          {post.status === "closed" && (
            <div className="rounded-lg border border-border/50 bg-muted/20 p-4 mb-8 text-center">
              <Lock className="h-4 w-4 text-muted-foreground mx-auto mb-1" />
              <p className="text-sm text-muted-foreground">
                This post is closed for new replies
              </p>
            </div>
          )}

          {/* Replies */}
          {post.replies.length > 0 && (
            <div>
              <h3 className="text-sm font-medium mb-4">
                Replies ({post.reply_count})
              </h3>
              <ReplyThread
                replies={post.replies}
                postShortId={shortId}
                postStatus={post.status}
                onReplyCreated={refreshPost}
              />
            </div>
          )}
        </div>

        <ContentFooter />
      </div>

      {/* Delete Confirmation Dialog */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Post</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this post? This action cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setShowDeleteDialog(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
