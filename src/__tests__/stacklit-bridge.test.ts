/**
 * __tests__/stacklit-bridge.test.ts
 *
 * Tests for the Stacklit bridge — codebase navigation layer.
 * Uses real temp files to simulate stacklit.json presence/absence.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createStacklitBridge } from "../core/stacklit-bridge.js";
import { defaultConfig } from "../core/config.js";

// ─── Sample stacklit.json ─────────────────────────────────────────────────────

const SAMPLE_STACKLIT = {
  framework: "Express",
  languages: ["TypeScript", "SQL"],
  entrypoint: "src/index.ts",
  total_files: 42,
  total_lines: 8420,
  hints: {
    test_command: "pnpm test",
    add_feature: "Add handler in src/api/, register in src/index.ts",
  },
  modules: {
    "src/auth": {
      purpose: "Authentication and session management",
      files: 8,
      lines: 1200,
      exports: ["AuthProvider", "useSession()", "loginAction()", "verifyToken()"],
      depends_on: ["src/db", "src/config"],
      activity: "high",
    },
    "src/db": {
      purpose: "PostgreSQL connection and query helpers",
      files: 4,
      lines: 600,
      exports: ["db", "query()", "transaction()"],
      depends_on: ["src/config"],
      activity: "high",
    },
    "src/config": {
      purpose: "Environment config and validation",
      files: 2,
      lines: 150,
      exports: ["config", "validateEnv()"],
      depends_on: [],
      activity: "low",
    },
    "src/api": {
      purpose: "REST API routes and controllers",
      files: 12,
      lines: 2800,
      exports: ["router", "authRouter", "userRouter"],
      depends_on: ["src/auth", "src/db"],
      activity: "high",
    },
    "src/utils": {
      purpose: "Shared utility functions",
      files: 6,
      lines: 800,
      exports: ["formatDate()", "paginate()", "sanitize()"],
      depends_on: [],
      activity: "medium",
    },
  },
};

// ─── Setup ────────────────────────────────────────────────────────────────────

async function makeProject(withStacklit = true): Promise<{
  projectPath: string;
  cleanup: () => Promise<void>;
}> {
  const projectPath = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), "duostack-stacklit-test-")
  );

  if (withStacklit) {
    await fsPromises.writeFile(
      path.join(projectPath, "stacklit.json"),
      JSON.stringify(SAMPLE_STACKLIT, null, 2),
      "utf-8"
    );
  }

  return {
    projectPath,
    cleanup: () => fsPromises.rm(projectPath, { recursive: true, force: true }),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("StacklitBridge", () => {
  // ── Availability ───────────────────────────────────────────────────────────

  describe("isAvailable", () => {
    it("returns true when stacklit.json exists", async () => {
      const { projectPath, cleanup } = await makeProject(true);
      try {
        const config = defaultConfig(projectPath);
        const bridge = createStacklitBridge(config);
        expect(bridge.isAvailable()).toBe(true);
      } finally {
        await cleanup();
      }
    });

    it("returns false when stacklit.json does not exist", async () => {
      const { projectPath, cleanup } = await makeProject(false);
      try {
        const config = defaultConfig(projectPath);
        const bridge = createStacklitBridge(config);
        expect(bridge.isAvailable()).toBe(false);
      } finally {
        await cleanup();
      }
    });
  });

  // ── Full index ─────────────────────────────────────────────────────────────

  describe("readFullIndex", () => {
    it("returns parsed stacklit.json", async () => {
      const { projectPath, cleanup } = await makeProject(true);
      try {
        const bridge = createStacklitBridge(defaultConfig(projectPath));
        const index = await bridge.readFullIndex();

        expect(index).not.toBeNull();
        expect(index!.framework).toBe("Express");
        expect(index!.languages).toEqual(["TypeScript", "SQL"]);
        expect(Object.keys(index!.modules)).toHaveLength(5);
      } finally {
        await cleanup();
      }
    });

    it("returns null when stacklit.json missing", async () => {
      const { projectPath, cleanup } = await makeProject(false);
      try {
        const bridge = createStacklitBridge(defaultConfig(projectPath));
        const index = await bridge.readFullIndex();
        expect(index).toBeNull();
      } finally {
        await cleanup();
      }
    });
  });

  // ── Derive map ─────────────────────────────────────────────────────────────

  describe("generateDeriveMap", () => {
    it("generates compact summary", async () => {
      const { projectPath, cleanup } = await makeProject(true);
      try {
        const bridge = createStacklitBridge(defaultConfig(projectPath));
        const derive = await bridge.generateDeriveMap();

        expect(derive).not.toBeNull();
        expect(derive!.summary).toContain("Express");
        expect(derive!.testCommand).toBe("pnpm test");
        expect(derive!.moduleCount).toBe(5);
        expect(derive!.entry).toBe("src/index.ts");
      } finally {
        await cleanup();
      }
    });

    it("includes hot modules", async () => {
      const { projectPath, cleanup } = await makeProject(true);
      try {
        const bridge = createStacklitBridge(defaultConfig(projectPath));
        const derive = await bridge.generateDeriveMap();

        // auth, db, api are high-activity
        expect(derive!.hotModules.length).toBeGreaterThan(0);
        expect(
          derive!.hotModules.some((m) => m.includes("auth") || m.includes("api"))
        ).toBe(true);
      } finally {
        await cleanup();
      }
    });

    it("caps modules at 20 for token budget", async () => {
      const { projectPath, cleanup } = await makeProject(false);
      try {
        // Create stacklit.json with 25 modules
        const bigStacklit = {
          framework: "Express",
          languages: ["TypeScript"],
          entrypoint: "src/index.ts",
          hints: { test_command: "pnpm test" },
          modules: Object.fromEntries(
            Array.from({ length: 25 }, (_, i) => [
              `src/module${i}`,
              {
                purpose: `Module ${i}`,
                files: 1,
                lines: 100,
                exports: [],
                depends_on: [],
                activity: "low",
              },
            ])
          ),
        };

        await fsPromises.writeFile(
          path.join(projectPath, "stacklit.json"),
          JSON.stringify(bigStacklit),
          "utf-8"
        );

        const bridge = createStacklitBridge(defaultConfig(projectPath));
        const derive = await bridge.generateDeriveMap();

        expect(derive!.modules.length).toBeLessThanOrEqual(20);
      } finally {
        await cleanup();
      }
    });
  });

  // ── Module query ───────────────────────────────────────────────────────────

  describe("queryModule", () => {
    it("finds module by exact path", async () => {
      const { projectPath, cleanup } = await makeProject(true);
      try {
        const bridge = createStacklitBridge(defaultConfig(projectPath));
        const result = await bridge.queryModule("src/auth");

        expect(result.found).toBe(true);
        expect(result.modulePath).toBe("src/auth");
        expect(result.purpose).toBe("Authentication and session management");
        expect(result.exports).toContain("AuthProvider");
      } finally {
        await cleanup();
      }
    });

    it("finds module by fuzzy match", async () => {
      const { projectPath, cleanup } = await makeProject(true);
      try {
        const bridge = createStacklitBridge(defaultConfig(projectPath));
        const result = await bridge.queryModule("auth");

        expect(result.found).toBe(true);
        expect(result.modulePath).toBe("src/auth");
      } finally {
        await cleanup();
      }
    });

    it("returns dependedOnBy correctly", async () => {
      const { projectPath, cleanup } = await makeProject(true);
      try {
        const bridge = createStacklitBridge(defaultConfig(projectPath));
        const result = await bridge.queryModule("src/db");

        // src/api and src/auth both depend on src/db
        expect(result.dependedOnBy).toContain("src/auth");
        expect(result.dependedOnBy).toContain("src/api");
      } finally {
        await cleanup();
      }
    });

    it("returns not found for unknown module", async () => {
      const { projectPath, cleanup } = await makeProject(true);
      try {
        const bridge = createStacklitBridge(defaultConfig(projectPath));
        const result = await bridge.queryModule("src/nonexistent");

        expect(result.found).toBe(false);
      } finally {
        await cleanup();
      }
    });
  });

  // ── Token health modes ─────────────────────────────────────────────────────

  describe("readForTokenHealth", () => {
    it("returns derive_map for normal health (default)", async () => {
      const { projectPath, cleanup } = await makeProject(true);
      try {
        const bridge = createStacklitBridge(defaultConfig(projectPath));
        const result = await bridge.readForTokenHealth("normal");

        expect(result.mode).toBe("derive_map");
        expect(result.data).not.toBeNull();
        expect(result.estimatedTokens).toBe(250);
      } finally {
        await cleanup();
      }
    });

    it("returns mcp_query when module query provided", async () => {
      const { projectPath, cleanup } = await makeProject(true);
      try {
        const bridge = createStacklitBridge(defaultConfig(projectPath));
        const result = await bridge.readForTokenHealth("normal", "auth");

        expect(result.mode).toBe("mcp_query");
        expect(result.estimatedTokens).toBe(150);
      } finally {
        await cleanup();
      }
    });

    it("returns derive_map for batching health", async () => {
      const { projectPath, cleanup } = await makeProject(true);
      try {
        const bridge = createStacklitBridge(defaultConfig(projectPath));
        const result = await bridge.readForTokenHealth("batching");

        expect(result.mode).toBe("derive_map");
        expect(result.estimatedTokens).toBe(250);
      } finally {
        await cleanup();
      }
    });

    it("returns skip for final_flush health", async () => {
      const { projectPath, cleanup } = await makeProject(true);
      try {
        const bridge = createStacklitBridge(defaultConfig(projectPath));
        const result = await bridge.readForTokenHealth("final_flush");

        expect(result.mode).toBe("skip");
        expect(result.data).toBeNull();
        expect(result.estimatedTokens).toBe(0);
      } finally {
        await cleanup();
      }
    });

    it("returns skip when unavailable regardless of health", async () => {
      const { projectPath, cleanup } = await makeProject(false);
      try {
        const bridge = createStacklitBridge(defaultConfig(projectPath));
        const result = await bridge.readForTokenHealth("normal");

        expect(result.mode).toBe("skip");
        expect(result.data).toBeNull();
      } finally {
        await cleanup();
      }
    });
  });

  // ── Dependency graph ───────────────────────────────────────────────────────

  describe("getDependencyGraph", () => {
    it("returns dependency graph for a module", async () => {
      const { projectPath, cleanup } = await makeProject(true);
      try {
        const bridge = createStacklitBridge(defaultConfig(projectPath));
        const graph = await bridge.getDependencyGraph("src/api", 2);

        // src/api depends on src/auth and src/db
        expect(graph["src/api"]).toContain("src/auth");
        expect(graph["src/api"]).toContain("src/db");

        // src/auth depends on src/db and src/config (depth 2)
        expect(graph["src/auth"]).toBeDefined();
      } finally {
        await cleanup();
      }
    });
  });

  // ── Caching ────────────────────────────────────────────────────────────────

  describe("caching", () => {
    it("returns same data on repeated reads within TTL", async () => {
      const { projectPath, cleanup } = await makeProject(true);
      try {
        const bridge = createStacklitBridge(defaultConfig(projectPath));

        const index1 = await bridge.readFullIndex();
        const index2 = await bridge.readFullIndex();

        // Same object reference — cache hit
        expect(index1).toBe(index2);
      } finally {
        await cleanup();
      }
    });

    it("re-reads after cache invalidation", async () => {
      const { projectPath, cleanup } = await makeProject(true);
      try {
        const bridge = createStacklitBridge(defaultConfig(projectPath));

        const index1 = await bridge.readFullIndex();
        bridge.invalidateCache();
        const index2 = await bridge.readFullIndex();

        // Different objects — cache miss after invalidation
        expect(index1).not.toBe(index2);
        // But same content
        expect(index1!.framework).toBe(index2!.framework);
      } finally {
        await cleanup();
      }
    });
  });
});
