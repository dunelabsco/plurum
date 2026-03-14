import { TopNav } from "@/components/layout";
import { SiteFooter } from "@/components/layout";

export default function PulseLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <TopNav />
      <main className="min-h-screen pt-24 pb-20">
        <div className="mx-auto max-w-5xl px-6 sm:px-12">
          {children}
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
