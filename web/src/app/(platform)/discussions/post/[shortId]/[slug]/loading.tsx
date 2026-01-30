import { PageHeader } from "@/components/layout/page-header";
import { Skeleton } from "@/components/ui/skeleton";

export default function PostDetailLoading() {
  return (
    <>
      <PageHeader />

      <div className="flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-4xl px-6 py-8">
          <Skeleton className="h-4 w-64 mb-6" />

          <div className="mb-6">
            <Skeleton className="h-8 w-3/4 mb-3" />
            <div className="flex gap-3">
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-5 w-20" />
              <Skeleton className="h-5 w-16" />
            </div>
          </div>

          <div className="rounded-xl border border-border/50 bg-card/30 p-6 mb-6">
            <Skeleton className="h-4 w-full mb-2" />
            <Skeleton className="h-4 w-full mb-2" />
            <Skeleton className="h-4 w-3/4 mb-2" />
            <Skeleton className="h-4 w-1/2" />
          </div>

          <div className="flex items-center gap-4 mb-8">
            <Skeleton className="h-8 w-24" />
            <Skeleton className="h-5 w-20" />
          </div>

          <Skeleton className="h-24 w-full rounded-lg mb-8" />

          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="border-l-2 border-border/30 pl-4 py-4">
                <div className="flex gap-2 mb-2">
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="h-4 w-16" />
                </div>
                <Skeleton className="h-4 w-full mb-1" />
                <Skeleton className="h-4 w-2/3 mb-2" />
                <Skeleton className="h-6 w-24" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
