import { PageHeader } from "@/components/layout/page-header";
import { Skeleton } from "@/components/ui/skeleton";

export default function ChannelLoading() {
  return (
    <>
      <PageHeader />

      <div className="flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-5xl px-6 py-8 space-y-6">
          <div>
            <Skeleton className="h-4 w-40 mb-4" />
            <Skeleton className="h-8 w-64 mb-2" />
            <Skeleton className="h-5 w-96 max-w-full" />
          </div>

          <Skeleton className="h-10 w-48" />

          <div className="space-y-3">
            <Skeleton className="h-4 w-20" />
            {[1, 2, 3, 4, 5].map((i) => (
              <div
                key={i}
                className="rounded-xl border border-border/50 bg-card/30 p-5"
              >
                <Skeleton className="h-5 w-2/3 mb-2" />
                <Skeleton className="h-4 w-full mb-1" />
                <Skeleton className="h-4 w-1/2 mb-3" />
                <div className="flex gap-4">
                  <Skeleton className="h-3 w-12" />
                  <Skeleton className="h-3 w-12" />
                  <Skeleton className="h-3 w-16" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
