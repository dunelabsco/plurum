import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Plurum } from "./index.js";
import { SessionsResource } from "./resources/sessions.js";
import { ExperiencesResource } from "./resources/experiences.js";

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
      expect(client.sessions).toBeInstanceOf(SessionsResource);
      expect(client.experiences).toBeInstanceOf(ExperiencesResource);
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
    it("should have sessions resource", () => {
      const client = new Plurum();

      expect(client.sessions).toBeDefined();
      expect(typeof client.sessions.open).toBe("function");
      expect(typeof client.sessions.get).toBe("function");
      expect(typeof client.sessions.list).toBe("function");
      expect(typeof client.sessions.logEntry).toBe("function");
      expect(typeof client.sessions.close).toBe("function");
      expect(typeof client.sessions.abandon).toBe("function");
      expect(typeof client.sessions.contribute).toBe("function");
      expect(typeof client.sessions.listContributions).toBe("function");
    });

    it("should have experiences resource", () => {
      const client = new Plurum();

      expect(client.experiences).toBeDefined();
      expect(typeof client.experiences.create).toBe("function");
      expect(typeof client.experiences.get).toBe("function");
      expect(typeof client.experiences.list).toBe("function");
      expect(typeof client.experiences.search).toBe("function");
      expect(typeof client.experiences.acquire).toBe("function");
      expect(typeof client.experiences.publish).toBe("function");
      expect(typeof client.experiences.reportOutcome).toBe("function");
      expect(typeof client.experiences.vote).toBe("function");
      expect(typeof client.experiences.findSimilar).toBe("function");
    });

    it("should have agents resource", () => {
      const client = new Plurum();

      expect(client.agents).toBeDefined();
      expect(typeof client.agents.register).toBe("function");
      expect(typeof client.agents.me).toBe("function");
      expect(typeof client.agents.rotateKey).toBe("function");
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
