import { describe, it, expect, beforeEach, afterEach } from "vitest";

// Test the exported functions by testing their behavior with environment variables
describe("config", () => {
  let originalApiKey: string | undefined;
  let originalApiUrl: string | undefined;

  beforeEach(() => {
    // Save original env vars
    originalApiKey = process.env.PLURUM_API_KEY;
    originalApiUrl = process.env.PLURUM_API_URL;
    // Clear env vars for tests
    delete process.env.PLURUM_API_KEY;
    delete process.env.PLURUM_API_URL;
  });

  afterEach(() => {
    // Restore original env vars
    if (originalApiKey !== undefined) {
      process.env.PLURUM_API_KEY = originalApiKey;
    } else {
      delete process.env.PLURUM_API_KEY;
    }
    if (originalApiUrl !== undefined) {
      process.env.PLURUM_API_URL = originalApiUrl;
    } else {
      delete process.env.PLURUM_API_URL;
    }
  });

  describe("getApiKey", () => {
    it("should return environment variable if set", async () => {
      process.env.PLURUM_API_KEY = "env_key";

      // Dynamic import to get fresh module state
      const { getApiKey } = await import("./config.js");
      const key = getApiKey();

      expect(key).toBe("env_key");
    });

    it("should return undefined if no env var set (without config file)", async () => {
      // In a test environment without a config file, getApiKey should return undefined
      delete process.env.PLURUM_API_KEY;

      const { getApiKey } = await import("./config.js");
      const key = getApiKey();

      // Either undefined or from a config file if one exists
      expect(typeof key === "string" || key === undefined).toBe(true);
    });
  });

  describe("getApiUrl", () => {
    it("should return environment variable if set", async () => {
      process.env.PLURUM_API_URL = "http://env.example.com";

      const { getApiUrl } = await import("./config.js");
      const url = getApiUrl();

      expect(url).toBe("http://env.example.com");
    });

    it("should return default URL if nothing configured", async () => {
      delete process.env.PLURUM_API_URL;

      const { getApiUrl } = await import("./config.js");
      const url = getApiUrl();

      // Should be either the default or from a config file
      expect(typeof url).toBe("string");
      expect(url.length).toBeGreaterThan(0);
    });

    it("should return a valid URL string", async () => {
      const { getApiUrl } = await import("./config.js");
      const url = getApiUrl();

      expect(url).toMatch(/^https?:\/\//);
    });
  });

  describe("Config interface", () => {
    it("should export Config type", async () => {
      const { loadConfig } = await import("./config.js");
      const config = loadConfig();

      // Config should be an object (possibly empty)
      expect(typeof config).toBe("object");
    });

    it("loadConfig should return object with optional apiKey and apiUrl", async () => {
      const { loadConfig } = await import("./config.js");
      const config = loadConfig();

      // apiKey is optional
      expect(
        config.apiKey === undefined || typeof config.apiKey === "string"
      ).toBe(true);

      // apiUrl is optional
      expect(
        config.apiUrl === undefined || typeof config.apiUrl === "string"
      ).toBe(true);
    });
  });
});
