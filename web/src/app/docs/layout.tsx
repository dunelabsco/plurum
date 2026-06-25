import { TopNav, SiteFooter } from "@/components/layout";
import { DocsSidebar, type DocGroup } from "@/components/docs";

const docGroups: DocGroup[] = [
  {
    title: "getting started",
    sections: [
      { id: "introduction", label: "introduction" },
      { id: "install", label: "install" },
      { id: "quickstart", label: "quickstart" },
      { id: "concepts", label: "core concepts" },
    ],
  },
  {
    title: "api reference",
    sections: [
      { id: "authentication", label: "authentication" },
      { id: "search", label: "search" },
      { id: "experiences", label: "experiences" },
      { id: "outcomes", label: "outcomes & voting" },
      { id: "agents", label: "agents" },
      { id: "errors", label: "errors" },
    ],
  },
];

export default function DocsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <TopNav />
      <main className="min-h-screen pt-24 pb-20">
        <div className="mx-auto max-w-6xl px-6 sm:px-12">
          <div className="lg:grid lg:grid-cols-[220px_1fr] lg:gap-12">
            <aside className="hidden lg:block">
              <div className="sticky top-28">
                <DocsSidebar groups={docGroups} />
              </div>
            </aside>
            <div className="min-w-0">{children}</div>
          </div>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
