# Exports may write to one folder the user picked, granted per export

Amends ADR 0001. "Save copies to a folder" (spec 0007) is the first feature that writes outside the app's data folder. Instead of loosening the guard, each export gets a temporary grant for exactly one place: a new sub-folder, made inside the folder the user chose in the system dialog, for that export only. The grant is never saved, is revoked when the export finishes, is cancelled or fails, and only one can exist at a time.

Everything else in ADR 0001 stays: the photo-folder rule still wins over the grant (a destination inside any photo folder ever chosen, or reached through a symlink into one, is refused), the app data folder is refused, `appFiles.ts` is still the only writer, and the renderer never supplies a path. Files are created without overwriting. Copies of the originals' bytes are read from the photo folder and written to the destination; the originals are only ever read.

## Consequences

- `test/safety.test.ts` attacks the grant: outside the granted folder, inside a photo folder, after the export ended, through a symlink, and via `..`.
- The alternative, letting the user drag files out or write wherever, was rejected: it would need the guard to trust arbitrary paths.
