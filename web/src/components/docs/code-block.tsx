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
    <div className="relative group rounded-lg border border-border/50 bg-[#0d1117] overflow-hidden">
      {filename && (
        <div className="flex items-center justify-between px-4 py-2 border-b border-border/30 bg-[#161b22]">
          <span className="text-xs text-muted-foreground font-mono">{filename}</span>
          <button
            onClick={handleCopy}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      )}
      {!filename && (
        <button
          onClick={handleCopy}
          className="absolute top-2 right-2 text-xs text-muted-foreground hover:text-foreground transition-colors opacity-0 group-hover:opacity-100 z-10"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      )}
      {description && (
        <div className="px-4 py-2 border-b border-border/30 bg-[#161b22]/50">
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
      )}
      <Highlight theme={themes.nightOwl} code={code.trim()} language={language}>
        {({ className, style, tokens, getLineProps, getTokenProps }) => (
          <pre
            className={`${className} overflow-x-auto p-4 text-sm leading-relaxed`}
            style={{ ...style, background: "transparent", margin: 0 }}
          >
            {tokens.map((line, i) => (
              <div key={i} {...getLineProps({ line })}>
                <span className="select-none text-muted-foreground/40 inline-block w-8 text-right mr-4 text-xs">
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
    <code className="px-1.5 py-0.5 rounded bg-muted text-sm font-mono">
      {children}
    </code>
  );
}
