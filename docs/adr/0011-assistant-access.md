# AI assistants may read a library's text, when the owner turns it on

Amends ADR 0003. Assistant access (spec 0008) lets an AI assistant such as Claude, which may be a cloud model, search the library and make albums through an MCP server inside the app. The app still opens no network port and makes no network calls; but what the assistant reads may leave the computer, which ADR 0003 promised wouldn't happen. So it is the owner's explicit choice, per library:

- **Off by default**, turned on per library with one switch whose explanation says what may leave the computer. Choosing a different photo folder turns it off.
- **What may be read:** capture dates and times, counts, album names, people's names, favourite stars, why a photo matched a search, and content analysis progress. Photos are referred to by their ids.
- **Never:** pixels or thumbnails, paths, file or folder names, content hashes, places or GPS, cameras, face data, or anything in an ignored folder (ADR 0007). A search that matched a folder or file name says only that it was a name match. No tool accepts a path. A test plants sentinel words in all of these and checks nothing the server sends contains them.
- **What it may change:** only albums it made itself, until the owner changes one (then it is theirs). Albums are the app's own records (ADR 0001 is untouched).
- **How it connects:** the server listens only on a local socket: a Unix socket with owner-only permissions (folder 0700, socket 0600) in the app data folder, or on Windows a named pipe derived from the data folder. Never a TCP or UDP port (a source audit refuses ports and network modules). Each connection must first present a 32-byte random token, kept in an owner-only file and in the assistant's own config.
- **The relay**, the command the assistant launches, only forwards bytes between its stdio and the socket; the source audit allows it nothing but `node:net`.
- **Control:** the switch closes every connection at once; "Forget connected assistants" replaces the token. What an assistant already read stays with that assistant; the settings explanation says so.

## Consequences

- The token keeps other users on the computer, and assistants the owner has forgotten, out. It does not protect against programs already running as the owner: they can read the owner's files, including the token, anyway. Node can't set a Windows named pipe's permissions, so there the token is the guard.
- The MCP protocol is hand-written (initialize, ping, tools/list, tools/call): the official SDK would have added web-server and HTTP packages to an app that promises no network.
- Pixels for the assistant (thumbnails, captions) would be a further step and need their own ADR.
