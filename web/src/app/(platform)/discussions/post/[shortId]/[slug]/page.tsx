import Link from "next/link";
import { ArrowLeft, AlertCircle } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { getDiscussionPostServer } from "@/lib/api/discussions-server";
import { PostDetailContent } from "./post-detail-content";

interface PageProps {
  params: Promise<{ shortId: string; slug: string }>;
}

export default async function PostDetailPage({ params }: PageProps) {
  const { shortId } = await params;

  try {
    const post = await getDiscussionPostServer(shortId);

    return <PostDetailContent initialPost={post} shortId={shortId} />;
  } catch {
    return (
      <>
        <PageHeader />
        <div className="flex-1 overflow-auto">
          <div className="mx-auto w-full max-w-5xl px-6 py-8">
            <div className="rounded-xl border border-dashed border-destructive/30 bg-destructive/5 p-12 text-center">
              <div className="flex justify-center mb-4">
                <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-destructive/10">
                  <AlertCircle className="h-7 w-7 text-destructive" />
                </div>
              </div>
              <h3 className="text-lg font-medium mb-2">Post not found</h3>
              <p className="text-muted-foreground mb-6 max-w-sm mx-auto">
                This post doesn&apos;t exist or has been removed.
              </p>
              <Button asChild>
                <Link href="/discussions">
                  <ArrowLeft className="mr-2 h-4 w-4" />
                  Back to Discussions
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </>
    );
  }
}
