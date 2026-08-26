/**
 * SPF #15 — the OpenSandbox adapter, 8.3b's "wire lane" (design doc §8.3b):
 * the REAL `@alibaba-group/opensandbox` SDK, driven against an in-process
 * `node:http` fake standing in for the OpenSandbox control plane — real
 * bytes on the wire, never a fetch mock (the `otel.test.ts` precedent,
 * `:29`/`:88-113`).
 *
 * **Scope, stated rather than assumed.** The spike's own REST surface list
 * (`sandbox-spike.json`'s `api_surface` field) documents the LIFECYCLE
 * verbs only — `POST/GET/DELETE /v1/sandboxes`, `/v1/sandboxes/{id}`,
 * `.../pause`, `.../resume`, `.../renew-expiration`, `.../endpoints/{port}`
 * — and is explicit that egress reads/patches are a SEPARATE surface (the
 * sidecar's own REST on port 18080). It never documents an endpoint or wire
 * shape for `commands.run`/`files.*` at all — those may not even go through
 * the control plane's REST surface (`execd` is a separate per-sandbox
 * sidecar image, per the spike's `ops_requirements` field). Faking that
 * traffic here would mean inventing an endpoint the spike never measured,
 * which is exactly the kind of unverified guess the spike-facts file is
 * supposed to keep out of this PR. This lane therefore fakes ONLY the
 * documented lifecycle CRUD surface — create / getInfo / renew / kill
 * (DELETE) / a 500 / the auth header — and leaves the exec/files wire shape
 * to §8.4's live e2e against a real control plane, where it belongs.
 *
 * **The skip rule, checked synchronously at declaration time** (design
 * §8.3b): a machine without `SPF_E2E_OPENSANDBOX_SDK=1` never even attempts
 * `loadOpenSandboxSdk()` — the gate is evaluated once, before any test
 * runs, and passed to `node:test`'s own `{skip}` option so a default
 * `npm test` reports these as skipped, never red. If the flag IS set but
 * the SDK is not installed, each test calls `t.skip(...)` with the exact
 * install command rather than throwing — a missing OPTIONAL SDK is a named
 * skip, never a failure (§4.1, §8.3b).
 *
 * **The fixture is developer-local and NOT a live capture in this
 * environment** — see `src/test/fixtures/opensandbox_create_body.json`'s
 * own header comment. This tree has neither the real SDK installed nor a
 * running control plane, so nothing here could actually record a real
 * wire body this session; the fixture is a best-effort reconstruction from
 * the spike's documented `Sandbox.create(options)` shape, and this file
 * does not deep-equal against it for that reason.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { loadOpenSandboxSdk } from "../core/sandbox_opensandbox.js";

const SDK_ENV_FLAG = "SPF_E2E_OPENSANDBOX_SDK";
const sdkGateOptions = { skip: !process.env[SDK_ENV_FLAG] ? `${SDK_ENV_FLAG} not set` : false };
const SDK_MISSING_SKIP = "@alibaba-group/opensandbox@0.1.11 not installed — npm i -D @alibaba-group/opensandbox@0.1.11";

interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

interface FakeControlPlane {
  url: string;
  requests: RecordedRequest[];
  setCreateStatus: (status: number) => void;
  close: () => Promise<void>;
}

/** The documented lifecycle CRUD surface ONLY — see this file's header comment for the exec/files scope decision. */
function startFakeControlPlane(): Promise<FakeControlPlane> {
  const requests: RecordedRequest[] = [];
  const sandboxes = new Map<string, { state: string; createdAt: string; expiresAt: string }>();
  let createStatus = 200;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf-8");
      const url = new URL(req.url ?? "/", "http://localhost");
      requests.push({ method: req.method ?? "", path: url.pathname, headers: req.headers, body });

      if (req.method === "POST" && url.pathname === "/v1/sandboxes") {
        if (createStatus !== 200) {
          res.writeHead(createStatus, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "create failed" }));
          return;
        }
        const id = randomUUID();
        const now = Date.now();
        const record = { state: "running", createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString() };
        sandboxes.set(id, record);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id, status: { state: record.state }, createdAt: record.createdAt, expiresAt: record.expiresAt }));
        return;
      }

      const idMatch = /^\/v1\/sandboxes\/([^/]+)(\/.*)?$/.exec(url.pathname);
      if (idMatch) {
        const id = idMatch[1]!;
        const rest = idMatch[2] ?? "";
        const sb = sandboxes.get(id);

        if (req.method === "GET" && rest === "") {
          if (!sb) {
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "not found" }));
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ id, status: { state: sb.state }, createdAt: sb.createdAt, expiresAt: sb.expiresAt }));
          return;
        }
        if (req.method === "DELETE" && rest === "") {
          sandboxes.delete(id);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (req.method === "POST" && rest === "/renew-expiration") {
          if (sb) sb.expiresAt = new Date(Date.now() + 3_600_000).toISOString();
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found", path: url.pathname }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        setCreateStatus: (status: number) => {
          createStatus = status;
        },
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

async function loadSdkOrSkip(t: { skip: (reason: string) => void }) {
  try {
    return await loadOpenSandboxSdk();
  } catch {
    t.skip(SDK_MISSING_SKIP);
    return null;
  }
}

test("wire: create -> getInfo -> renew -> kill() issues a DELETE -> close() releases the local connection, against real HTTP", sdkGateOptions, async (t) => {
  const sdk = await loadSdkOrSkip(t);
  if (!sdk) return;
  const plane = await startFakeControlPlane();
  try {
    const sandbox = await sdk.Sandbox.create({
      connectionConfig: { domain: new URL(plane.url).host, protocol: "http", requestTimeoutSeconds: 5 },
      image: "debian",
      env: {},
      timeoutSeconds: 3600,
    });
    assert.ok(sandbox.id, "create must return an id");

    const info = await sandbox.getInfo();
    assert.equal(info.status.state, "running");

    await sandbox.renew(60);
    const renewReq = plane.requests.find((r) => r.method === "POST" && r.path.endsWith("/renew-expiration"));
    assert.ok(renewReq, "renew() must hit .../renew-expiration");

    await sandbox.kill();
    const deleteReq = plane.requests.find((r) => r.method === "DELETE");
    assert.ok(deleteReq, "kill() must issue a DELETE against the control plane — the spike's own equivalence (\"DELETE ... or SDK kill()\")");

    // close() releases the local HTTP agent — no network call is required for it to succeed.
    await sandbox.close();
  } finally {
    await plane.close();
  }
});

test("wire: a 500 on create surfaces a rejection, not a hang", sdkGateOptions, async (t) => {
  const sdk = await loadSdkOrSkip(t);
  if (!sdk) return;
  const plane = await startFakeControlPlane();
  plane.setCreateStatus(500);
  try {
    await assert.rejects(
      sdk.Sandbox.create({
        connectionConfig: { domain: new URL(plane.url).host, protocol: "http", requestTimeoutSeconds: 5 },
        image: "debian",
        env: {},
        timeoutSeconds: 3600,
      }),
    );
  } finally {
    await plane.close();
  }
});

test("wire: an apiKey in ConnectionConfig reaches the control plane as the OPEN-SANDBOX-API-KEY header", sdkGateOptions, async (t) => {
  const sdk = await loadSdkOrSkip(t);
  if (!sdk) return;
  const plane = await startFakeControlPlane();
  try {
    await sdk.Sandbox.create({
      connectionConfig: { domain: new URL(plane.url).host, protocol: "http", apiKey: "test-key-123", requestTimeoutSeconds: 5 },
      image: "debian",
      env: {},
      timeoutSeconds: 3600,
    });
    const createReq = plane.requests.find((r) => r.method === "POST" && r.path === "/v1/sandboxes");
    assert.ok(createReq);
    assert.equal(createReq!.headers["open-sandbox-api-key"], "test-key-123");
  } finally {
    await plane.close();
  }
});
