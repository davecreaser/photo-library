# 0006: Best photos

Status: done
Issue: #6

## Problem

"I have 400 photos of the trip, half of them nearly the same, some blurry. I don't want to go through them all to find the good ones." Today the user can open an album or a suggested album and see everything in capture-time order. Nothing tells them which shots are repeats of each other, which are out of focus or badly exposed, or which few photos would tell the story of the trip. This is the engine behind both hooks: "it organises itself" (find the good ones without effort) and "it made my photobook" (later recipes need a chosen set).

## User stories

- **US-1** As someone with hundreds of photos from one trip, I want near-identical shots grouped, with the best one on top, so that I stop looking at the same picture twelve times.
- **US-2** As that user, I want blurry, too-dark or too-bright photos ranked below sharper ones so that I don't pick them by accident.
- **US-3** As that user, I want a "Best of" view of any album or suggested album that picks a sensible number of photos telling the story of the trip (the moments, places and people that mattered, not just one photo per day), so that I get a good short list in one click.
- **US-7** As that user, I want the choice to reflect what I care about (the photos I star, the people I've named, the things I say I want), and to be able to steer it in words, so that it feels like my pick and not a generic one.
- **US-4** As that user, I want to change the choice (swap a photo for another from its group, add, remove, change how many) and then use it, so that I stay in charge.
- **US-5** As that user, I want to keep the chosen photos as a new album, so that later features (slideshow, photobook) and I can use them.
- **US-6** As a privacy-minded user, I want all of this done on my computer, with no file touched.

## Acceptance criteria

Terms. A **moment** is a run of photos close in time and scene (a lunch, a viewpoint, a market stop), found by capture-time gaps and content similarity. A **look-alike group** is two or more photos of the same scene taken close together. A photo's **quality score** is a number from 0 to 1 combining sharpness, exposure and (when there are faces) face size. A **best-of selection** is the app's pick of N photos from a set (an album or a suggested album).

- **AC-1 Quality measured.** Each photo's sharpness and exposure are measured once, locally, in the existing background analysis pass (newest first), and stored by photo with a version. Test photos: a sharp generated image scores higher than the same image strongly blurred; an almost-black or almost-white image scores lower than a well-exposed one. A photo that can't be read has no score and is never preferred over a scored one. Existing libraries are measured in the background without blocking use; photos not yet measured are treated as middling and the view says how many are pending.
- **AC-2 Look-alikes.** Photos are grouped as look-alikes when their content vectors (spec 0002) are very similar (cosine at or above `LOOKALIKE_MIN_SCORE`, calibrated so a burst of one scene groups and two different scenes of the same place do not) and their capture times are within 10 minutes of the next photo in the group. Undated photos group only above a stricter similarity threshold. Grouping is by chain (A~B and B~C puts all three together) with a group size cap of 30. Computed from stored vectors; no new model. Photos without vectors are never grouped.
- **AC-3 Best of an album.** Every album and every suggested album has a **Best of** view. It picks by default `clamp(round(10% of photos), 12, 60)` photos (40 for 400) by telling the story of the set rather than filling a quota per day:
  - The set is split into **moments** (AC-3a). Each moment gets a share of N in proportion to its **weight**: more photos taken (the photographer lingered), a starred photo, named people present, and a nearby-in-time album or tag the user made. The share is shrunk (square root) so long moments don't take over, and every moment of at least 3 photos can get one when N allows.
  - Within a moment, photos are chosen one at a time by **value minus repetition**: a photo's value is its quality score plus its interest signals (AC-4); its repetition is its content similarity to photos already picked anywhere in the selection (not only its own look-alike group). So two sunsets from different days don't both make it when a different place is waiting.
  - At most one photo per look-alike group. Photos with a very low quality score are excluded unless nothing else is left for that moment. A set smaller than the default N shows all its non-duplicate photos.
- **AC-3a Moments.** Moments are computed, not stored, from capture times (a gap over 90 minutes starts a new one, or a jump in content similarity within a day) and content vectors. They are not shown as albums; the view only uses them for coverage and for the reason text ("One of 3 from the market"). Undated photos form moments by content only.
- **AC-4 Interest signals (what makes a photo matter).** A photo's value rises with: you starred it (strongest); it is in another album you made; it carries a tag; it has named people, more so when the person is large and central in the frame; the person is someone you've named and have many photos of across the library (people who matter to you); you took several shots of it (it is in a look-alike group, a mild signal). Each named person with at least 3 photos in the set appears in at least one selection photo when N allows, by value (a photo of several people counts for all of them). These are fixed, documented weights; no model judges beauty. Eyes-open is not scored (see Non-goals).
- **AC-4a Your taste (optional, on-device).** When the user has starred at least 20 photos in the library, a "Lean towards what I star" setting (on by default, turn off in Settings) adds a small bonus to photos whose content vectors are close to the average of their starred photos, so the pick drifts to the kind of picture they like (people, landscapes, close-ups). The bonus is capped so it never outweighs a clear quality difference. Computed from stored vectors; nothing is learned by a model, uploaded or stored beyond what exists. Edits in a Best of view (swap, remove, add) do not train anything.
- **AC-4b Steer in words.** The Best of header has a "Focus on…" field. Typing words (e.g. "the kids, food, the beach") adds a bonus to photos whose content matches (the same SigLIP text search as spec 0002, above `CONTENT_MIN_SCORE`) and refills the pick; clearing it returns to the default. The focus is not saved after the view closes. With no content model yet, the field says "Search by content isn't ready yet."
- **AC-5 Deterministic and explainable.** The same photos and settings always give the same selection. Each selected photo can say why in plain words, from {"Sharpest of 6 similar photos", "One of 3 from the market", "Includes Maria", "You starred this one", "Matches “the beach”", "Something different from the rest"}, shown as a tooltip in the Best of grid and in the viewer's info panel. The reason shown is the one that mattered most for that photo's pick.
- **AC-6 Adjusting.** In the Best of view the user can: change how many (a stepper, from 6 to the set size); open a selected photo's look-alike group and swap in another from it; remove a photo; add any other photo of the set. Edits last until the view is closed unless kept (AC-7); changing N after edits keeps the user's edits and refills or trims the automatic picks only. "Reset" returns to the automatic pick.
- **AC-7 Keep it.** "Make album" creates an ordinary album (named "Best of <source name>", editable) from the current selection, nested under the source album when there is one. The new album is plain: nothing keeps it in sync, and the source album is unchanged. Making it again creates a second album with a numbered name; nothing is overwritten.
- **AC-8 Look-alikes elsewhere.** In an album's grid, a "Show look-alikes together" toggle (off by default) stacks each look-alike group into one tile showing its best photo and a count badge; opening the tile shows the group. Toggling never changes the album's contents or the counts shown.
- **AC-9 Empty and edge cases.** Fewer than 6 photos in a set: the view says "Not enough photos to choose from". A set whose photos aren't all measured yet: the view picks from what is measured and says "Still reading your photos: 112 of 400 done". Missing photos and ignored-folder photos are never selected.
- **AC-10 Large libraries.** Measuring quality adds under 40 ms per photo to the existing analysis pass (24-megapixel JPEG, reusing the decode already done for analysis). Look-alike groups and a selection for a 5,000-photo set take under 1 second; for 100,000 photos, under 10 seconds, never blocking the UI (off the main thread or in chunks, cached in memory, invalidated by scans and analysis).
- **AC-11 Safety and privacy.** Nothing in the photo folder is created, changed or deleted; measurements come from pixels already decoded (safety suite passes, no new write path). Scores are stored by photo in the app database only, never leave the machine, are dropped when the photo is forgotten (including by ignoring a folder, ADR 0007), and are recomputed when `QUALITY_VERSION` is bumped.
- **AC-12 Migration.** The schema change (next `SCHEMA_VERSION`, a new `photo_quality` table) keeps albums, tags, names and settings, with a migration test.

## Non-goals

- **Eyes open / blinking.** Needs a face classifier the app doesn't have (YuNet/SFace don't say). A follow-up once the rest proves useful.
- Aesthetic scoring by a model ("is this beautiful"). Judged taste is personal and a generic model would impose someone else's. The pick uses technical quality, the user's own signals (stars, albums, tags, named people), repetition avoidance, and words the user types; the only learning is a capped lean towards the average of their own stars (AC-4a), which is arithmetic on existing vectors.
- Learning from the user's edits in the Best of view (swap/remove/add). A candidate follow-up if the owner wants the pick to improve over time.
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
- **Assumptions to watch:** the moment gap (90 minutes), the signal weights and the taste cap are guesses to tune against the owner's own trips (`scripts/model-eval`-style measurement, read-only); the 10-minute window and default N (10%, 12–60) reflect one person's trips and cameras; N is adjustable per view and both are constants to tune. Burst-heavy shooters (sports, wildlife) may want bigger groups.

