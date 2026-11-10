# 0009: Assistant access: best photos and proposals

Status: approved
Issue: #52; epic #55

## Problem

"Pick the best 40 from the Norway trip: different moments, everyone in it, not five of the same view." The owner tried assistant access (spec 0008) on their own library: Claude finds the photos and makes albums, but it is poor at choosing the best ones, because all it has is capture times, people's names and stars. It can't see the photos, so it can't tell a sharp shot from a blurry one or notice that twelve photos are the same view. The app already can: the Best of engine (spec 0006) scores quality, groups look-alikes and spreads the pick over moments and people. Today the assistant has no way to use it, and whatever it picks goes straight into an album with no chance for the owner to look first. The owner wants the app's judgement behind the assistant's pick, and their own eye on the final choice before anything is kept.

## User stories

- **US-1** As the owner, I want my assistant to ask the app for the best N photos of an album (sharp, not repeats, every moment and the people who matter) so that its pick is good even though it never sees the photos.
- **US-2** As the owner, I want each picked photo to come with a short reason and its look-alike alternatives so that the assistant can explain the pick to me and adjust it when I ask ("more of Anna", "not that one, another from the same spot").
- **US-3** As the owner, I want to get the best of a year, a date range or a person's photos too, so that a photobook of 2024 is one request, not only a trip that already has an album.
- **US-4** As the owner, I want the assistant's pick to open in the app's Best of screen, where I swap, remove or add photos and approve it with "Make album", so that nothing is kept until I have looked at it.
- **US-5** As the owner, I want the assistant to learn what I decided (made the album, with which changes, or walked away) so that it can carry on without me retelling it.
- **US-6** As someone who keeps photos off the cloud, I want these new tools to reveal no more than spec 0008 allows (no pixels, paths, folder or file names, places, cameras or ignored-folder photos) so that turning on assistant access stays an informed choice.
- **US-7** As the owner of a large library, I want a best-of of a 5,000-photo year to come back in seconds without freezing the window, and small or empty albums to get a clear answer instead of an error.

## Acceptance criteria

Terms as in spec 0006 (Best of, look-alikes, moments, quality score) and spec 0008 (assistant access, assistant album, server, token). A **proposal** is a set of photos the assistant asks the owner to review, shown in the Best of screen; it lives in the app's memory only and is never stored. Server tests drive the tools with an MCP client over a real local socket (`node --test`, like `test/assistant.test.ts`) on macOS, Linux and Windows CI; the window handoff is tested with Playwright (e2e). Generated libraries only.

