import path from "node:path";
import { allChains, repoChainProblems } from "../../chains/index.ts";

/**
 * A repo-defined chain's `source` is an absolute path into `.spf/chains/` by
 * construction (that's the one place `loadRepoChains` ever looks) — trim it
 * back to the repo-relative fragment a human actually wants to see, rather
 * than a long absolute path that's identical on every machine's checkout
 * except for the leading segment.
 */
function repoChainLabel(source: string): string {
  const marker = path.join(".spf", "chains");
  const idx = source.lastIndexOf(marker);
  return idx === -1 ? source : source.slice(idx);
}

export function listCommand(): number {
  // Built-ins first, then repo chains — same order `allChains()` guarantees,
  // so this listing and `findChain`'s resolution order never disagree about
  // which chain wins on a name collision.
  const chains = allChains();
  const width = Math.max(...chains.map((c) => c.name.length));
  for (const chain of chains) {
    const agents = typeof chain.requiredAgents === "function" ? "(--agent picks who)" : chain.requiredAgents.join(", ") || "(none)";
    const suites = typeof chain.requiredSuites === "function" ? chain.requiredSuites({}) : chain.requiredSuites;
    const suiteNote = typeof chain.requiredSuites === "function" ? " (--suite overrides)" : "";
    console.log(`${chain.name.padEnd(width)}  ${chain.phases}`);
    console.log(`${"".padEnd(width)}  ${chain.describe}`);
    console.log(`${"".padEnd(width)}  agents: ${agents}${suites.length ? `  ·  quality suites: ${suites.join(", ")}${suiteNote}` : ""}`);
    // `source` is undefined for every built-in — only a chain loaded from a
    // `.spf/chains/*.yaml` file carries one (see chains/repo_chains.ts).
    if (chain.source) {
      console.log(`${"".padEnd(width)}  (repo: ${repoChainLabel(chain.source)})`);
    }
    console.log();
  }
  console.log(`spf <name> "<prompt>" [--config <path>] [--adw-id <id>] [--cwd <dir>] [--suite <name>]   (spf run <name> ... works identically)`);
  console.log(`spf watch polls a tracker and runs one of these chains per issue — spf doctor shows the current config.`);

  // Every malformed `.spf/chains/*.yaml` file (bad YAML, a schema/params
  // mismatch, a name naming a step factory that doesn't exist) becomes a
  // problem here instead of a chain in the list above — loadRepoChains()
  // never throws, so this is the only place an operator finds out their
  // chain file didn't register at all.
  const problems = repoChainProblems();
  if (problems.length > 0) {
    console.log();
    console.log(`${problems.length} repo chain file(s) failed to load — run \`spf doctor\` for detail:`);
    for (const problem of problems) {
      console.log(`  ! ${problem.file}: ${problem.message}`);
    }
  }
  return 0;
}
