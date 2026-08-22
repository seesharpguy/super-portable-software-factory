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
}
