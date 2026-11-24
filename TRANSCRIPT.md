# Transcript — mend v3 (make.fun `hidden-spec-cli-01-run-20261122`)

Built 2026-11-24, from the competition kit's `SPEC.md` (sections 5–8
implemented here; sections 1–4, 9, 10 and the runner come from the starter).
`main.ts` is an own implementation, written fresh from the spec.

## Anchor

```
makefun anchor 2964a48987afcaf3f1e1c5426537b7c9f9690b90 round 34234913
```

## What v3 fixes vs v2

- `/dev/null` in a unified `--- `/`+++ ` header is now a missing file, not a
  literal path — v2 failed creation/deletion sections with
  `error: unsafe /dev/null` (2 of the 100 public practice checks).
- Format detection follows SPEC §4 exactly (first non-blank line for v4a/json;
  any line for SEARCH / `diff --git` / `--- `+`+++ `), so prose before a patch
  and indented first lines are detected correctly.
- Unified `\\` handling follows SPEC §6 precisely: a `\\` line removes the
  final break only when it follows the hunk's last context or `+` line, not
  when it follows a `-` line.
- V4A end-of-file chunks: the tier is fixed by the EOF-ending occurrences
  alone (SPEC §8: "an end-of-file chunk takes only an occurrence that ends at
  the file's last line"), so a lower-tier non-final match does not block a
  higher-tier final one.
- Both-`/dev/null` unified section is reported as `error: unsafe ` (empty
  path) instead of crashing.
- V4A Add sections treat a whitespace-only middle line as a parse error (the
  spec's "empty" line is literally empty); trailing blank lines at the end of
  a section are dropped.
- Search-replace: a `>>>>>>> REPLACE` line before the `=======` is read as part
  of the old lines (the spec only requires `=======` then `>>>>>>> REPLACE`
  after the SEARCH line).

## Verification

- Public practice set: **100 of 100 passed, practice score 1000**.
- 56 extra edge-case tests written for this version (unified hunks before any
  section, malformed `@@`, `--- ` without `+++ `, nearest-occurrence ties,
  empty-O insertions, move chains, R-line sorting by new path, CRLF files,
  `--strict` rejections, V4A parse lines, detection rules, usage errors,
  exit-1 atomicity, JSON fault lines, overlapping `str_replace` counts):
  **56 passed, 0 failed** (`/tmp/mend-edge3.mjs`, not part of the entry).
