"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { OAuthConnection } from "@/lib/auth/oauth-types";

export function OAuthConnections() {
  const [connections, setConnections] = useState<OAuthConnection[]>([]);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/oauth/connections", { cache: "no-store" });
      if (!response.ok) throw new Error();
      const result = await response.json();
      setConnections(result.connections);
      setEnabled(result.enabled);
      setError("");
    } catch {
      setError("connections could not be loaded. try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function disconnect(connection: OAuthConnection) {
    setBusy(connection.client_id);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/oauth/connections", {
        method: "POST",
        body: new URLSearchParams({
          client_id: connection.client_id,
          expected_grant_id: connection.grant_id ?? "",
        }),
        cache: "no-store",
      });
      const result = await response.json();
      if (!response.ok) {
        setError(result.error || "disconnect could not be confirmed. refresh and try again.");
        return;
      }
      setNotice(result.state === "disconnected"
        ? "app disconnected."
        : "access is blocked. retry in a moment to finish disconnecting.");
      await load();
    } catch {
      setError("disconnect could not be confirmed. refresh and try again.");
    } finally {
      setBusy(null);
    }
  }

  if (enabled === false || (enabled === null && loading)) return null;
  return (
    <section className="rounded-2xl border border-black/[0.06] bg-white/40 p-5 backdrop-blur-sm">
      <div className="flex items-center justify-between gap-4">
        <h2 className="font-display text-[11px] tracking-wide text-black/40">connected apps</h2>
        <button type="button" onClick={() => { setLoading(true); void load(); }} disabled={loading || busy !== null}
          className="text-xs text-black/50 underline underline-offset-4 disabled:opacity-40">
          refresh
        </button>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-black/50">
        manage apps allowed to use your plurum agents. removing a plugin from your app does not revoke its access.
      </p>
      {error && <p role="alert" className="mt-4 text-sm text-[#D71921]">{error}</p>}
      {notice && <p role="status" className="mt-4 text-sm text-black/60">{notice}</p>}
      {loading ? (
        <div className="mt-5 flex items-center gap-2 text-sm text-black/40"><Loader2 aria-hidden className="h-4 w-4 animate-spin" />loading connections…</div>
      ) : enabled && connections.length === 0 ? (
        <p className="mt-5 text-sm text-black/40">no connected apps.</p>
      ) : (
        <ul className="mt-5 divide-y divide-black/[0.06]">
          {connections.map(connection => (
            <li key={connection.client_id} className="flex flex-col gap-4 py-5 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 space-y-1.5">
                <p className="break-words text-sm font-medium text-[#0A0A0A]">{connection.client_name || "oauth app"}</p>
                <p className="break-all font-mono text-[11px] text-black/40">{connection.client_id}</p>
                <p className="break-words text-sm text-black/55">
                  {connection.agent_name || "no agent linked"}
                  {connection.agent_username && ` · @${connection.agent_username}`}
                  {connection.agent_id && !connection.agent_active && " · inactive"}
                </p>
                {connection.state === "revocation_pending" && <p className="text-xs text-[#D71921]">access blocked · disconnect pending</p>}
                {connection.state === "unbound" && <p className="text-xs text-black/45">connection needs attention</p>}
              </div>
              <button type="button" disabled={busy !== null} onClick={() => void disconnect(connection)}
                aria-label={`disconnect ${connection.client_name || "oauth app"}`}
                className="inline-flex shrink-0 items-center justify-center gap-2 self-start rounded-full border border-[#D71921]/20 px-4 py-2 font-display text-xs text-[#D71921] transition-colors hover:bg-[#D71921]/5 disabled:opacity-40">
                {busy === connection.client_id && <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />}
                {connection.state === "revocation_pending" ? "retry disconnect" : "disconnect"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
