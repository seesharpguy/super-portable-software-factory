/** `spf init` — seed a `.spf/` override directory. Everything else is inherited from the packaged defaults. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as paths from "../../core/paths.ts";
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
`;

const GITIGNORE_ENTRIES = [".spf/data/", ".env"];

function ensureGitignore(repoRoot: string): void {
  const gitignorePath = path.join(repoRoot, ".gitignore");
  const hadFile = existsSync(gitignorePath);
  const existing = hadFile ? readFileSync(gitignorePath, "utf-8").split("\n") : [];
  const missing = GITIGNORE_ENTRIES.filter((entry) => !existing.includes(entry));
  if (missing.length === 0) return;
  const body = hadFile ? existing.join("\n").replace(/\n*$/, "\n") + "\n" : "";
  writeFileSync(gitignorePath, `${body}# spf runtime\n${missing.join("\n")}\n`);
  console.log(`updated ${gitignorePath} (added ${missing.join(", ")})`);
}

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

  ensureGitignore(anchor.repo_root);
  console.log(`\nnext: spf doctor   (confirm everything resolves), then spf scout "describe this repo"`);
  return 0;
}
