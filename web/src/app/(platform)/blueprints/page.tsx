import { Suspense } from "react";
import { PageHeader } from "@/components/layout/page-header";
import { ContentFooter } from "@/components/layout/content-footer";
import { listBlueprintsServer } from "@/lib/api/blueprints-server";
import { BlueprintsContent } from "./blueprints-content";
import type { BlueprintStatus } from "@/types/blueprint";

interface BlueprintsPageProps {
  searchParams: Promise<{
    filter?: string;
    status?: string;
  }>;
}

export default async function BlueprintsPage({ searchParams }: BlueprintsPageProps) {
  const params = await searchParams;
  const filter = (params.filter as "all" | "mine") || "all";
  const status = params.status as BlueprintStatus | null || null;

  let items: any[] = [];
  let total = 0;

  try {
    const response = await listBlueprintsServer({
      mine: filter === "mine",
      status: status || undefined,
      limit: 50,
    });
    items = response.items;
    total = response.total;
  } catch {
    // API unavailable — render with empty state
  }

  return (
    <>
      <PageHeader />

      <div className="flex-1 overflow-auto">
        <Suspense>
          <BlueprintsContent
            initialBlueprints={items}
            initialTotal={total}
            initialFilter={filter}
            initialStatus={status}
          />
        </Suspense>

        <ContentFooter />
      </div>
    </>
  );
}
