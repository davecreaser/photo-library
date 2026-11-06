# The photo folder is read-only; all organising is virtual

The app never creates, changes, moves, renames or deletes anything in the photo folder, including EXIF data and sidecar files. Albums, tags, favourites, names, events and clock corrections live only in the app's own database. The obvious alternative, organising by moving files into folders and writing metadata into them, was rejected: the owner's first requirement was that photos can never be lost or damaged by the app, and they may also be organised by other tools.

## Consequences

- Fixes to data in the files (e.g. a wrong camera clock) are applied as corrections at read time, never written back.
- This is enforced in layers, not by convention: a process-wide filesystem guard that refuses writes inside any photo folder ever chosen (and anywhere outside the app's data folder), a single module allowed to write, external tools only ever given copies, and tests that audit the source and attack a protected folder. Weakening any layer needs a new ADR.
