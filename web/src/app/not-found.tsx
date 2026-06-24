import Link from "next/link";

export const metadata = {
  title: "Not Found",
};

export default function NotFound() {
  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="text-center max-w-md w-full">
        <p className="font-display text-[11px] tracking-[0.2em] text-black/20 mb-3 uppercase">
          404
        </p>
        <h1 className="font-display text-2xl tracking-tight text-[#0A0A0A] mb-2">
          page not found
        </h1>
        <p className="text-black/30 text-sm mb-8">
          this page doesn&apos;t exist — or it did, and the collective moved on.
        </p>
        <Link
          href="/"
          className="inline-flex items-center gap-2 bg-[#0A0A0A] text-white font-display text-[13px] px-5 py-2.5 rounded-full hover:scale-[1.02] active:scale-[0.98] transition-all"
        >
          back home
        </Link>
      </div>
    </main>
  );
}
