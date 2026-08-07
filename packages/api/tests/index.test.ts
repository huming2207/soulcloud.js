/**
 * API_BIND_ADDRESS handling (P2) — entrypoint-level guard tests.
 *
 * Parsing itself lives in `parseBindAddress` (packages/api/src/config.ts,
 * unit-tested in tests/config.test.ts incl. the `[::1]:port` branch).
 * index.ts consumes it and exits(1) with a clear error on a null result,
 * so these tests exercise the real entrypoint as a subprocess:
 *
 *   - an unparseable address must terminate the process (exit 1) with a
 *     clear error instead of starting a misconfigured server
 *   - a valid host:port must be bound by the HTTP server, and the process
 *     shuts down cleanly on SIGTERM
 */

import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

const ENTRYPOINT = new URL("../src/index.ts", import.meta.url).pathname;

interface EntryResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface RunningEntry {
  child: ReturnType<typeof spawn>;
  stdout: () => string;
  stderr: () => string;
}

function entryEnv(bindAddress: string): Record<string, string> {
  const env: Record<string, string> = {
    API_BIND_ADDRESS: bindAddress,
    JWT_SECRET: "j".repeat(32),
  };
  if (process.env.DATABASE_URL) env.DATABASE_URL = process.env.DATABASE_URL;
  return env;
}

/** Spawns the API entrypoint with the given API_BIND_ADDRESS. */
function runEntrypoint(bindAddress: string): RunningEntry {
  const child = spawn("bun", ["run", ENTRYPOINT], {
    env: { ...process.env, ...entryEnv(bindAddress) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  return { child, stdout: () => stdout, stderr: () => stderr };
}

function waitExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("entrypoint did not exit in time")), 30_000);
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function waitForOutput(
  run: RunningEntry,
  predicate: (stdout: string, stderr: string) => boolean,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(run.stdout(), run.stderr())) return;
    if (run.child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!predicate(run.stdout(), run.stderr())) {
    throw new Error(
      `entrypoint output not seen in time\nstdout: ${run.stdout()}\nstderr: ${run.stderr()}`,
    );
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

// The entrypoint requires DATABASE_URL (loadApiConfig). The suite contract
// runs tests via scripts/test.sh, which always sets it; skip otherwise.
const suite = process.env.DATABASE_URL ? describe : describe.skip;

suite("API_BIND_ADDRESS parsing (entrypoint subprocess)", () => {
  test("an unparseable address terminates the process with a clear error", async () => {
    const run = runEntrypoint("not-an-address");
    const code = await waitExit(run.child);
    expect(code).toBe(1);
    expect(run.stderr()).toContain("Invalid API_BIND_ADDRESS");
  });

  test("a valid host:port is extracted from the regex and the server binds on it", async () => {
    const port = await freePort();
    const bindAddress = `127.0.0.1:${port}`;
    const run = runEntrypoint(bindAddress);
    try {
      await waitForOutput(run, (out) => out.includes(`listening on ${bindAddress}`));
      expect(run.child.exitCode).toBeNull(); // still running
    } finally {
      run.child.kill("SIGTERM");
    }
    const code = await waitExit(run.child);
    expect(code).toBe(0); // clean shutdown handler
  });
});
