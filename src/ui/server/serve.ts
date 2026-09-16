/**
 * `spf ui` bootstrap: bind the app to a real port, print the URL, optionally
 * open a browser, and shut down cleanly on SIGINT/SIGTERM.
 *
 * Binds loopback-only (127.0.0.1) by DEFAULT, deliberately — this server can
 * flip a database column and reveal agent prompts, and a companion CLI has
 * no reason to listen on every interface unless someone explicitly asks for
 * it via `options.host` (`--host` on the CLI). Widening the bind is an
 * opt-in the caller states on purpose, not a default — see issue #90.
 */
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import type { NormalizedObservabilityDb } from "../../core/data_types.ts";
import { createApp } from "./app.ts";
import { SfDb } from "./db.ts";

export interface UiOptions {
  /** Bare local sqlite path (sugar for `{kind:"sqlite",path}`), or a normalized `observability.db` descriptor. */
  db: NormalizedObservabilityDb | string;
  /** `paths.resolveDataPaths(...).sessions_dir` — required whenever `db` is `kind:"d1"`; see `SfDb.open`'s doc comment. */
  sessionsDir?: string;
  webDir: string;
  /** Explicit port. Omit to try the default and probe upward on collision. */
  port?: number;
  /**
   * Bind address. Omit for the safe default (`127.0.0.1`, loopback-only).
   * Set explicitly (e.g. `"0.0.0.0"`, or a specific interface IP) to make
   * this reachable off-box — a deliberate widening, not something a caller
   * should ever get by accident. See the module doc comment above.
   */
  host?: string;
  open?: boolean;
}

export interface UiHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}

const DEFAULT_PORT = 4600;
const PORT_PROBE_ATTEMPTS = 10;

function isAddrInUse(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "EADDRINUSE";
}

function listen(app: ReturnType<typeof createApp>, port: number, hostname: string): Promise<ServerType> {
  return new Promise((resolvePromise, reject) => {
    const server = serve({ fetch: app.fetch, port, hostname }, () => resolvePromise(server));
    server.on("error", reject);
  });
}

/** Best-effort only — a failure here (no GUI, unknown platform) is never fatal. */
function openUrl(url: string): void {
  const platform = process.platform;
  const [cmd, args] = platform === "darwin" ? ["open", [url]] : platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    const child = spawn(cmd as string, args as string[], { detached: true, stdio: "ignore" });
    child.on("error", () => {}); // e.g. xdg-open not installed — swallow, url is already printed
    child.unref();
  } catch {
    // swallow — the URL is already printed either way
  }
}

export async function runUi(options: UiOptions): Promise<UiHandle> {
  const db = await SfDb.open(options.db, options.sessionsDir);
  const app = createApp(db, options.webDir);

  const host = options.host ?? "127.0.0.1";
  const explicit = options.port !== undefined;
  const startPort = options.port ?? DEFAULT_PORT;
  let server: ServerType | undefined;
  let port = startPort;

  const attempts = explicit ? 1 : PORT_PROBE_ATTEMPTS;
  for (let i = 0; i < attempts; i++) {
    port = startPort + i;
    try {
      server = await listen(app, port, host);
      break;
    } catch (error) {
      if (!isAddrInUse(error)) throw error;
      if (i === attempts - 1) {
        await db.close();
        throw new Error(
          explicit
            ? `port ${port} is already in use — pick another with --port`
            : `ports ${startPort}-${port} are all in use — pick one explicitly with --port`,
        );
      }
    }
  }

  const info = server!.address() as AddressInfo | null;
  const boundPort = info?.port ?? port;
  const url = `http://${host}:${boundPort}`;

  const shouldOpen = options.open !== false && process.stdout.isTTY && !process.env.CI && !process.env.SSH_CONNECTION;
  if (shouldOpen) openUrl(url);

  const close = (): Promise<void> =>
    new Promise((resolvePromise, reject) => {
      server!.close(() => {
        db.close().then(resolvePromise, reject);
      });
    });

  const shutdown = () => {
    void close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return { url, port: boundPort, close };
}
