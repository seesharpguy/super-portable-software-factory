import { CHAINS } from "../../chains/index.ts";

export function listCommand(): number {
  const width = Math.max(...CHAINS.map((c) => c.name.length));
  for (const chain of CHAINS) {
    const agents = typeof chain.requiredAgents === "function" ? "(--agent picks who)" : chain.requiredAgents.join(", ") || "(none)";
    console.log(`${chain.name.padEnd(width)}  ${chain.phases}`);
    console.log(`${"".padEnd(width)}  ${chain.describe}`);
    console.log(`${"".padEnd(width)}  agents: ${agents}${chain.requiredSuites.length ? `  ·  quality suites: ${chain.requiredSuites.join(", ")}` : ""}`);
    console.log();
  }
  console.log(`spf <name> "<prompt>" [--config <path>] [--adw-id <id>] [--cwd <dir>]   (spf run <name> ... works identically)`);
  console.log(`spf watch polls a tracker and runs one of these chains per issue — spf doctor shows the current config.`);
  return 0;
}
