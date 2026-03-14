"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Loader2 } from "lucide-react";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const supabase = createClient();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);

    try {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (error) throw error;
      router.push("/dashboard");
      router.refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setIsLoading(false);
    }
  };

  const inputClasses =
    "w-full bg-white/40 backdrop-blur-sm border border-black/[0.06] rounded-xl px-4 py-3 text-sm text-[#0A0A0A] placeholder:text-black/20 focus:border-black/15 focus:outline-none transition-colors";

  return (
    <div className="min-h-svh flex flex-col items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <div className="text-center mb-10">
          <Link href="/" className="font-display text-sm tracking-tight text-[#0A0A0A]">
            plurum
          </Link>
        </div>

        <div className="bg-white/40 backdrop-blur-sm border border-black/[0.06] rounded-2xl p-6 sm:p-8">
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="text-center space-y-2">
              <h1 className="font-display text-xl text-[#0A0A0A]">welcome back</h1>
              <p className="text-black/30 text-sm">
                sign in to your account to continue
              </p>
            </div>

            <div className="space-y-4">
              <div className="space-y-2">
                <label htmlFor="email" className="font-display text-[11px] tracking-wide text-black/25 block">email</label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@example.com"
                  required
                  className={inputClasses}
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label htmlFor="password" className="font-display text-[11px] tracking-wide text-black/25 block">password</label>
                  <Link
                    href="/forgot-password"
                    className="text-[11px] text-black/20 hover:text-[#0A0A0A] transition-colors"
                  >
                    forgot password?
                  </Link>
                </div>
                <input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="enter your password"
                  required
                  className={inputClasses}
                />
              </div>

              {error && (
                <div className="border border-[#D71921]/20 rounded-xl bg-[#D71921]/5 px-4 py-2.5 text-sm text-[#D71921]">
                  {error}
                </div>
              )}

              <button
                type="submit"
                className="w-full bg-[#0A0A0A] text-white font-display text-[13px] py-3 rounded-full hover:scale-[1.01] active:scale-[0.99] transition-all disabled:opacity-30"
                disabled={isLoading}
              >
                {isLoading ? (
                  <span className="flex items-center justify-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    signing in...
                  </span>
                ) : (
                  "sign in"
                )}
              </button>
            </div>

            <p className="text-center text-[13px] text-black/25">
              don&apos;t have an account?{" "}
              <Link href="/signup" className="text-[#0A0A0A] hover:underline">
                sign up
              </Link>
            </p>
          </form>
        </div>
      </div>
    </div>
  );
}
