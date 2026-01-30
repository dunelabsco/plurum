"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MessageCircle, Plus, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PostCard, CreatePostForm } from "@/components/discussions";
import type {
  DiscussionChannel,
  DiscussionPostSummary,
} from "@/types/discussion";

interface ChannelContentProps {
  channel: DiscussionChannel | null;
  channelSlug: string;
  channels: DiscussionChannel[];
  initialPosts: DiscussionPostSummary[];
  initialTotal: number;
  initialSort: "newest" | "top";
}

export function ChannelContent({
  channel,
  channelSlug,
  channels,
  initialPosts,
  initialTotal,
  initialSort,
}: ChannelContentProps) {
  const router = useRouter();
  const [showCreateForm, setShowCreateForm] = useState(false);

  const handleSortChange = (sort: string) => {
    router.push(`/discussions/${channelSlug}?sort=${sort}`);
  };

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8 space-y-6">
      {/* Breadcrumb + Header */}
      <div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground mb-4">
          <Link href="/discussions" className="hover:text-foreground transition-colors">
            Discussions
          </Link>
          <span>/</span>
          <span className="text-foreground">
            {channel?.name || channelSlug}
          </span>
        </div>

        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              {channel?.name || channelSlug}
            </h1>
            {channel?.description && (
              <p className="text-muted-foreground mt-1">
                {channel.description}
              </p>
            )}
          </div>
          <Button onClick={() => setShowCreateForm(true)} className="shrink-0">
            <Plus className="h-4 w-4 mr-2" />
            New Post
          </Button>
        </div>
      </div>

      {/* Sort Controls */}
      <Tabs value={initialSort} onValueChange={handleSortChange}>
        <TabsList>
          <TabsTrigger value="newest">Newest</TabsTrigger>
          <TabsTrigger value="top">Top</TabsTrigger>
        </TabsList>
      </Tabs>

      {/* Posts */}
      {initialPosts.length > 0 ? (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {initialTotal} post{initialTotal !== 1 ? "s" : ""}
          </p>
          {initialPosts.map((post, i) => (
            <PostCard key={post.id} post={post} index={i} />
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-border/50 p-12 text-center">
          <MessageCircle className="h-8 w-8 text-muted-foreground/50 mx-auto mb-3" />
          <p className="text-muted-foreground mb-2">No posts in this channel</p>
          <p className="text-sm text-muted-foreground mb-4">
            Start the conversation
          </p>
          <Button
            variant="outline"
            onClick={() => setShowCreateForm(true)}
          >
            <Plus className="h-4 w-4 mr-2" />
            Create First Post
          </Button>
        </div>
      )}

      {/* Create Post Dialog */}
      <Dialog open={showCreateForm} onOpenChange={setShowCreateForm}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Create New Post</DialogTitle>
          </DialogHeader>
          <CreatePostForm
            channels={channels}
            defaultChannelSlug={channelSlug}
            onCancel={() => setShowCreateForm(false)}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
