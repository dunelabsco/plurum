import { TopNav } from "@/components/layout";
import { SiteFooter } from "@/components/layout";

export default function SessionsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <TopNav />
      <main className="min-h-screen pt-16 pb-[var(--space-3xl)]">
        <div className="mx-auto max-w-5xl px-[var(--space-xl)]">
          {children}
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
