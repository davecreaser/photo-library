# 0001: Suggested albums

Status: approved
Issue: none

## Problem

The owner finds the automatic "Events & trips" view more clutter than help: "The events and trips thing doesn't quite work for me. It should be smarter, and maybe be a 'suggested albums' thing? And only suggest albums if it's a named folder in my directory (like Sail Amsterdam) or if there are more than a certain number of photos in it. When it's like 4 photos on a random wednesday it just comes up as clutter." On their library today (904 photos) the view lists 38 events. 26 of them are named only by a date, and 22 of those have fewer than 10 photos ("Wed, 12 Aug 2026": 4 photos). The events that matter (Sail Amsterdam, Poland, Norway) have already been saved as albums by hand, but they still show up as events next to the albums. The view mixes two jobs: proposing groupings and holding the ones the user kept. Only the first is needed, because albums already do the second.

## User stories

- **US-1** As the owner, I want the app to suggest albums only for my named folders and for sizeable bursts of photos, so that the list is worth reading and not clutter.
- **US-2** As the owner, I want to turn a suggestion into a real album in one step (choosing its name), so that what I keep sits with my other albums and lasts.
- **US-3** As the owner, I want to combine several suggestions into one album (e.g. three days of a Norway trip), so that one trip split by the app becomes one album.
- **US-4** As the owner, I want to dismiss a suggestion and have it stay dismissed after rescans, moves and renames, so that I only decide once.
- **US-5** As the owner, I want small date-only groups to stop being suggested without losing access to those photos, so that "4 photos on a random Wednesday" are still in the Timeline but not pushed at me.
- **US-6** As the owner upgrading from today's version, I want my existing merges and saved albums kept, and nothing I already organised suggested again.
- **US-7** As a future user whose folders and habits differ from the owner's, I want to set how big a group of photos must be before it is suggested, so that suggestions fit my library.

## Acceptance criteria

Terms. A **suggested album** is a group of photos the app proposes as an album. It comes from either a **named folder** (a folder whose name is not generic, as `folderName` decides today, e.g. `fuji/trips/08.25.sail_amsterdam` → "Sail Amsterdam") or a **burst**: loosely filed photos taken without an 18-hour gap, named by their dates. A burst lying inside a short named folder's dates still joins that folder's suggestion, as today. **Minimum burst size** defaults to 20 and counts present photos (copies once).

