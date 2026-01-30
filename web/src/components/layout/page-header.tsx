"use client";

interface PageHeaderProps {
  actions?: React.ReactNode;
}

export function PageHeader({ actions }: PageHeaderProps) {
  // Only render if there are actions to show
  if (!actions) {
    return null;
  }

  return (
    <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center justify-end gap-2 bg-background/80 backdrop-blur-sm px-4 md:px-6">
      <div className="flex items-center gap-2">{actions}</div>
    </header>
  );
}
