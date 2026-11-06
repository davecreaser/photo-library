# Photo Library

Electron desktop app that organises a folder of camera photos without ever changing it. Vocabulary: `CONTEXT.md`. Why things are the way they are: `docs/adr/`.

## Hard rule: never touch the user's photos

The photo folder is **read-only** (ADR 0001): nothing under it is ever written, moved, renamed, modified or deleted, including EXIF and sidecar files. Everything the app produces goes in `app.getPath('userData')`; "delete" in the UI only ever removes the app's own records. The protection is layered; keep every layer intact:

1. `fsGuard.ts`, installed first thing in `index.ts`, wraps every Node fs write/delete function process-wide. It refuses targets inside any photo folder ever chosen (`protectedRoots` setting) or outside the app data/temp folders, and fails closed.
2. `appFiles.ts` is the only module that writes or deletes, and checks `assertWritable` itself. External tools (`sips`) only ever get a copy in app temp.
3. `test/safety.test.ts` audits `src/` (no `child_process`, no fs write imports, no `trashItem`, no sharp `.toFile` outside those two files) and attacks a protected folder with every fs write/delete API.
4. SQLite writes natively, so its path is checked with `assertWritable` before opening.
5. A photo folder that overlaps the app data folder is refused.

Tests that touch a photo folder snapshot it before and after (excluding `.DS_Store`, which Finder rewrites); keep those assertions.

## Data model

- A photo is its content (`photos.hash`, ADR 0002); `files` holds its copies. Everything the user organises attaches to the photo.
- `taken_at_raw` is the recorded time, `taken_at` the capture time after `clock_corrections` (matched on camera + raw time, so they never stack). `present` and `taken_at` are derived: `refreshDerived()` after scans and correction changes.
- Events (`events.ts`), clock suggestions (`dates.ts`) and folder-name heuristics (`folders.ts`) are computed, not stored; `organiser.ts` caches them. User merges/renames are `event_groups`: member event ids plus a date span that absorbs date-only events.
- Favourites are only the user's stars. Folder names like `best/` mean nothing (the owner's feedback).
- Ignored folders: `ignoredFolders` setting (default `["private"]`), rules in `ignore.ts`. Newly ignored photos are forgotten entirely (ADR 0007).
- Faces: `faces.ts` (YuNet + SFace via onnxruntime; models in `resources/models`, fetched at install, SHA-256 pinned), `faceGroups.ts`, `people.ts`. `assigned_by='user'` faces define a person; `regroup()` recomputes `'auto'` matches and unnamed groups, respecting `face_rejections`. Thresholds err towards splitting (ADR 0006). Bump `FACE_MODEL_VERSION` to re-analyse.
- Schema changes bump `SCHEMA_VERSION` in `db.ts` with a migration that keeps albums, tags, names and settings, plus a test.

## Conventions

- `node:sqlite`, not a native SQLite module (ADR 0005). Nothing uses the network at runtime (ADR 0003).
- Imports use explicit `.ts` extensions so `node --test` can run main-process code directly; avoid TS syntax type-stripping can't handle (enums, parameter properties, namespaces).
- Cross-platform: CI runs macOS, Windows and Linux. Split paths on both separators, compare paths with `path.relative`, and give every macOS-only tool a fallback.
- Tests use generated photos only (`e2e/library.ts`, test helpers); never real ones. Move/copy files "as the user" with `test/helpers.ts`, which runs outside the guard.
- Check: `npm run typecheck && npm test && npm run e2e`.

## Workflow

New features go through `/feature` (`.claude/skills/feature/`): spec (`docs/specs/`, product agent) → design (designer agent) → build → review (reviewer agent) → QA (qa agent) → PR. The user approves the spec and design, and merges PRs. Agents push feature branches only; `.claude/hooks/block-dangerous-git.sh` blocks pushes to main, force-pushes and merges.