## Design

Reuses the album and suggestion header actions, `PhotoGrid`, the viewer info panel, the status-slot notices and the sidebar. No new sidebar section.

### Where it lives

- **Album page and opened suggestion**: a **Best of** button in the header actions.
- **Route** `{ kind: 'bestOf', source }` (album or suggestion), a `PhotoGrid` of the selected photos with a header.
- **Album grid**: a **Show look-alikes together** toggle in the header, remembered for the session.
- **Viewer info panel**: one line of reason, e.g. "Sharpest of 6 similar photos", for photos in a Best of view.

### Best of view

- Title **"Best of Sintra"**, subtitle `40 of 412 photos · 14 moments`.
- A **"Focus on…"** text field under the title (placeholder: "the kids, food, the beach"); typing refills the pick after a short pause; a small ✕ clears it.
- Header: stepper **"Show [ 40 ] photos"** (− / +, 6 to the set size), **[Make album]** (primary), **[Back to Sintra]**, and **Reset** once edited.
- Grid: selected photos in capture-time order, with day headings. Each tile has a hover ✕ (remove) and, when it has look-alikes, a stack badge "6" that opens a strip of the group under the tile ("Pick another") to swap.
- A final ghost tile **"Add a photo…"** opens a picker of the rest of the set.
- Tile tooltip: the reason (AC-5). Day headings stay, with a quiet moment label under the tile when it differs from its neighbour. Make album tooltip: **"Creates a new album with these photos. Nothing is moved or changed on disk."**

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

