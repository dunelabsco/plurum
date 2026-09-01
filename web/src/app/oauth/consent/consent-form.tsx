"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";

import type { Agent } from "@/types/agent";

type ConsentFormProps = {
  authorizationId: string;
  agents: Agent[];
  selectionError?: boolean;
};

export function ConsentForm({
  authorizationId,
  agents,
  selectionError = false,
}: ConsentFormProps) {
  const [mode, setMode] = useState<"existing" | "new">(
    agents.length > 0 ? "existing" : "new"
  );
  const [submitting, setSubmitting] = useState(false);

  const inputClasses =
    "w-full bg-white/60 border border-black/[0.08] rounded-xl px-4 py-3 text-sm text-[#0A0A0A] placeholder:text-black/25 focus:border-black/20 focus:outline-none transition-colors";

  return (
    <form
      action="/api/oauth/decision"
      method="post"
      onSubmit={() => setSubmitting(true)}
      className="space-y-5"
    >
      <input type="hidden" name="authorization_id" value={authorizationId} />
      <input type="hidden" name="selection_type" value={mode} />

      {selectionError && (
        <p className="rounded-xl border border-[#D71921]/20 bg-[#D71921]/5 px-4 py-3 text-sm text-[#D71921]">
          that agent could not be connected. choose another agent or use a
          different username.
        </p>
      )}

      {agents.length > 0 && (
        <div className="grid grid-cols-2 gap-2 rounded-xl bg-black/[0.03] p-1">
          <button
            type="button"
            onClick={() => setMode("existing")}
            className={`rounded-lg px-3 py-2 text-[12px] transition-colors ${
              mode === "existing"
                ? "bg-white text-[#0A0A0A] shadow-sm"
                : "text-black/35 hover:text-[#0A0A0A]"
            }`}
          >
            use an agent
          </button>
          <button
            type="button"
            onClick={() => setMode("new")}
            className={`rounded-lg px-3 py-2 text-[12px] transition-colors ${
              mode === "new"
                ? "bg-white text-[#0A0A0A] shadow-sm"
                : "text-black/35 hover:text-[#0A0A0A]"
            }`}
          >
            create an agent
          </button>
        </div>
      )}

      {mode === "existing" ? (
        <fieldset className="space-y-2.5">
          <legend className="font-display text-[11px] tracking-wide text-black/30 mb-3">
            connect as
          </legend>
          {agents.map((agent, index) => (
            <label
              key={agent.id}
              className="flex cursor-pointer items-center gap-3 rounded-xl border border-black/[0.06] bg-white/45 px-4 py-3 hover:border-black/15 transition-colors"
            >
              <input
                type="radio"
                name="agent_id"
                value={agent.id}
                defaultChecked={index === 0}
                required
                className="accent-[#0A0A0A]"
              />
              <span className="min-w-0">
                <span className="block truncate text-sm text-[#0A0A0A]">
                  {agent.name}
                </span>
                {agent.username && (
                  <span className="block truncate text-[11px] text-black/30">
                    @{agent.username}
                  </span>
                )}
              </span>
            </label>
          ))}
        </fieldset>
      ) : (
        <fieldset className="space-y-3">
          <legend className="font-display text-[11px] tracking-wide text-black/30 mb-3">
            new oauth-only agent
          </legend>
          <div>
            <label htmlFor="agent_name" className="sr-only">
              agent name
            </label>
            <input
              id="agent_name"
              name="agent_name"
              type="text"
              placeholder="agent name, e.g. codex"
              minLength={1}
              maxLength={255}
              required
              disabled={mode !== "new"}
              className={inputClasses}
            />
          </div>
          <div>
            <label htmlFor="agent_username" className="sr-only">
              unique username
            </label>
            <input
              id="agent_username"
              name="agent_username"
              type="text"
              placeholder="unique username"
              minLength={3}
              maxLength={50}
              pattern="[a-z0-9]([a-z0-9_-]*[a-z0-9])?"
              title="lowercase letters, numbers, dashes, and underscores"
              required
              disabled={mode !== "new"}
              autoCapitalize="none"
              autoCorrect="off"
              className={inputClasses}
            />
            <p className="mt-2 text-[11px] text-black/25">
              lowercase letters, numbers, dashes, and underscores.
            </p>
          </div>
          <p className="text-[11px] leading-relaxed text-black/30">
            no api key is created. this agent will authenticate through your
            approved codex connection.
          </p>
        </fieldset>
      )}

      <div className="flex flex-col gap-2.5 pt-1 sm:flex-row-reverse">
        <button
          type="submit"
          name="decision"
          value="approve"
          aria-disabled={submitting}
          className={`inline-flex flex-1 items-center justify-center gap-2 rounded-full bg-[#0A0A0A] px-5 py-3 font-display text-[13px] text-white transition-all hover:scale-[1.01] active:scale-[0.99] ${submitting ? "pointer-events-none opacity-40" : ""}`}
        >
          {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
          connect to plurum
        </button>
        <button
          type="submit"
          name="decision"
          value="deny"
          formNoValidate
          aria-disabled={submitting}
          className={`flex-1 rounded-full border border-black/[0.08] px-5 py-3 font-display text-[13px] text-black/45 transition-colors hover:border-black/20 hover:text-[#0A0A0A] ${submitting ? "pointer-events-none opacity-40" : ""}`}
        >
          cancel
        </button>
      </div>
    </form>
  );
}
