# 0006: Best photos

Status: draft
Issue: #6

## Problem

"I have 400 photos of the trip, half of them nearly the same, some blurry. I don't want to go through them all to find the good ones." Today the user can open an album or a suggested album and see everything in capture-time order. Nothing tells them which shots are repeats of each other, which are out of focus or badly exposed, or which few photos would tell the story of the trip. This is the engine behind both hooks: "it organises itself" (find the good ones without effort) and "it made my photobook" (later recipes need a chosen set).

## User stories

- **US-1** As someone with hundreds of photos from one trip, I want near-identical shots grouped, with the best one on top, so that I stop looking at the same picture twelve times.
- **US-2** As that user, I want blurry, too-dark or too-bright photos ranked below sharper ones so that I don't pick them by accident.
- **US-3** As that user, I want a "Best of" view of any album or suggested album that picks a sensible number of photos covering every day and every named person, so that I get a good short list in one click.
- **US-4** As that user, I want to change the choice (swap a photo for another from its group, add, remove, change how many) and then use it, so that I stay in charge.
- **US-5** As that user, I want to keep the chosen photos as a new album, so that later features (slideshow, photobook) and I can use them.
- **US-6** As a privacy-minded user, I want all of this done on my computer, with no file touched.

## Acceptance criteria

Terms. A **look-alike group** is two or more photos of the same scene taken close together. A photo's **quality score** is a number from 0 to 1 combining sharpness, exposure and (when there are faces) face size. A **best-of selection** is the app's pick of N photos from a set (an album or a suggested album).

- **AC-1 Quality measured.** Each photo's sharpness and exposure are measured once, locally, in the existing background analysis pass (newest first), and stored by photo with a version. Test photos: a sharp generated image scores higher than the same image strongly blurred; an almost-black or almost-white image scores lower than a well-exposed one. A photo that can't be read has no score and is never preferred over a scored one. Existing libraries are measured in the background without blocking use; photos not yet measured are treated as middling and the view says how many are pending.
- **AC-2 Look-alikes.** Photos are grouped as look-alikes when their content vectors (spec 0002) are very similar (cosine at or above `LOOKALIKE_MIN_SCORE`, calibrated so a burst of one scene groups and two different scenes of the same place do not) and their capture times are within 10 minutes of the next photo in the group. Undated photos group only above a stricter similarity threshold. Grouping is by chain (A~B and B~C puts all three together) with a group size cap of 30. Computed from stored vectors; no new model. Photos without vectors are never grouped.
- **AC-3 Best of an album.** Every album and every suggested album has a **Best of** view. With 400 photos over 5 days it picks by default `clamp(round(10% of photos), 12, 60)` photos (40 here): at most one from each look-alike group, the one with the highest quality score, spread so that every capture day in the set has at least one photo when N allows, with the rest spread in proportion to each day's photo count. Photos with a very low quality score are excluded unless nothing else is left for that day. A set smaller than the default N shows all its non-duplicate photos.
- **AC-4 People covered.** When the set contains photos of named people, each person with at least 3 photos in the set appears in at least one selected photo, when N allows (the person's best-scoring photo is preferred; a photo of several people counts for all of them). Eyes-open is not scored (see Non-goals).
- **AC-5 Deterministic and explainable.** The same photos and settings always give the same selection. Each selected photo can say why in plain words, from {"Sharpest of 6 similar photos", "Only photo of 14 Aug", "Includes Maria", "You starred this one"}, shown as a tooltip in the Best of grid and in the viewer's info panel.
- **AC-6 Adjusting.** In the Best of view the user can: change how many (a stepper, from 6 to the set size); open a selected photo's look-alike group and swap in another from it; remove a photo; add any other photo of the set. Edits last until the view is closed unless kept (AC-7); changing N after edits keeps the user's edits and refills or trims the automatic picks only. "Reset" returns to the automatic pick.
- **AC-7 Keep it.** "Make album" creates an ordinary album (named "Best of <source name>", editable) from the current selection, nested under the source album when there is one. The new album is plain: nothing keeps it in sync, and the source album is unchanged. Making it again creates a second album with a numbered name; nothing is overwritten.
- **AC-8 Look-alikes elsewhere.** In an album's grid, a "Show look-alikes together" toggle (off by default) stacks each look-alike group into one tile showing its best photo and a count badge; opening the tile shows the group. Toggling never changes the album's contents or the counts shown.
- **AC-9 Empty and edge cases.** Fewer than 6 photos in a set: the view says "Not enough photos to choose from". A set whose photos aren't all measured yet: the view picks from what is measured and says "Still reading your photos: 112 of 400 done". Missing photos and ignored-folder photos are never selected.
- **AC-10 Large libraries.** Measuring quality adds under 40 ms per photo to the existing analysis pass (24-megapixel JPEG, reusing the decode already done for analysis). Look-alike groups and a selection for a 5,000-photo set take under 1 second; for 100,000 photos, under 10 seconds, never blocking the UI (off the main thread or in chunks, cached in memory, invalidated by scans and analysis).
- **AC-11 Safety and privacy.** Nothing in the photo folder is created, changed or deleted; measurements come from pixels already decoded (safety suite passes, no new write path). Scores are stored by photo in the app database only, never leave the machine, are dropped when the photo is forgotten (including by ignoring a folder, ADR 0007), and are recomputed when `QUALITY_VERSION` is bumped.
- **AC-12 Migration.** The schema change (next `SCHEMA_VERSION`, a new `photo_quality` table) keeps albums, tags, names and settings, with a migration test.

## Non-goals

- **Eyes open / blinking.** Needs a face classifier the app doesn't have (YuNet/SFace don't say). A follow-up once the rest proves useful.
- Aesthetic scoring by a model ("is this beautiful"); only technical quality plus coverage.
- Hiding, rejecting or deleting look-alikes or poor photos; everything stays in the album, and files are never touched.
- Picking across the whole library or a year (the photobook recipe will reuse this selection later).
- Slideshow, photobook or export; this makes the list.
- Storing look-alike groups or selections (computed, like suggestions).
- Best of for search results or a person's photos (the selection works on any set, so it is cheap to add).