- **AC-1 Eight tools.** `tools/list` returns exactly `library_overview`, `search_photos`, `create_album`, `add_to_album`, `remove_from_album`, `best_of`, `propose_selection` and `proposal_status`, and nothing else. This supersedes spec 0008's AC-8 "exactly five tools"; the rest of that criterion (a description per tool saying what it returns, its limits and one example call; errors as plain sentences that say what to do next; internal failures as "Photo Library couldn't do that: something went wrong inside the app") applies to the new tools too. `best_of`'s description says that for a year, a date range or a person's photos the assistant first gathers them with `search_photos`, makes an album with `create_album`, then runs `best_of` on that album, and that suggested albums are not available (find the photos with `search_photos` instead). `propose_selection`'s description says the owner decides in the app and that the assistant must not make the same album itself.
- **AC-2 `best_of` inputs.** `best_of(album_id, count?, focus?, include?, exclude?)`. `album_id` is any album from `library_overview` (the owner's or the assistant's; reading never changes it). `count` is 6–200 (default: the app's default for the album's size, `clamp(round(10%), 12, 60)`, so 40 for 400 photos), capped at the album's photo count. `focus` is "Focus on…" text (at most 200 characters), as in the app. `include` (always in the pick) and `exclude` (never picked) take at most 1,000 photo ids each and map to the engine's `fixed` and `exclude`. Errors name the field: unknown `album_id` ("There is no album with id 99. library_overview lists the albums."), `count` outside 6–200, a non-string `focus` or one over 200 characters, an id in both `include` and `exclude`, unknown inputs. Ids in `include`/`exclude` that aren't present photos of that album are listed in `not_in_album` and ignored. More `include` ids than `count` raise the count to fit them (noted in the result).
- **AC-3 Same pick as the app.** For the same album, count, focus, include and exclude, `best_of` returns the same photo ids, in the same capture-time order, as the Best of screen (`BestOfService.get` with `source: { kind: 'album', id }`), and calling it twice gives the same result (test: equal ids to `BestOfService.get` on a generated album with look-alike bursts, two named people, a starred photo and an excluded id). The engine is used as is: no assistant-only weights, and the owner's "Lean towards what I star" setting applies as in the window.
- **AC-4 `best_of` result.** In this order: `album_id`, `name` (the album's name), `total` (present photos in the album), `count`, `default_count`, `moments`, any `note`s, `not_in_album` when non-empty, then `photos`. Each photo has the same fields as a `search_photos` result (id, capture time to the minute or null, people, albums, favourite) without `match`, plus `reason`: one sentence in the same words as the app's tooltip ("Sharpest of 6 similar photos", "You starred this one", "Includes Anna", "Matches “the beach”", "One of 3 from this moment", "The one from this moment", "Something different from the rest"), or "Included as you asked" for an `include` id; and `alternatives`: up to 5 ids of its look-alikes that weren't picked, best first, left out when there are none. A pick of 200 photos is under 64 KB of JSON.
- **AC-5 Small, empty and unfinished albums.** An album with fewer than 6 present photos (including an empty one) is not an error: the result has `total`, `too_few: true`, empty `photos` and the note "This album has only 4 photos, too few to choose from: use them all, or search_photos for more." While quality isn't measured for every photo of the album, the note "Quality is measured for 112 of 400 photos so far; the pick will improve as Photo Library reads the rest" is added and unmeasured photos are treated as in the app. With `focus` but no content model, the note "focus is unavailable until content analysis is ready; the pick ignores it" is added and the pick is the one without focus. Missing photos and photos in ignored folders are never picked, offered as alternatives or counted.
- **AC-6 `propose_selection`.** `propose_selection(album_id, photo_ids)` takes 6–200 distinct ids (duplicates are dropped before counting). Ids that aren't present photos of that album are listed in `not_in_album` and left out; if fewer than 6 remain, or the album has fewer than 6 photos, it refuses with a sentence saying so ("A proposal needs at least 6 photos of the album; for fewer, use create_album.") and nothing opens. Otherwise it returns within 1 second, without waiting for the owner: `proposal_id`, `album_id`, `name`, `photos` (how many are proposed), `not_in_album`, `status: "waiting"` and the message "Waiting for the owner in Photo Library. Call proposal_status with this proposal_id to see what they decided; don't make this album yourself." It writes nothing to the database.
- **AC-7 The pick opens in the window.** Within 2 seconds of `propose_selection` the window shows the Best of screen of that album with exactly the proposed photos: they are the screen's fixed photos and the count equals their number, so nothing is added automatically and nothing is left out. Each proposed photo's tooltip says it was picked by the assistant (final copy from design, e.g. "Picked by your AI assistant") rather than "You chose this one", and the screen says it is a proposal waiting for the owner. The window is brought forward: opened if none is open, restored if minimised, shown and focused; where the system refuses focus (Windows, some Linux desktops) the taskbar entry asks for attention instead. Unsaved work is never discarded: if the owner has an edited Best of with no album made, the existing "Leave without making an album?" prompt appears first; choosing Stay keeps them where they were and the proposal is `closed`.
- **AC-8 The owner decides.** Every spec 0006 adjustment works on a proposal (swap from the look-alike strip, remove, add, the stepper, "Focus on…"). "Reset" returns to the assistant's proposal, not the automatic pick. Only "Make album" keeps anything: it makes "Best of <album name>" as today (numbered if taken, nested under the source album, source unchanged). That album is the owner's, not an assistant album: no "AI" marker, and `add_to_album`/`remove_from_album` refuse it as the owner's. No tool can make it, approve it or press anything in the window.
- **AC-9 `proposal_status`.** `proposal_status(proposal_id)` returns the proposal's `status` and, by status: `waiting` (showing, nothing made yet; `edited: true` once the owner has changed it); `approved` (the owner made an album from it: `album_id`, `name`, `photos`, `kept` count, `added` and `removed` ids compared with the proposal; the first album made from it counts, later edits don't change the answer); `closed` (the owner left the proposal's Best of screen without making an album, chose Stay in AC-7, or the source album was deleted); `replaced` (a newer proposal opened before the owner decided, with `by_proposal_id`); `expired` (Photo Library quit, the photo folder changed, or assistant access was turned off since). Proposal ids are never reused while the app runs. An id it never issued gets "No proposal with id 7. Proposals last until Photo Library is closed." One proposal shows at a time: a new one, from any connected assistant, replaces a waiting one under AC-7's unsaved-work rule.
- **AC-10 End-to-end handoff (e2e).** With access on and a generated library: the assistant calls `create_album` with a year's photos, `best_of` on it with count 12, and `propose_selection` with those 12 ids; the window shows that pick; the owner removes one, swaps one from its look-alike strip and presses Make album; `proposal_status` then reports `approved` with 11 photos, the removed and swapped-out ids in `removed` and the swapped-in id in `added`. A second run where the owner presses "Back to …" instead reports `closed`, and no album was made. Passes on Linux and Windows CI (macOS by hand, as for spec 0008).
- **AC-11 Access turned off mid-proposal.** Turning access off (or "Forget connected assistants") while a proposal waits leaves the Best of screen open as an ordinary Best of the owner can still keep or leave; the proposal is `expired` for any later connection. Calls in flight get spec 0008's "Assistant access was turned off in Photo Library", and a `propose_selection` cut off this way opens nothing.
- **AC-12 Privacy and safety.** spec 0008's AC-14 sentinel test covers all three new tools on every success, note and error path (too few, unknown ids, unknown album, bad inputs, every proposal status): no byte sent contains a path or part of one, a folder or file name, the photo folder's name, a hash, coordinates, a camera model, pixels, a raw quality score, or the id of a photo in an ignored folder. No tool accepts or returns a suggested album or its id (suggestion ids embed folder names, e.g. `f:<folder>`). Reasons come only from the fixed list in AC-4, with only named people's names and the assistant's own focus words in them. An e2e session running all eight tools leaves the photo folder byte-identical (snapshot before and after, excluding `.DS_Store`); the app makes no network connection; nothing about proposals is written to disk; and ADR 0011 is updated to list Best of reasons and look-alike alternatives among what may be read, and that an assistant may open a proposal in the window but never keep one.
- **AC-13 Large libraries and several assistants.** On a generated library of 100,000 photos: `best_of` on a 5,000-photo album answers within 2 seconds and on a 100,000-photo album within 15 seconds (spec 0006's budgets plus the tool's own work), with the window responsive meanwhile (a grid scroll during the call isn't blocked); `propose_selection` on a 5,000-photo album returns within 1 second and the screen shows the pick within 2. Two assistants connected at once each get their own correct `best_of` results, and their proposals follow AC-9's one-at-a-time rule.

Traceability: US-1 → AC-2, AC-3, AC-4, AC-13. US-2 → AC-4. US-3 → AC-1 (the create_album-then-best_of route), AC-10. US-4 → AC-6, AC-7, AC-8, AC-10. US-5 → AC-9, AC-10, AC-11. US-6 → AC-12. US-7 → AC-5, AC-13.

## Non-goals

- Suggested albums as a `best_of` or proposal source (see Open question 1).
- `best_of` over search filters, dates or people directly: a date range or year becomes an assistant album first (settled in the epic).
- Raw quality scores, moment boundaries or look-alike groups beyond each pick's alternatives in tool results.
- The assistant keeping a pick without the owner: no auto-approve, no "make album" tool for proposals, no setting to skip the review.
- More than one proposal on screen at a time, a queue or history of proposals, or proposals surviving a restart.
- Proposals for anything other than a Best of (a slideshow, saving copies: epic #55 #53).
- Changing the Best of engine, its weights or its reasons for the assistant.
- A pick of more than 200 photos through the assistant.

### Later

- Opt-in thumbnails for the assistant ("the nicer of these two", real captions), under their own ADR: pixels leaving the computer is a bigger step than text.
- Suggested albums for the assistant without their folder names (opaque handles with dates and counts), if creating an album per trip proves clumsy.
- Agent evals (#51) measuring how often the owner approves the assistant's pick unchanged.
- Recipes as MCP prompts (#54) that chain search, `best_of` and `propose_selection` into "a photobook of 2024".
- An "Assistant activity" list showing proposals and their outcomes.

## Safety & privacy

- **Photo folder:** nothing new reads or writes it. `best_of` reads what the Best of engine already stores (quality scores, content vectors, faces) from the app database; the only thing kept is the album the owner makes with the existing "Make album", in the app's own records (ADR 0001 unchanged). Proposals live in memory.
- **Network:** the app still opens no port and makes no network call (ADR 0003, ADR 0011). What the assistant reads may leave the computer as before; the new items are Best of reasons (fixed sentences with a named person's name or the assistant's own focus words) and look-alike alternative ids. ADR 0011 is updated to say so, and that the assistant can bring the window forward with a proposal but can't keep one.
- **Personal data:** nothing new is stored about people. Named people's names were already readable through `search_photos`; reasons add nothing beyond them. Suggested albums stay out, because their names and ids are folder names. Turning access off, forgetting assistants or quitting ends every proposal.
- **Window control:** a new power for the assistant: it can change what the window shows and bring it forward. Limited to opening one Best of screen at a time, never over unsaved Best of edits without the owner's say (AC-7), and only while access is on.

## Product

- **Who it's for:** the owner and power users with assistant access on (spec 0008). It is also the first real test of "it made my photobook" from the brief: the owner approving a pick in a minute. The approve-rate in the evals (#51) tells us whether the in-app photobook recipe should copy this flow.
- **Tiers:** no gating now, as for spec 0008; decide with pricing.
- **Owner-specific assumptions:** the owner's library (measured read-only: 943 photos, all quality-measured, 8 albums of 16 to 106 photos, no assistant albums yet) means the default pick is 12 for most albums; the 6–200 range and 200 cap come from photobook sizes, not from this library. The reason sentences are English, like the app. The create-an-album-first route means a trip or year the owner hasn't made an album of leaves an "AI" album in the sidebar; the approved "Best of …" album is nested inside it, and deleting the AI album keeps the Best of album (it moves up a level, as for any album).

## Design

The UI is the existing Best of screen (spec 0006 Design), opened by the assistant with its pick. Nothing new in the sidebar, no new dialog and no new component: one header `subtitle` (like the assistant album hint of spec 0008), one new reason line, and inline `notice-line`s in the Best of bar like the existing leave prompt. Assistant-facing copy (tool descriptions, errors, notes, statuses) is fixed by AC-1 to AC-9 and not repeated here.

### Where it lives

- **Entry point:** none for the owner to find; a `propose_selection` call opens it. The window shows the Best of screen of the proposal's album: title **"Best of Norway 2024"** as today, the album's name in "Back to Norway 2024".
- **Window:** brought forward on every proposal (opened, restored, shown, focused; taskbar or dock attention where the system refuses focus). No sound, no system notification, no in-app toast.
- **On the way in:** the photo viewer and any open dialog (settings, "Add a photo", Assistant access) close; a grid selection is dropped, as on any navigation. The only unsaved work the app has is an edited Best of, handled under "A proposal arrives over unsaved edits" below.

### The proposal screen (waiting)

- **Header subtitle** (`.subtitle` under the title, where an assistant album shows its hint): **"Picked by your AI assistant for you to look over. Change anything you like; nothing is kept until you press Make album."**
- **Best of bar:** unchanged layout. Subtitle line `40 of 412 photos · 14 moments`; stepper "Show [ 40 ] photos" starting at the number proposed; **[Make album]** with its existing tooltip "Creates a new album with these photos. Nothing is moved or changed on disk."; **[Back to Norway 2024]**; **Reset** only once the pick differs from the proposal.
- **Tiles:** exactly the proposed photos, in capture-time order with day headings, each with the hover ✕, the look-alike stack badge and the "Add a photo…" ghost tile, as today.
- **Reason line** (tile tooltip and the viewer's info panel): **"Picked by your AI assistant"** for each proposed photo still in the pick. A photo the owner swaps in or adds says "You chose this one" as today; a photo the stepper's + adds gets the engine's own reason ("Sharpest of 6 similar photos" and so on).
- **No "AI" pill** on tiles or the title: the subtitle and tooltips say it once without marking 40 tiles.

### Adjusting it (AC-8)

- **✕ / Delete, ⌘Z / Ctrl+Z, swap from the look-alike strip, "Add a photo…":** as spec 0006. Removing makes the pick one smaller (down to 6, after which the engine fills the gap with its own reason, as today).
- **Stepper +:** adds the engine's next-best photos around the assistant's (the proposed ones are fixed and stay).
- **Stepper −:** proposed photos are fixed, so − can't go below the number of fixed photos; there it is disabled with the tooltip **"To show fewer, remove photos with ✕"**. Above that it removes automatic additions, as today.
- **"Focus on…":** works as today, but only guides photos the engine adds. While it has text and the pick is all fixed photos, a `hint` beside it reads **"Your assistant's picks stay; press + to add photos that match."**
- **Reset:** returns to the proposal: the proposed photos, count equal to their number, nothing removed. "Focus on…" text is kept, as Reset keeps it today. It shows only while the photo set or count differs from the proposal; no confirm, as today.
- **Edited** means the set of photos shown differs from the proposal (this is `edited: true` in `proposal_status`). A count change that is undone, or Reset, makes it unedited again.

### Make album

- Same button, tooltip and result as spec 0006: "Best of Norway 2024" (numbered if taken), nested under the source album, an ordinary album of the owner's with no "AI" pill and no assistant hint.
- Notice as today: **"Made the album “Best of Norway 2024” with 39 photos. [Open album]"**
- The header subtitle changes to **"Made from your AI assistant's pick. The album is yours; the assistant can't change it."** The tooltips keep "Picked by your AI assistant".
- Error: **"Couldn’t make the album."** as today; the proposal stays waiting.
- Later edits and a second Make album behave as today; the assistant only hears about the first.

### Leaving

- **[Back to Norway 2024], Esc, or the sidebar:** an unedited proposal leaves at once; an edited one, with no album made, asks first in the bar, as today: **"Leave without making an album?" [Leave] [Stay]**. Leave closes the proposal; Stay keeps it waiting. After Make album, leaving never asks.
- **The source album deleted** (by the owner) while it shows: the screen leaves as for deleting any open album; the proposal is closed.

### A newer proposal

- **Over an unedited or already-made proposal, or an unedited ordinary Best of:** the screen switches to the new pick at once (same or different album) with the notice line **"Your AI assistant sent a new pick."** It clears on the next action, like other notices.
- **Over an edited Best of with no album made** (proposal or ordinary): the window comes forward but the screen doesn't change; the bar shows **"Your AI assistant sent a new pick of “Iceland”. Leave without making an album?" [Leave] [Stay]**, focus on Stay. Leave opens the new proposal (the old one is replaced). Stay, or Esc, closes the new proposal and keeps the owner's screen as it was (an old proposal there stays waiting).
- **While that prompt is up, a third proposal arrives:** the prompt's album name updates to the newest; the one it replaced is replaced.

### Access turned off, or assistants forgotten, while it shows (AC-11)

- The screen stays as it is, with the owner's edits; nothing is reset. It is now an ordinary Best of: Make album, Back, Reset (still to the proposal) all work.
- The header subtitle becomes **"Assistant access is off, so your assistant won't hear what you decide. You can still make the album."** Tooltips keep "Picked by your AI assistant" (it's still true).
- A newer proposal can't arrive; an incoming-pick prompt that was up disappears and the screen is unchanged.

### States

- **Loading:** if the pick takes over 300 ms, the grid line reads **"Opening your AI assistant's pick…"** (instead of "Choosing the best photos…"). On a 5,000-photo album it shows within 2 seconds (AC-13).
- **Populated (waiting):** as above.
- **Edited:** Reset appears; leaving asks.
- **Made:** made notice and made subtitle.
- **Pending analysis:** the existing "Still reading your photos: 112 of 400 done. The choice will improve as it goes." line; it affects only what + adds.
- **Error / too few:** `propose_selection` refuses fewer than 6, so the screen never opens empty. If photos went missing between the call and the screen (a rescan) and fewer than 6 remain, the existing empty state shows: **"Not enough photos to choose from."** [Back to Norway 2024]; the proposal is closed when the owner leaves.
- **Very large library:** the pick is at most 200 photos; the grid and Add a photo picker page as today.
- **Empty library / no access:** no proposal can arrive; nothing changes.

### Keyboard

As spec 0006: Esc leaves (or asks), Delete removes the photo under the pointer, ⌘Z / Ctrl+Z puts it back, arrows step the viewer through the pick. In the incoming-pick prompt, Esc is Stay, Enter on the focused button chooses it.

### Traceability

| AC           | Satisfied by                                                                                                                                                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-1 to AC-6 | No UI (assistant-facing copy in the ACs)                                                                                                                                                                                                                      |
| AC-7         | Where it lives (window forward, viewer and dialogs close); proposal screen: proposed photos only, count = their number, "Picked by your AI assistant" tooltip, waiting subtitle; loading line; incoming-pick prompt over edits (Stay closes the new proposal) |
| AC-8         | Adjusting it (✕, swap, add, stepper, Focus on…); Reset to the proposal; Make album: owner's album, no "AI" pill, made subtitle "the assistant can't change it"                                                                                                |
| AC-9         | waiting = proposal screen; `edited` = Edited definition; approved = Make album (first one counts); closed = Leave, Stay, source deleted, too-few leave; replaced = A newer proposal; expired = access off (and quit, folder change)                           |
| AC-10        | ✕ and swap on the proposal, Make album; "Back to …" on an unedited proposal leaves at once (closed, no album)                                                                                                                                                 |
| AC-11        | Access turned off: screen kept as an ordinary Best of, access-off subtitle, no more prompts                                                                                                                                                                   |
| AC-12        | Make album tooltip ("Nothing is moved or changed on disk"); no stored proposal, nothing on screen survives a restart                                                                                                                                          |
| AC-13        | Loading state within 2 s; very large library state                                                                                                                                                                                                            |

## Open questions

1. **Suggested albums as a source?** _Recommended: leave them out of this version._ Their ids embed the folder name (`f:Norway 2024`) and their names are folder names, which ADR 0011 says never leave. The assistant can still reach a trip: `search_photos` name-matches folder names without saying so, then `create_album` and `best_of`. The cost is an extra "AI" album per trip the owner hasn't made into an album. The alternative is opaque per-connection handles listed with only dates and counts (a new `library_overview` field); useful only if the owner's trips mostly live as suggestions, which the owner can confirm.
2. **How the assistant learns the outcome.** _Recommended: a small `proposal_status` tool, making eight tools in all, one more than the seven first planned._ It is explicit, so a model knows to ask, and it can be polled. Alternatives: a status field added to every later tool result (no new tool, but the assistant only hears when it happens to call something else, and every result grows), or `propose_selection` with only an id to mean "check" (one tool doing two jobs, which models misuse). Neither keeps the call open waiting for the owner, since assistants time out.
3. **How a proposal loads into Best of.** _Recommended: the proposed photos as `fixed`, count equal to their number, nothing excluded,_ so the screen shows exactly the assistant's pick, and raising the stepper adds automatic picks the owner asked for. Reset returns to the proposal, not the automatic pick. Guess to confirm: that you want Reset to go back to the assistant's pick.
4. **Can the assistant propose photos `best_of` didn't pick?** _Recommended: yes, any present photos of the album_ (it may have adjusted the pick on your instruction); the only rule is that they are in the album, because "Make album" keeps only photos of its source.
5. **Whose album is the approved one?** _Recommended: yours (no "AI" marker), since you pressed Make album; the assistant can't change it afterwards._ The alternative (an assistant album) lets it tweak the result later but blurs who decided.
6. **Unsaved Best of edits when a proposal arrives.** _Recommended: the existing "Leave without making an album?" prompt; Stay closes the proposal._ Alternative: hold the proposal behind a notice until you're ready, which is more design and code for a rare case.
7. **Bringing the window forward.** _Recommended: yes, on every proposal (restore and focus; taskbar attention where the system refuses focus)._ The alternative is a quieter notice inside the app, which you might miss while talking to Claude in another window. Say if focus stealing would annoy you.
8. **Counts.** _Recommended: 6–200 for both `best_of` and proposals._ 6 is the Best of minimum; 200 keeps a result under 64 KB and covers photobooks. A guess about your photobook size: say if you want more.
9. **Quality scores to the assistant.** The epic's guardrails allow quality scores, but spec 0008 kept them out. _Recommended: still out; reasons only._ Numbers invite the assistant to re-rank by score alone, undoing the engine's variety, and add nothing you can check.
10. **Alternatives per pick.** _Recommended: up to 5 look-alike ids per pick._ They are already computed, so cheap; more would bloat a 200-photo result.
11. **Tier.** _Recommended: no gating now; decide with pricing,_ as for spec 0008.

## Decisions

- 2026-11-10 (settled in epic #55 and the task, not reopened):
  - `best_of` wraps the existing Best of engine (`BestOfService`, `BestOfRequest`) and returns photo ids in `search_photos`' compact shape plus a short reason per photo from the engine's reasons, and the look-alike alternatives for each pick.
  - A year or date range is handled by the assistant making an assistant album with `create_album` first and running `best_of` on it; the tool description says so.
  - `propose_selection` opens the app's existing Best of screen with the assistant's picks loaded as `fixed`, brings the window forward and returns at once ("waiting for the owner in Photo Library"). The owner swaps, removes and approves with the existing "Make album"; nothing is final without them.
  - Same privacy rules as spec 0008 and ADR 0011: no paths, folder or file names, pixels, places, cameras or hashes; reasons must not leak folder names (the engine's reasons are fixed sentences with only named people's names and focus words).
  - Spec 0008's AC-8 "exactly five tools" is superseded by AC-1 here.
- 2026-11-10, the owner's answers to the open questions (all as recommended): 1. suggested albums are left out (the assistant searches, makes an album, then runs `best_of`); 2. a separate `proposal_status` tool, so eight tools; 3. the proposal loads as `fixed` with count = picks, nothing excluded, and Reset returns to the assistant's pick; 4. the assistant may propose any present photo of the album; 5. the approved album is the owner's (no AI marker); 6. unsaved Best of edits get the existing "Leave without making an album?" prompt, and Stay closes the proposal; 7. the window comes forward on every proposal; 8. counts 6–200 for both tools; 9. no quality scores to the assistant, reasons only; 10. up to 5 alternatives per pick; 11. no paid gating now.
- 2026-11-10, the owner's answers on the design (all as recommended): leaving an unedited proposal doesn't ask first; tooltips keep "Picked by your AI assistant" after access is turned off; no AI pill per tile; − can't shrink below the assistant's picks (remove with ✕); the window comes forward even while the owner is typing in the app.
- 2026-11-10, review: fixed proposals arriving faster than the window renders, a prompt left behind when the owner navigates away, the source album being deleted (now leaves the screen and closes the proposal), a proposal lost to a brand-new window (the preload keeps it until the window subscribes), "edited" worked out from the owner's changes rather than the last answer, the made and access-off subtitles sticking, re-added proposed photos saying "You chose this one", and one focus listener. Not changed: leaving an edited Best of through the sidebar doesn't ask first; that predates this spec (spec 0006) and the Design's "as today" is corrected here. AC-13's 100,000-photo budget is covered by the engine's own test (spec 0006 AC-10), not at tool level. The AC-10 e2e skips where the content model is unavailable, as the other Best of swap tests do.
