# Photo Library

A personal, local-only desktop app (Electron + React + SQLite) for browsing and organising the photos from my camera.

- **Read-only.** Photos are never moved, renamed, modified or deleted. All organisation (albums, tags) lives in the app's own database.
- **Ignored folders** (sidebar → "Ignored folders…"): skip any folder by name (`private` by default, at any depth) or a specific folder. Nothing from them is indexed, thumbnailed or analysed; remove the rule to bring them back.
- **Virtual folders.** Albums can be nested, and a photo can be in any number of them.
- **Browse by date** via the Timeline (year → month), using EXIF capture dates (falls back to the file date).
- **Search** with free text: `august 2020`, `2020-08`, `spain`, `jake birthday`. Dates become date filters; other words match folder/file names, album names and tags.
- **Formats:** JPEG/PNG/WebP/GIF natively; HEIC, TIFF and RAW (CR2/CR3/NEF/ARW/DNG/…) via macOS `sips` or the embedded preview.
- **Photos are identified by content (SHA-256).** Move, rename or copy files, or point the app at a new folder holding the same photos, and albums, tags and favourites stay. Identical copies show once.
- **Events & trips** are detected automatically from your folder names and gaps in time. Keep one permanently with "Save as album".
- **Camera clock fixes:** the app spots a camera whose clock was wrong (by comparing with folder names like `08.25.sail_amsterdam`) and corrects dates with one click, inside the app only.
- **Favourites:** star any photo.
- **Merge events:** one trip split over several days? Select the events and merge them ("Norway"), or rename one. Photos added later within those dates join it.
- **People:** faces are found and grouped locally. Type a name once per group and future photos of that person are recognised; search "jake". Wrong match? One click, and it won't happen again.
- **Incremental rescans.** Files that disappear (e.g. an unplugged drive) are hidden, not forgotten, and keep their albums/tags when they come back.

## Run

```bash
npm install        # also downloads the two face models (~39 MB, checksum-verified)
npm run dev        # development with hot reload
npm run build && npm start
npm test           # unit + integration tests
npm run typecheck
```

## Where data lives

`~/Library/Application Support/photo-library/`:

- `library.db`: SQLite index, albums, tags, settings
- `cache/thumb`, `cache/preview`: generated thumbnails/previews (safe to delete; they regenerate)

## Roadmap

1. ~~Events, clock fixes, duplicates, favourites~~ (done)
2. ~~Faces~~ (done)
3. **Semantic search:** local CLIP embeddings so "beach", "snow" or "birthday cake" work without tags.
4. **Places:** reverse-geocode GPS offline to country/city.
5. Optional (opt-in) Claude API captions, if the local models aren't good enough.
