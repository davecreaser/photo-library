# 0004: Collapsible sidebar sections

Status: done
Issue: #41

## Problem

The owner: "currently the list of people in the sidebar is always open, we should be able to collapse that for cleanliness." `Sidebar.tsx` lists up to 12 named people under the People row, always, pushing Albums, Tags and the Timeline down; the list grows with every person named. The Timeline years already collapse; People, Albums and Tags do not.

## User stories

- **US-1** As someone who has named people, I want to collapse the people listed under People so that the sidebar stays short and Albums are within reach.
- **US-2** As a user, I want the same for the Albums and Tags lists so that I can keep only what I use on screen.
- **US-3** As a user, I want my choices remembered between launches so that I don't tidy the sidebar every time.
- **US-4** As a user, I want collapsing never to hide where I am or what exists (counts stay, the current view stays marked) so that I don't get lost.

## Acceptance criteria

- **AC-1 People collapse.** The People row has a ▾/▸ toggle (same glyph and style as the Timeline year toggle). With people named, ▸ hides the listed people and ▾ shows them (up to 12, as today). Clicking the toggle does not open the People view; clicking the rest of the row still does. With no named people the toggle is absent.
- **AC-2 People collapsed by default.** On a fresh install, or an upgrade with no saved choice, the people list is collapsed; the owner can expand it.
- **AC-3 Albums and Tags collapse.** The Albums and Tags section headings each have the same toggle. Collapsing hides the whole list (including sub-albums), the "Albums are virtual folders…" hint, and the inline new-album input. Both are open by default, as today. Tags still hides entirely when there are no tags. Timeline is unchanged.
- **AC-4 Counts stay.** A collapsed People row still shows its count (number of people, or analysis percentage while analysing). A collapsed Albums or Tags heading shows how many albums or tags it holds.
- **AC-5 Never hides where you are.** While People is collapsed and the current view is a person, the People row is shown as active (highlighted). While Albums (or Tags) is collapsed and the current view is an album (or tag) inside it, its heading is shown as active in the same way. Collapsing never changes the current view.
- **AC-6 Creating expands.** Pressing ＋ on Albums while it is collapsed expands it first, so the new-album input is visible. Creating an album from elsewhere (for example accepting a suggestion) does not change the collapsed state.
- **AC-7 Remembered.** The collapsed/expanded state of each of People, Albums and Tags survives quitting and relaunching, and is kept in the app's own settings in the app data folder. After relaunch, a choice the user made (open or closed) wins over the defaults in AC-2/AC-3. Changing the photo folder does not reset it.
- **AC-8 Keyboard and accessibility.** The toggles are reachable with Tab and operate with Enter/Space, and expose their state (`aria-expanded`) and a label ("Show people" / "Hide people", etc.).
- **AC-9 Safe and cheap.** Only a setting in the app data folder is written; the photo folder is unchanged against its snapshot and the safety audit passes with no new exceptions (ADR 0001); nothing uses the network (ADR 0003). Toggling a section is instant with a library of 100,000 photos and with 500 albums, and the first paint on launch uses the saved state (no flash of the wrong state).
- **AC-10 Resilient.** A missing or unreadable saved value falls back to the defaults without error.

## Non-goals

- Collapsing Suggested albums, Favourites, All photos or the footer.
- Collapse-all / expand-all, drag-reordering sections, or resizing the sidebar.
- Raising or removing the 12-people limit, or showing the current person while People is collapsed.
- Collapsing individual albums (sub-album trees).
- Remembering which Timeline years are open (stays as today).

## Safety & privacy

- Photo folder: nothing new reads or writes it. A UI preference is stored through the existing `settings` table (`db.setSetting`), in SQLite under the app data folder, whose path is already checked.
- Network: none.
- Personal data: none new. The saved value records only open/closed per section, not any names.

## Product

Free tier, nothing assumes the owner's library. "Collapsed by default" applies to People only (owner's answer); Albums and Tags stay open by default because they are the main way to reach a collection.

## Design

### Where it lives

The left sidebar. A toggle on the 👤 People row, and on the Albums and Tags section headings (`h2`).

### States

- **People, collapsed (default):** `▸ 👤 People` with count (e.g. `7`) at the right; named people hidden. If the current view is a person, the People row has the active highlight.
- **People, expanded:** `▾ 👤 People`, the people listed beneath as today.
- **People, none named:** no toggle (a blank slot keeps the label aligned, as the Timeline "Undated" row does with an empty `disclosure`).
- **People, analysing:** count slot shows the percentage as today, collapsed or not.
- **Albums/Tags heading:** `▾ ALBUMS  3  ＋` / `▸ ALBUMS  3  ＋`. The count is muted, between the label and ＋ (Tags has no ＋). Collapsed with the current view inside: heading text in the active accent.
- **Large library:** state is a boolean per section; nothing depends on library size. Long album trees simply hide.
- **Error/missing setting:** defaults (People ▸, Albums ▾, Tags ▾).

### Copy

- Toggle tooltips and accessible labels: "Show people" / "Hide people", "Show albums" / "Hide albums", "Show tags" / "Hide tags".
- No new visible text otherwise; the existing albums hint is shown only while Albums is expanded.

### Interactions

- Click ▾/▸ (stopPropagation, like year toggles): toggles that section only; the view does not change.
- Clicking the People row label/count still opens the People view; it does not toggle.
- Clicking an Albums/Tags heading's toggle or the heading text toggles it (headings have no view of their own).
- ＋ on Albums when collapsed: expands, then shows the new-album input.
- Enter/Space on a focused toggle activates it. The state is saved on each change and loaded before first paint.
- No undo needed: the toggle is its own undo.

### Components reused

The Timeline `disclosure` span and its ▾/▸ glyphs; the `.nav-item` and `.sidebar h2` styles. The toggle becomes a `<button class="disclosure">` styled like the span so it can take focus. Persistence via a small IPC get/set over the `settings` table (key `sidebarSections`, JSON of booleans).

### Traceability

AC-1/2: People row states. AC-3/4: Albums/Tags heading. AC-5: active highlight rules. AC-6: ＋ interaction. AC-7/10: saved state, defaults. AC-8: button + aria. AC-9: settings-only write, boolean state.

## Open questions

1. Should Albums and Tags also start collapsed? Recommended: no (open, as today); only People starts collapsed per the owner's answer to question 2.

## Decisions

- 2026-11-06: Remember the state between launches (idea question 1; recommended answer, owner approved).
- 2026-11-06: People is collapsed by default (idea question 2; owner: yes).
- 2026-11-06: If a person is the current view while People is collapsed, show no extra person row; the People row is highlighted instead (idea question 3; recommended answer).
- 2026-11-06: Albums and Tags can also be collapsed (idea question 4; owner: yes). Whether they start collapsed is open question 1.
- 2026-11-06: Albums and Tags start open (open question 1; owner replied `go`, so the recommended answer).
