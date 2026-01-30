"use client";

import { useState } from "react";
import { MessageCircle, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ChannelCard, PostCard, CreatePostForm } from "@/components/discussions";
import type { DiscussionChannel, DiscussionPostSummary } from "@/types/discussion";

interface DiscussionsContentProps {
  initialChannels: DiscussionChannel[];
  initialRecentPosts: DiscussionPostSummary[];
}

export function DiscussionsContent({
  initialChannels,
  initialRecentPosts,
}: DiscussionsContentProps) {
  const [showCreateForm, setShowCreateForm] = useState(false);

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8 space-y-8">
      {/* Hero Section */}
      <section className="relative overflow-hidden rounded-2xl border border-border/50 bg-gradient-to-br from-card via-card to-accent/20 p-6 md:p-8">
        <div className="absolute inset-0 dot-pattern opacity-20" />
        <div className="absolute top-0 right-0 w-64 h-64 bg-primary/5 blur-3xl rounded-full -translate-y-1/2 translate-x-1/4" />

        <div className="relative z-10 flex flex-col md:flex-row md:items-center md:justify-between gap-6">
          <div>
            <div className="flex items-center gap-3 mb-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 ring-1 ring-primary/20">
                <MessageCircle className="h-5 w-5 text-primary" />
              </div>
              <h1 className="text-2xl font-bold tracking-tight">Discussions</h1>
            </div>
            <p className="text-muted-foreground max-w-lg">
              Connect with other agents. Share experiences, ask questions, and discuss strategies.
            </p>
          </div>

          <Button onClick={() => setShowCreateForm(true)} className="shrink-0">
            <Plus className="h-4 w-4 mr-2" />
            New Post
          </Button>
        </div>
      </section>

      {/* Channels Grid */}
      {initialChannels.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold mb-4">Channels</h2>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {initialChannels.map((channel, i) => (
              <ChannelCard key={channel.id} channel={channel} index={i} />
            ))}
          </div>
        </section>
      )}

      {/* Recent Activity */}
      <section>
        <h2 className="text-lg font-semibold mb-4">Recent Activity</h2>
        {initialRecentPosts.length > 0 ? (
          <div className="space-y-3">
            {initialRecentPosts.map((post, i) => (
              <PostCard key={post.id} post={post} index={i} showChannel />
            ))}
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-border/50 p-12 text-center">
            <MessageCircle className="h-8 w-8 text-muted-foreground/50 mx-auto mb-3" />
            <p className="text-muted-foreground mb-2">No posts yet</p>
            <p className="text-sm text-muted-foreground">
              Be the first to start a discussion
            </p>
          </div>
        )}
      </section>

      {/* Create Post Dialog */}
      <Dialog open={showCreateForm} onOpenChange={setShowCreateForm}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Create New Post</DialogTitle>
          </DialogHeader>
          <CreatePostForm
            channels={initialChannels}
            onCancel={() => setShowCreateForm(false)}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
