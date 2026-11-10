# 0008: Assistant access

Status: approved
Issue: #49 (connect and read) and #50 (make albums), built together; epic #55

## Problem

"I want to ask Claude about my photos ('when were we last in Poland?', 'Jake at the beach last summer') without building a UI for every question. And when Claude has found the photos, I want them in an album, not a list of ids." Today the only way to answer a question like that is to search in the app yourself, one view at a time, and the only way to keep the result is to select and add the photos by hand. An AI assistant the owner already uses (Claude Desktop, Claude Code) could do the asking and the gathering, if the app let it, safely: it must not see the photos themselves or where they are on disk, must not be able to touch the files, and must be off unless the owner turns it on.

## User stories

- **US-1** As the owner, I want to ask my AI assistant questions about my library (when, how many, who, what's in them) so that I get answers without clicking through views.
- **US-2** As the owner, I want the assistant to put the photos it found into an album so that the result is kept in the app, where I can look at it, change it or delete it.
- **US-3** As the owner, I want assistant access off until I turn it on, and to be able to turn it off or cut off every connected assistant at any time, so that I stay in control.
- **US-4** As someone who keeps photos off the cloud, I want to know exactly what the assistant can see (and that it never sees the photos themselves, where they are, or anything in an ignored folder) so that turning it on is an informed choice.
- **US-5** As the owner, I want to connect Claude Desktop or Claude Code by copying one snippet from the app so that setup takes a minute.
- **US-6** As the owner, I want to be sure the assistant can't change my files or my own albums, and that whatever it makes I can undo in the app, so that trying it is risk-free.

## Acceptance criteria

Terms. **Assistant access** is the setting. The **server** is the MCP server inside the app's main process, listening on a **local socket** (a Unix domain socket on macOS and Linux, a named pipe on Windows). The **relay** is the small command an assistant launches; it forwards bytes between its stdin/stdout and the local socket. The **token** is a random secret the relay must present. An **assistant album** is an album made through `create_album` that the owner hasn't changed since (AC-13). Tests drive the server with an MCP client over a real local socket (`node --test`), and the window with Playwright (e2e), on generated libraries only.

- **AC-1 Off by default, opt-in per library.** A new library, and every existing library after upgrading, has assistant access off: no socket file or pipe exists and nothing listens. The settings area has one switch ("Let AI assistants use this library", final copy from design) with a short explanation of what an assistant can and cannot see (AC-14) and that the assistant may send what it reads to its provider's servers. Turning it on starts the server within 1 second; the choice is stored in the library's settings and survives restarts. Choosing a different photo folder turns it off (see Open question 9).
- **AC-2 Setup snippets.** While access is on, settings shows, with copy buttons: the JSON entry for Claude Desktop's config and the `claude mcp add` command for Claude Code. Both run the relay with `node` from the repo's build output (absolute path) and pass the socket location and the token as environment variables. Paths and quoting are correct for the platform (Windows backslashes escaped in the JSON); pasting either one as shown connects successfully (e2e: run the shown command and call `library_overview`). The README has the same instructions, without a real token.
- **AC-3 The relay only relays.** The relay's source imports nothing but stdio and socket APIs: no `fs`, database, `child_process` or network module (the source audit enforces it, stricter than for the rest of `src/`). When the app isn't running, access is off, or the socket can't be reached, it answers every MCP request within 2 seconds with an error whose text contains "Open Photo Library and turn on assistant access", and stays running. If the app becomes reachable later in the same session, the next request is forwarded and works without restarting the assistant. When the assistant closes stdin, the relay exits. It never logs the token.
- **AC-4 Local socket, owner only, no port.** On macOS and Linux the socket is `assistant/assistant.sock` in the app data folder; the `assistant` folder is mode 0700 and the socket 0600 (checked with `stat` in tests). On Windows it is a named pipe whose name is derived from the data folder, and it refuses remote clients. The server never listens on a TCP or UDP port: its address is a path or pipe name, and the source audit refuses `listen` with a port number and any `http`/`https`/`dgram` server in `src/`. The same server and relay tests pass on macOS, Linux and Windows CI.
- **AC-5 Token.** The token is 32 random bytes, created when access is first turned on, kept in `assistant/token` (mode 0600 on macOS/Linux) and never in the database, logs or any tool result. A connection must present it as its first message within 5 seconds; a missing or wrong token (compared in constant time) gets the error "This assistant's setup is out of date: copy it again from Photo Library's settings" and is closed, and no tool runs (tested: wrong token, no token, token sent late, token for another data folder).
- **AC-6 Socket file lifecycle.** The socket path is checked with `assertWritable` before listening (it is created natively, like the database). Creating the folder, writing the token, setting permissions and removing a stale socket go through `appFiles.ts`. A socket file left by a crash is removed on start only if it is a socket inside the `assistant` folder and nothing answers on it; a live one (another running copy of the app on the same data folder) is left alone and settings says assistant access is in use by another Photo Library window. Any failure to start (that, a path too long for the system, permissions) shows "Couldn't start assistant access" with the reason in settings, leaves the switch off, and the rest of the app works normally. Quitting the app closes the socket and removes the file.
- **AC-7 Turning off and forgetting.** Turning access off closes the socket and every connection within 1 second and removes the socket file; calls in flight are answered with "Assistant access was turned off in Photo Library" and none of them leaves a half-made change (each album change is one transaction: all of it or none). "Forget connected assistants" (in settings, while on) replaces the token and closes every connection; a relay with the old token gets the AC-5 error, and the newly shown snippets work.
- **AC-8 Exactly five tools.** `tools/list` returns `library_overview`, `search_photos`, `create_album`, `add_to_album` and `remove_from_album`, nothing else (no delete, rename, move, tag, star or export). Each description says, for a model, what the tool returns, its limits (page size, ids per call), and one example call. Errors are plain sentences that say what to do next ("No person named 'Jak'. Named people: Jake, Anna, …"), never stack traces or internal messages; unexpected internal errors become "Photo Library couldn't do that: something went wrong inside the app".
- **AC-9 `library_overview`.** One call returns, compactly: photos in the library (present photos only) and how many are undated; photos per year; albums (id, name, parent id, photo count, first and last capture date, whether it is an assistant album); named people with photo counts; and content analysis progress ("analysed 400 of 943"). An empty library (no photo folder chosen, or no photos) returns zeros and the note "No photos yet: choose a photo folder in Photo Library". Suggested albums, face groups, tags, clock corrections and settings are not included.
- **AC-10 `search_photos`.** Inputs: optional free `text` (run through the existing search, so dates and people's names in it filter and the rest is a content phrase, exactly as in the app's search box), optional `from`/`to` capture dates (`YYYY-MM-DD`, inclusive; undated photos are excluded when either is given), optional `people` (names; a photo must show all of them), optional `album_id`, `offset`, and `limit` (default 50, at most 200). The result gives `total` first, then the page: per photo its id, capture date and time to the minute (or null), people's names, albums (id and name), whether it's a favourite, and why it matched: `name` (a name match), `content` with its rank, or `filter` (no text). Order and total are the same as the app's search with the same text and filters (test: the same ids as `PhotoSearch.query`). Paging is stable: page 2 continues page 1 even if more photos are analysed meanwhile, and an assistant search never disturbs the paging of a search open in the window. Zero results is `total: 0`, not an error.
- **AC-11 Search inputs and partial content search.** Bad input gets an AC-8 error naming the field: dates not `YYYY-MM-DD` or `from` after `to`, an unknown person (listing named people, at most 50), an unknown `album_id`, `limit` outside 1–200, no input at all is allowed (all photos, newest first). While content analysis is unfinished the result notes "content search covers 400 of 943 photos so far"; when the content model is unavailable it notes "content search is unavailable; only name matches are listed" and returns the name matches.
- **AC-12 Album tools.** `create_album(name, photo_ids?)` makes a top-level album: the name is trimmed, 1–100 characters, and refused if any album already has it (ignoring case), with the existing album's id in the error, so a retried call never makes a duplicate. `add_to_album` and `remove_from_album(album_id, photo_ids)` work only on assistant albums; on any other album they refuse with "That album is the owner's; you can only change albums you made". Every call takes at most 1,000 photo ids and returns what changed: album id and name, `added` or `removed` count, and the ids that were already there/not there and the ids not found. Ids of unknown, forgotten (including ignored-folder) or missing photos are reported as not found and never added. Repeating a call changes nothing more.
- **AC-13 Marked, and undone in the app.** Assistant albums show a marker in the sidebar (design settles it) and appear in the open window within 1 second of the call, without reloading. As soon as the owner renames, moves, or adds or removes photos in one, it becomes an ordinary album: the marker goes and the assistant can no longer change it. Deleting an assistant album in the app undoes everything the assistant did to it, as for any album. Stored as one new column on albums (`SCHEMA_VERSION` bump with a migration that keeps albums, tags, names and settings, plus a test).
- **AC-14 Privacy and safety.** On a generated library whose folder and file names contain sentinel words, with photos in an ignored folder (default `private/` and a path rule) and GPS in EXIF, no byte the server sends (tool results, errors, descriptions, server info) across every tool, success and error path contains: any path or part of one, a folder or file name, the photo folder's name, a content hash, coordinates, camera model, pixels or image data, or any id of a photo that is in an ignored folder. Name matches caused by folder or file names are reported as `name` without saying which name. No tool accepts a path. An e2e session that turns access on, runs all five tools and turns it off leaves the photo folder byte-identical (snapshot before and after, excluding `.DS_Store`); the app makes no network connection; `test/safety.test.ts` also attacks the new `appFiles.ts` functions with targets inside a protected folder; and ADR 0011 (amending ADR 0003) is written.
- **AC-15 Large libraries and several assistants.** On a generated library of 100,000 photos, 500 albums and 200 people: `library_overview` answers within 1 second in under 64 KB of JSON; a filter or name-only `search_photos` page answers within 2 seconds, and a page of 200 is under 40 KB; content search is as fast as in the app (spec 0002). The window stays responsive while the assistant searches. Two assistants connected at once (e.g. Claude Desktop and Claude Code) each get correct, separate results.

## Non-goals

- Deleting, renaming or moving albums, or changing the owner's albums, through the assistant. Undo is the app's existing delete.
- An "Assistant activity" list (deferred by the epic's decisions).
- Anything with pixels: thumbnails, previews or captions sent to the assistant.
- Places, GPS, cameras, tags, clock corrections, suggested albums, face groups or quality scores in tool results.
- Best of, proposals, slideshows, saving copies, recipes as MCP prompts (epic #55: #52, #53, #54) and agent evals (#51).
- An installer or packaged relay binary; one setting per assistant; network transports (HTTP/SSE) of any kind.
- Per-assistant permissions (read-only vs albums).

### Later

- The activity list (tool, time, counts), kept locally, for trust and debugging.
- `best_of` and `propose_selection` reusing the Best of screen (#52), then slideshow and copies (#53), then recipes as prompts (#54).
- Opt-in thumbnails for the assistant, under their own ADR.
- Letting the assistant add to the owner's albums, if the owner wants it once the activity list exists to undo it.
- A packaged relay (run with the app's own Electron binary) once there's an installer.
- A local model as the client.

## Safety & privacy

- **Photo folder:** nothing new reads it beyond the database the app already keeps; no tool reads image files, and none accepts a path. Nothing writes there (ADR 0001 unchanged). New writes are all in the app data folder through `appFiles.ts`: the `assistant` folder, the token file, permissions, and removing a stale socket. The socket itself is created natively, so its path is checked with `assertWritable` first, as SQLite's is. The relay can't write at all: the source audit allows it only stdio and socket APIs. Album changes go through the existing album code and are the app's own records.
- **Network:** the app still opens no network port and makes no network calls (ADR 0003). But when access is on, what the assistant reads may leave the computer, because the assistant may be a cloud model. That is a change to ADR 0003's promise, recorded in **ADR 0011**, written during the build. It must say: assistant access is off by default and turned on per library; when on, what may be read is capture dates and times, counts, album names, people's names, favourite stars, why a photo matched and content analysis progress, with photos referred to by their ids; never pixels, paths, folder or file names, hashes, locations, cameras, face data, or anything in an ignored folder (ADR 0007); the server listens only on a local socket with owner-only permissions (a named pipe that refuses remote clients on Windows) and a token, never a TCP or UDP port; the relay only relays; and the switch, "Forget connected assistants" and the settings explanation are how the owner controls it.
- **What the token does and doesn't protect:** it keeps other users on the computer, and assistants the owner has forgotten, out. Any program running as the owner can already read the owner's files, including the token; the ADR says so plainly.
- **Personal data:** nothing new is stored about people. One new column records which albums the assistant made. Turning access off or forgetting assistants removes their access immediately; what an assistant already read stays with that assistant (the settings explanation says so).

## Product

- **Who it's for:** an owner/power-user feature, not the brief's target user, who won't configure an MCP server. It doesn't replace building recipes in the app; it makes trying them cheap and is the base for the rest of epic #55 and for "ask your library".
- **Tiers:** no tier impact now; nothing is gated. Whether assistant access is part of a paid tier is for the pricing decision (Open question 12).
- **Owner-specific assumptions:** setup snippets are for Claude Desktop and Claude Code, the owner's assistants; any MCP client that launches a stdio command works the same way. The relay assumes `node` (22.18 or later) on the PATH and the repo's build output, since there's no installer yet. Search parsing (month names, filler words) is English, as in the app. The owner's library (measured read-only: 943 photos, 61 undated, 8 albums, 10 people, 0 tags) is far below AC-15's scale; the scale numbers come from the target of 100,000 photos.

## Design

**Where it lives.** A new link at the end of the sidebar footer's settings links, after "Best of settings…": **"Assistant access…"**, or **"Assistant access (on)…"** while it's on, so the owner can always see at a glance that it's on. It opens an "Assistant access" modal dialog built like the Best of settings dialog (`LeanDialog`): a `label.toggle` checkbox, `hint` paragraphs, `error` paragraphs, a "Done" button. Assistant albums are marked in the sidebar's album list (below). Nothing else in the window changes.

**Dialog states.** Title "Assistant access" in every state. Under it, always, the switch and the explanation:

- Switch: **"Let AI assistants use this library"**
- Explanation (`hint`): "An AI assistant such as Claude can search this library and make albums of its own. It sees capture dates, album names, people's names and favourites, and may send them to its company's servers. It never sees the photos themselves, file or folder names, places, or anything in an ignored folder, and it can't change your files or your own albums."

1. _Off (default, AC-1)._ The switch and explanation only. Button "Done".
2. _Starting (AC-1)._ The switch shows ticked and is disabled; a `hint` beside it reads "Starting…". Usually too brief to see (under 1 second).
3. _On (AC-1, AC-2, AC-7)._ The switch ticked. Below it, heading (h3) **"Set up an assistant"**, then:
   - Hint: "Needs Node.js 22.18 or later on this computer. The text below includes a secret key for this library: keep it private, like a password."
   - Sub-heading **"Claude Desktop"**, hint: "In Claude Desktop, open Settings › Developer › Edit Config and add this. If the file already lists other servers, add only the "photo-library" entry inside its "mcpServers". Then restart Claude Desktop."
   - A read-only code block (monospace, selectable, scrolls sideways rather than wrapping) with the full JSON, `mcpServers` wrapper included; button **"Copy"**.
   - Sub-heading **"Claude Code"**, hint: "Run this once in a terminal:"; a code block with the `claude mcp add` command (wraps, since it's one line); button **"Copy"**.
   - The token appears only inside the two snippets, exactly as copied; it is never shown on its own or masked (what's shown is what's pasted, AC-2).
   - Then the forget control (below) and, as a closing `hint`: "Turning this off or forgetting assistants stops their access at once. What an assistant has already read stays with it."
   - Button "Done".
4. _Couldn't start (AC-6)._ The switch is off and enabled; under it an `error` paragraph: **"Couldn't start assistant access: {reason}."** with these reasons:
   - another copy of the app on the same data folder: "another Photo Library window is using it. Quit that one, then turn it on here"
   - path too long: "the app's data folder path is too long for this system"
   - permissions: "the app couldn't set up its own assistant folder (permission denied)"
   - anything else: "something went wrong inside the app"
     The rest of the app works as normal. Ticking the switch again retries; the error clears when it starts. If it fails at app launch (setting was on), the setting is saved as off, the footer link reads **"Assistant access (couldn't start)…"** in the error colour, and the dialog shows the same error until the owner opens it and closes it, or turns it on successfully.
5. _Different photo folder (AC-1, Decision 9)._ Choosing a different folder with "Change folder…" turns access off with no prompt (the safe direction): the footer link goes back to "Assistant access…" and the dialog opens in state 1. The token is kept, so turning it on for the new library makes the assistants already set up work again without copying anything; the assistant meanwhile gets the relay's "Open Photo Library and turn on assistant access" message.

Empty library (folder chosen, no photos yet): the switch works the same; the assistant gets the AC-9 note. There is no settings link before a folder is chosen (the Welcome screen has no sidebar). Very large libraries change nothing in the dialog.

**Forget connected assistants (AC-7).** A button **"Forget connected assistants…"** under the snippets. The app confirms forget-type actions inline ("Forget them…", "Forget name…"), so this does too: the button is replaced by a `hint` and two buttons:

- "Forget every connected assistant? They lose access now and need setting up again with the new text above. Your photos and albums are not affected." **"Forget"** (danger) **"Cancel"**.
- After Forget, the snippets show the new token and a `hint` replaces the button for as long as the dialog stays open: "Done. Copy the setup again into each assistant you still want to use." The button returns the next time the dialog is opened.

**Assistant albums in the sidebar (AC-13).** An album the assistant made shows a small muted pill **"AI"** after its name, before the count (same muted colour and size as the count; the name truncates first). Tooltip on the pill and the row: "Made by an AI assistant. It becomes yours when you rename it, move it, or add or remove photos." In the album's own view the header has a `subtitle` with the same sentence. Everything else about the row is unchanged: hover actions, drag, "Move to…", delete with the existing inline confirm ("Delete album "X"? Photos stay on disk."), which undoes everything the assistant did to it. A new or changed assistant album appears in the list, with its count, within 1 second of the call, with no toast; if it is the open view, its grid refreshes in place, keeping the selection and scroll. An empty assistant album shows count 0 like any empty album.

As soon as the owner renames it, moves it (drag or "Move to…"), or adds or removes photos (selection bar, viewer), the pill and subtitle disappear on the same refresh and it's an ordinary album. Nothing else (opening it, starring its photos, making a sub-album inside it, saving copies) counts as a change. No undo for the change of ownership: there's nothing to undo, since the album is unchanged except by the owner's own edit.

**Interactions.** The footer link opens the dialog; Esc, clicking the backdrop or "Done" closes it (focus returns to the link). Space toggles the switch. Unticking takes effect at once, with no confirm (it's the safe direction); the setup block disappears. "Copy" puts the snippet on the clipboard and reads **"Copied"** for 2 seconds; if the clipboard fails it reads "Couldn't copy" and the owner can select the text in the block by hand. Enter on a focused "Forget" confirms; Esc or "Cancel" backs out. The clipboard needs a new preload call (the renderer has none today).

**Copy for the assistant** (errors, notes, tool descriptions) is fixed by AC-3, AC-5, AC-7, AC-8, AC-9, AC-11 and AC-12 and is not repeated here.

**Traceability.**

| AC            | Satisfied by                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------ |
| AC-1          | Footer link; states 1–3; switch copy and explanation; state 5 (folder change turns it off)                         |
| AC-2          | State 3: the two snippets with "Copy", token only inside them                                                      |
| AC-3          | No UI; relay message (state 5 mentions what the assistant sees)                                                    |
| AC-4          | No UI (tests)                                                                                                      |
| AC-5          | No UI; token only in snippets (state 3)                                                                            |
| AC-6          | State 4, including the "another window" reason and the launch failure link                                         |
| AC-7          | Unticking (Interactions); "Forget connected assistants…" with inline confirm                                       |
| AC-8 to AC-12 | No UI (assistant-facing copy in the ACs)                                                                           |
| AC-13         | "AI" pill, tooltip and album subtitle; live refresh; becomes ordinary on the owner's edit; delete as for any album |
| AC-14         | Explanation copy (what it sees, may leave the computer, never sees); state 3 closing hint                          |
| AC-15         | No new UI; live refresh doesn't reload the window                                                                  |

## Open questions

1. **Can the assistant change the owner's own albums?** _Recommended: no. `add_to_album` and `remove_from_album` work only on albums the assistant made and the owner hasn't changed since._ Undo then stays "delete the album", with no activity list needed. The cost: "add these to my Norway album" isn't possible in this version; the assistant makes a new album instead.
2. **How are assistant albums marked?** _Recommended: one column (`made_by`), a marker in the sidebar until the owner changes the album themselves (rename, move, add or remove photos), when it becomes theirs._ Issue #50 said "until the owner opens them"; opening is a weaker signal, and tying the marker to ownership means one rule for both the marker and what the assistant may change. Alternative: no marker at all (simplest, but you can't tell what the assistant made).
3. **Suggested albums in `library_overview`?** _Recommended: leave them out._ Issue #49 listed them, but named suggestions are folder names, which the guardrails say never leave. Albums made from suggestions (named by you) are included.
4. **Name matches on folder and file names.** _Recommended: keep them in the results (so the assistant gets the same results as the app's search box), reported only as `name`, never with the folder's name._ The assistant can still infer that some folder or file name contains a word it searched for. The alternative is to drop folder and file name matching for the assistant, which makes "Poland" miss a `2019 Poland` folder in a library without albums.
5. **How the relay gets the token.** _Recommended: in the setup snippet, as an environment variable in the assistant's config,_ so "Forget connected assistants" really cuts off every configured assistant. The alternative (the relay reads the token file) makes setup token-free but makes forgetting meaningless, since any relay could re-read the new token. The cost: the token sits in Claude's config file in plain text.
6. **"Forget connected assistants" in this version?** _Recommended: yes._ It's a new token plus closing connections, about as small as the switch.
7. **Assistant started before the app.** _Recommended: if the app becomes reachable mid-session, the relay reconnects transparently (AC-3). If the app was closed when the assistant started, the assistant may have no tools listed; the error message tells the owner to open Photo Library and reconnect the server in the assistant._ Making tools appear without reconnecting would mean the relay carrying its own copy of the tool list; worth it only if this bites.
8. **Use the official MCP SDK or a hand-written subset?** _Recommended: the SDK (`@modelcontextprotocol/sdk`, pinned), server core only, with our own socket transport._ It handles protocol versions and schemas correctly; the build checks that nothing in it opens a port or uses the network at runtime. The relay doesn't use it.
9. **Does the setting survive choosing a different photo folder?** _Recommended: no, it turns off._ ADR 0003 says opt-in per library, and a new folder is effectively a new library. Keeping it on is one line simpler.
10. **Which photo details go out?** _Recommended: capture date and time to the minute, people's names (confirmed and matched faces, as the app's search uses), album names, and favourite stars._ Stars weren't in the epic's list but are the owner's own signal and help photobook questions. Tags, cameras and places stay out for now (you have no tags today).
11. **ADR number.** The task said ADR 0010, but 0010 is already "Exports write to one granted folder". _Recommended: this is ADR 0011._
12. **Paid tier?** _Recommended: no gating now; decide with pricing._
13. **Windows named pipes.** Node can't set a pipe's permissions, and refusing remote clients has to be checked on Windows during the build. _Recommended: if the pipe can't refuse remote clients, the token is the guard and the ADR says so; otherwise, as AC-4._ This is a guess about Node's behaviour that the build must check.

## Decisions

- 2026-11-10 (settled in epic #55 and the task, not reopened):
  - Off by default, opt-in per library through one setting; a new ADR amends ADR 0003 (what may leave the computer when it's on; still no TCP port).
  - The MCP server runs inside the Electron main process on a local socket (Unix domain socket in the app data folder on macOS/Linux, named pipe on Windows), owner-only permissions plus a token. The command an assistant launches is a stdio relay that only forwards bytes, never opens the database or writes files; when the app isn't running or access is off it answers with "Open Photo Library and turn on assistant access".
  - The assistant sees dates, counts, album names, people's names and why a photo matched; never pixels, paths, folder names or anything in an ignored folder (ADR 0007). Photos are referred to by their ids.
  - Five tools: `library_overview`, `search_photos` (free text through `photoSearch.ts`, plus date range, people and album filters; total first, then a page), `create_album`, `add_to_album`, `remove_from_album`. Albums stay virtual. No delete tool. The activity list is deferred.
  - Setup in settings (Claude Desktop JSON and `claude mcp add`) and the README; the relay runs with `node` from the build output until there's an installer.
  - Turning access off closes the socket and rejects calls in flight.
- 2026-11-10, the owner's answers to the open questions (all as recommended):
  1. The assistant changes only albums it made; the owner's own albums are read-only to it. Undo stays "delete the album".
  2. Assistant albums carry a `made_by` marker shown in the sidebar until the owner changes the album, which makes it theirs.
  3. No suggested albums in `library_overview`.
  4. Folder and file name matches stay in search results, reported only as `name`.
  5. The relay gets the token from an environment variable in the assistant's config, so "Forget connected assistants" really cuts it off.
  6. "Forget connected assistants" is in this version.
  7. The relay reconnects transparently; if the app was closed at startup, the error says to open it and reconnect.
  8. ~~The pinned `@modelcontextprotocol/sdk`~~ Changed during the build (owner, 2026-11-10): the MCP protocol (initialize, ping, tools/list, tools/call over newline-delimited JSON-RPC) is hand-written in the app. The SDK would have added 17 dependencies, including the express and hono web servers, an HTTP client and cross-spawn, to an app that promises no network.
  9. Choosing a different photo folder turns access off.
  10. Photo details sent: date and time to the minute, people, albums, favourite stars. No tags, cameras or places.
  11. The ADR is 0011 (0010 is taken).
  12. No paid gating now.
  13. Windows: check during the build that the named pipe refuses remote clients; if it can't, the token is the guard and the ADR says so.
      AC-15's 100k-photo budgets are kept.
- 2026-11-10, the owner's design answers (all as recommended): assistant albums get a muted "AI" text label; an album becomes the owner's when they rename it, move it, or add or remove photos (no "Keep as mine" button); access turns off quietly at a failed launch or a change of photo folder (saved as off, shown by the footer link); the Claude Code command uses `--scope user`.
- 2026-11-10, during the build (review findings): the Claude Code command puts the server name before `--env` (the CLI's `--env` takes several values and swallowed the name). Album names the app made from a folder name (Best of from a suggested album, converted merges) are album names, so the assistant can see them; the settings text and ADR 0011 say so. On Windows the named pipe isn't known to refuse remote clients (decision 13): the token is the guard there, recorded in ADR 0011.
