/**
 * Import this FIRST in any test file that spawns `git`.
 *
 * When the suite runs inside a git hook (lefthook's `pre-push`), git exports
 * GIT_DIR — and sometimes GIT_WORK_TREE/GIT_INDEX_FILE — into every child
 * process, and those beat `cwd` for every git invocation. A test that does
 * `git init` / `git remote add` / `git commit` in a scratch tmpdir then
 * silently operates on the REAL repository being pushed. Observed damage
 * before this guard existed: a stray empty "init" commit landed on the
 * checked-out branch, and `git init` re-initialized the shared `.git`
 * directory as BARE (git treats a target directory named `.git` as a bare
 * repo), breaking `git status` in the main checkout until `core.bare` was
 * flipped back.
 *
 * Deleting the variables at module load — each test file is its own
 * `node --test` process — makes `cwd` authoritative again for the whole
 * file, including git calls made by the code under test.
 */
for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY"]) {
  delete process.env[key];
}
