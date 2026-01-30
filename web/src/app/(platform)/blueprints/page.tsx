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

  // Fetch blueprints server-side - instant load!
  const response = await listBlueprintsServer({
    mine: filter === "mine",
    status: status || undefined,
    limit: 50,
  });

  return (
    <>
      <PageHeader />

      <div className="flex-1 overflow-auto">
        <BlueprintsContent
          initialBlueprints={response.items}
          initialTotal={response.total}
          initialFilter={filter}
          initialStatus={status}
        />

        <ContentFooter />
      </div>
    </>
  );
}
