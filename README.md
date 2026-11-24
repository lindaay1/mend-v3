# mend

One patch tool for every AI edit format. Applies a patch to the files in the
current directory and reports what changed.

## Usage

```
mend [--format=auto|unified|search-replace|v4a|json] [--check] [--strict] [PATCH]
```

`PATCH` is a file, or `-` / omitted for standard input.

- `--format` — read the patch in one format (`auto`, the default, detects it).
- `--check` — do everything but write: same output and exit code, no file is
  created, changed or deleted.
- `--strict` — match lines exactly (tier 0 only).

Exit 0: the changed paths, in UTF-8 byte order, one per line
(`A <path>` added, `D <path>` deleted, `M <path>` changed,
`R <old> -> <new>` moved), then `ok: <n> file(s)`.
Exit 1: one `error: <code> <path>` line per failed edit, then
`failed: <k> of <n> edits`; nothing is written.
Exit 2: a single `error: usage`, `error: no-patch`, `error: format` or
`error: parse <N>` line.

## Formats

- **unified** — `diff --git` sections with `--- `/`+++ ` headers and `@@` hunks.
  Nearest-occurrence hunks with a running length delta, creations, deletions
  and moves (`rename from`/`rename to`).
- **search-replace** — `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE` blocks
  with a path line above each block.
- **v4a** — `*** Begin Patch` / `*** Add File:` / `*** Delete File:` /
  `*** Update File:` sections, `@@` anchors, `*** End of File` chunks and
  `*** Move to:`.
- **json** — one JSON array of edit objects, or JSON Lines: `create`,
  `str_replace`, `insert`.

## Matching

Old lines are found at the first of three tiers where they occur: exact,
trailing whitespace ignored, then leading and trailing whitespace ignored.
At tier 2, new lines are re-indented to the file's indentation. `--strict`
tries tier 0 only.

## Running

Node 22+, standard library only:

```
node main.ts --help        # (no help flag; see above)
node main.ts patch.diff
cat patch.diff | node main.ts
```

`runner.ts` is the trial harness used by the competition kit; it runs
`main.ts` against a set of checks served over HTTP (`MAKEFUN_ENV_URL`).

## License

MIT. See `LICENSE`.
