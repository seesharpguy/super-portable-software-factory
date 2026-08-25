/**
 * Regression tests for `spf.config.yaml`'s `env:` block — a declarative,
 * committable alternative to an out-of-band shell export for non-secret
 * settings like `SPF_CLAUDE_CMD` (see `SFConfigSchema`'s doc comment in
 * `data_types.ts` and `agents.ts`'s `applyConfigEnv`/`interpolateEnvValue`).
 * `env: config merges into `SFConfig` (loadConfig's own merge behavior) is
 * covered separately in `data_types.test.ts` — this file is specifically
 * about applying that map to `process.env`: precedence against an
 * already-set var, `${VAR}` interpolation, and the fail-loud contract for a
 * reference to something genuinely unset.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { applyConfigEnv, interpolateEnvValue } from "../core/agents.js";

const PROBE_KEYS = ["SPF_TEST_ENV_A", "SPF_TEST_ENV_B", "SPF_TEST_ENV_SECRET", "SPF_TEST_ENV_UNDEFINED"];

/** Saves/restores a set of process.env keys around a test — this module mutates real global state. */
function withEnv(fn: () => void): void {
  const saved = new Map(PROBE_KEYS.map((k) => [k, process.env[k]]));
  try {
    fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("applyConfigEnv: a key not already in process.env gets set from cfg.env", () => {
  withEnv(() => {
    delete process.env.SPF_TEST_ENV_A;
    applyConfigEnv({ SPF_TEST_ENV_A: "from-config" });
    assert.equal(process.env.SPF_TEST_ENV_A, "from-config");
  });
});

test("applyConfigEnv: an already-set process.env value wins — cfg.env supplies a default, never forces an override", () => {
  withEnv(() => {
    process.env.SPF_TEST_ENV_A = "from-shell";
    applyConfigEnv({ SPF_TEST_ENV_A: "from-config" });
    assert.equal(process.env.SPF_TEST_ENV_A, "from-shell", "matches process.loadEnvFile()'s own precedence for .env");
  });
});

test("applyConfigEnv: ${VAR} interpolates from process.env at call time — a real secret can live in .env and be referenced without being written into spf.config.yaml", () => {
  withEnv(() => {
    delete process.env.SPF_TEST_ENV_B;
    process.env.SPF_TEST_ENV_SECRET = "sekrit-value";
    applyConfigEnv({ SPF_TEST_ENV_B: "prefix-${SPF_TEST_ENV_SECRET}-suffix" });
    assert.equal(process.env.SPF_TEST_ENV_B, "prefix-sekrit-value-suffix");
  });
});

test("applyConfigEnv: multiple entries apply independently, each against its own precedence check", () => {
  withEnv(() => {
    process.env.SPF_TEST_ENV_A = "already-set";
    delete process.env.SPF_TEST_ENV_B;
    applyConfigEnv({ SPF_TEST_ENV_A: "ignored", SPF_TEST_ENV_B: "applied" });
    assert.equal(process.env.SPF_TEST_ENV_A, "already-set");
    assert.equal(process.env.SPF_TEST_ENV_B, "applied");
  });
});

test("interpolateEnvValue: a plain value with no ${...} passes through untouched", () => {
  assert.equal(interpolateEnvValue("SPF_CLAUDE_CMD", "ollama launch claude --model {model}"), "ollama launch claude --model {model}");
});

test("interpolateEnvValue: an undefined ${VAR} reference throws, naming both the config key and the missing var — fail loud, not a silent empty string", () => {
  withEnv(() => {
    delete process.env.SPF_TEST_ENV_UNDEFINED;
    assert.throws(
      () => interpolateEnvValue("SOME_KEY", "${SPF_TEST_ENV_UNDEFINED}"),
      /env\.SOME_KEY: references \$\{SPF_TEST_ENV_UNDEFINED\}, which is not set/,
    );
  });
});

test("applyConfigEnv: an undefined ${VAR} reference throws even when applying (not silently skipped or emptied)", () => {
  withEnv(() => {
    delete process.env.SPF_TEST_ENV_A;
    delete process.env.SPF_TEST_ENV_UNDEFINED;
    assert.throws(() => applyConfigEnv({ SPF_TEST_ENV_A: "${SPF_TEST_ENV_UNDEFINED}" }));
    assert.equal(process.env.SPF_TEST_ENV_A, undefined, "the throwing key is never partially applied");
  });
});
