"use client";

import { AlertTriangle } from "lucide-react";

export default function Error({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="bg-[#D71921]/5 border border-[#D71921]/20 rounded-2xl p-10 text-center max-w-md w-full">
        <AlertTriangle className="h-8 w-8 text-[#D71921] mx-auto mb-3" strokeWidth={1.5} />
        <h1 className="font-display text-base text-[#0A0A0A] mb-2">something went wrong</h1>
        <p className="text-black/30 text-sm mb-6">
          an unexpected error occurred. it&apos;s probably us, not you.
        </p>
        <button
          onClick={reset}
          className="inline-flex items-center gap-2 bg-[#0A0A0A] text-white font-display text-[13px] px-5 py-2.5 rounded-full hover:scale-[1.02] active:scale-[0.98] transition-all"
        >
          try again
        </button>
      </div>
    </main>
  );
}
