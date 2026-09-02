/**
 * bun:sqlite's surface, backed by node:sqlite, so tracer.ts and the visualizer's
 * db.ts change only their import line.
 *
 * This is deliberately NOT a full bun:sqlite polyfill — it's the ~10-behavior
 * subset SPF actually calls (query/exec/get/all/run, readonly, PRAGMAs, WAL).
 * Every mapping below was verified live against node:sqlite, not assumed:
 *
 *  - bun:sqlite's `{ readonly: true }` maps to node:sqlite's `{ readOnly: true }`
 *    (capital O). Passing the lowercase bun spelling to node:sqlite is NOT an
 *    error — it is silently ignored and the connection opens read-write. That
 *    would quietly void every "this connection never writes" guarantee in the
 *    codebase, so the translation below is deliberate, not cosmetic.
 *  - PRAGMAs (journal_mode, table_info) return rows through the normal
 *    prepare()/get()/all() path on both drivers, and multi-statement `exec()`
 *    works on both — so the tracer's schema creation and additive ALTER
 *    migrations need no changes at all.
 *  - `.query()` on bun:sqlite is a MEMOIZED prepare — the same SQL text
 *    returns the same cached statement. node:sqlite's `prepare()` is not
 *    memoized, and db.ts rebuilds its SQL per-request through an
 *    `optionalColumn()` probe, so this shim caches by exact SQL text. That is
 *    also *correct*: when a tracer ALTER lands mid-serve and the probed SQL
 *    text changes, a fresh statement is prepared automatically.
 *  - node:sqlite's `get()` returns `undefined` for no-row, not `null`; rows
 *    come back with a null prototype. Both are normalized below so existing
 *    `?? null` / `Object.assign(row, ...)` call sites stay honest.
 *  - node:sqlite defaults `enableForeignKeyConstraints: true` — unlike plain
 *    SQLite and bun:sqlite, which both default FK enforcement OFF — so this
 *    is disabled explicitly to restore the behavior the rest of the
 *    codebase was written against. `tracer.ts`'s SCHEMA carries no
 *    `REFERENCES` clauses at all (removed for SPF #66: rows are not always
 *    inserted parent-before-child — e.g. the very first `events` row for a
 *    session lands before that session's own `sessions` row commits, and an
 *    event recorded outside any phase carries `phase_id: ""`, never NULL —
 *    and Cloudflare D1 enforces FKs UNCONDITIONALLY with no way to disable
 *    them, so a clause that was already only decorative on local sqlite
 *    would crash every D1 session outright). This setting is now a no-op
 *    for `tracer.ts`'s own tables specifically, but is kept here as this
 *    wrapper's general default — `cli/commands/abort.ts` and `migrate.ts`
 *    also open a plain `Database` against the same db file for their own
 *    ad-hoc queries, and neither has any reason to want FK enforcement on.
 */

import { DatabaseSync, type SQLInputValue } from "node:sqlite";

/**
 * bun:sqlite accepts any JS value as a bind param; node:sqlite is typed to
 * null/number/bigint/string/ArrayBufferView. Every current call site only
 * ever passes strings/numbers/null, so this cast documents the narrowing
 * this adapter is responsible for rather than widening node:sqlite's types.
 */
function asSqlParams(params: unknown[]): SQLInputValue[] {
  return params as SQLInputValue[];
}

export interface DatabaseOptions {
  readonly?: boolean;
}

export interface Statement<Row, Params extends unknown[]> {
  get(...params: Params): Row | null;
  all(...params: Params): Row[];
  run(...params: Params): { changes: number; lastInsertRowid: number | bigint };
}

const STATEMENT_CACHE_LIMIT = 200;

export class Database {
  private readonly db: DatabaseSync;
  private readonly statementCache = new Map<string, ReturnType<DatabaseSync["prepare"]>>();

  constructor(path: string, options?: DatabaseOptions) {
    this.db = new DatabaseSync(path, {
      readOnly: options?.readonly ?? false,
      timeout: 5000,
      enableForeignKeyConstraints: false,
    });
  }

  /** Cached prepare, keyed by exact SQL text — see the module doc comment. */
  query<Row = unknown, Params extends unknown[] = unknown[]>(sql: string): Statement<Row, Params> {
    let stmt = this.statementCache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      if (this.statementCache.size >= STATEMENT_CACHE_LIMIT) {
        const oldest = this.statementCache.keys().next().value;
        if (oldest !== undefined) this.statementCache.delete(oldest);
      }
      this.statementCache.set(sql, stmt);
    }
    return {
      get: (...params: Params) => {
        guardNamedParams(params, sql);
        const row = stmt!.get(...asSqlParams(params));
        return row === undefined ? null : ({ ...(row as object) } as Row);
      },
      all: (...params: Params) => {
        guardNamedParams(params, sql);
        return (stmt!.all(...asSqlParams(params)) as object[]).map((row) => ({ ...row })) as Row[];
      },
      run: (...params: Params) => {
        guardNamedParams(params, sql);
        const result = stmt!.run(...asSqlParams(params));
        return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
      },
    };
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Every current call site passes only strings/numbers, positionally. If a
 * future call ever passes a bare object as the first param against SQL with
 * no named-parameter markers, node:sqlite's `allowBareNamedParameters`
 * default would silently reinterpret it — fail loudly instead.
 */
function guardNamedParams(params: unknown[], sql: string): void {
  const first = params[0];
  const looksNamed = first !== null && typeof first === "object";
  const sqlHasNamedMarkers = /[:$@][A-Za-z_]/.test(sql);
  if (looksNamed && !sqlHasNamedMarkers) {
    throw new Error(`sqlite: unexpected object parameter for a positional query: ${sql}`);
  }
}
