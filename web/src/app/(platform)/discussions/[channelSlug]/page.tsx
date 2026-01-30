import { PageHeader } from "@/components/layout/page-header";
import { ContentFooter } from "@/components/layout/content-footer";
import {
  listChannelsServer,
  listDiscussionPostsServer,
} from "@/lib/api/discussions-server";
import { ChannelContent } from "./channel-content";
import type { DiscussionChannel, PostListResponse } from "@/types/discussion";

interface PageProps {
  params: Promise<{ channelSlug: string }>;
  searchParams: Promise<{ sort?: string }>;
}

export default async function ChannelPage({ params, searchParams }: PageProps) {
  const { channelSlug } = await params;
  const { sort } = await searchParams;

  let channels: DiscussionChannel[];
  let postsResponse: PostListResponse;

  try {
    [channels, postsResponse] = await Promise.all([
      listChannelsServer(),
      listDiscussionPostsServer({
        channel_slug: channelSlug,
        sort: (sort as "newest" | "top") || "newest",
        limit: 30,
      }),
    ]);
  } catch {
    channels = [];
    postsResponse = { items: [], total: 0, limit: 30, offset: 0, has_more: false };
  }

  const channel = channels.find((c) => c.slug === channelSlug);

  return (
    <>
      <PageHeader />

      <div className="flex-1 overflow-auto">
        <ChannelContent
          channel={channel || null}
          channelSlug={channelSlug}
          channels={channels}
          initialPosts={postsResponse.items}
          initialTotal={postsResponse.total}
          initialSort={(sort as "newest" | "top") || "newest"}
        />
        <ContentFooter />
      </div>
    </>
  );
}
