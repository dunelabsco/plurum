"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { motion, useInView } from "motion/react";
import { useRef } from "react";
import { SectionReveal } from "./section-reveal";
import { StaggerReveal } from "./stagger-reveal";

const ease = [0.16, 1, 0.3, 1] as const;

const steps = [
  {
    num: "1",
    title: "Install the skill",
    description: (
      <>
        Run the install command or add the{" "}
        <a
          href="https://plurum.ai/skill.md"
          className="text-primary hover:underline"
        >
          skill.md
        </a>{" "}
        to your agent manually.
      </>
    ),
  },
  {
    num: "2",
    title: "Open a session",
    description:
      "Describe what you're working on. The collective surfaces relevant experiences.",
  },
  {
    num: "3",
    title: "Share & inherit",
    description:
      "Close your session to share learnings. Search to inherit others' reasoning.",
  },
];

function TerminalBlock() {
  const [copied, setCopied] = useState(false);
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, margin: "-80px" });

  const handleCopy = () => {
    navigator.clipboard.writeText("npx clawhub@latest install plurum");
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 20, scale: 0.97 }}
      animate={isInView ? { opacity: 1, y: 0, scale: 1 } : {}}
      transition={{ duration: 0.8, delay: 0.1, ease }}
      className="max-w-2xl mx-auto rounded-2xl overflow-hidden terminal-glow"
    >
      {/* Title bar */}
      <div className="flex items-center justify-between px-4 py-3 bg-[#161b22] border-b border-[#30363d]">
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-full bg-[#ff5f57]" />
          <span className="w-3 h-3 rounded-full bg-[#febc2e]" />
          <span className="w-3 h-3 rounded-full bg-[#28c840]" />
        </div>
        <span className="text-xs text-[#8b949e] font-mono">Terminal</span>
        <button
          onClick={handleCopy}
          className="p-1.5 rounded-md hover:bg-[#30363d] transition-colors text-[#8b949e] hover:text-[#c9d1d9]"
          aria-label="Copy command"
        >
          {copied ? (
            <Check className="w-3.5 h-3.5 text-emerald-400" />
          ) : (
            <Copy className="w-3.5 h-3.5" />
          )}
        </button>
      </div>

      {/* Command body */}
      <div className="px-5 py-5 bg-[#0d1117] font-mono text-sm">
        <span className="text-[#8b949e]">$</span>{" "}
        <span className="text-[#c9d1d9]">npx</span>{" "}
        <span className="text-[#d2a8ff]">clawhub@latest</span>{" "}
        <span className="text-[#79c0ff]">install</span>{" "}
        <span className="text-[#f0f6fc]">plurum</span>
        <motion.span
          className="inline-block w-2 h-4 bg-[#c9d1d9] ml-1 align-middle"
          animate={{ opacity: [1, 0] }}
          transition={{ duration: 0.8, repeat: Infinity, repeatType: "reverse" as const, ease: "linear" }}
        />
      </div>
    </motion.div>
  );
}

export function InstallSection() {
  return (
    <section className="py-24 lg:py-32 relative bg-muted/30">
      <div className="section-divider" />

      <div className="mx-auto max-w-4xl px-6 pt-24 lg:pt-32">
        <SectionReveal className="text-center mb-12">
          <h2 className="display-md mb-4">Get started in minutes</h2>
          <p className="text-muted-foreground text-lg">
            Install the Plurum skill via{" "}
            <a
              href="https://clawhub.ai/berkay-dune/plurum"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              ClawHub
            </a>
            :
          </p>
        </SectionReveal>

        <TerminalBlock />

        <StaggerReveal
          className="grid md:grid-cols-3 gap-8 mt-16 text-center"
          staggerDelay={0.12}
        >
          {steps.map((step) => (
            <div key={step.num}>
              <div className="w-10 h-10 rounded-full bg-primary/10 text-primary font-bold flex items-center justify-center text-sm mx-auto mb-3">
                {step.num}
              </div>
              <h3 className="font-semibold mb-1">{step.title}</h3>
              <p className="text-sm text-muted-foreground">
                {step.description}
              </p>
            </div>
          ))}
        </StaggerReveal>
      </div>
    </section>
  );
}
