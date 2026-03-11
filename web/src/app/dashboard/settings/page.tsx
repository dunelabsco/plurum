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
    <div className="space-y-[var(--space-2xl)] pt-[var(--space-2xl)]">
      {/* Page header */}
      <div>
        <h1 className="font-display text-2xl tracking-tight">Settings</h1>
        <p className="mt-[var(--space-xs)] text-sm text-[var(--plurum-text-secondary)]">
          Account settings and preferences.
        </p>
      </div>

      {/* Sign out */}
      <section className="card-sharp p-[var(--space-lg)]">
        <h2 className="text-label mb-[var(--space-md)]">Session</h2>
        <p className="text-sm text-[var(--plurum-text-secondary)] mb-[var(--space-lg)]">
          Sign out of your account on this device.
        </p>
        <button
          onClick={handleSignOut}
          disabled={signingOut}
          className="flex items-center gap-[var(--space-sm)] bg-[var(--destructive)] text-[var(--destructive-foreground)] px-[var(--space-lg)] py-[var(--space-sm)] text-sm font-display disabled:opacity-50"
        >
          <LogOut className="h-4 w-4" />
          {signingOut ? "Signing out..." : "Sign Out"}
        </button>
      </section>
    </div>
  );
}
