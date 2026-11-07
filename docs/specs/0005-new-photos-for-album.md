# 0005: New photos for an album

Status: approved
Issue: #19

## Problem

"I copied the last day of Sintra off the card. The app made a new suggestion instead of adding it to my Sintra album." Spec 0001 made albums from suggestions fixed: photos found later become a new suggestion if they are big enough, or (when they fall in the same named folder or the same burst as the album) are silently hidden because the group is "mostly decided". Either way the user's Sintra album stays incomplete and the app doesn't say so. The user has to notice, open the album and add the photos by hand.

## User stories

- **US-1** As someone who copies more photos off the card after making an album from a suggestion, I want the app to tell me "12 new photos for Sintra" so that I don't have to notice and hunt for them.
- **US-2** As that user, I want to add them in one step, or look at them first, so that the album is complete without effort or surprise.
- **US-3** As that user, I want to say "no thanks" once and not be asked again about those same photos.
- **US-4** As that user, I want these photos not to also show up as a new suggested album.

## Acceptance criteria

Terms. A **source album** is an album made from accepted suggestion(s) that still exists (it has an accepted decision, spec 0001). **New photos for an album** are present photos that are not in the source album and meet either condition: (a) captured within the album's date span, which runs from its earliest to its latest capture time and is extended by the 18-hour burst gap at the end; or (b) in the same detected group (named folder or burst) as a decision's photos, where at least half of that group's photos were in the decision. Photos already in any album, in a dismissed decision, or that were declined for this album (AC-5) are not counted. Undated photos are only counted through (b).

- **AC-1 Offered.** After an album is made from a suggestion, copying a day of further photos into the photo folder and rescanning makes the app offer "12 new photos for Sintra" (the count of new photos). With zero new photos nothing is offered. An album that wasn't made from a suggestion (made by hand) is never offered new photos.
- **AC-2 Where.** The offers are listed at the top of Suggested albums (one row per album, newest first) and counted in the sidebar's Suggested albums badge. Opening a row shows exactly the new photos in capture-time order.
- **AC-3 Add.** "Add to Sintra" adds exactly those photos to the album, the offer disappears, the album's count rises by that number, and the sidebar and offer count update at once. Nothing else about the album changes.
- **AC-4 Not a second suggestion.** New photos that qualify under AC-1 never also appear in a suggested album card, whether they would have formed a new burst or a named folder. Photos that don't qualify (outside the album's dates and in a different group) are suggested as before.
- **AC-5 Decline.** "Not these" hides the offer with one-step undo. The same photos are not offered for that album again after rescans and restarts. Photos found later that are not among those declined are offered as a new offer.
- **AC-6 Combined albums.** For an album made by combining suggestions, the date span covers all the combined photos. Offers are per album, never one per original suggestion.
- **AC-7 Decisions follow the album.** Deleting the album removes its offers, and its suggestion(s) come back as in spec 0001 (including the new photos, as part of the group). Removing photos from the album by hand does not make them "new" again, and photos the user removed are never offered.
- **AC-8 Large libraries and no photos.** Computing offers adds under 200 ms at 100,000 photos and 2,000 albums. Before the first scan, or with no source albums, nothing is offered and no new empty state appears.
- **AC-9 Safety and privacy.** Nothing in the photo folder is created, changed or deleted (safety suite passes). Declined offers are stored by photo, are removed when the photos are forgotten (including by ignoring a folder, ADR 0007), and never leave the machine.

## Non-goals

- Offering new photos to albums made by hand, or to albums made from anything other than suggestions.
- Merging a new suggestion into an existing album (a separate feature).
- Adding automatically without asking.
- Choosing individual new photos to add (add all, or open and use Add to album from the selection bar).
- Notifications outside the app.
- Offering photos that look similar by content.

## Safety & privacy

- **Photo folder:** read-only as today (ADR 0001); offers are computed from the database (capture times, album and decision photos).
- **Network:** nothing leaves the machine (ADR 0003).
- **Personal data:** a new table of declined offers (album + photo ids), kept by photo (ADR 0002), removed with the album or when the photo is forgotten.

## Product

