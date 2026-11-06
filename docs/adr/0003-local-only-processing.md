# All processing is local; the app makes no network calls

Photos, faces and metadata never leave the machine, and the running app never uses the network. ML models (face detection/recognition, later CLIP) are downloaded once at install time, pinned by SHA-256, and loaded from disk. Cloud AI (e.g. the Claude API for captions) was considered and deferred: if it is ever added it must be explicit opt-in per library, because local-only is the product's core promise.
