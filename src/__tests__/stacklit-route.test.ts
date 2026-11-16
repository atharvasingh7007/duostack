/**
 * __tests__/stacklit-route.test.ts
 *
 * Tests for the /stacklit/* endpoints.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createOrchestrator } from "../core/orchestrator.js";
import { createApiServer } from "../api/server.js";
import { createStacklitBridge } from "../core/stacklit-bridge.js";
import { defaultConfig } from "../core/config.js";

let server: http.Server;
let baseUrl: string;
let tmpDir: string;

async function req(
  method: "GET" | "POST",
  p: string,
  body?: unknown
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const url = new URL(`${baseUrl}${p}`);
    const options = {
      hostname: url.hostname,
      port: parseInt(url.port),
      path: `${url.pathname}${url.search}`,
      method,
      headers: {
        "Content-Type": "application/json",
        ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
      },
    };
    const r = http.request(options, (res) => {
      let resp = "";
      res.on("data", (c) => (resp += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(resp) }); }
        catch { resolve({ status: res.statusCode ?? 0, body: resp }); }
      });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

beforeAll(async () => {
  tmpDir = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), "duostack-stacklit-route-test-")
  );

  const stacklitContent = {
    version: "0.3.0",
    modules: {
      "src/auth": {
        purpose: "Authentication and JWT tokens",
        dependencies: ["src/utils"],
      },
      "src/utils": {
        purpose: "General helpers",
        dependencies: [],
      },
    },
    languages: ["TypeScript"],
    framework: "Express",
  };

  const stacklitPath = path.join(tmpDir, "stacklit.json");
  await fsPromises.writeFile(stacklitPath, JSON.stringify(stacklitContent, null, 2), "utf-8");

  const config = defaultConfig(tmpDir);
  config.stacklit.jsonPath = stacklitPath;
  const bridge = createStacklitBridge(config);

  const orchestrator = await createOrchestrator({
    projectPath: tmpDir,
    stateDir: tmpDir,
    stacklitPath,
  });
  await orchestrator.initOnly();

  const app = createApiServer(orchestrator, bridge);

  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    if (server) server.close(() => resolve());
    else resolve();
  });
  await fsPromises.rm(tmpDir, { recursive: true, force: true });
});

describe("Stacklit Routes", () => {
  it("GET /stacklit/status returns availability and module count", async () => {
    const res = await req("GET", "/stacklit/status");
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.moduleCount).toBe(2);
  });

  it("GET /stacklit/context returns context based on token health", async () => {
    const res = await req("GET", "/stacklit/context?health=normal");
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("derive_map");
    expect(res.body.available).toBe(true);
  });

  it("GET /stacklit/context returns 400 when health param is missing", async () => {
    const res = await req("GET", "/stacklit/context");
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("health query param required");
  });

  it("GET /stacklit/module/:query finds matching module", async () => {
    const res = await req("GET", "/stacklit/module/auth");
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    expect(res.body.modulePath).toBe("src/auth");
  });

  it("GET /stacklit/module/:query returns 404 for unknown module", async () => {
    const res = await req("GET", "/stacklit/module/nonexistent");
    expect(res.status).toBe(404);
    expect(res.body.found).toBe(false);
  });

  it("GET /stacklit/deps/:module returns dependency graph", async () => {
    const res = await req("GET", "/stacklit/deps/src%2Fauth?depth=2");
    expect(res.status).toBe(200);
    expect(res.body.module).toBe("src/auth");
    expect(res.body.depth).toBe(2);
    expect(res.body.graph).toBeDefined();
  });

  it("GET /stacklit/full returns complete index", async () => {
    const res = await req("GET", "/stacklit/full");
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.index.version).toBe("0.3.0");
  });
});
