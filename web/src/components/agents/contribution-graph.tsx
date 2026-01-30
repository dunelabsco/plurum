"use client";

import { useMemo } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ContributionDay } from "@/types/agent-profile";

interface ContributionGraphProps {
  data: ContributionDay[];
  title?: string;
  className?: string;
}

const DAYS_OF_WEEK = ["", "Mon", "", "Wed", "", "Fri", ""];
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const intensityClasses: Record<number, string> = {
  0: "bg-muted/30",
  1: "bg-primary/25 hover:bg-primary/35",
  2: "bg-primary/45 hover:bg-primary/55",
  3: "bg-primary/70 hover:bg-primary/80",
  4: "bg-primary hover:bg-primary/90",
};

/**
 * GitHub-style contribution graph showing the current calendar year (Jan 1 - Dec 31).
 * Uses CSS Grid with 7 rows (days) and ~53 columns (weeks).
 */
export function ContributionGraph({ data, title, className }: ContributionGraphProps) {
  // Process data into weeks (columns)
  const { weeks, monthLabels, totalPoints, currentYear } = useMemo(() => {
    const currentYear = new Date().getFullYear();
    const startDate = new Date(currentYear, 0, 1); // Jan 1
    const endDate = new Date(currentYear, 11, 31); // Dec 31

    // Ensure we have data for the full year, filling missing with zeros
    const dataMap = new Map(data.map((d) => [d.date, d]));
    const fullData: ContributionDay[] = [];

    const current = new Date(startDate);
    while (current <= endDate) {
      const dateStr = current.toISOString().split("T")[0];
      const existing = dataMap.get(dateStr);
      fullData.push(
        existing || { date: dateStr, intensity: 0 as const, points: 0 }
      );
      current.setDate(current.getDate() + 1);
    }

    // Group into weeks (7 days each)
    const weeks: ContributionDay[][] = [];
    let currentWeek: ContributionDay[] = [];

    // Find the first Sunday to start from
    const firstDate = new Date(fullData[0].date);
    const firstDayOfWeek = firstDate.getDay(); // 0 = Sunday

    // Pad the first week with empty slots if needed
    for (let i = 0; i < firstDayOfWeek; i++) {
      currentWeek.push({ date: "", intensity: 0 as const, points: 0 });
    }

    for (const day of fullData) {
      currentWeek.push(day);
      if (currentWeek.length === 7) {
        weeks.push(currentWeek);
        currentWeek = [];
      }
    }

    // Push remaining days
    if (currentWeek.length > 0) {
      weeks.push(currentWeek);
    }

    // Generate month labels with column positions
    const monthLabels: { month: string; col: number }[] = [];
    let lastMonth = -1;

    weeks.forEach((week, weekIndex) => {
      const firstDayInWeek = week.find((d) => d.date);
      if (firstDayInWeek && firstDayInWeek.date) {
        const date = new Date(firstDayInWeek.date);
        const month = date.getMonth();
        if (month !== lastMonth) {
          monthLabels.push({ month: MONTHS[month], col: weekIndex });
          lastMonth = month;
        }
      }
    });

    const totalPoints = fullData.reduce((sum, d) => sum + d.points, 0);

    return { weeks, monthLabels, totalPoints, currentYear };
  }, [data]);

  const formatDate = (dateStr: string) => {
    if (!dateStr) return "";
    const date = new Date(dateStr);
    return date.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  return (
    <section className={cn("space-y-4", className)}>
      {title && (
        <h2 className="text-lg font-semibold">{title}</h2>
      )}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {totalPoints.toLocaleString()} contributions in {currentYear}
        </p>
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          <span>Less</span>
          <div className="flex gap-0.5">
            {[0, 1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className={cn("size-2.5 rounded-sm", intensityClasses[i])}
              />
            ))}
          </div>
          <span>More</span>
        </div>
      </div>

      <div className="overflow-x-auto pb-2">
        <div className="min-w-fit">
          {/* Month labels */}
          <div className="flex mb-1 ml-8 text-[10px] text-muted-foreground">
            {monthLabels.map((label, i) => (
              <div
                key={i}
                className="flex-shrink-0"
                style={{
                  marginLeft: i === 0 ? `${label.col * 13}px` : undefined,
                  width:
                    i < monthLabels.length - 1
                      ? `${(monthLabels[i + 1].col - label.col) * 13}px`
                      : "auto",
                }}
              >
                {label.month}
              </div>
            ))}
          </div>

          {/* Grid with day labels */}
          <div className="flex">
            {/* Day labels */}
            <div className="flex flex-col gap-[3px] mr-2 text-[10px] text-muted-foreground">
              {DAYS_OF_WEEK.map((day, i) => (
                <div key={i} className="h-3 flex items-center">
                  {day}
                </div>
              ))}
            </div>

            {/* Activity cells */}
            <TooltipProvider delayDuration={100}>
              <div className="flex gap-[3px]">
                {weeks.map((week, weekIndex) => (
                  <div key={weekIndex} className="flex flex-col gap-[3px]">
                    {week.map((day, dayIndex) => (
                      <Tooltip key={dayIndex}>
                        <TooltipTrigger asChild>
                          <div
                            className={cn(
                              "size-3 rounded-sm transition-colors",
                              day.date
                                ? intensityClasses[day.intensity]
                                : "bg-transparent"
                            )}
                          />
                        </TooltipTrigger>
                        {day.date && (
                          <TooltipContent
                            side="top"
                            className="text-xs"
                          >
                            <p className="font-medium">
                              {day.points} {day.points === 1 ? "point" : "points"}
                            </p>
                            <p className="text-muted-foreground">
                              {formatDate(day.date)}
                            </p>
                          </TooltipContent>
                        )}
                      </Tooltip>
                    ))}
                  </div>
                ))}
              </div>
            </TooltipProvider>
          </div>
        </div>
      </div>
    </section>
  );
}
