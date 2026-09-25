/**
 * The herdr channel against a fake herdr server on a real Unix socket (not a
 * mocked client — proves the newline-JSON bytes on the wire), covering the
 * watch lifecycle (claim → pane + tail → phase updates → PR → done), blocked
 * issues, fan-out routing, attended one-off runs, and `resolveNotifier`
 * resolving/skipping the channel by whether spf is inside a herdr pane.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";
import { HerdrChannel, herdrEnvFrom, herdrRequest, resetHerdrState } from "../core/notify/herdr_channel.js";
import { resolveNotifier } from "../core/notify/notifier.js";
import type { NotifyEvent } from "../core/notify/channel.js";
import { SFConfigSchema } from "../core/data_types.js";

interface Received {
  method: string;
  params: Record<string, any>;
}

/** A herdr stand-in: records every request, hands out pane ids on split, and can be told to fail a method. */
async function fakeHerdr(opts: { failMethods?: string[] } = {}): Promise<{ socketPath: string; received: Received[]; close: () => Promise<void> }> {
  const socketPath = path.join(mkdtempSync(path.join(tmpdir(), "spf-herdr-")), "h.sock");
  const received: Received[] = [];
  let nextPane = 2;
  const server = net.createServer((conn) => {
    let buffer = "";
    conn.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const request = JSON.parse(buffer.slice(0, newline));
      received.push({ method: request.method, params: request.params });
      const reply = opts.failMethods?.includes(request.method)
        ? { id: request.id, error: { code: "not_found", message: `${request.method} failed` } }
        : request.method === "pane.split"
          ? { id: request.id, result: { type: "pane_info", pane: { pane_id: `w1:p${nextPane++}` } } }
          : { id: request.id, result: { type: "ok" } };
      conn.end(`${JSON.stringify(reply)}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return { socketPath, received, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

function ev(kind: NotifyEvent["kind"], fields: Array<[string, string]>, extra: Partial<NotifyEvent> = {}): NotifyEvent {
  return { kind, level: "info", title: kind, fields, ...extra };
}

const methods = (received: Received[]) => received.map((r) => r.method);

beforeEach(() => resetHerdrState());

test("herdrEnvFrom needs HERDR_ENV=1, a socket path, and a pane id", () => {
  assert.equal(herdrEnvFrom({}), null);
  assert.equal(herdrEnvFrom({ HERDR_SOCKET_PATH: "/s", HERDR_PANE_ID: "w1:p1" }), null);
  assert.equal(herdrEnvFrom({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" }), null);
  assert.deepEqual(herdrEnvFrom({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/s", HERDR_PANE_ID: "w1:p1" }), { socketPath: "/s", paneId: "w1:p1" });
});

test("herdrRequest writes one newline-terminated {id, method, params} and rejects on an API error", async () => {
  const herdr = await fakeHerdr({ failMethods: ["pane.get"] });
  try {
    await herdrRequest(herdr.socketPath, "pane.list", { a: 1 }, 1000);
    assert.deepEqual(herdr.received[0], { method: "pane.list", params: { a: 1 } });
    await assert.rejects(herdrRequest(herdr.socketPath, "pane.get", { pane_id: "x" }, 1000), /pane\.get failed/);
  } finally {
    await herdr.close();
  }
});

test("herdrRequest rejects promptly when nothing is listening", async () => {
  await assert.rejects(herdrRequest("/nonexistent/herdr.sock", "pane.list", {}, 1000), /herdr pane\.list/);
});

test("watch lifecycle: claim splits a pane off spf's own, run_started tails the run, and phases, PR, and done update it", async () => {
  const herdr = await fakeHerdr();
  try {
    const channel = new HerdrChannel({ socketPath: herdr.socketPath, paneId: "w1:p1" }, { cwd: "/repo" });
    await channel.send(ev("watch_started", [["repo", "o/r"]]), 1000);
    await channel.send(ev("issue_claimed", [["issue", "42"], ["title", "add login"], ["chain", "plan-build-test"]], { title: "issue 42 claimed" }), 1000);
    await channel.send(ev("run_started", [["adw_id", "issue-42"]], { title: "run started — plan-build-test" }), 1000);
    await channel.send(ev("phase_retry", [["adw_id", "issue-42"]], { title: "retry 1/3 — build" }), 1000);
    await channel.send(ev("pr_opened", [["issue", "42"], ["title", "add login"], ["pr", "#7"]]), 1000);
    await channel.send(ev("issue_done", [["issue", "42"], ["title", "add login"], ["pr", "#7"]]), 1000);

    const split = herdr.received.find((r) => r.method === "pane.split")!;
    assert.deepEqual(split.params, { direction: "right", target_pane_id: "w1:p1", cwd: "/repo", focus: false });
    assert.deepEqual(herdr.received.find((r) => r.method === "pane.send_text")!.params, { pane_id: "w1:p2", text: "spf events issue-42 --follow\n" });

    const states = herdr.received.filter((r) => r.method === "pane.report_agent").map((r) => [r.params.pane_id, r.params.state, r.params.message]);
    assert.deepEqual(states, [
      ["w1:p1", "idle", "watching"],
      ["w1:p2", "working", "plan-build-test"],
      ["w1:p2", "working", "run started — plan-build-test"],
      ["w1:p2", "working", "retry 1/3 — build"],
      ["w1:p2", "idle", "PR #7 in review"],
    ]);
    assert.deepEqual(herdr.received.at(-1), { method: "pane.close", params: { pane_id: "w1:p2" } });

    const seqs = herdr.received.filter((r) => r.params.seq !== undefined).map((r) => r.params.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "seq must increase so herdr never drops a later report as stale");
    assert.ok(herdr.received.every((r) => !("source" in r.params) || r.params.source === "spf"));
  } finally {
    await herdr.close();
  }
});

test("a blocked issue flips its pane to blocked and raises a herdr notification", async () => {
  const herdr = await fakeHerdr();
  try {
    const channel = new HerdrChannel({ socketPath: herdr.socketPath, paneId: "w1:p1" }, { cwd: "/repo" });
    await channel.send(ev("issue_claimed", [["issue", "42"], ["title", "t"], ["chain", "c"]]), 1000);
    await channel.send(ev("issue_blocked", [["issue", "42"], ["title", "t"]], { level: "notice", title: "issue 42 blocked", detail: "gates failed\nmore" }), 1000);
    const blocked = herdr.received.filter((r) => r.method === "pane.report_agent").at(-1)!;
    assert.equal(blocked.params.state, "blocked");
    assert.equal(blocked.params.message, "gates failed");
    assert.deepEqual(herdr.received.at(-1), { method: "notification.show", params: { title: "issue 42 blocked", body: "gates failed", sound: "request" } });
  } finally {
    await herdr.close();
  }
});

test("an issue id that isn't plainly shell-safe gets a pane and state, but nothing typed into it", async () => {
  const herdr = await fakeHerdr();
  try {
    const channel = new HerdrChannel({ socketPath: herdr.socketPath, paneId: "w1:p1" }, { cwd: "/repo" });
    await channel.send(ev("issue_claimed", [["issue", "42; rm -rf ~"], ["title", "t"], ["chain", "c"]]), 1000);
    await channel.send(ev("run_started", [["adw_id", "issue-42; rm -rf ~"]]), 1000);
    assert.ok(methods(herdr.received).includes("pane.split"));
    assert.ok(!methods(herdr.received).includes("pane.send_text"));
  } finally {
    await herdr.close();
  }
});

test("a fan-out attempt's run_started doesn't tail (siblings share the pane), and its phase events route to the issue's pane", async () => {
  const herdr = await fakeHerdr();
  try {
    const channel = new HerdrChannel({ socketPath: herdr.socketPath, paneId: "w1:p1" }, { cwd: "/repo" });
    await channel.send(ev("watch_started", []), 1000);
    await channel.send(ev("issue_claimed", [["issue", "4"], ["title", "t"], ["chain", "c"]]), 1000);
    await channel.send(ev("issue_claimed", [["issue", "42"], ["title", "t"], ["chain", "c"]]), 1000);
    await channel.send(ev("run_started", [["adw_id", "issue-42-r1-3"]]), 1000);
    await channel.send(ev("phase_failed", [["adw_id", "issue-42-r1-3"]], { level: "error", title: "phase failed — build" }), 1000);
    assert.ok(!methods(herdr.received).includes("pane.send_text"));
    const last = herdr.received.at(-1)!;
    assert.equal(last.method, "pane.report_agent");
    assert.equal(last.params.pane_id, "w1:p3", "issue-42-r1-3 belongs to issue 42, not issue 4");
    assert.equal(last.params.message, "phase failed — build");
  } finally {
    await herdr.close();
  }
});

test("under watch, a run event that matches no issue pane leaves the daemon's own pane alone", async () => {
  const herdr = await fakeHerdr();
  try {
    const channel = new HerdrChannel({ socketPath: herdr.socketPath, paneId: "w1:p1" }, { cwd: "/repo" });
    await channel.send(ev("watch_started", []), 1000);
    const before = herdr.received.length;
    await channel.send(ev("run_started", [["adw_id", "spec-9"]]), 1000);
    assert.equal(herdr.received.length, before);
  } finally {
    await herdr.close();
  }
});

test("an attended one-off run reports on spf's own pane, and a failure also notifies", async () => {
  const herdr = await fakeHerdr();
  try {
    const channel = new HerdrChannel({ socketPath: herdr.socketPath, paneId: "w1:p1" }, { cwd: "/repo" });
    await channel.send(ev("run_started", [["adw_id", "a1b2c3d4"]], { title: "run started — build" }), 1000);
    await channel.send(ev("run_failed", [["adw_id", "a1b2c3d4"]], { level: "error", title: "run failed — build" }), 1000);
    const states = herdr.received.filter((r) => r.method === "pane.report_agent").map((r) => [r.params.pane_id, r.params.state]);
    assert.deepEqual(states, [["w1:p1", "working"], ["w1:p1", "idle"]]);
    assert.deepEqual(herdr.received.find((r) => r.method === "pane.report_metadata")!.params.state_labels, { idle: "failed" });
    assert.equal(herdr.received.at(-1)!.method, "notification.show");
  } finally {
    await herdr.close();
  }
});

test("a revision re-claim reuses the issue's pane while it's alive, and opens a new one once it's gone", async () => {
  const herdr = await fakeHerdr();
  try {
    const channel = new HerdrChannel({ socketPath: herdr.socketPath, paneId: "w1:p1" }, { cwd: "/repo" });
    const claim = ev("issue_claimed", [["issue", "42"], ["title", "t"], ["chain", "c"]]);
    await channel.send(claim, 1000);
    await channel.send(claim, 1000);
    assert.equal(methods(herdr.received).filter((m) => m === "pane.split").length, 1);
  } finally {
    await herdr.close();
  }
  const gone = await fakeHerdr({ failMethods: ["pane.get"] });
  try {
    const channel = new HerdrChannel({ socketPath: gone.socketPath, paneId: "w1:p1" }, { cwd: "/repo" });
    const claim = ev("issue_claimed", [["issue", "42"], ["title", "t"], ["chain", "c"]]);
    await channel.send(claim, 1000);
    await channel.send(claim, 1000);
    assert.equal(methods(gone.received).filter((m) => m === "pane.split").length, 2);
  } finally {
    await gone.close();
  }
});

test("resolveNotifier skips a herdr channel outside herdr with one warning, and resolves it inside", () => {
  const cfg = v.parse(SFConfigSchema, { notifications: { events: "errors", channels: [{ kind: "herdr" }] } });
  const saved = { HERDR_ENV: process.env.HERDR_ENV, HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH, HERDR_PANE_ID: process.env.HERDR_PANE_ID };
  try {
    delete process.env.HERDR_ENV;
    const logs: string[] = [];
    assert.equal(resolveNotifier(cfg, { log: (m) => logs.push(m) }), null);
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /not running inside a herdr pane/);

    Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/h.sock", HERDR_PANE_ID: "w1:p1" });
    assert.ok(resolveNotifier(cfg, { log: () => undefined }));
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
