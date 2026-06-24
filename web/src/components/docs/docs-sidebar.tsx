"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export interface DocSection {
  id: string;
  label: string;
}

export interface DocGroup {
  title: string;
  sections: DocSection[];
}

interface DocsSidebarProps {
  groups: DocGroup[];
}

export function DocsSidebar({ groups }: DocsSidebarProps) {
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    const ids = groups.flatMap((g) => g.sections.map((s) => s.id));
    const targets = ids
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);

    if (targets.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        // Find the section closest to the top (visible)
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible.length > 0) {
          setActiveId(visible[0].target.id);
        }
      },
      {
        rootMargin: "-100px 0px -60% 0px",
        threshold: 0,
      }
    );

    targets.forEach((el) => observer.observe(el));

    return () => observer.disconnect();
  }, [groups]);

  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>, id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    e.preventDefault();
    const top = el.getBoundingClientRect().top + window.scrollY - 96;
    window.scrollTo({ top, behavior: "smooth" });
    history.replaceState(null, "", `#${id}`);
    setActiveId(id);
  };

  return (
    <nav className="space-y-8">
      {groups.map((group) => (
        <div key={group.title}>
          <p className="font-display text-[11px] tracking-[0.15em] text-black/25 mb-3 uppercase">
            {group.title}
          </p>
          <ul className="space-y-1">
            {group.sections.map((section) => {
              const isActive = activeId === section.id;
              return (
                <li key={section.id}>
                  <Link
                    href={`#${section.id}`}
                    onClick={(e) => handleClick(e, section.id)}
                    className={cn(
                      "block py-1.5 text-sm transition-colors border-l-2 pl-3 -ml-px",
                      isActive
                        ? "text-[#0A0A0A] border-[#0A0A0A]"
                        : "text-black/35 border-transparent hover:text-[#0A0A0A] hover:border-black/15"
                    )}
                  >
                    {section.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
