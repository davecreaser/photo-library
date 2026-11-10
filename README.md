# Photo Library

A personal, local-only desktop app (Electron + React + SQLite) for browsing and organising the photos from my camera.

- **Read-only.** Photos are never moved, renamed, modified or deleted. All organisation (albums, tags) lives in the app's own database.
- **Ignored folders** (sidebar → "Ignored folders…"): skip any folder by name (`private` by default, at any depth) or a specific folder. Nothing from them is indexed, thumbnailed or analysed; remove the rule to bring them back.
- **Virtual folders.** Albums can be nested, and a photo can be in any number of them.
- **Browse by date** via the Timeline (year → month), using EXIF capture dates (falls back to the file date).
- **Search** with free text: `august 2020`, `2020-08`, `spain`, `jake birthday`. Dates become date filters; other words match folder/file names, album names and tags.
- **Search by content:** `beach`, `snow`, `sunset over water`, `jake beach 2025`. Each photo is analysed once, on this computer, in the background (SigLIP); photos that match by name come first, then photos that look like what you typed, best match first.
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
npm install        # also downloads the face and content-search models (~39 MB + ~407 MB, checksum-verified)
npm run dev        # development with hot reload
npm run build && npm start
npm test           # unit + integration tests
npm run typecheck
```

## Architecture

[`docs/architecture.html`](docs/architecture.html) walks through how the app is built: its processes, the five layers that keep the photo folder read-only, one photo's path from scan to search and Best of, the data model, assistant access and its evals. Open it in a browser (download it, or clone the repo).

## AI assistants (assistant access)

Claude, or any MCP client, can search the library and make albums of its own (spec 0008, ADR 0011). It never sees the photos, file or folder names, or places; it sees dates, album and people's names and favourites, which a cloud assistant may send to its company's servers. Off by default.

1. Build once (`npm run build`), start the app, and in the sidebar open **Assistant access…** and tick **Let AI assistants use this library**.
2. Copy the setup the dialog shows (it contains this library's secret key):
   - **Claude Desktop:** Settings › Developer › Edit Config, add the `photo-library` entry, restart Claude Desktop. It looks like:
     ```json
     {
       "mcpServers": {
         "photo-library": {
           "command": "node",
           "args": ["<repo>/out/main/relay.js"],
           "env": { "PHOTO_LIBRARY_SOCKET": "<app data>/assistant/assistant.sock", "PHOTO_LIBRARY_TOKEN": "<secret key>" }
         }
       }
     }
     ```
   - **Claude Code:** `claude mcp add --scope user photo-library --env 'PHOTO_LIBRARY_SOCKET=…' --env 'PHOTO_LIBRARY_TOKEN=…' -- node '<repo>/out/main/relay.js'`
3. Ask for the best photos of an album or a year: the assistant uses the app's Best of (it can see sharpness and look-alikes; the assistant can't) and opens its pick in Photo Library for you to adjust and keep with **Make album** (spec 0009). Nothing is kept until you do.
4. Keep Photo Library open while the assistant works. Needs Node.js 22.18 or later. Turning the switch off, or **Forget connected assistants**, cuts assistants off at once.

### Measuring how well assistants use the tools (evals)

`scripts/agent-eval/` (spec 0010) runs ten fixed requests ("make an album of the Norway trip", "pick the best 12 of Sintra for me to look over", …) through Claude Code headless against the built app, and grades what ends up in the library, not what Claude says. Use it to see whether a change to a tool's description or result made Claude better or worse.

```sh
npm run build
node scripts/agent-eval/run.ts --dry-run                 # the tasks and the worst-case cost; no model, no network
node scripts/agent-eval/run.ts                           # 10 tasks × 3 runs, default model claude-sonnet-5-5
node scripts/agent-eval/run.ts --task trip --runs 5      # one task, more runs
node scripts/agent-eval/run.ts --save-baseline           # record the numbers to compare later changes with
node --test "scripts/agent-eval/*.test.ts"               # the graders and report, without a model
```

- **By hand only, never in CI.** It uses the network and costs money: each run is capped (30 turns, $1), and a whole eval above `--budget` ($15) needs `--yes`. With `ANTHROPIC_API_KEY` set it runs isolated with `--bare`; otherwise it uses your Claude login with your settings left out.
- **Generated photos only.** The first run builds a generated library (about 570 images, placeholder people "Alex" and "Sam") and its app data in `~/.cache/photo-library-eval/agent/`, once per app version. Every run works on a throwaway copy; the photo folder is checked before and after each run, and the eval stops if anything in it changed. Never point it at a real library: it refuses a folder it didn't generate, and the app's real data folder.
- **What leaves the computer:** the prompts and the generated library's tool results go to the model provider while the eval runs. Transcripts and reports stay in the cache; the only committed output is `baseline-<model>.json`, numbers only.
- **Reading the results:** a difference of one run in three is noise; use `--runs 5` before deciding. For the Best of tasks, "would approve unchanged" is a proxy (the size asked for, no near-duplicates, everyone in it, overlap with the app's own pick): generated photos can't tell whether you'd like them.

## Where data lives

`~/Library/Application Support/photo-library/`:

- `library.db`: SQLite index, albums, tags, settings
- `cache/thumb`, `cache/preview`: generated thumbnails/previews (safe to delete; they regenerate)

## Roadmap

Specs live in `docs/specs/`; features go through `/feature`.

1. ~~Events, clock fixes, duplicates, favourites~~ (done)
2. ~~Faces~~ (done)
3. ~~Suggested albums~~ (spec 0001, done)
4. **Search by content** (spec 0002, in review): a local CLIP-style model (SigLIP) and a vector index (sqlite-vec), so "beach", "snow" or "birthday cake" work without tags.
5. **Best photos** (spec 0003): near-duplicate detection (from the content embeddings), quality scores (sharpness, exposure, eyes open) and "pick a diverse set of N" (covering days and people). Useful on its own as a "Best of" view for any album or suggestion.
6. **Assistant access** (spec 0008, epic #55): an MCP server inside the app on a local socket (no port), so Claude can search and make albums; then Best of and proposals, slideshow and copies, and recipes as prompts. Replaces the localhost API + n8n plan.
7. **Recipes with n8n**: n8n chains the app's building blocks for a job, with a human approval step and optional delivery to outside services (which the app never does itself).
   - First recipe: **trip slideshow** ("make me a slideshow of our holiday to Poland"): pick the best ~40, approve or swap them in a form, render a video to `~/Movies`.
   - Then: **photobook selection** ("best of 2026 as a present"): an album of the best ~60 plus a folder of copies ready for the print shop.
   - Popular recipes become built-in buttons later ("Make slideshow" on an album).
8. **Ask your library**: an n8n AI agent using the local API as tools ("when did we last go to Poland?", "Jake at the beach last summer"), with a local model (Ollama) or opt-in Claude for text only. This is the prototype for in-app natural-language search (RAG over the library).
9. **Places:** reverse-geocode GPS offline to country/city.
10. Optional (opt-in) Claude API captions, if the local models aren't good enough.
