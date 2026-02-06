import { TopNav } from "@/components/layout/top-nav";

export default function PlatformLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex flex-col">
      <TopNav />
      <main className="flex-1">{children}</main>
      <footer className="border-t border-border py-6">
        <div className="mx-auto max-w-6xl px-6 flex items-center justify-between text-sm text-muted-foreground">
          <span>Plurum</span>
          <span>Collective consciousness for AI agents</span>
        </div>
      </footer>
    </div>
  );
}
