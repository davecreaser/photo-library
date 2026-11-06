# Content vectors live in the library database and are compared with sqlite-vec

Search by content (spec 0002) compares a phrase's vector with every analysed photo's. The vectors live in the library's own SQLite file, in a plain table (`content_vectors`: one row per photo, int8, 768 bytes), and are compared exactly in SQL with **sqlite-vec**'s `vec_distance_cosine`, so a search filters by present photos, people and dates in the same query. This is the first loadable extension the app uses, which amends ADR 0005: `node:sqlite` opens the library with `allowExtension: true`, `vectorStore.ts` loads sqlite-vec (npm `sqlite-vec` 0.1.9, prebuilt for macOS x64/arm64, Linux x64/arm64 and Windows x64) and then switches extension loading off again, so no SQL can load anything else. The owner chose sqlite-vec over an in-memory brute force (lower memory, filtering in SQL, and a step towards approximate indexes), accepting a pre-1.0 dependency.

We measured sqlite-vec's own `vec0` virtual table and didn't use it (yet): scanning 100,000 int8 vectors with filters took ~525 ms through `vec0` against ~105 ms from a plain table, a virtual table can't take part in foreign-key cascades (so forgetting photos would need its own clean-up everywhere), and its nearest-neighbour query returns a fixed number of results, where search needs every photo above a threshold. Exact search is fast enough at 100,000 photos (spec 0002, AC-12).

Vectors are stored as int8 (each scaled so its largest component is ±127) rather than 3 KB of float32, to stay within 2 KB a photo. On COCO val2017 with the app's pipeline this costs almost nothing: text→image recall@1 66.9% against 67.1% at full precision, and 96.5% of each top 20 unchanged over 633 queries (`scripts/model-eval/calibrate.mjs`).

## Consequences

- `vectorStore.ts` is the only code that knows how vectors are stored and compared. Swapping in a brute force or an approximate `vec0` index changes that file (an index is a migration of the index only; `content_vectors` stays the record of each photo's analysis).
- The database is still opened only after `assertWritable` checks its path; sqlite-vec reads and writes nothing but the database.
- If sqlite-vec can't load (an unsupported platform, a broken install), content search says it is unavailable and everything else works as before.
- A packaged build must ship the platform's sqlite-vec library outside the app archive (e.g. electron-builder `asarUnpack`), since SQLite loads it from a real path.
