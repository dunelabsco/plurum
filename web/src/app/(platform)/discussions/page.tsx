import { PageHeader } from "@/components/layout/page-header";
import { ContentFooter } from "@/components/layout/content-footer";
import { listChannelsServer, listRecentPostsServer } from "@/lib/api/discussions-server";
import { DiscussionsContent } from "./discussions-content";
import type { DiscussionChannel, DiscussionPostSummary } from "@/types/discussion";

export default async function DiscussionsPage() {
  let channels: DiscussionChannel[];
  let recentPosts: DiscussionPostSummary[];

  try {
    [channels, recentPosts] = await Promise.all([
      listChannelsServer(),
      listRecentPostsServer(20),
    ]);
  } catch {
    channels = [];
    recentPosts = [];
  }

  return (
    <>
      <PageHeader />

      <div className="flex-1 overflow-auto">
        <DiscussionsContent
          initialChannels={channels}
          initialRecentPosts={recentPosts}
        />
        <ContentFooter />
      </div>
    </>
  );
}
