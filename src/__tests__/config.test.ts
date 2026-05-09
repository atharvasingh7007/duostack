/**
 * __tests__/config.test.ts
 *
 * Tests for config loading, merging, and defaults.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfigLoader, defaultConfig, loadConfig } from "../core/config.js";
import { DEFAULT_PORT } from "../api/server.js";

async function makeTempProject(): Promise<string> {
  const dir = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), "duostack-config-test-")
  );
  await fsPromises.mkdir(path.join(dir, ".duostack"), { recursive: true });
  return dir;
}

describe("ConfigLoader", () => {
  let projectPath: string;

  beforeEach(async () => {
    projectPath = await makeTempProject();
  });

  afterEach(async () => {
    await fsPromises.rm(projectPath, { recursive: true, force: true });
  });

  // ── Defaults ───────────────────────────────────────────────────────────────

  describe("defaultConfig", () => {
    it("returns correct stateDir", () => {
      const config = defaultConfig(projectPath);
      expect(config.stateDir).toBe(
        path.join(projectPath, ".duostack", "state")
      );
    });

    it("returns correct default port", () => {
      const config = defaultConfig(projectPath);
      expect(config.api.port).toBe(DEFAULT_PORT);
    });

    it("sets claude role to planner", () => {
      const config = defaultConfig(projectPath);
      expect(config.agents.claude.role).toBe("planner");
    });

    it("sets antigravity role to executor", () => {
      const config = defaultConfig(projectPath);
      expect(config.agents.antigravity.role).toBe("executor");
    });

    it("sets default lease duration to 20 minutes", () => {
      const config = defaultConfig(projectPath);
      expect(config.leases.durationMinutes).toBe(20);
    });

    it("sets stacklit path relative to project", () => {
      const config = defaultConfig(projectPath);
      expect(config.stacklit.jsonPath).toBe(
        path.join(projectPath, "stacklit.json")
      );
    });
  });

  // ── Load from file ─────────────────────────────────────────────────────────

  describe("load", () => {
    it("returns defaults when config file does not exist", async () => {
      const loader = new ConfigLoader(projectPath);
      const config = await loader.load();

      expect(config.api.port).toBe(DEFAULT_PORT);
      expect(config.leases.durationMinutes).toBe(20);
    });

    it("merges file values over defaults", async () => {
      const configPath = path.join(projectPath, ".duostack", "duostack.config.json");
      await fsPromises.writeFile(
        configPath,
        JSON.stringify({
          api: { port: 4000 },
          leases: { durationMinutes: 30 },
        }),
        "utf-8"
      );

      const loader = new ConfigLoader(projectPath);
      const config = await loader.load();

      expect(config.api.port).toBe(4000);
      expect(config.leases.durationMinutes).toBe(30);
      // Unspecified values keep defaults
      expect(config.agents.claude.role).toBe("planner");
    });

    it("caches config after first load", async () => {
      const loader = new ConfigLoader(projectPath);
      const config1 = await loader.load();
      const config2 = await loader.load();

      expect(config1).toBe(config2); // same object reference
    });

    it("handles malformed JSON gracefully", async () => {
      const configPath = path.join(projectPath, ".duostack", "duostack.config.json");
      await fsPromises.writeFile(configPath, "{ invalid json }", "utf-8");

      const loader = new ConfigLoader(projectPath);
      const config = await loader.load();

      // Should fall back to defaults
      expect(config.api.port).toBe(DEFAULT_PORT);
    });
  });

  // ── Write ──────────────────────────────────────────────────────────────────

  describe("write", () => {
    it("writes config to disk", async () => {
      const loader = new ConfigLoader(projectPath);
      const config = defaultConfig(projectPath);
      config.api.port = 5000;

      await loader.write(config);

      const loader2 = new ConfigLoader(projectPath);
      const loaded = await loader2.load();
      expect(loaded.api.port).toBe(5000);
    });

    it("creates .duostack directory if missing", async () => {
      const newProject = await fsPromises.mkdtemp(
        path.join(os.tmpdir(), "duostack-write-test-")
      );

      try {
        const loader = new ConfigLoader(newProject);
        const config = defaultConfig(newProject);
        await loader.write(config); // should not throw

        const configPath = path.join(newProject, ".duostack", "duostack.config.json");
        const exists = await fsPromises.stat(configPath).then(() => true).catch(() => false);
        expect(exists).toBe(true);
      } finally {
        await fsPromises.rm(newProject, { recursive: true, force: true });
      }
    });
  });

  // ── loadConfig helper ──────────────────────────────────────────────────────

  describe("loadConfig", () => {
    it("loads config for a project path", async () => {
      const config = await loadConfig(projectPath);
      expect(config.projectPath).toBe(projectPath);
    });
  });

  // ── loadSync ───────────────────────────────────────────────────────────────

  describe("loadSync", () => {
    it("returns defaults synchronously when no file", () => {
      const loader = new ConfigLoader(projectPath);
      const config = loader.loadSync();
      expect(config.api.port).toBe(DEFAULT_PORT);
    });

    it("loads file synchronously when present", async () => {
      const configPath = path.join(projectPath, ".duostack", "duostack.config.json");
      await fsPromises.writeFile(
        configPath,
        JSON.stringify({ api: { port: 9999 } }),
        "utf-8"
      );

      const loader = new ConfigLoader(projectPath);
      const config = loader.loadSync();
      expect(config.api.port).toBe(9999);
    });
  });
});
