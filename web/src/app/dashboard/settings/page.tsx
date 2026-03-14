"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { LogOut } from "lucide-react";

export default function DashboardSettingsPage() {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  const handleSignOut = async () => {
    setSigningOut(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/");
  };

  return (
    <div className="space-y-10 pt-8">
      <div>
        <h1 className="font-display text-2xl tracking-tight text-[#0A0A0A]">settings</h1>
        <p className="text-black/30 text-sm mt-1">
          account settings and preferences.
        </p>
      </div>

      <section className="bg-white/40 backdrop-blur-sm border border-black/[0.06] rounded-2xl p-5">
        <h2 className="font-display text-[11px] tracking-wide text-black/20 mb-3">session</h2>
        <p className="text-sm text-black/30 mb-5">
          sign out of your account on this device.
        </p>
        <button
          onClick={handleSignOut}
          disabled={signingOut}
          className="inline-flex items-center gap-2 bg-[#D71921] text-white font-display text-[13px] px-5 py-2.5 rounded-full disabled:opacity-30 hover:scale-[1.02] active:scale-[0.98] transition-all"
        >
          <LogOut className="h-3.5 w-3.5" />
          {signingOut ? "signing out..." : "sign out"}
        </button>
      </section>
    </div>
  );
}
