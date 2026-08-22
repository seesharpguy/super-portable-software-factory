import { CHAINS } from "../../chains/index.ts";

export function listCommand(): number {
  const width = Math.max(...CHAINS.map((c) => c.name.length));
  for (const chain of CHAINS) {
    const agents = typeof chain.requiredAgents === "function" ? "(--agent picks who)" : chain.requiredAgents.join(", ") || "(none)";
    const suites = typeof chain.requiredSuites === "function" ? chain.requiredSuites({}) : chain.requiredSuites;
    const suiteNote = typeof chain.requiredSuites === "function" ? " (--suite overrides)" : "";
    console.log(`${chain.name.padEnd(width)}  ${chain.phases}`);
    console.log(`${"".padEnd(width)}  ${chain.describe}`);
    console.log(`${"".padEnd(width)}  agents: ${agents}${suites.length ? `  ·  quality suites: ${suites.join(", ")}${suiteNote}` : ""}`);
    console.log();
  }
  console.log(`spf <name> "<prompt>" [--config <path>] [--adw-id <id>] [--cwd <dir>] [--suite <name>]   (spf run <name> ... works identically)`);
  console.log(`spf watch polls a tracker and runs one of these chains per issue — spf doctor shows the current config.`);
  return 0;
}