## Safety & privacy

- **Photo folder:** read-only as today (ADR 0001). Quality is measured from pixels already decoded for analysis (or the cached preview for formats sharp can't read); nothing is written there.
- **Network:** nothing leaves the machine (ADR 0003); no new model download.
- **Personal data:** a per-photo quality score and version. No new data about people; people coverage reads existing named faces. Forgetting a photo removes its score.

## Product

- **Tier:** core organising and the base for outcomes; free. Any paid tier would be about the recipes built on top.
- **Assumptions to watch:** the 10-minute window and default N (10%, 12–60) reflect one person's trips and cameras; N is adjustable per view and both are constants to tune. Burst-heavy shooters (sports, wildlife) may want bigger groups.

## Design

Reuses the album and suggestion header actions, `PhotoGrid`, the viewer info panel, the status-slot notices and the sidebar. No new sidebar section.

### Where it lives

- **Album page and opened suggestion**: a **Best of** button in the header actions.
- **Route** `{ kind: 'bestOf', source }` (album or suggestion), a `PhotoGrid` of the selected photos with a header.
- **Album grid**: a **Show look-alikes together** toggle in the header, remembered for the session.
- **Viewer info panel**: one line of reason, e.g. "Sharpest of 6 similar photos", for photos in a Best of view.

### Best of view

- Title **"Best of Sintra"**, subtitle `40 of 412 photos · 5 days`.
- Header: stepper **"Show [ 40 ] photos"** (− / +, 6 to the set size), **[Make album]** (primary), **[Back to Sintra]**, and **Reset** once edited.
- Grid: selected photos in capture-time order, with day headings. Each tile has a hover ✕ (remove) and, when it has look-alikes, a stack badge "6" that opens a strip of the group under the tile ("Pick another") to swap.
- A final ghost tile **"Add a photo…"** opens a picker of the rest of the set.
- Tile tooltip: the reason (AC-5). Make album tooltip: **"Creates a new album with these photos. Nothing is moved or changed on disk."**

### Notices (the existing status slot)

- After Make album: **"Made the album “Best of Sintra” with 40 photos. [Open album]"**
- Pending: **"Still reading your photos: 112 of 400 done. The choice will improve as it goes."** (above the grid, live).
- Error: **"Couldn’t make the album."** with no change.

### States

- **Empty (under 6 photos)**: `.empty` **"Not enough photos to choose from."** with [Back to Sintra]. For an empty set the Best of button is disabled with that tooltip.
- **Loading**: skeleton grid with "Choosing the best photos…", only if it takes over 300 ms.
- **Pending analysis**: the notice above; picks come from what is measured.
- **Populated / edited**: as above.
- **Very large (5,000-photo album)**: same view; computed off the main thread; the grid pages like any `PhotoGrid`.
- **Look-alike toggle on**: tiles with a count badge; opening shows the group in a `PhotoGrid` titled "6 similar photos".

### Interactions

- Click a tile opens the viewer (arrows move within the selection). ✕ or Delete removes it (⌘Z undoes). Stepper: +/- and arrow keys. Esc leaves the view; if the user edited, **"Leave without making an album?"** [Leave] [Stay].

### Traceability

- AC-1: pending notice. AC-2: badge, strip, toggle. AC-3: default pick and stepper. AC-4/5: reasons ("Includes Maria"). AC-6: stepper, ✕, strip, Add a photo, Reset. AC-7: Make album and notice. AC-8: toggle and tile badge. AC-9: empty and pending states. AC-10: loading skeleton. AC-11: copy says nothing on disk changes. AC-12: no UI.

## Open questions

1. Eyes open was in the idea, but no model we ship can tell it. Recommended: leave it out of this spec and ship sharpness, exposure and face size; add eyes-open later with its own model decision (ADR) once the owner has judged the picks.
2. Default count `clamp(10%, 12, 60)`, adjustable. Recommended: yes.
3. Should "Make album" be the only way to keep a selection (not also mark favourites)? Recommended: album only; favourites stay the user's own stars.
4. Should a starred photo win its look-alike group over the sharpest one? Recommended: yes, shown as "You starred this one".
5. Should Best of also appear for search results and a person's photos? Recommended: not now; albums and suggestions only.
6. Should quality measuring join the single analysis pass in `analysis.ts`? Recommended: yes, to avoid decoding twice; an already-analysed library re-reads its photos once to get scores, without re-running faces or content.

## Decisions

- (None yet; the owner's answers go here.)
