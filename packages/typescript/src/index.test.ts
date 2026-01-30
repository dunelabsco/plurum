import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Plurum } from "./index.js";
import { BlueprintsResource } from "./resources/blueprints.js";
import { FeedbackResource } from "./resources/feedback.js";

describe("Plurum", () => {
  beforeEach(() => {
    // Clear env vars
    delete process.env.PLURUM_API_KEY;
    delete process.env.PLURUM_API_URL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("constructor", () => {
    it("should create client with default config", () => {
      const client = new Plurum();

      expect(client).toBeInstanceOf(Plurum);
      expect(client.blueprints).toBeInstanceOf(BlueprintsResource);
      expect(client.feedback).toBeInstanceOf(FeedbackResource);
    });

    it("should create client with API key", () => {
      const client = new Plurum({ apiKey: "test_key" });

      expect(client).toBeInstanceOf(Plurum);
    });

    it("should create client with custom API URL", () => {
      const client = new Plurum({ apiUrl: "http://localhost:8000" });

      expect(client).toBeInstanceOf(Plurum);
    });

    it("should create client with custom timeout", () => {
      const client = new Plurum({ timeout: 60000 });

      expect(client).toBeInstanceOf(Plurum);
    });

    it("should create client with all options", () => {
      const client = new Plurum({
        apiKey: "test_key",
        apiUrl: "http://localhost:8000",
        timeout: 60000,
      });

      expect(client).toBeInstanceOf(Plurum);
    });
  });

  describe("resources", () => {
    it("should have blueprints resource", () => {
      const client = new Plurum();

      expect(client.blueprints).toBeDefined();
      expect(typeof client.blueprints.search).toBe("function");
      expect(typeof client.blueprints.get).toBe("function");
      expect(typeof client.blueprints.list).toBe("function");
      expect(typeof client.blueprints.create).toBe("function");
      expect(typeof client.blueprints.update).toBe("function");
      expect(typeof client.blueprints.similar).toBe("function");
    });

    it("should have feedback resource", () => {
      const client = new Plurum();

      expect(client.feedback).toBeDefined();
      expect(typeof client.feedback.vote).toBe("function");
      expect(typeof client.feedback.reportExecution).toBe("function");
    });
  });
});

describe("exports", () => {
  it("should export Plurum as default", async () => {
    const module = await import("./index.js");
    expect(module.default).toBe(Plurum);
  });

  it("should export Plurum as named export", async () => {
    const { Plurum: PlurimNamed } = await import("./index.js");
    expect(PlurimNamed).toBe(Plurum);
  });

  it("should export error classes", async () => {
    const module = await import("./index.js");

    expect(module.PlurimError).toBeDefined();
    expect(module.AuthenticationError).toBeDefined();
    expect(module.NotFoundError).toBeDefined();
    expect(module.RateLimitError).toBeDefined();
    expect(module.ValidationError).toBeDefined();
  });
});
