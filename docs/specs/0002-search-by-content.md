# 0002: Search by content

Status: approved
Issue: none (roadmap item 3 in `README.md`, "Semantic search")

## Problem

Search only finds a photo if its words are already written down somewhere: a folder or file name, an album, a tag, or a named person. The owner's ~1,740 photos are mostly in camera folders like `fuji/unsorted/` with names like `DSCF0300.JPG`, so "beach", "snow", "dog", "birthday cake" or "sunset over water" find nothing unless someone has tagged those photos by hand, and nobody will tag thousands of photos. The owner wants to type what is in a photo and see it, on their own machine and without sending photos anywhere.

## User stories

- **US-1** As someone looking for a photo, I want to type what's in it ("beach", "dog", "sunset over water") and see photos that show it, so that I can find photos nobody has tagged.
- **US-2** As someone looking for a photo, I want to combine what's in it with a date, a person or a name I already use ("snow 2026", "jake beach", "poland church"), so that I can narrow down to the one I remember.
- **US-3** As someone searching, I want the best matches first and no unrelated photos padding the results, so that a search I trust is quick to scan and a search with no match says so.
- **US-4** As someone searching, I want everything that search finds today (folder/file names, albums, tags, people, dates) to keep working exactly as well, so that the new search never makes an old search worse.
- **US-5** As a new user, I want to know what the app is doing while it first analyses my photos and how long it will take, and to be able to search what's done so far, so that I'm not left wondering why "beach" finds only some of my beach photos.
- **US-6** As a user adding photos later, I want new photos to become searchable by content after a rescan without the whole library being analysed again, so that keeping the library current is cheap.
- **US-7** As someone with a very large library (100,000+ photos), I want content search to stay fast and analysis to survive quitting the app, so that the feature is usable at that size.
- **US-8** As a privacy-conscious user, I want content analysis to happen entirely on my machine and to be forgotten along with photos I ignore, so that the app keeps its local-only and read-only promises.

## Acceptance criteria

"Content match" below means a photo whose content the app judges similar enough to the content phrase (see AC-2). "Name match" means today's matching of a word against folder/file names, albums, tags or people's names. Automated tests use generated images whose content the model can tell apart reliably (for example solid red vs solid blue images, or images with a large rendered word such as "DOG"), never real photos. The quality criterion (AC-11) is judged by the owner on their own library.

- **AC-1 Finds what's in the photo.** In an analysed library of generated red and blue images with no tags, albums or matching names, "red" shows the red images and not the blue ones; a phrase ("a red square") is matched as a whole. Results are best match first, and paging neither repeats nor skips a photo.
- **AC-2 Honest results.** A photo is a content match only at or above a fixed minimum score for the current model (not dependent on library size); the same query on the same library always gives the same results in the same order. When nothing matches by content or name ("xqzv kjrw", "giraffe" without giraffes), the user sees an empty result saying no photos matched.
- **AC-3 Only present photos, once.** Missing photos and photos in ignored folders never appear; a photo with several copies appears once.
- **AC-4 Combines with dates and people.** A date ("snow 2026", "beach august 2025") filters by capture time and a person's name ("jake beach") filters to photos of that person; content matches for the remaining words are ranked within them. Words used for dates or people aren't part of the content phrase.
- **AC-5 Never worse than today.** With no content phrase left ("jake", "august 2025"), results are exactly today's, in today's order. Otherwise every photo today's search returns is still returned and comes first (e.g. the `12.25.poland` folder for "poland", a "beach" tag for "beach"), followed by further content matches best first.
- **AC-6 Natural phrasing.** Filler words today's search ignores ("show me photos of dogs on the beach") don't stop a match.
- **AC-7 Analysis in the background.** After a scan, analysis starts by itself, newest photos first, while the app stays fully usable. Progress (done of total, with a time estimate) is shown separately from face analysis. Searching during analysis uses the analysed photos and says analysis is still running.
- **AC-8 Analysed once per photo.** Analysis resumes after quitting or a crash without redoing photos; a rescan analyses only new photos. Moving, renaming or copying files, switching to a folder with the same photos, or a missing photo coming back causes no re-analysis; a photo edited in place is analysed again.
- **AC-9 Every format, graceful failures.** HEIC and RAW photos are analysed from their cached preview. An unreadable photo is recorded once, not retried, and doesn't stop analysis. If the content model is missing or fails its checksum, the app says content search is unavailable and how to fix it, and all existing search works as today.
- **AC-10 Model upgrades.** A new model version re-analyses photos (with progress, as a first run), and search never mixes two models' results.
- **AC-11 Good enough to trust.** On the owner's fully analysed library, for at least 8 of 10 evaluation queries ("beach", "snow", "dog", "birthday cake", "sunset over water" and five the owner picks), at least 15 of the first 20 results (or all, if fewer) show what was asked, as judged by the owner. Queries and judgements are recorded in the PR.
- **AC-12 Fast at scale.** Analysis averages ≤ 0.5 s per photo on the owner's Mac. With 100,000 analysed (generated) photos: first page of results within 1 s, later searches within 0.5 s; ≤ 300 MB extra memory, ≤ 2 KB per photo on disk, ≤ 1 s added to start-up; no UI pause over 200 ms during analysis. Measurements recorded in the PR.
- **AC-13 Local and safe.** The running app makes no network requests (works offline, ADR 0003); the photo folder is unchanged against its snapshot and the safety audit passes with no new exceptions (ADR 0001); ignoring a folder forgets its photos' analysis (ADR 0007).
- **AC-14 Upgrade.** Opening a library from the previous version keeps albums, tags, names, faces and settings, then analyses every present photo.

