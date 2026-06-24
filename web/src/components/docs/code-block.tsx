"use client";

import { Highlight, themes } from "prism-react-renderer";
import { useState } from "react";

interface CodeBlockProps {
  code: string;
  language: string;
  filename?: string | null;
  description?: string | null;
}

export function CodeBlock({ code, language, filename, description }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code.trim());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative group rounded-2xl bg-[#0A0A0A] overflow-hidden">
      {filename && (
        <div className="flex items-center justify-between px-5 py-2.5 border-b border-white/5">
          <span className="text-[11px] font-display text-white/40">{filename}</span>
          <button
            onClick={handleCopy}
            className="text-[11px] text-white/25 hover:text-white/60 transition-colors"
          >
            {copied ? "copied" : "copy"}
          </button>
        </div>
      )}
      {!filename && (
        <button
          onClick={handleCopy}
          className="absolute top-3 right-3 text-[11px] text-white/25 hover:text-white/60 transition-colors opacity-0 group-hover:opacity-100 z-10"
        >
          {copied ? "copied" : "copy"}
        </button>
      )}
      {description && (
        <div className="px-5 py-2.5 border-b border-white/5">
          <p className="text-sm text-white/40">{description}</p>
        </div>
      )}
      <Highlight theme={themes.nightOwl} code={code.trim()} language={language}>
        {({ className, style, tokens, getLineProps, getTokenProps }) => (
          <pre
            className={`${className} overflow-x-auto p-4 sm:p-5 text-xs sm:text-sm leading-relaxed`}
            style={{ ...style, background: "transparent", margin: 0 }}
          >
            {tokens.map((line, i) => (
              <div key={i} {...getLineProps({ line })}>
                <span className="select-none text-white/15 hidden sm:inline-block w-8 text-right mr-4 text-xs">
                  {i + 1}
                </span>
                {line.map((token, key) => (
                  <span key={key} {...getTokenProps({ token })} />
                ))}
              </div>
            ))}
          </pre>
        )}
      </Highlight>
    </div>
  );
}

export function InlineCode({ children }: { children: React.ReactNode }) {
  return (
    <code className="px-1.5 py-0.5 rounded-lg bg-black/[0.03] text-[11px] font-display">
      {children}
    </code>
  );
}
