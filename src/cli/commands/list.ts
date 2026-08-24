import path from "node:path";
import { allChains, repoChainProblems } from "../../chains/index.ts";
import { isInteractive } from "../ask.ts";

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

export async function listCommand(): Promise<number> {
  // Built-ins first, then repo chains — same order `allChains()` guarantees,
  // so this listing and `findChain`'s resolution order never disagree about
  // which chain wins on a name collision.
  const chains = allChains();
  const width = Math.max(...chains.map((c) => c.name.length));
  const entries = chains.map((chain) => {
    const agents = typeof chain.requiredAgents === "function" ? "(--agent picks who)" : chain.requiredAgents.join(", ") || "(none)";
    const suites = typeof chain.requiredSuites === "function" ? chain.requiredSuites({}) : chain.requiredSuites;
    const suiteNote = typeof chain.requiredSuites === "function" ? " (--suite overrides)" : "";
    return {
      name: chain.name,
      phases: chain.phases,
      describe: chain.describe,
      agentsLine: `agents: ${agents}${suites.length ? `  ·  quality suites: ${suites.join(", ")}${suiteNote}` : ""}`,
      // `source` is undefined for every built-in — only a chain loaded from a
      // `.spf/chains/*.yaml` file carries one (see chains/repo_chains.ts).
      repoLabel: chain.source ? repoChainLabel(chain.source) : undefined,
    };
  });

  const usageLines = [
    `spf <name> "<prompt>" [--config <path>] [--adw-id <id>] [--cwd <dir>] [--suite <name>]   (spf run <name> ... works identically)`,
    `spf watch polls a tracker and runs one of these chains per issue — spf doctor shows the current config.`,
  ];

  if (isInteractive()) {
    const { renderChainList } = await import("../ui/reports.tsx");
    await renderChainList(entries, usageLines);
  } else {
    for (const entry of entries) {
      console.log(`${entry.name.padEnd(width)}  ${entry.phases}`);
      console.log(`${"".padEnd(width)}  ${entry.describe}`);
      console.log(`${"".padEnd(width)}  ${entry.agentsLine}`);
      if (entry.repoLabel) console.log(`${"".padEnd(width)}  (repo: ${entry.repoLabel})`);
      console.log();
    }
    for (const line of usageLines) console.log(line);
  }

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
