# 0007: Save copies to a folder

Status: done
Issue: #7

## Problem

"The print shop and my nephew's slideshow app want a folder of JPEGs. My photos are RAW and HEIC files scattered over folders, and I'm scared of messing them up." Today the only way to hand photos to anything else is to dig the files out of the photo folder by hand, convert them, and hope nothing gets moved or renamed on the way. The app should make a clean folder of copies in one step, and never touch the originals.

## User stories

- **US-1** As someone preparing photos for a print shop or a slideshow, I want to save the photos I selected, or a whole album, as a folder of JPEGs so that I can hand the folder over.
- **US-2** As that user, I want RAW and HEIC photos converted to JPEG, and the files numbered in order, so that any app or shop can use them and shows them in the right order.
- **US-3** As that user, I want an optional size limit and capture times (after clock correction) in the file names so that files fit the shop's limits and sort by when the photo was taken.
- **US-4** As someone scared of messing things up, I want to be sure the originals are never changed, and that the copies are never placed inside my photo folder.

## Acceptance criteria

Terms. An **export** is one "Save copies" run: it writes new files into a **destination folder** the user picks for that run only. Copies are new files; the photo's copies in the photo folder are only read.

- **AC-1 Entry points.** "Save copies…" is in the selection bar (for the selected photos) and in an album's header (for all photos in the album, including photos of albums inside it). It is not offered with nothing selected or in an empty album. Missing photos are left out, and the dialog says how many.
- **AC-2 Destination.** The user picks the destination folder with the system folder dialog (which can create a new folder). Files are written into a new sub-folder named after the album (or "Photos") plus the date, so nothing existing is overwritten; if that name exists, a number is added ("Sintra 2", never replacing). A destination inside any photo folder ever chosen, or inside the app's data folder, is refused with a message before anything is written. The choice is not remembered as a permission: the next export asks again.
- **AC-3 Files.** Every photo becomes one JPEG. A JPEG is copied byte for byte (so its quality and EXIF are unchanged) unless a size limit applies. RAW and HEIC (and other non-JPEG formats) are converted to JPEG at quality 92, upright, in sRGB, using the same decoding as thumbnails (embedded preview for RAW, `sips` on macOS, with a fallback where it is missing). A photo that cannot be read or converted is skipped and listed at the end; the rest are still saved.
- **AC-4 Order and names.** Files are numbered in capture-time order (undated photos last, in folder-and-name order): `0001.jpg`, `0002.jpg`, … with enough digits for the count. Option "Add the date to file names" gives `0001 2024-07-14 1032.jpg` using the capture time after clock correction (not the recorded time), and nothing for undated photos. Names contain no characters that Windows, macOS or Linux refuse. A photo is a photo, so the same photo selected twice, or present as two copies, is saved once.
- **AC-5 Size limit.** Option "Longest side": Original (default), 4000, 2000 or 1600 pixels. Photos smaller than the limit are not enlarged. A JPEG at the original size is copied untouched; a resized one is re-encoded at quality 90.
- **AC-6 Progress and cancel.** A progress bar shows "Saving 37 of 120". The app stays usable. "Cancel" stops after the file in progress and keeps what was saved so far, saying how many were saved. Saving 5,000 photos does not hold them all in memory (one or a few at a time).
- **AC-7 Result.** On finishing, the dialog says "Saved 118 of 120 copies to <folder>", names the skipped photos and why, and has a "Show in folder" button. A full disk or unwritable destination stops the export with a clear message and the number saved.
- **AC-8 Originals untouched.** Before and after an export, every file in the photo folder is byte-identical (same names, sizes, modification times). Nothing is added to the photo folder, not even temporary files.
- **AC-9 Guard rule.** The filesystem guard allows writes to exactly one extra place per export: the destination sub-folder the user just picked, granted for that export only and never persisted. It is refused if inside a protected root (that rule still wins) or the app data folder, and revoked on finish, cancel or error. Outside an export the guard behaves as before. This amends the layers of ADR 0001 and is recorded in a new ADR. `test/safety.test.ts` additionally attacks the grant: writing outside the granted sub-folder, inside a photo folder, after the export ended, through a symlink in the destination pointing into a photo folder, and via `..`.
- **AC-10 One writer.** Export writing lives in `appFiles.ts` (still the only writer), takes the granted folder from the guard, and is covered by the source audit. The renderer never supplies a path: the destination comes only from the folder dialog in the main process.
- **AC-11 Nothing leaves the computer.** No network is used. The only thing stored is a setting remembering the last options (size limit, date in names), never the destination.
- **AC-12 Large libraries.** Exporting 1,000 JPEGs without a size limit takes no more than a few seconds beyond disk speed; the UI never freezes; and the album header and selection bar do not slow down at 100,000 photos.