## Non-goals

- **Natural-language questions** that the app interprets, such as "photos of Jake at the beach in Spain last summer" or "what did we do in August?". This spec only splits a query into dates, people and a content phrase with simple rules. A later spec can replace the splitting with a smarter parser (including a local or opt-in language model, RAG over the library) on top of the same per-photo content analysis; nothing here should assume the parser stays rule-based.
- **Automatic categories or suggested tags** ("Beaches", "Food", "Pets" in the sidebar), automatic captions, and grouping photos by content. These reuse the same per-photo analysis later.
- **"More like this"** (find photos similar to a chosen photo), and duplicate/near-duplicate detection by content.
- **Places**: searching by location from GPS (roadmap item 4). Place names in queries are only matched as folder names (today) or by content (whatever the model sees).
- **Queries in languages other than English** (see Decisions).
- **Text in photos (OCR)** as a dedicated feature; the model may pick up some large text, but that's incidental.
- **Explicit query syntax**: quotes, `NOT`, `OR`, field prefixes (`person:`, `tag:`), or a setting to search content only.
- **Tuning by the user**: a strictness slider, per-query thresholds, marking results as wrong or teaching the model.
- **Content search inside other views** (searching within an album, event or person view). Search remains one global view, as today.
- **Cloud models** (the opt-in Claude API captions in roadmap item 5).
- **A separate vector database server or process.** The vector index lives in the library's own SQLite file (see Requirements).
- **Pausing or scheduling analysis** (e.g. only on mains power). See Decisions.

## Requirements the build must meet (not a design)

These aren't screens; they're constraints the design and build must satisfy and that the ACs above test.

**Model**

- Runs locally with the existing onnxruntime-node stack (or something equally free of per-platform native rebuild pain) on macOS, Windows and Linux CPUs, with no GPU required.
- One image encoder and one text encoder that put photos and phrases in the same space (CLIP-style), so a typed phrase can be compared with any analysed photo without re-reading the photo.
- Licence of both the weights and any code we ship permits free and paid commercial distribution, bundled in an installer, without per-user fees or attribution beyond a notices file. "Research only", "non-commercial" or field-of-use licences are out. Training-data provenance is recorded alongside the choice (see Decisions).
- Download size for the content model(s): at most 400 MB, ideally under 250 MB, on top of the 39 MB of face models. Fetched at install, pinned by SHA-256, loaded from disk (ADR 0003), the same way as `scripts/fetch-models.mjs` does for faces.
- Quality good enough to pass AC-11; speed good enough to pass AC-12. Where these conflict, AC-11 wins and AC-12's number is revisited with the owner.
- The model choice is recorded in an ADR, with the candidates compared on licence, size, speed on the reference machine and AC-11 results.

**Stored analysis**

- One result per photo (not per copy), keyed by photo content (ADR 0002), tagged with the model version, kept in the app's data folder (never the photo folder) and removed when the photo is forgotten.
- Stored so that later features (automatic categories, "more like this", natural-language search, RAG) can read every photo's result and search by a phrase without re-analysing photos or depending on the search box.

**Vector search**