- **Tier:** core organising, free.
- **Assumptions to watch:** the 18-hour extension at the album's end reflects the same gap as bursts (0001) and is tuned for one person's trips. Someone who adds photos from a trip weeks later is not offered them by date.

## Design

Reuses the Suggested albums view (`SuggestionsView`), the status-slot notices, and the card grid. No new screens other than a section and a route.

### Where it lives

- **Suggested albums view**: a section **"New photos for your albums"** above the year-grouped cards, shown only when there are offers. Header-less lists of rows, one per album.
- **Sidebar**: the Suggested albums badge counts waiting suggestions plus waiting offers.
- **Opened offer**: route `{ kind: 'albumOffer', albumId }`, a `PhotoGrid` of the new photos, like an opened suggestion.

### Offer row

`[cover]  **12 new photos for Sintra**   13 Aug 2025 · 12 photos     [Add to Sintra] [Look] [Not these]`

- Cover: the first new photo. Name bold, meta is the date range of the new photos.
- **Add to Sintra** (primary-small); **Look** opens the offer; **Not these** declines. Tooltips: Add, **"Adds these 12 photos to the album Sintra. Nothing is moved or changed on disk."** Not these, **"Stop offering these photos for Sintra."**
- 1 photo reads **"1 new photo for Sintra"**.
- Long names truncate with a title tooltip.

### Notices (the existing status slot)

- After Add: **"Added 12 photos to “Sintra”. [Open album]"**
- After Not these: **"Won’t offer these 12 photos for “Sintra” again. [Undo]"** (⌘Z too).
- Error: **"Couldn’t add the photos."** with no change to the album.

### Opened offer

- Title **"New photos for Sintra"**, subtitle `13 Aug 2025 · 12 photos`. Header actions **[Add to Sintra]** and **[Not these]** (Not these goes back to the list with the Undo notice; Add opens the album).
- Gone (already added or no longer there): `.empty` **"These photos have been dealt with."** with **[Back to Suggested albums]**.

### States

- **Empty / none**: the section is absent; nothing else changes. With offers but no suggestions, the nothing-left text is not shown.
- **Loading**: the section appears with the cards; no separate spinner.
- **Very large**: rows are few (one per album); the section scrolls with the page. Opened offers page like any `PhotoGrid`.

### Traceability

- AC-1, AC-2: section, row copy, sidebar badge. AC-3: Add, notice. AC-4: cards don't show these photos (no UI). AC-5: Not these, Undo. AC-6: one row per album. AC-7: no UI; delete confirm unchanged. AC-8: section absent when empty. AC-9: copy says nothing is moved or changed.

## Open questions

1. Should offers also count photos captured inside the album's date span that aren't in the same folder (e.g. a phone photo of the same afternoon)? Recommended: yes, as in AC-1 (a), since that's what the idea asks for ("fall inside the dates").
2. Should the end of the span be extended by the 18-hour gap, so "the last day of Sintra" (copied later, on a new day) is caught? Recommended: yes; without it that exact case is missed unless it is in the same folder.
3. Should an offer also appear in the album's own page (a banner), as well as in Suggested albums? Recommended: not now; one place keeps it calm.
4. "Not these" is per set of photos, not "never offer anything for this album". Recommended: per photos, so later days are still offered.

## Decisions

The owner replied `go`, so the recommended answers stand.

1. Photos inside the album's date span in a different folder are counted: yes.
2. The end of the span is extended by the 18-hour burst gap: yes.
3. No banner on the album's own page; offers live only in Suggested albums.
4. "Not these" applies to those photos only; later photos are offered anew.

Implementation notes:

- Photos added through an offer are also added to the album's accepted decision, so removing one later doesn't make it new again, and deleting the album brings the whole group back as a suggestion.
- Photos offered to an album are taken out of the detected groups before suggestions are chosen (AC-4); a trimmed burst's name and dates follow the remaining photos.
- Schema version 6 adds `offer_declines` (album + photo, cascading with both).

5. Review: photos declined with "Not these" are also not shown as a new suggestion (they were turned down for this album, not freed up). Offers are recomputed per call; measured cost is pure-compute under 200 ms at 100k photos, caching deferred.
