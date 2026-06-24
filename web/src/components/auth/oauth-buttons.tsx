"use client";

import { useState } from "react";
import { Github, Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type Provider = "google" | "github";

const PROVIDER_LABELS: Record<Provider, string> = {
  google: "continue with Google",
  github: "continue with GitHub",
};

export function OAuthButtons({ next = "/dashboard" }: { next?: string }) {
  const [loading, setLoading] = useState<Provider | null>(null);
  const supabase = createClient();

  async function handle(provider: Provider) {
    setLoading(provider);
    const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo },
    });
    if (error) {
      console.error(`OAuth ${provider} failed:`, error);
      setLoading(null);
    }
    // success path: browser navigates away to the provider, no state cleanup needed
  }

  const baseClasses =
    "w-full flex items-center justify-center gap-2.5 bg-white/40 backdrop-blur-sm border border-black/[0.06] text-[#0A0A0A] font-display text-[13px] py-3 rounded-full hover:bg-white/60 hover:border-black/15 active:scale-[0.99] transition-all disabled:opacity-30";

  return (
    <div className="space-y-2.5">
      <button
        type="button"
        onClick={() => handle("google")}
        disabled={loading !== null}
        className={baseClasses}
      >
        {loading === "google" ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <GoogleIcon className="h-4 w-4" />
        )}
        {PROVIDER_LABELS.google}
      </button>

      <button
        type="button"
        onClick={() => handle("github")}
        disabled={loading !== null}
        className={baseClasses}
      >
        {loading === "github" ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Github className="h-4 w-4" strokeWidth={1.5} />
        )}
        {PROVIDER_LABELS.github}
      </button>
    </div>
  );
}

function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M21.6 12.2c0-.7-.06-1.4-.17-2H12v3.8h5.4a4.6 4.6 0 0 1-2 3.05v2.5h3.23c1.9-1.74 2.97-4.3 2.97-7.35Z"
        fill="#4285F4"
      />
      <path
        d="M12 22c2.7 0 4.96-.9 6.62-2.43l-3.22-2.5c-.9.6-2.04.96-3.4.96-2.6 0-4.82-1.76-5.61-4.12H3.06v2.58A10 10 0 0 0 12 22Z"
        fill="#34A853"
      />
      <path
        d="M6.39 13.91A6 6 0 0 1 6.07 12c0-.67.11-1.32.32-1.91V7.5H3.06A10 10 0 0 0 2 12c0 1.62.39 3.15 1.06 4.5l3.33-2.59Z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.96c1.47 0 2.79.5 3.83 1.5l2.87-2.86A10 10 0 0 0 12 2 10 10 0 0 0 3.06 7.5l3.33 2.59C7.18 7.72 9.4 5.96 12 5.96Z"
        fill="#EA4335"
      />
    </svg>
  );
}

export function OAuthDivider() {
  return (
    <div className="relative">
      <div className="absolute inset-0 flex items-center">
        <div className="w-full border-t border-black/[0.06]" />
      </div>
      <div className="relative flex justify-center text-[11px]">
        <span className="bg-white/40 px-3 text-black/25 font-display tracking-wide">or</span>
      </div>
    </div>
  );
}