- Owner decision: use `sqlite-vec` (a vector index inside the library's SQLite file, verified to load in Electron's `node:sqlite` on macOS, Windows x64 and Linux), behind a small vector-store module so it can be swapped for in-memory brute force (or a later sqlite-vec with approximate indexes) by changing one file. This amends ADR 0005 (loadable extensions are now used): record it in a new ADR with the model choice or alongside it.
- Searches must be able to filter in SQL (present photos, a person, a date range) together with the vector match, which later features (natural-language search, RAG) build on.
- Up to 100,000 photos exact search is fast enough; nothing here should make adding an approximate index a migration of anything but the index itself.

## Safety & privacy

- **Photo folder:** analysis reads each photo once (or its cached preview for formats sharp can't decode), as face analysis already does. Nothing is written there. Everything produced goes in the app's data folder through the existing write path (`appFiles.ts` / the guarded database), and the fs guard and safety audit stay as they are (AC-13).
- **Network:** nothing leaves the machine at runtime (AC-13). The model is downloaded at install time like the face models, pinned by SHA-256. If the packaged product needs a different delivery (bundled in the installer vs downloaded on first launch), see Decisions: first-launch download would conflict with ADR 0003 as written.
- **Personal data:** a numeric summary of each photo's content is stored. It isn't a face embedding and doesn't identify people by itself, but it does describe the user's private photos, so it is treated like faces: forgotten with ignored folders (AC-13) and with forgotten photos, kept for missing photos (AC-8), and never exported or sent anywhere. Search queries are not stored or logged.

## Product

- **Free vs paid tier:** the owner is considering free up to a library size and paid above. This spec builds content search with no gating; AC-12 hold at 100k regardless of tier. Any licence check must work offline (ADR 0003), so it can't be a server check at runtime. See Decisions.
- **English only:** the date words, months and filler words in `src/shared/search.ts` are already English, and most permissively licensed CLIP-style models understand English text best. Queries in other languages will give poor results in this version (see Decisions). Nothing in the stored per-photo analysis should prevent swapping in a multilingual text encoder later; if the image side changes too, AC-10 covers re-analysis.
- **Owner-specific assumptions:** none intended. The evaluation queries in AC-11 come from the owner's library, but thresholds must not be tuned only on it in a way that makes other libraries worse: the threshold in AC-7 is set on a mixed set, and the owner's set is the acceptance check.
- **Placeholder copy:** the search box hint ("Search: “august 2025”, “poland”, “jake”…") should start suggesting content queries once this ships; the design step decides the words.
- **Cost of analysis for users:** at 0.5 s/photo, a 100k library takes about 14 hours of background CPU on first run (resumable, AC-8). That's acceptable for a one-off, but it should be visible up front (AC-7) and is a reason to add a pause control later.

## Design

_Filled in by the design step._

## Open questions

None open; all resolved below. The owner supplies their five evaluation queries for AC-11 when the QA step runs.

## Decisions

- 2026-11-06: Content matches add to today's name matches (name matches first, then content matches best first), so no search gets worse. Two tiers only; the three-tier partial-match ranking is dropped.
- 2026-11-06: Relevance order when there's a content phrase; date order otherwise. A "sort by date" toggle is a possible follow-up.
- 2026-11-06: A word matching a person's name means the person, as today.
- 2026-11-06: One background pass per photo for faces and content, newest first, separate progress counts; no battery handling yet (leave room for pause).
- 2026-11-06: Budgets: ≤ 2 KB/photo on disk, ≤ 300 MB memory at 100k photos; the build may store reduced precision if AC-11 passes.
- 2026-11-06: Models are bundled in the installer for packaged builds (ADR 0003 unchanged); ≤ 400 MB download.
- 2026-11-06: English-only queries in this version.
- 2026-11-06: Licence (commercial use allowed) is a hard requirement; training-data provenance is recorded in the model ADR. Candidates checked so far: OpenAI CLIP ViT-B/32 (MIT, ONNX available), SigLIP (licence to verify), MobileCLIP (custom licence, needs reading); Jina CLIP v2 is excluded (non-commercial).
- 2026-11-06: No free/paid gating in this spec.
- 2026-11-06: Strict "no match" (empty result) in this version.
- 2026-11-06: Owner chose `sqlite-vec` behind a module over brute force (lower memory, SQL filtering, and the owner's goal of exploring vector databases), accepting the pre-1.0 dependency risk.
- 2026-11-06: Spec trimmed from 39 to 14 acceptance criteria at the owner's request.