- AC-1: pending notice. AC-2: badge, strip, toggle. AC-3: default pick and stepper. AC-3/3a: subtitle's moment count. AC-4/5: reasons ("Includes Maria", "You starred this one"). AC-4a: Settings toggle "Lean towards what I star" (with the line "Uses only your own stars, on this computer."). AC-4b: Focus field. AC-6: stepper, ✕, strip, Add a photo, Reset. AC-7: Make album and notice. AC-8: toggle and tile badge. AC-9: empty and pending states. AC-10: loading skeleton. AC-11: copy says nothing on disk changes. AC-12: no UI.

## Open questions

1. Eyes open was in the idea, but no model we ship can tell it. Recommended: leave it out of this spec and ship sharpness, exposure and face size; add eyes-open later with its own model decision (ADR) once the owner has judged the picks.
2. Default count `clamp(10%, 12, 60)`, adjustable. Recommended: yes.
3. Should "Make album" be the only way to keep a selection (not also mark favourites)? Recommended: album only; favourites stay the user's own stars.
4. Should a starred photo win its look-alike group over the sharpest one? Recommended: yes, shown as "You starred this one".
5. Should Best of also appear for search results and a person's photos? Recommended: not now; albums and suggestions only.
6. Should quality measuring join the single analysis pass in `analysis.ts`? Recommended: yes, to avoid decoding twice; an already-analysed library re-reads its photos once to get scores, without re-running faces or content.
7. (New) Choosing "with context": should the pick use moments, interest signals, repetition avoidance and a "Focus on…" field instead of one-per-day-and-person? Recommended: yes, as written.
8. (New) Should a model ever judge what's beautiful? Recommended: no. It is too personal and would be someone else's taste. Instead, lean (capped, on by default, can be turned off) towards the average of the user's own stars. Say if you would rather have no taste lean at all.
9. (New) Should the Best of view learn from the user's swaps and removals so later picks improve? Recommended: not in this spec; revisit once the owner has used it.

## Decisions

- The owner replied `go` with no changes, so the recommended answers to questions 1–9 apply: no eyes-open (1); default count `clamp(10%, 12, 60)`, adjustable (2); Make album is the only way to keep a selection (3); a starred photo wins its look-alike group (4); albums and suggestions only (5); quality is measured inside the single analysis pass (6); moments, signals, repetition avoidance and Focus (7); capped lean towards the user's own stars, on by default (8); edits do not train later picks (9).
- Built as specified, with these choices where the spec left room: quality is measured on its own small aspect-preserving decode (256 px) unless faces need the 2048 px decode, so scores don't depend on which analyses ran; look-alike thresholds are `LOOKALIKE_MIN_SCORE` 0.93 (undated 0.97), calibrated with `scripts/model-eval/lookalikes.ts` on generated scenes and to be re-checked on real trips; the moment break similarity is 0.55; removing a photo in the Best of view makes the pick one smaller, adding makes it one bigger, swapping keeps the size; Delete removes the photo under the pointer and ⌘Z / Ctrl+Z puts it back; reasons for the moment kind read "One of 3 from this moment" (no moment names). The stepper's top is the set size, but a pick is capped at one photo per look-alike group, so it can show fewer than the stepper says in a very repetitive set.