- **AC-1 What is suggested.** Named folders are suggested at any size (even 2 photos). Bursts are suggested only with at least the minimum burst size: with the default, 20 photos is suggested, 19 is not, and 15 photos over 3 days is not while 62 photos on one day is. Undated photos are suggested only via a named folder, listed after dated suggestions. Photos in small bursts are still in All photos and the Timeline, their organisation unchanged.
- **AC-2 The list.** "Suggested albums" replaces "Events & trips" in the sidebar and shows how many are waiting. Suggestions are listed newest first with name, date range, photo count and a cover (a favourite if there is one); opening one shows exactly its photos in capture-time order.
- **AC-3 Accept.** Accepting asks for a name, pre-filled with the suggestion's name. An empty name is refused. Confirming creates a top-level album with exactly the suggestion's photos (a duplicate album name is allowed, as today), and the suggestion is no longer listed.
- **AC-4 Combine.** With two or more suggestions selected, combining makes one album holding all their photos, its name pre-filled from a named-folder suggestion in the selection if there is one. None of them is listed afterwards.
- **AC-5 Dismiss.** Dismissing removes a suggestion at once, with one-step undo. A dismissed list in the view shows every dismissed suggestion and can restore each.
- **AC-6 Decisions stick.** Accepted and dismissed suggestions stay hidden across rescans, restarts, moving or renaming copies (including renaming the named folder on disk) and photos going missing. A suggestion counts as the same while at least half of its current photos were in the one decided on; a group that is now mostly new photos (e.g. 25 of 60) is suggested again.
- **AC-7 Albums are fixed; deleting undoes.** An album made from suggestions doesn't change when photos are added later, and editing it never brings a suggestion back. Deleting it lists the suggestion(s) it came from again.
- **AC-8 Already organised.** A suggestion at least half of whose photos are in one existing album is not shown (on the owner's library: Norway, Poland, Sail Amsterdam).
- **AC-9 Upgrade.** Merged or renamed events not yet saved as albums become albums with the same name and photos. No album, tag, favourite, person or clock correction changes.
- **AC-10 Threshold setting.** The minimum burst size can be changed in the Suggested albums view; values outside 1–1,000 are refused. A change applies immediately, without a rescan, and doesn't affect decisions already made.
- **AC-11 Empty states.** Before the first scan, the view explains that suggestions appear after scanning. When nothing is left to suggest, it says so (linking to the dismissed list if not empty).
- **AC-12 Large libraries.** For 100,000 photos (2,000 named folders), suggestions compute in under 2 seconds, and the view with 2,000 suggestions opens and scrolls smoothly.
- **AC-13 Safety and privacy.** Nothing in the photo folder is created, changed or deleted by any of this (safety suite passes). When a folder is ignored, records of accepted and dismissed suggestions for its photos (including names from folder names) are forgotten (ADR 0007).

## Non-goals

- Content-based suggestions ("beach", "snow") or grouping by what is in the photos. That is 0002 (search by image content).
- Location-based grouping or naming ("Lisbon", "Norway") from GPS. That waits for Places (roadmap 4).
- People-based suggestions ("Weekend with Jake").
- Learning from dismissals (e.g. never suggesting Wednesdays), or changing the 18-hour gap or the generic folder-name list in the UI.
- Creating albums automatically without the user accepting.
- Adding photos found later to an album that came from a suggestion ("12 new photos for Sintra, add them?").
- Removing individual photos from a suggestion before accepting. Curate in the album afterwards.
- Choosing a parent album when accepting. Albums from suggestions are top-level and can be nested by hand later, if the app allows moving albums.
- Merging a suggestion into an existing album.
- Notifications or banners about new suggestions.

## Safety & privacy

- **Photo folder:** read-only as today (ADR 0001). Suggestions come from data already in the database (paths, capture times, favourites). Nothing new reads the photo folder, and nothing writes to it.
- **Network:** nothing leaves the machine (ADR 0003).
- **Personal data:** new records of accepted and dismissed suggestions, made of the photos they contained (by photo, so they survive moves; ADR 0002) and possibly a name taken from a folder. Folder names can be private ("Personal"), so these records are cleared when their photos are forgotten, including by ignoring a folder (ADR 0007, AC-13). Removing an album from a suggestion forgets its accepted record (AC-7).

## Product

- **Tier:** core organising, so free. Nothing here is a paid-tier candidate.
- **Owner-specific assumptions that must become configurable or general:**
  - The minimum burst size (20) was chosen from the owner's library: there it keeps 3 date-named bursts (34, 53 and 62 photos) and drops 22. It is a user setting (AC-10). Whether 20 suits people who shoot hundreds of phone photos a day is not known.
  - The generic folder-name list (`fuji`, `kodak`, `trips`, `insta`, `unsorted`…) is English and reflects the owner's cameras and habits. Someone whose folders are `Apple/2024/IMG_…` or `Fotos/Urlaub` gets wrong or no named-folder suggestions. It stays built-in for now (Non-goals) but is the first thing to open up for other users.
  - The `MM.YY.name` date prefix (`08.25.sail_amsterdam`) is the owner's convention. Other date prefixes are only partly understood.
  - The 18-hour gap and the 14-day limit on named folders absorbing loose photos are tuned for one person's trips.
  - Dates in burst names use British English (`en-GB`).
- **Positioning:** "Suggested albums" is the product's word for automatic grouping. "Event" leaves the UI. CONTEXT.md needs a **Suggested album** entry replacing or redefining **Event** before work starts.

## Design

To be filled in by the design step.

## Open questions

None open; all resolved below.

## Decisions

- 2026-11-06: Suggested albums replaces the Events & trips view; kept groupings live only as albums.
- 2026-11-06: Minimum burst size 20 photos (owner chose 20 over 15 and 30), adjustable in the view.
- 2026-11-06: Albums made from suggestions are fixed; photos added later become a new suggestion if big enough. "Add new photos to this album" is a later feature.
- 2026-11-06: Named folders are suggested at any size; one dismissal clears a folder the owner doesn't want.
- 2026-11-06: "Same suggestion" is decided by photos (the 50% rule), never by name or path.
- 2026-11-06: Undo is one-step plus a dismissed list with Restore.
- 2026-11-06: "Smarter" for this spec = threshold, hiding what's already an album, remembering decisions; content/places/people are later features.
- 2026-11-06: The generic folder-name list stays built-in; opening it up is the first follow-up before release to others.
- 2026-11-06: CONTEXT.md: **Event** is replaced by **Suggested album**.
- 2026-11-06: Spec trimmed from 39 to 13 acceptance criteria at the owner's request (same behaviour, fewer, broader criteria).
