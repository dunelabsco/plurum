"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { LogOut, Loader2 } from "lucide-react";

export default function DashboardSettingsPage() {
  const router = useRouter();
  const supabase = createClient();

  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [createdAt, setCreatedAt] = useState<string | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [initialDisplayName, setInitialDisplayName] = useState("");

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState(false);

  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      const u = data.user;
      if (u) {
        setEmail(u.email ?? "");
        setCreatedAt(u.created_at ?? null);
        const name =
          (u.user_metadata?.display_name as string | undefined) ??
          (u.user_metadata?.full_name as string | undefined) ??
          (u.user_metadata?.name as string | undefined) ??
          "";
        setDisplayName(name);
        setInitialDisplayName(name);
        setProvider(u.app_metadata?.provider ?? null);
      }
      setLoading(false);
    });
  }, [supabase]);

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSaveError(null);
    setSaveOk(false);
    try {
      const { error } = await supabase.auth.updateUser({
        data: { display_name: displayName.trim() },
      });
      if (error) throw error;
      setInitialDisplayName(displayName.trim());
      setSaveOk(true);
      setTimeout(() => setSaveOk(false), 2500);
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : "could not save");
    } finally {
      setSaving(false);
    }
  };

  const handleSignOut = async () => {
    setSigningOut(true);
    await supabase.auth.signOut();
    router.push("/");
  };

  const profileDirty = displayName.trim() !== initialDisplayName.trim();
  const inputClasses =
    "w-full bg-white/40 backdrop-blur-sm border border-black/[0.06] rounded-xl px-4 py-3 text-sm text-[#0A0A0A] placeholder:text-black/20 focus:border-black/15 focus:outline-none transition-colors disabled:opacity-50";

  const formattedJoined = createdAt
    ? new Date(createdAt).toLocaleDateString(undefined, {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : null;

  return (
    <div className="space-y-10 pt-8">
      <div>
        <h1 className="font-display text-2xl tracking-tight text-[#0A0A0A]">settings</h1>
        <p className="text-black/30 text-sm mt-1">
          account settings and preferences.
        </p>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-4 w-4 animate-spin text-black/30" />
        </div>
      ) : (
        <>
          <section className="bg-white/40 backdrop-blur-sm border border-black/[0.06] rounded-2xl p-5">
            <h2 className="font-display text-[11px] tracking-wide text-black/20 mb-4">profile</h2>
            <form onSubmit={handleSaveProfile} className="space-y-4">
              <div className="space-y-2">
                <label htmlFor="display-name" className="font-display text-[11px] tracking-wide text-black/25 block">
                  display name
                </label>
                <input
                  id="display-name"
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="how should we call you?"
                  className={inputClasses}
                  maxLength={80}
                />
              </div>

              {saveError && (
                <div className="border border-[#D71921]/20 rounded-xl bg-[#D71921]/5 px-4 py-2.5 text-sm text-[#D71921]">
                  {saveError}
                </div>
              )}
              {saveOk && (
                <div className="border border-black/[0.06] rounded-xl bg-white/60 px-4 py-2.5 text-sm text-[#0A0A0A]">
                  saved.
                </div>
              )}

              <button
                type="submit"
                disabled={saving || !profileDirty}
                className="bg-[#0A0A0A] text-white font-display text-[13px] px-5 py-2.5 rounded-full hover:scale-[1.01] active:scale-[0.99] transition-all disabled:opacity-30"
              >
                {saving ? (
                  <span className="flex items-center justify-center gap-2">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    saving...
                  </span>
                ) : (
                  "save"
                )}
              </button>
            </form>
          </section>

          <section className="bg-white/40 backdrop-blur-sm border border-black/[0.06] rounded-2xl p-5">
            <h2 className="font-display text-[11px] tracking-wide text-black/20 mb-4">account</h2>
            <dl className="space-y-3 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-black/30">email</dt>
                <dd className="text-[#0A0A0A] truncate">{email}</dd>
              </div>
              {provider && (
                <div className="flex justify-between gap-4">
                  <dt className="text-black/30">signed in with</dt>
                  <dd className="text-[#0A0A0A]">{provider}</dd>
                </div>
              )}
              {formattedJoined && (
                <div className="flex justify-between gap-4">
                  <dt className="text-black/30">joined</dt>
                  <dd className="text-[#0A0A0A]">{formattedJoined}</dd>
                </div>
              )}
            </dl>
            {provider === "email" && (
              <div className="mt-5 pt-5 border-t border-black/[0.06]">
                <Link
                  href="/forgot-password"
                  className="text-[13px] text-black/40 hover:text-[#0A0A0A] transition-colors"
                >
                  change password →
                </Link>
              </div>
            )}
          </section>

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
        </>
      )}
    </div>
  );
}
