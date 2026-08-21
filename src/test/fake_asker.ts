/**
 * Shared test double for `cli/ask.ts`'s `Asker` interface — the seam
 * `runInterview` (`cli/interview.ts`) exists to be driven through, the same
 * way `FakeProvider`/`FakeCodeHost` (`watch.test.ts`) stand in for
 * `IssueProvider`/`CodeHostProvider`.
 *
 * Answers are keyed by a SUBSTRING of the question's label, not by call
 * order — `runInterview` asks a different number of questions depending on
 * earlier answers (skip a quality check, skip watch entirely, ...), so a
 * positional queue would silently misalign the moment a test changes one
 * answer. Substring matching keeps each scenario's script self-documenting
 * and immune to that.
 */
import type { Asker, SelectChoice } from "../cli/ask.js";

export interface AskerScript {
  text?: Record<string, string>;
  select?: Record<string, string>;
  confirm?: Record<string, boolean>;
  secret?: Record<string, string>;
  /** Used when a confirm's label matches nothing in `confirm` above. Defaults to the caller's own default. */
  defaultConfirm?: boolean;
}

function firstMatch<T>(map: Record<string, T> | undefined, label: string): T | undefined {
  if (!map) return undefined;
  const key = Object.keys(map).find((k) => label.includes(k));
  return key === undefined ? undefined : map[key];
}

export function createFakeAsker(script: AskerScript): Asker {
  return {
    async text(label, opts) {
      const answer = firstMatch(script.text, label);
      return answer !== undefined ? answer : (opts?.default ?? "");
    },
    async select<T extends string>(label: string, _choices: SelectChoice<T>[], dflt: T): Promise<T> {
      const answer = firstMatch(script.select, label);
      return (answer !== undefined ? answer : dflt) as T;
    },
    async confirm(label, dflt) {
      const answer = firstMatch(script.confirm, label);
      if (answer !== undefined) return answer;
      return script.defaultConfirm ?? dflt;
    },
    async secret(label, _opts) {
      return firstMatch(script.secret, label) ?? "";
    },
    note() {},
    heading() {},
    close() {},
  };
}