## Non-goals

- Anything that sends photos anywhere (upload, print-shop ordering, sharing links, email).
- Other formats (PNG, WebP, HEIC) or other quality settings; stripping EXIF or location; watermarks.
- Exporting videos, sidecars, or people/tag data; writing a manifest.
- Remembering the destination, or exporting on a schedule.
- Moving or replacing the originals with the copies.
- Editing photos (cropping, rotating, colour).

## Safety & privacy

- Photo folder: only read. This is the first feature that writes outside the app's data folder, so it needs a new guard rule (AC-9), recorded in a new ADR amending ADR 0001: writes only into the one destination sub-folder the user picked for that export, never inside any photo folder, never persisted. Every other layer stays: single writer module, tests that audit `src/` and attack the guard, and the content worker still has no writable roots.
- Copied JPEGs keep their EXIF, including where the photo was taken. The dialog says so, so the user knows before handing them over.
- Network: none (ADR 0003).
- Personal data: nothing new is stored about people.

## Product

No tier impact; this is the hand-off step for every later outcome (slideshow, photobook). Nothing assumes the owner's library: folder and file names come from the user's own album names.

## Design

**Where it lives.** A "Save copies…" button in the selection bar next to "Add to album", and one in an album's header. Both open the same modal dialog (existing modal pattern).

**Dialog states.**

1. _Options._ Title "Save copies of 24 photos". Text: "Makes a new folder of JPEG copies. Your photo folder is not touched." Fields: "Longest side" select (Original, 4000 px, 2000 px, 1600 px) and checkbox "Add the date to file names". Note: "RAW and HEIC photos are converted to JPEG. Copies keep each photo's information, including where it was taken." If some are missing: "3 missing photos will be left out." Buttons: "Choose folder…" (primary), "Cancel".
2. _Folder refused._ Inline error under the buttons: "That folder is inside your photo folder. Choose somewhere else, such as Desktop or Documents."
3. _Saving._ Progress bar and "Saving 37 of 120". Button "Cancel" (copies already saved stay).
4. _Done._ "Saved 118 of 120 copies to Sintra 2024-07-14." Buttons "Show in folder", "Done". If any were skipped: a scrolling list "Couldn't save: IMG_0412.CR3 (couldn't be read)".
5. _Cancelled._ "Stopped. 37 copies were saved to Sintra 2024-07-14." Same buttons.
6. _Error._ "Couldn't save to that folder: the disk is full. 37 copies were saved." Buttons "Choose another folder…", "Done".

Empty state: the selection-bar button exists only with a selection; the album-header button is absent for an empty album. Very large selections show only the count in the title.

**Interactions.** Enter on the options chooses the folder; Esc cancels before saving and acts as Cancel while saving; the options are remembered for next time, the folder is not. Focus returns to the button that opened the dialog.

**Traceability.** AC-1 buttons and missing note; AC-2 states 1–2; AC-3, 4, 5 option fields and note; AC-6 state 3; AC-7 states 4–6; AC-8–10 no UI (tests); AC-11 remembered options; AC-12 progress state.

## Open questions

1. Where do the copies go inside the chosen folder: a new sub-folder (e.g. "Sintra 2024-07-14") or straight in? **Recommended: a new sub-folder**, so nothing existing is overwritten and the guard grant is narrow.
2. Should JPEGs at original size be copied byte for byte (keeping EXIF, including location) rather than re-encoded? **Recommended: yes**, with the location note in the dialog; stripping location is a later option.
3. Size-limit choices: Original, 4000, 2000, 1600 px? **Recommended: yes.**
4. File names: plain numbers by default, capture date as an option? **Recommended: yes**, date off by default.
5. Should an album export include photos in albums inside it? **Recommended: yes.**

## Decisions

The owner replied `go` without changes, so the recommended answers apply:

1. Copies go into a new sub-folder of the chosen folder, named after the album (or "Photos") plus the date; if it exists, a number is added ("Sintra 2024-07-14 2").
2. JPEGs at original size are copied byte for byte, keeping EXIF including location. The dialog says "JPEG copies keep each photo's information, including where it was taken": resized JPEGs keep their metadata too, but RAW/HEIC conversions carry only what the decoder provides, so the note speaks of JPEG copies.
3. Size choices: Original, 4000, 2000, 1600 px.
4. Plain numbers by default; the capture date is an option, off by default.
5. An album export includes photos in albums inside it.

Recorded in ADR 0010.
