/**
 * SF visualizer app — JSON API over a target repo's sf.db, plus the packaged
 * SPA. Reads are read-only; the single write is POST
 * /api/sessions/:adw_id/archive, which sets one review flag on a row.
 *
 * There is no ingest endpoint and no websocket. The data path is
 * agents -> sqlite -> web ui, and the UI gets there by polling.
 *
 * Ported from a Bun.serve({routes}) app — Hono's :param routes are the same
 * shape, so every route transcribes directly. Two deliberate behavior
 * changes from the Bun version: a GET to the archive route now 404s as JSON
 * (it used to fall through to the SPA, since Bun's routes object only wires
 * POST there); and the manual decodeURIComponent() on route params is
 * dropped — Hono decodes them itself, so keeping it would double-decode.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { Hono } from "hono";
import { SfDb } from "./db.ts";
import { serveStatic } from "./static.ts";
import type { AgentPrompts, ApiError } from "../shared/types.ts";

/**
 * adw_ids and agent names are path segments on disk, so anything that isn't a
 * plain identifier is rejected outright rather than sanitized into something
 * that might still escape the sessions directory.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

function isSafeSegment(value: string): boolean {
  return SAFE_SEGMENT.test(value) && value !== "." && value !== "..";
}

function intQueryParam(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function createApp(db: SfDb, webDir: string): Hono {
  const app = new Hono();

  app.use("/api/*", async (c, next) => {
    await next();
    c.header("cache-control", "no-store");
  });

  app.get("/api/health", (c) =>
    c.json({ ok: true, db: db.path, journal_mode: db.journalMode, sessions: db.sessionCount() }),
  );

  app.get("/api/sessions", (c) => c.json(db.sessions(intQueryParam(c.req.query("limit"), 200))));

  app.get("/api/sessions/:adw_id", (c) => {
    const adwId = c.req.param("adw_id");
    const detail = db.sessionDetail(adwId);
    if (!detail) return c.json({ error: `no session ${adwId}` } satisfies ApiError, 404);
    return c.json(detail);
  });

  // The one write. Archiving is review triage — it belongs to the reader, not
  // to the run — so it never touches anything a tracer wrote.
  app.post("/api/sessions/:adw_id/archive", async (c) => {
    const adwId = c.req.param("adw_id");
    if (!isSafeSegment(adwId)) return c.json({ error: "invalid adw_id" } satisfies ApiError, 400);
    const body = (await c.req.json().catch(() => ({}))) as { archived?: unknown };
    const archived = body.archived === undefined ? true : Boolean(body.archived);
    if (!db.setArchived(adwId, archived)) return c.json({ error: `no session ${adwId}` } satisfies ApiError, 404);
    return c.json({ adw_id: adwId, archived });
  });

  app.get("/api/sessions/:adw_id/events", (c) =>
    c.json(db.events(c.req.param("adw_id"), intQueryParam(c.req.query("after"), 0), intQueryParam(c.req.query("limit"), 500))),
  );

  app.get("/api/sessions/:adw_id/envelopes", (c) => c.json(db.envelopes(c.req.param("adw_id"))));

  app.get("/api/sessions/:adw_id/gates", (c) => c.json(db.gates(c.req.param("adw_id"))));

  // The exact prompts an agent was sent, read from the session dir. Files are
  // the raw record; the db has no copy of them.
  app.get("/api/sessions/:adw_id/agents/:agent/prompts", (c) => {
    const adwId = c.req.param("adw_id");
    const agent = c.req.param("agent");
    if (!isSafeSegment(adwId) || !isSafeSegment(agent)) {
      return c.json({ error: "invalid adw_id or agent" } satisfies ApiError, 400);
    }
    if (!db.session(adwId)) return c.json({ error: `no session ${adwId}` } satisfies ApiError, 404);

    const dir = resolve(db.sessionsDir, adwId, agent, "prompts");
    // Defense in depth: the segment check already forbids traversal.
    if (dir !== db.sessionsDir && !dir.startsWith(db.sessionsDir + sep)) {
      return c.json({ error: "invalid path" } satisfies ApiError, 400);
    }

    // A prompt file is absent whenever the agent never ran in this session —
    // a normal state, so it reads as null rather than an error.
    const read = (name: string): string | null => {
      const file = resolve(dir, `${name}.md`);
      return existsSync(file) ? readFileSync(file, "utf-8") : null;
    };
    return c.json({ system: read("system"), user: read("user") } satisfies AgentPrompts);
  });

  // Registered after every real /api/* route: a miss under /api/ is a 404,
  // never the SPA fallback.
  app.all("/api/*", (c) => c.json({ error: `no route ${c.req.path}` } satisfies ApiError, 404));

  app.get("*", serveStatic(webDir));

  app.onError((err, c) => {
    console.error(`[sf] ${c.req.method} ${c.req.path}:`, err);
    return c.json({ error: err.message } satisfies ApiError, 500);
  });

  return app;
}
