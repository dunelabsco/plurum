import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import chalk from "chalk";
import {
  formatPercent,
  formatTags,
  formatStatus,
  formatScore,
} from "./output.js";

// Disable chalk colors for testing
chalk.level = 0;

describe("output utilities", () => {
  describe("formatPercent", () => {
    it("should format 0 as 0%", () => {
      expect(formatPercent(0)).toBe("0%");
    });

    it("should format 1 as 100%", () => {
      expect(formatPercent(1)).toBe("100%");
    });

    it("should format 0.5 as 50%", () => {
      expect(formatPercent(0.5)).toBe("50%");
    });

    it("should round decimals", () => {
      expect(formatPercent(0.956)).toBe("96%");
      expect(formatPercent(0.954)).toBe("95%");
    });

    it("should handle values greater than 1", () => {
      expect(formatPercent(1.5)).toBe("150%");
    });
  });

  describe("formatTags", () => {
    it("should return 'none' for empty array", () => {
      const result = formatTags([]);
      expect(result).toContain("none");
    });

    it("should format single tag", () => {
      const result = formatTags(["docker"]);
      expect(result).toContain("docker");
    });

    it("should format multiple tags with comma separator", () => {
      const result = formatTags(["docker", "aws", "deployment"]);
      expect(result).toContain("docker");
      expect(result).toContain("aws");
      expect(result).toContain("deployment");
      expect(result).toContain(",");
    });
  });

  describe("formatStatus", () => {
    it("should format published status", () => {
      const result = formatStatus("published");
      expect(result).toContain("published");
    });

    it("should format draft status", () => {
      const result = formatStatus("draft");
      expect(result).toContain("draft");
    });

    it("should format deprecated status", () => {
      const result = formatStatus("deprecated");
      expect(result).toContain("deprecated");
    });

    it("should format archived status", () => {
      const result = formatStatus("archived");
      expect(result).toContain("archived");
    });

    it("should return unknown status as-is", () => {
      const result = formatStatus("unknown");
      expect(result).toBe("unknown");
    });
  });

  describe("formatScore", () => {
    it("should format high score (>= 0.7)", () => {
      const result = formatScore(0.85);
      expect(result).toContain("0.85");
    });

    it("should format medium score (0.4 - 0.7)", () => {
      const result = formatScore(0.55);
      expect(result).toContain("0.55");
    });

    it("should format low score (< 0.4)", () => {
      const result = formatScore(0.25);
      expect(result).toContain("0.25");
    });

    it("should format to 2 decimal places", () => {
      expect(formatScore(0.12345)).toContain("0.12");
      expect(formatScore(0.99999)).toContain("1.00");
    });

    it("should handle edge cases", () => {
      expect(formatScore(0)).toContain("0.00");
      expect(formatScore(1)).toContain("1.00");
      expect(formatScore(0.7)).toContain("0.70");
      expect(formatScore(0.4)).toContain("0.40");
    });
  });
});
