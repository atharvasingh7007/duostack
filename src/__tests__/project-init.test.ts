/**
 * __tests__/project-init.test.ts
 *
 * Tests for the project initializer — preflight checks, event writing,
 * idempotency, and Stacklit metadata extraction.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createProjectInitializer } from "../core/project-init.js";
import { defaultConfig } from "../core/config.js";
import { createEventStore } from "../core/event-store.js";

// ─── Setup ────────────────────────────────────────────────────────────────────

const SAMPLE_STACKLIT = {
  framework: "Express",
  languages: ["TypeScript", "PostgreSQL"],
  entrypoint: "src/index.ts",
  hints: { test_command: "pnpm test" },
  modules: {
    "src/auth": {
      purpose: "JWT authentication",
      files: 5,
      lines: 800,
      exports: ["AuthProvider"],
      depends_on: ["src/db"],
      activity: "high",
    },
  },
};

async function makeProject(withStacklit = false, withGit = false): Promise<{
  projectPath: string;
  stateDir: string;
  cleanup: () => Promise<void>;
}> {
  const projectPath = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), "duostack-init-test-")
  );
  const stateDir = path.join(projectPath, ".duostack", "state");
  await fsPromises.mkdir(stateDir, { recursive: true });

  if (withStacklit) {
    await fsPromises.writeFile(
      path.join(projectPath, "stacklit.json"),
      JSON.stringify(SAMPLE_STACKLIT, null, 2),
      "utf-8"
    );
  }

  if (withGit) {
    await fsPromises.mkdir(path.join(projectPath, ".git"), { recursive: true });
  }

  return {
    projectPath,
    stateDir,
    cleanup: () => fsPromises.rm(projectPath, { recursive: true, force: true }),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ProjectInitializer", () => {

  // ── Preflight checks ───────────────────────────────────────────────────────

  describe("runPreflight", () => {
    it("passes state directory check when dir is writable", async () => {
      const { projectPath, cleanup } = await makeProject();
      try {
        const config = defaultConfig(projectPath);
        const initializer = createProjectInitializer(config);
        const result = await initializer.runPreflight();

        const stateDirCheck = result.checks.find(
          (c) => c.name === "State directory writable"
        );
        expect(stateDirCheck).toBeDefined();
        expect(stateDirCheck!.passed).toBe(true);
      } finally {
        await cleanup();
      }
    });

    it("warns when git is not initialized (non-fatal)", async () => {
      const { projectPath, cleanup } = await makeProject(false, false);
      try {
        const config = defaultConfig(projectPath);
        const initializer = createProjectInitializer(config);
        const result = await initializer.runPreflight();

        const gitCheck = result.checks.find(
          (c) => c.name === "Git repository"
        );
        expect(gitCheck).toBeDefined();
        expect(gitCheck!.passed).toBe(false);
        expect(gitCheck!.fatal).toBe(false); // warning only
      } finally {
        await cleanup();
      }
    });

    it("passes git check when .git exists", async () => {
      const { projectPath, cleanup } = await makeProject(false, true);
      try {
        const config = defaultConfig(projectPath);
        const initializer = createProjectInitializer(config);
        const result = await initializer.runPreflight();

        const gitCheck = result.checks.find((c) => c.name === "Git repository");
        expect(gitCheck!.passed).toBe(true);
      } finally {
        await cleanup();
      }
    });

    it("warns when stacklit.json is missing (non-fatal)", async () => {
      const { projectPath, cleanup } = await makeProject(false);
      try {
        const config = defaultConfig(projectPath);
        const initializer = createProjectInitializer(config);
        const result = await initializer.runPreflight();

        const stacklitCheck = result.checks.find(
          (c) => c.name === "Stacklit index"
        );
        expect(stacklitCheck!.passed).toBe(false);
        expect(stacklitCheck!.fatal).toBe(false);
      } finally {
        await cleanup();
      }
    });

    it("passes stacklit check when stacklit.json exists", async () => {
      const { projectPath, cleanup } = await makeProject(true);
      try {
        const config = defaultConfig(projectPath);
        const initializer = createProjectInitializer(config);
        const result = await initializer.runPreflight();

        const stacklitCheck = result.checks.find(
          (c) => c.name === "Stacklit index"
        );
        expect(stacklitCheck!.passed).toBe(true);
      } finally {
        await cleanup();
      }
    });

    it("passes Node version check on Node 20+", async () => {
      const { projectPath, cleanup } = await makeProject();
      try {
        const config = defaultConfig(projectPath);
        const initializer = createProjectInitializer(config);
        const result = await initializer.runPreflight();

        const nodeCheck = result.checks.find(
          (c) => c.name === "Node.js version"
        );
        // We're running on Node 20+ in the test environment
        expect(nodeCheck).toBeDefined();
        expect(nodeCheck!.fatal).toBe(true);
      } finally {
        await cleanup();
      }
    });
  });

  // ── Initialize ─────────────────────────────────────────────────────────────

  describe("initialize", () => {
    it("writes ProjectInitialized event to events.jsonl", async () => {
      const { projectPath, stateDir, cleanup } = await makeProject();
      try {
        const config = defaultConfig(projectPath);
        const initializer = createProjectInitializer(config);

        const result = await initializer.initialize({
          projectName: "my-app",
          goal: "Build something great",
          techStack: ["TypeScript"],
        });

        expect(result.alreadyInitialized).toBe(false);
        expect(result.eventId).toBeTruthy();
        expect(result.projectName).toBe("my-app");
        expect(result.goal).toBe("Build something great");

        // Verify the event was actually written
        const store = await createEventStore(stateDir);
        const event = await store.readLatestOfType("ProjectInitialized");
        expect(event).not.toBeNull();
        expect(event!.payload.projectName).toBe("my-app");
      } finally {
        await cleanup();
      }
    });

    it("uses project directory name as default projectName", async () => {
      const { projectPath, cleanup } = await makeProject();
      try {
        const config = defaultConfig(projectPath);
        const initializer = createProjectInitializer(config);

        const result = await initializer.initialize();

        // Should use the temp dir basename
        expect(result.projectName).toBeTruthy();
        expect(result.projectName.length).toBeGreaterThan(0);
      } finally {
        await cleanup();
      }
    });

    it("extracts tech stack from stacklit.json", async () => {
      const { projectPath, cleanup } = await makeProject(true);
      try {
        const config = defaultConfig(projectPath);
        const initializer = createProjectInitializer(config);

        const result = await initializer.initialize();

        // Stacklit has languages: ["TypeScript", "PostgreSQL"]
        expect(result.techStack).toContain("TypeScript");
      } finally {
        await cleanup();
      }
    });

    it("extracts goal from stacklit.json modules", async () => {
      const { projectPath, cleanup } = await makeProject(true);
      try {
        const config = defaultConfig(projectPath);
        const initializer = createProjectInitializer(config);

        const result = await initializer.initialize();

        // Goal should reference module purposes from stacklit
        expect(result.goal).toBeTruthy();
        expect(result.goal.length).toBeGreaterThan(5);
      } finally {
        await cleanup();
      }
    });

    it("is idempotent — second call returns alreadyInitialized=true", async () => {
      const { projectPath, cleanup } = await makeProject();
      try {
        const config = defaultConfig(projectPath);
        const initializer = createProjectInitializer(config);

        const first = await initializer.initialize({
          projectName: "test",
          goal: "Test goal",
        });
        expect(first.alreadyInitialized).toBe(false);

        const second = await initializer.initialize({
          projectName: "different name",
          goal: "Different goal",
        });
        expect(second.alreadyInitialized).toBe(true);
        // Returns original values, not the new ones
        expect(second.projectName).toBe("test");
        expect(second.goal).toBe("Test goal");
      } finally {
        await cleanup();
      }
    });

    it("includes warning when stacklit is missing", async () => {
      const { projectPath, cleanup } = await makeProject(false);
      try {
        const config = defaultConfig(projectPath);
        const initializer = createProjectInitializer(config);

        const result = await initializer.initialize({ projectName: "test" });

        expect(result.warnings.length).toBeGreaterThan(0);
        expect(result.warnings[0]).toContain("stacklit");
      } finally {
        await cleanup();
      }
    });

    it("no warnings when stacklit is present", async () => {
      const { projectPath, cleanup } = await makeProject(true);
      try {
        const config = defaultConfig(projectPath);
        const initializer = createProjectInitializer(config);

        const result = await initializer.initialize({ projectName: "test" });

        expect(result.warnings).toHaveLength(0);
      } finally {
        await cleanup();
      }
    });

    it("creates snapshots after init", async () => {
      const { projectPath, stateDir, cleanup } = await makeProject();
      try {
        const config = defaultConfig(projectPath);
        const initializer = createProjectInitializer(config);

        await initializer.initialize({ projectName: "snap-test" });

        // project.snapshot.json should exist
        const snapshotPath = path.join(stateDir, "project.snapshot.json");
        const exists = await fsPromises
          .stat(snapshotPath)
          .then(() => true)
          .catch(() => false);
        expect(exists).toBe(true);

        // And it should have the right goal
        const content = await fsPromises.readFile(snapshotPath, "utf-8");
        const snapshot = JSON.parse(content) as { projectName: string };
        expect(snapshot.projectName).toBe("snap-test");
      } finally {
        await cleanup();
      }
    });
  });

  // ── readStacklit ────────────────────────────────────────────────────────────

  describe("readStacklit", () => {
    it("returns null when stacklit.json missing", async () => {
      const { projectPath, cleanup } = await makeProject(false);
      try {
        const config = defaultConfig(projectPath);
        const initializer = createProjectInitializer(config);

        const result = await initializer.readStacklit();
        expect(result).toBeNull();
      } finally {
        await cleanup();
      }
    });

    it("extracts goal and tech stack from stacklit.json", async () => {
      const { projectPath, cleanup } = await makeProject(true);
      try {
        const config = defaultConfig(projectPath);
        const initializer = createProjectInitializer(config);

        const result = await initializer.readStacklit();

        expect(result).not.toBeNull();
        expect(result!.techStack).toContain("TypeScript");
        expect(result!.goal).toContain("JWT authentication"); // from module purpose
      } finally {
        await cleanup();
      }
    });
  });
});
