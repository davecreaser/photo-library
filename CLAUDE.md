# Photo Library

Personal Electron app that indexes a folder of camera photos and organises them virtually.

## Hard rule: never touch the user's photos

- The photo folder is **read-only**. Never write, move, rename, modify or delete anything under it, including sidecar files and EXIF. Corrections (e.g. wrong camera clock) are stored in the DB and applied virtually.
- Safety is layered. Don't weaken any layer:
  1. `fsGuard.ts`, installed first thing in `index.ts`, wraps every Node fs write/delete function process-wide. It refuses targets inside any photo folder ever chosen (`protectedRoots` setting) or outside the app data/temp folders. It fails closed: no guard, no writes.
  2. `appFiles.ts` is the only module allowed to write/delete, and it calls `assertWritable` itself. `sips` only ever gets a copy of the photo in app temp.
  3. `test/safety.test.ts` audits all of `src/` (no `child_process`, no `fs` write imports, no `trashItem`, no sharp `.toFile` outside the two files above) and attacks a protected folder with every fs write/delete API.
  4. SQLite writes natively, so its path is checked with `assertWritable` before opening.
  5. Choosing a photo folder that overlaps the app data folder is refused.
- Photos are read via `photoFs.ts`, `metadata.ts` (exifr) and `thumbnails.ts` (sharp `.toBuffer()` only).
- Everything the app produces (DB, thumbnails, previews, future face/embedding data) goes in `app.getPath('userData')`.
- "Delete" in the UI only ever deletes virtual records (albums, tags, album membership).
- Ignored folders are user-configurable (`ignoredFolders` setting, default `["private"]`, rules in `ignore.ts`). A rule without "/" is a folder name matched at any depth; with "/" it's a path from the base folder. Both are case-insensitive and only look below the base (macOS has its own `/private`). Photos already indexed from a newly ignored folder are forgotten on the next scan: rows, faces, names, tags, cached thumbnails and face crops. Files are untouched.
- When comparing the photo folder before/after, exclude `.DS_Store`: Finder rewrites it when you browse a folder, and the app never reads dotfiles.
- `test/scanner.test.ts` snapshots the photo folder before/after; keep that assertion when changing scanning.

## Data model

- A **photo is its content** (`photos.hash` = SHA-256 of the file). `files` holds its locations. Albums, tags and favourites attach to the photo, so moves, renames, copies and a new base folder keep them. Identical copies are one photo.
- Dates: `taken_at_raw` (what the camera recorded, `null` if none) and `taken_at` (after `clock_corrections`, which is what's shown and searched). Corrections match on camera + raw time, so they never stack.
- Derived columns (`present`, `auto_favorite`, `taken_at`) are recomputed by `refreshDerived()` after scans and correction changes.
- Events (`events.ts`) and clock suggestions (`dates.ts`) are computed, not stored. `organiser.ts` caches them. Folder-name heuristics live in `folders.ts`.
- Favourites are only the user's stars (`photos.favorite`). Folder names like `best/`/`insta/` deliberately mean nothing (user feedback).
- Event merges/renames are `event_groups` rows: member event ids plus a date span. A date-only event inside the span joins the group; folder-named events only join by id.
- Faces (`faces.ts`): YuNet detection (whole image + overlapping 640px tiles at 1280px), 5-landmark alignment to 112×112, SFace 128-d embeddings. Models live in `resources/models` and are fetched at install by `scripts/fetch-models.mjs` (SHA-256 pinned); the app itself never uses the network. `faces` rows hang off the photo (content), so they survive moves. Bump `FACE_MODEL_VERSION` to re-analyse.
- People (`people.ts`, `faceGroups.ts`): `assigned_by='user'` faces define a person; `regroup()` auto-matches other faces (`'auto'`, recomputed every time, `face_rejections` respected) and clusters the rest into unnamed groups. Thresholds err towards splitting. Naming two groups the same name merges them.
- Schema changes bump `SCHEMA_VERSION` in `db.ts` with a migration that preserves albums, tags and settings (see the v1→v2 test).

## Layout

- `src/main/`: Electron main process: `db.ts` (node:sqlite, schema, queries), `scanner.ts` (incremental indexing), `metadata.ts` (EXIF), `thumbnails.ts` (cache, sharp → sips → embedded preview), `index.ts` (window, IPC, `photo://` protocol).
- `src/preload/`: typed `window.api` bridge; the IPC contract is the `Api` interface in `src/shared/types.ts`.
- `src/shared/search.ts`: free-text query parser (pure, unit-tested).
- `src/renderer/`: React UI.

## Conventions

- Use the built-in `node:sqlite` (no native SQLite module, no electron-rebuild).
- Imports use explicit `.ts` extensions so `node --test --experimental-strip-types` can run main-process code directly. Avoid TS-only syntax that type stripping can't handle (enums, parameter properties, namespaces).
- Strictly local: no network calls with photo data. Cloud AI would be an explicit opt-in feature.
- Check: `npm run typecheck && npm test && npm run build`.
