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

Content search adds no new screen. It lives in the existing search box, the search view's results grid and the top bar's status area. Everything below reuses existing patterns: the top bar's scan status (`.scan-status`), the grid meta line (`.grid-meta`), `.hint`, `.empty`, `.error` and the People view's section headings (`.people h2`). Curly quotes (“ ”) and the ellipsis character (…) are used as in the rest of the app.

### Terms used here

- **Content phrase**: what's left of the query after dates, people's names and filler words are taken out (see AC-4, AC-6). The UI shows it in quotes so the user can see what was searched for by content. Examples: "jake beach august 2025" gives “beach”; "show me photos of dogs on the beach" gives “dogs beach” (or whatever the build's phrase rules leave).
- **Name matches**: what search finds today (folder/file names, albums, tags, people). **Content matches**: photos that look like the content phrase.

### Where it lives

- **Search box** (top bar), as today. Typing still debounces by 250 ms into the search view, and clearing the box still returns to All photos.
- **Search view** (`view.kind === 'search'`): title `“{query}”` as today, then the meta line, an optional hint line, and the grid.
- **Top bar status** (`.scan-status`, left of Rescan): shows content-analysis progress, and a quiet "unavailable" note.
- Face analysis stays where it is: the percentage on the sidebar's People item and the hint at the top of the People view. The two analyses are never shown in the same place, so their counts never get confused (AC-7).

### Search box placeholder

- Content search available, or still analysing: `Search: “sunset over water”, “jake 2025”, “poland”…`
  (one content query, a person plus a date, a folder name)
- Content search unavailable (AC-9): today's placeholder, unchanged: `Search: “august 2025”, “poland”, “jake”…`

### Results: one list, name matches first

One grid, in one order: name matches first (today's order), then content matches, best match first (decided in the spec). When **both** groups have photos, a full-width divider row sits in the grid just before the first content match:

- Divider label: `Looks like “{content phrase}”`
- Style: a grid row spanning every column (`grid-column: 1 / -1`), styled like `.people h2` but muted and 12px, with a hairline in `var(--border)` above it and 10px of space either side. It isn't a tile: it can't be clicked or selected, and shift-click ranges pass over it (selection indices only count tiles).
- With paging (300 a page), the divider shows once, at the position of the first content match, on whichever page it falls. The grid needs a count of name matches from the query to place it.

No divider when there are only name matches or only content matches; the meta line says which.

No label on the name-matches group: it comes first, it's what search has always shown, and the meta line already says "by name".

### Grid meta line (search view only)

Today's line is `{N} photos · ⌘-click or shift-click to select` (or `· {n} selected`). In the search view:

| Situation                                           | Meta line                                                                        |
| --------------------------------------------------- | -------------------------------------------------------------------------------- |
| No content phrase (e.g. "jake", "august 2025")      | Unchanged: `{N} photos · ⌘-click or shift-click to select` (AC-5)                |
| Name and content matches                            | `{N} photos · {a} by name, then {b} that look like “{phrase}”, best match first` |
| Content matches only                                | `{N} photos that look like “{phrase}” · best match first`                        |
| Name matches only, content phrase found nothing     | `{N} photos by name · none look like “{phrase}”`                                 |
| Any of the above with a selection                   | the part after the first `·` is kept and `· {n} selected` is added at the end    |
| Loading a new search (until the first page arrives) | `Searching…`                                                                     |

Counts use `toLocaleString()` and "photo"/"photos" agrees with the number (`1 photo`). "Best match first" is the hint that results are ranked by relevance, not by date; no scores or badges are shown on tiles. Tile tooltips stay `{fileName} · {date}`.

While a new search loads, the previous results stay in place (as today) and the meta line reads `Searching…`, so the first content search after launch, which may take up to a second while the text model loads, doesn't look stuck.

### Hint line under the meta line (search view, only when there's a content phrase)

Shown as a `.hint` paragraph between the meta line and the grid. At most one at a time:

- **Analysis still running (AC-7):**
  `Still analysing your photos: {done} of {total} done, {estimate}. Photos not analysed yet can only be found by name.` followed by a link-style button `Refresh results`.
  When analysis finishes while the user is on the results, the hint changes to:
  `All photos are now analysed.` followed by `Refresh results`.
  Results never reorder by themselves while the user is looking at them; `Refresh results` re-runs the same query and scrolls to the top. The hint disappears after a refresh once analysis is done.
- **Re-analysing for a new model version (AC-10):** same as above but starting `Updating search for a new version: {done} of {total} done, {estimate}.` Search only uses photos the new version has analysed, so this is the same state as a first run.
- **Content search unavailable (AC-9):** `.hint` with the first sentence in `var(--danger)`:
  `Content search is unavailable: {reason} {fix}` then `Names, albums, tags, people and dates are still searched.`
  - `{reason}`: `its model file is missing.` or `its model file is damaged (checksum didn't match).`
  - `{fix}`, packaged app: `Reinstall Photo Library to fix this.`; development build: `Run “npm run fetch-models”, then restart the app.`

When the query has no content phrase (AC-5 case), no hint is shown, even during analysis or when unavailable: the results are exactly today's, so there's nothing to warn about.

### Empty result (AC-2)

Uses `.empty`, replacing today's `No photos here yet.` in the search view only:

- Normal: `No photos matched “{query}”.`
  second line (`.hint`): `Search looks at what’s in your photos, and at folder and file names, albums, tags, people and dates. Try different or fewer words.`
- While analysis is running: `No photos matched “{query}” yet.`
  second line: `{done} of {total} photos are analysed so far; more may match when analysis finishes ({estimate}).`
- Content search unavailable: `No photos matched “{query}”.`
  second line: `Content search is unavailable, so only names, albums, tags, people and dates were searched.`

No near-misses or "closest results" are shown: strict no-match was decided in the spec.

### Top bar status (`.scan-status`)

Order of precedence, highest first (only one shows):

1. Scanning (today's): `Reading new photos… {indexed} / {found}` or `Checking… …`
2. Scan failed (today's): `Scan failed: {error}`
3. **Content analysis running:** `Analysing photos for search… {done} / {total} · {estimate}`
   Model upgrade: `Updating search… {done} / {total} · {estimate}`
   Tooltip (`title`): `Photo Library is learning what’s in each photo, on this computer, so you can search for things like “beach” or “dog”. Each photo is analysed once; you can keep using the app, and search uses the photos done so far.`
4. After a scan (today's): `{n} new, {m} moved/copied · {N} photos`
5. **Content search unavailable:** `{N} photos · content search unavailable` (the second part in `.error`), tooltip: the same `{reason} {fix}` text as the search hint.
6. Idle (today's): `{N} photos`

Analysis starts right after a scan, so state 3 replaces the "N new" summary while it runs. For a rescan that adds a few photos this lasts seconds (`Analysing photos for search… 3 / 12 · less than a minute left`).

The first run's estimate is shown as soon as analysis starts, so a large library sees "about 14 h left" up front (Product section).

### Time estimate copy (`{estimate}`)

Based on the average rate over the last ~2 minutes of analysis (or since it started, if less):

- Until 20 photos or 15 seconds have been done: `estimating time…`
- Under 1 minute: `less than a minute left`
- 1 to 59 minutes: `about {m} min left` (rounded up)
- 1 hour or more: `about {h} h left` (rounded to the nearest hour, minimum 1)

In the empty-state sentence the bracketed form drops "left": `(about 4 min)`, `(less than a minute)`, or the bracket is omitted while estimating.

### Interactions

- Typing, debounce, clearing and leaving search work as today. Every view change clears the search, as today.
- Clicking a tile opens the viewer on the results in the shown order; ←/→ move through name matches then content matches, as listed (the divider isn't a stop).
- ⌘/Ctrl-click and shift-click select as today, across the divider. The selection bar (albums, tags) works unchanged, so a content search is a quick way to tag photos ("beach" → select → tag _beach_), after which they become name matches.
- `Refresh results` (link-style `button.link`, as in the sidebar footer) re-runs the current query.
- No undo is needed: nothing here changes data.

### States per screen

**Search view**

- Loading: previous results stay, meta `Searching…`.
- Populated: meta line per the table; divider when both groups exist.
- Empty: `.empty` copy above.
- Analysis running: hint line with `Refresh results`; results use analysed photos only.
- Unavailable: hint line in danger colour; name search works as today.
- Very large library (100k): same states; paging adds 300 at a time as today, counts are exact, the divider appears once. A 14 h first run reads `about 14 h left`.

**Top bar**: states 1–6 above.

**People view / sidebar**: unchanged; face progress stays separate.

**Viewer, albums, tags, events, timeline**: unchanged; content search isn't offered inside other views (non-goal).

### What the grid needs from a search query (for the build)

Not an API design, just the facts the UI shows: total count, count of name matches (to place the divider), the content phrase (or none), and content-analysis state (`analysing` / `idle` / `unavailable` with done, total, estimate and reason). Progress arrives like `onFaceProgress`, as its own event.

### Traceability

- **AC-1** Finds what's in the photo: content-only meta line `{N} photos that look like “red” · best match first`; grid in relevance order; paging as today (no visual repeat/skip). Repeat/skip tested by query paging tests.
- **AC-2** Honest results: empty state `No photos matched “{query}”.` with its hint; threshold and stable ordering have no UI, tested by query tests on generated images.
- **AC-3** Only present photos, once: no UI; tested by query tests (missing, ignored, multiple copies).
- **AC-4** Combines with dates and people: title shows the full query; meta line quotes only the content phrase (`look like “beach”` for "jake beach august 2025"), showing date/person words aren't in it; filtering tested by query tests.
- **AC-5** Never worse than today: no-content-phrase meta line and grid unchanged, no hint; name matches first, then divider `Looks like “…”`, then content matches; meta `{a} by name, then {b} that look like …`.
- **AC-6** Natural phrasing: meta line's quoted phrase shows the filler words gone; tested by parser tests.
- **AC-7** Analysis in the background: top bar `Analysing photos for search… {done} / {total} · {estimate}`, separate from People's face percentage; search hint `Still analysing your photos: …` with `Refresh results`; empty-state `… yet.` variant. Newest-first order and responsiveness tested by analysis tests and AC-12 measurements.
- **AC-8** Analysed once per photo: no UI beyond short progress after a rescan (`… 3 / 12 · less than a minute left`); tested by resume/rescan/move/edit tests.
- **AC-9** Every format, graceful failures: unavailable placeholder, top bar `content search unavailable` with fix tooltip, search hint `Content search is unavailable: … {fix}`, unavailable empty-state line. HEIC/RAW and unreadable-photo handling have no UI; tested by analysis tests.
- **AC-10** Model upgrades: top bar `Updating search… {done} / {total} · {estimate}` and hint `Updating search for a new version: …`; no-mixing tested by model-version tests.
- **AC-11** Good enough to trust: no UI; judged by the owner using the populated search view, recorded in the PR.
- **AC-12** Fast at scale: `Searching…` covers the ≤ 1 s first search; very-large-library states above; numbers measured and recorded in the PR.
- **AC-13** Local and safe: no UI; tested by offline/network, snapshot and safety-audit tests, and ignore-forgets-analysis tests.
- **AC-14** Upgrade: after upgrade the top bar shows the first-run analysis state for every present photo; data kept is tested by the migration test.

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
- 2026-11-06 (model): SigLIP base at half precision, after a benchmark of six families, a compression test and a blind test on the owner's photos (ADR 0008). Size budget relaxed to ~800 MB by the owner; the chosen model needs 407 MB.
- 2026-11-06 (AC-11): owner's blind test of 13 searches: SigLIP 189/260 relevant in the top 20s, ≥ 15/20 on 7 searches. Several searches need features beyond content search (a named place, a date phrase) or have fewer than 15 matching photos; the owner judged the result good enough without a per-search breakdown.
- 2026-11-06 (design): Results never refresh by themselves during analysis; a "Refresh results" link re-runs the search. Only content matches get a divider ("Looks like …"). Analysis progress replaces the top bar's "N new" note while it runs; face progress stays with People. No UI for photos that couldn't be analysed.
