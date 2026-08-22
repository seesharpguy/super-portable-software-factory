/**
 * What every chain's `main()` receives. The CLI (or, later, the chain
 * registry) resolves every path here — a chain never has its own opinion
 * about where the config file or the working directory are, and none of the
 * historical per-chain hardcoded config-path defaults survive this.
 */
export interface ChainContext {
  prompt: string;
  /**
   * Absolute paths, in load order (agents.loadConfig merges them: later
   * overrides earlier). The built-in packaged default, then an optional
   * discovered `.spf/spf.config.yaml` — or just the one explicit `--config`
   * path, standalone, with no built-in underneath it.
   */
  config_paths: string[];
  adw_id: string | null;
  /** Absolute. The anchor session.ensure() resolves repo_root and data_dir from. */
  cwd: string;
  /** The CLI name (`"plan-build-test"`), for session.ensure()'s trace record — see core/session.ts. */
  chain_name: string;
  /**
   * The originating tracker issue's id, only meaningful to the `refine`
   * chain — `steps.publishIssues()` renders it as a `## Parent: #<id>`
   * back-reference on every issue it creates (`core/refine.ts`'s
   * `renderBody`). `null`/omitted for a manual run with no source issue
   * (a bare `spf refine "<spec text>"`, no `--issue`). Every other chain
   * ignores this field.
   */
  issue_id?: string | null;
  /**
   * True when no human is at the keyboard for this run — `spf watch`'s
   * daemon lane, a cron/CI invocation — false for an interactive
   * `spf <chain> "..."`.
   *
   * REQUIRED, deliberately: it is not a flag a call site may forget. Every
   * ChainContext construction site has to state which lane it is, because
   * "unattended" is what makes several safety rules non-negotiable rather
   * than merely advisable — most concretely, a repo-local chain
   * (`.spf/chains/*.yaml`) may only ADD gates, never drop a built-in one
   * (see `steps.ts`'s GATE_ALLOWLIST comment): there is nobody watching the
   * console to notice that `diffMatchesClaims` was quietly turned off. A
   * boolean that defaults to `false` would make the dangerous lane the one
   * you get by accident.
   */
  unattended: boolean;
  /**
   * Absolute path of the YAML file this chain was loaded from, when it is a
   * repo-local chain (`.spf/chains/<name>.yaml` — see
   * `chains/repo_chains.ts`). `undefined` for a built-in chain, which has no
   * file: it IS spf's own code.
   *
   * `steps.startRun()` writes this into the trace as a single
   * `chain_source` log event, so a session in the UI or in `spf trace` can
   * always answer "whose chain definition ran this?" — the answer stops
   * being obvious the moment a target repo can ship its own chains, and the
   * trace is the only durable record (the YAML file itself may have been
   * edited by the time anyone reads the run back).
   */
  chain_source?: string;
}
