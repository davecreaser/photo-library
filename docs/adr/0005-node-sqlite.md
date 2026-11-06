# Built-in node:sqlite instead of better-sqlite3

The database uses Node's built-in `node:sqlite` (available in Electron's Node), not the more common `better-sqlite3`. That avoids a native module that must be rebuilt for each Electron version and platform, which matters for cross-platform builds. The trade-off is a younger API; revisit if it lacks something we need (e.g. loadable extensions for a vector index).
