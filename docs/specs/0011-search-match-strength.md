# 0011: Search match strength

Status: done
Issue: #61; epic #55 (assistant access)

## Problem

"I asked my assistant for an album of the red photos from 2025. It found all ten, then added four that weren't red, because the search gave it no way to tell where the good matches stopped." `search_photos` (spec 0008) lists content matches best first with only a rank, so a loose match at rank 14 looks like a match at rank 1. In the assistant eval (spec 0010, claude-sonnet-5-5, 3 runs) this is the only failing task: `content` passes 0 of 3, each time with the 10 red photos plus 4 other July 2025 photos.

## User stories

- **US-1** As the owner asking my assistant for photos of something ("red", "snow"), I want it to be able to tell strong matches from weak ones, so that the album it makes holds what I asked for and not loose extras.
- **US-2** As the owner, I want the assistant still to be able to include weak matches when I ask for everything, so that nothing is hidden from it.
- **US-3** As the owner, I want the raw similarity score to stay inside the app, so that the assistant gets no more information about my photos than it needs.

## Acceptance criteria

- **AC-1 Strength on content matches.** In `search_photos`, every content match carries a strength: `"match": {"content": 3, "strength": "strong"}` or `"weak"`. Name matches (`"name"`) and filter-only results (`"filter"`) are unchanged. The tier is two-valued; no number other than the rank is returned.
- **AC-2 The line.** Strength is decided inside the app from the similarity scores of the search's content matches, with one rule that is fixed for the content model, never per library, and chosen by calibration (Decision 1). The best content match is always strong. Every match ranked above a strong one is strong too (the tiers never interleave), also across pages: the same search gives the same strength to a photo whatever the `offset` and `limit`.
- **AC-3 Counts.** `total` is unchanged (name matches plus all content matches) and paging is unchanged. A new `strong_total` gives the number of strong content matches in the whole search, shown only when the search has a content phrase. With no content phrase, or no content matches, it is absent.
- **AC-4 Tool description.** The `search_photos` description explains the two tiers in a sentence or two: weak matches are looser and should be left out unless the owner asked for everything or "anything like" it; `strong_total` says how many there are. The description does not mention scores.
- **AC-5 Score stays inside.** No score, distance or threshold appears in any tool result, error, or description. A test checks the result of a content search has no keys other than the documented ones.
- **AC-6 The app's own search is unchanged.** The search box lists the same photos in the same order with the same copy as before; the threshold for being shown at all (`CONTENT_MIN_SCORE`) is unchanged.
- **AC-7 Calibrated, and measured.** The line is calibrated on the model-eval set with `scripts/model-eval/calibrate.mjs` (not on the agent eval's generated library), and the calibration, with its precision and recall for strong matches, is recorded in the code comment beside the constant as `CONTENT_MIN_SCORE`'s is. After the change, `node scripts/agent-eval/run.ts --task content --runs 5` passes at least 4 of 5, and `trip` and `people-date-place` stay at their baseline (3/3). The numbers go in the PR.
- **AC-8 Edge cases.** A search with one content match: it is strong. Content search unavailable (model missing, or analysis still running): no strength is invented; the existing `note` still appears and `strong_total` is absent. A search whose phrase matches nothing: unchanged ("nothing found" behaviour), no `strong_total`.
- **AC-9 Safety and privacy.** Nothing reads or writes the photo folder beyond what search already does; no network; no new stored data (strength is computed per search, never stored). `test/safety.test.ts` passes unchanged.
- **AC-10 Scale.** A search over a 100,000-photo library is no slower than before beyond a negligible amount: the scores are already computed by the vector search, and the line costs one pass over them.

Traceability: US-1 → AC-1, AC-2, AC-4, AC-7. US-2 → AC-3, AC-4. US-3 → AC-1, AC-5. Edge cases → AC-8, AC-10.

## Non-goals

- The app's search box: no "Less likely" divider (a later idea in the issue).
- `best_of`'s focus words using the same line.
- Three tiers, or any numeric confidence.
- Changing `CONTENT_MIN_SCORE` or the content model.

## Safety & privacy

- Photo folder: untouched; this only reshapes an existing tool result.
- Network: none (ADR 0003).
- Personal data: none new. A coarse tier reveals less than the rank and photo ids already do.

## Product

Free/paid tier: none. Nothing here assumes the owner's own library: the line is tuned on a public set (COCO) and is fixed for the model.

## Design

No UI change: the result is read by the assistant, not shown in the app. Tool description wording (AC-4), to be refined against the eval:

> Content matches say how strong they are: "strong" or "weak". Weak matches are looser, so leave them out of albums and answers unless the owner asked for everything or for anything like it. strong_total is how many strong matches there are in all.

Result example: `{"total": 24, "strong_total": 10, "offset": 0, "photos": [{"id": 812, "match": {"content": 1, "strength": "strong"}, …}]}`.

## Open questions

1. Where is the line: a second fixed threshold, the biggest gap in the scores, or a fraction of the best match? Recommended: whichever calibrates best on the model-eval set; probably a fraction of the best, so it adapts to the phrase.
2. Two tiers or three? Recommended: two (`strong`, `weak`).
3. Should `total` count only strong matches? Recommended: no. Keep `total` as now and add `strong_total`.

## Decisions

Owner: `go` (recommended answers).

1. **The line is a fraction of the best match's margin above `CONTENT_MIN_SCORE`**, `STRONG_FRACTION = 0.65`: strong if `score − min ≥ 0.65 × (best − min)`. Calibrated on COCO val2017 (5,000 images, 80 object names) with `scripts/model-eval/calibrate-strength.mjs`: strong matches 97% right and 34% of all right matches kept strong; weak matches 51% right. Revised after review: the first line, 0.65 of the raw score (91% / 63%), failed the content eval 0 of 5, because two non-red photos scored 0.78 of the best (0.61 of its margin); measured from 0 rather than from the minimum, every match looks close to the best, and a phrase whose best match is only just in comes back all strong. At equal precision the margin beats a raw fraction (0.80: 97% / 32%) and the biggest gap (89% / 21%). Owner's choice between margin 0.50 (94% / 53%, eval still fails) and 0.65: **0.65, precision over recall**; albums hold what was asked for, and weak matches stay available when the owner asks for everything.
2. **Two tiers**: `strong`, `weak`.
3. **`total` unchanged**; `strong_total` added.

AC-7, measured locally (claude-sonnet-5-5, owner's login, 2026-11-12): `content` 5/5 (baseline 0/3; 0/5 with the first line), `trip` 3/3, `people-date-place` 3/3. The eval runs with `ANTHROPIC_API_KEY` or a Claude login, so it can run outside the headless build.
