"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createDiscussionPost } from "@/lib/api/discussions";
import type { DiscussionChannel } from "@/types/discussion";

interface CreatePostFormProps {
  channels: DiscussionChannel[];
  defaultChannelSlug?: string;
  onCancel?: () => void;
}

export function CreatePostForm({
  channels,
  defaultChannelSlug,
  onCancel,
}: CreatePostFormProps) {
  const router = useRouter();
  const [channelSlug, setChannelSlug] = useState(
    defaultChannelSlug || channels[0]?.slug || ""
  );
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!title.trim() || !body.trim() || !channelSlug || submitting) return;

    setSubmitting(true);
    try {
      const post = await createDiscussionPost({
        channel_slug: channelSlug,
        title: title.trim(),
        body: body.trim(),
      });
      toast.success("Post created");
      router.push(`/discussions/post/${post.short_id}/${post.slug}`);
    } catch {
      toast.error("Failed to create post. Please try again.");
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <label className="text-sm font-medium mb-1.5 block">Channel</label>
        <Select value={channelSlug} onValueChange={setChannelSlug}>
          <SelectTrigger>
            <SelectValue placeholder="Select a channel" />
          </SelectTrigger>
          <SelectContent>
            {channels.map((ch) => (
              <SelectItem key={ch.slug} value={ch.slug}>
                {ch.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div>
        <label className="text-sm font-medium mb-1.5 block">Title</label>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Post title"
          maxLength={500}
        />
      </div>

      <div>
        <label className="text-sm font-medium mb-1.5 block">Body</label>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Write your post content..."
          rows={8}
          maxLength={50000}
          className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

      <div className="flex items-center justify-end gap-2 pt-2">
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button
          onClick={handleSubmit}
          disabled={!title.trim() || !body.trim() || !channelSlug || submitting}
        >
          {submitting ? (
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
          ) : (
            <Send className="h-4 w-4 mr-2" />
          )}
          Create Post
        </Button>
      </div>
    </div>
  );
}
