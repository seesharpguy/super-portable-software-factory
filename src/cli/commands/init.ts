/** `spf init` — seed a `.spf/` override directory. Everything else is inherited from the packaged defaults. */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as paths from "../../core/paths.ts";
import { ensureGitignore } from "../gitignore.ts";
import { parseCli } from "../../core/utils.ts";

const STARTER_CONFIG = `# .spf/spf.config.yaml — merged ON TOP of spf's packaged built-in defaults.
# List only what you want to CHANGE; everything else (the roster, prompts,
# models) is inherited. Run \`spf doctor\` any time to see what's actually in
# effect for this repo, and where each value came from.

# Uncomment to enable a quality-gated chain (build-test, plan-build-test,
# plan-build-test-quality, quality, simple-sdlc) — an unconfigured suite
# fails loudly before anything runs, on purpose, rather than reporting a
# placeholder green.
# quality:
#   checks:
#     - {name: test, operation: build, argv: ["npm", "test"], timeout_seconds: 600}
#   suites:
#     test: [test]
#     all: [test]

# agents:
#   - name: builder
#     model: anthropic/claude-sonnet-4-6
#     coding_agent: claude_code   # run this agent on Claude Code instead of Flue
#     model: sonnet               # claude_code's own alias, NOT provider/model-id

# Uncomment to enable \`spf watch\` — polls GitHub issues labeled
# <label_prefix>:ready and runs \`chain\` against each in its own worktree.
# Needs a GITHUB_TOKEN env var (classic PAT, repo scope) — \`spf doctor\` checks.
# watch:
#   repo: owner/name
#   label_prefix: spf
#   chain: plan-build-test
#   base_branch: main
`;

// .spf/spf.config.yaml and .spf/prompt_engineering/ stay tracked — they're
// shared project config, same as package.json. Only runtime/generated
// content is ignored: session traces (data/), a hand-editable engine copy
// (engine/, from `spf eject`), and secrets (.env).
const GITIGNORE_ENTRIES = [".spf/data/", ".spf/engine/", ".env"];

export function initCommand(argv: string[]): number {
  const { options, flags } = parseCli(argv, ["cwd"], ["force"]);
  const anchor = paths.resolveAnchor(options["cwd"]);
  const sfDir = path.join(anchor.repo_root, ".spf");
  mkdirSync(sfDir, { recursive: true });

  const configPath = path.join(sfDir, "spf.config.yaml");
  if (existsSync(configPath) && !flags["force"]) {
    console.log(`${configPath} already exists — leaving it alone (--force to overwrite)`);
  } else {
    writeFileSync(configPath, STARTER_CONFIG);
    console.log(`wrote ${configPath}`);
  }

  ensureGitignore(anchor.repo_root, GITIGNORE_ENTRIES);
  console.log(`\nnext: spf doctor   (confirm everything resolves), then spf scout "describe this repo"`);
  return 0;
}
