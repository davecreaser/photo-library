# Photos are identified by their content hash, not their path

A photo is the SHA-256 of its file contents; paths are just where its copies currently live. This lets users move and rename files, or switch to a new photo folder holding the same photos, without losing albums, tags, favourites or names. Identical copies collapse into one photo. Identifying by path (simpler, no full-file reads) was rejected because it loses all organisation on any move. Cheaper partial fingerprints were rejected because a false match would merge two different photos' organisation.

## Consequences

- The first scan reads every file in full (~20 s for 31 GB on an SSD); later scans only read new or changed files.
- A photo edited in place keeps its organisation (same path, new hash). A photo edited _and_ moved becomes a new photo.
