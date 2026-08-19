/**
 * What every chain's `main()` receives. The CLI (or, later, the chain
 * registry) resolves every path here — a chain never has its own opinion
 * about where the config file or the working directory are, and none of the
 * historical per-chain hardcoded config-path defaults survive this.
 */
export interface ChainContext {
  prompt: string;
  /** Absolute. */
  config_path: string;
  adw_id: string | null;
  /** Absolute. The anchor session.ensure() resolves repo_root and data_dir from. */
  cwd: string;
}
