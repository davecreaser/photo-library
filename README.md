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

Specs live in `docs/specs/`; features go through `/feature`.

1. ~~Events, clock fixes, duplicates, favourites~~ (done)
2. ~~Faces~~ (done)
3. ~~Suggested albums~~ (spec 0001, done)
4. **Search by content** (spec 0002, in progress): a local CLIP-style model and a vector index, so "beach", "snow" or "birthday cake" work without tags.
5. **Best photos** (spec 0003): near-duplicate detection (from the content embeddings), quality scores (sharpness, exposure, eyes open) and "pick a diverse set of N" (covering days and people). Useful on its own as a "Best of" view for any album or suggestion.
6. **Local app API**: a localhost-only API (search, people, events, albums, best photos, export copies, render slideshow) that tools and agents can call. The app itself stays local-only.
7. **Recipes with n8n**: n8n chains the app's building blocks for a job, with a human approval step and optional delivery to outside services (which the app never does itself).
   - First recipe: **trip slideshow** ("make me a slideshow of our holiday to Poland"): pick the best ~40, approve or swap them in a form, render a video to `~/Movies`.
   - Then: **photobook selection** ("best of 2026 as a present"): an album of the best ~60 plus a folder of copies ready for the print shop.
   - Popular recipes become built-in buttons later ("Make slideshow" on an album).
8. **Ask your library**: an n8n AI agent using the local API as tools ("when did we last go to Poland?", "Jake at the beach last summer"), with a local model (Ollama) or opt-in Claude for text only. This is the prototype for in-app natural-language search (RAG over the library).
9. **Places:** reverse-geocode GPS offline to country/city.
10. Optional (opt-in) Claude API captions, if the local models aren't good enough.
