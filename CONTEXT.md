# Photo Library

A desktop app that organises a folder of camera photos without ever changing it: everything the user organises lives in the app, on top of the files.

## Language

### Photos and where they live

**Photo folder**:
The folder the user points the app at; everything below it is the library's source. Only ever read.
_Avoid_: base path, root, import folder

**Photo**:
One image, identified by its content: identical files anywhere in the photo folder are the same photo.
_Avoid_: image, file, asset, item

**Copy**:
One file on disk holding a photo's content. A photo has one or more copies; moving or renaming a copy doesn't change the photo.
_Avoid_: duplicate (for the concept), location, instance

**Missing photo**:
A photo with no copy currently found in the photo folder. Hidden, but remembered with its albums, tags and names in case it comes back.
_Avoid_: deleted photo

**Ignored folder**:
A folder the user excludes by name (anywhere) or by path (that folder only). Its photos are never part of the library.
_Avoid_: excluded folder, private folder (that's just the default name)

**Forget**:
To remove what the app knows about a photo (its record, names, tags, thumbnails). Never affects files.
_Avoid_: delete, remove (when talking about photos)

### Time

**Capture time**:
When the photo was taken, as shown and searched: the recorded time after any clock correction.
_Avoid_: date, timestamp, created date

**Recorded time**:
The time the camera wrote into the photo, which may be wrong if the camera's clock was.
_Avoid_: EXIF date, original date

**Clock correction**:
A rule that shifts the recorded times of one camera's photos (optionally only those before a date) to give their capture times.
_Avoid_: time fix, date offset

**Undated photo**:
A photo with no recorded time (e.g. a scan or a download). Never given a guessed date.

### Organising

**Album**:
A named collection of photos made by the user; albums can contain albums. Adding a photo to an album never moves a file.
_Avoid_: folder, virtual folder (in the UI), collection

**Tag**:
A free-text label on photos.
_Avoid_: keyword, label

**Favourite**:
A photo the user has starred. Never inferred from folder names.
_Avoid_: best, pick

**Suggested album**:
A group of photos the app proposes as an album, from a named folder or a burst of photos taken together. Accepting makes it an album; dismissing hides it for good.
_Avoid_: event, trip, moment

### Search

**Name match**:
A photo a search finds because its words are written down: in a folder or file name, an album, a tag or a person's name.
_Avoid_: keyword match, text match

**Content phrase**:
What's left of a search after dates, people's names and filler words; it is looked for in what photos show.
_Avoid_: query embedding, prompt

**Content match**:
A photo a search finds because it looks like the content phrase. Listed after the name matches, best match first.
_Avoid_: semantic match, AI match, similar photo

**Content analysis**:
The app's one-off reading, on this computer, of what each photo shows, which content search compares phrases with.
_Avoid_: indexing (that's the scan), embedding, tagging

### People

**Face**:
One appearance of someone in a photo.

**Person**:
Someone the user has named. A person's photos are those with a face that is theirs.
_Avoid_: contact, identity, subject

**Face group**:
Faces the app thinks belong to the same, not-yet-named person. Naming a face group makes it a person, or adds it to the person with that name.
_Avoid_: cluster (in the UI), unknown person

**Confirmed face**:
A face the user has said belongs to a person, by naming its face group or the face itself.

**Matched face**:
A face the app has attributed to a person automatically because it looks like their confirmed faces. The user can reject it ("not this person"), and it won't be matched to them again.
_Avoid_: auto-tagged, suggested face

**Offer** (new photos for an album):
Photos that turned up after an album was made from a suggestion, inside its dates or in its folder. Shown in Suggested albums as "N new photos for Sintra"; the user adds them or says "Not these" (remembered by photo). Never added automatically; hand-made albums get none.

**Best of**:
The app's pick of a few photos from an album or suggested album that tell its story (about 10%, adjustable). Computed on demand, never stored; the user can swap, remove and add, then **Make album** to keep it as a plain album ("Best of Sintra"). Chosen from technical quality and the user's own signals (stars, albums, tags, named people, words typed in "Focus on…"), never by a model judging beauty.
_Avoid_: highlights, favourites (favourites are only the user's stars)

**Look-alikes**:
Photos of the same scene taken close together (very similar content, within 10 minutes). Computed from content vectors, never stored; at most one of a group is in a Best of pick.

**Moment**:
A run of photos close in time and scene (a lunch, a viewpoint). Computed, never shown as an album; Best of gives each moment a share of the pick.

**Quality score**:
A number from 0 to 1 per photo from sharpness, exposure and face size, measured once in the background analysis pass (`photo_quality`, `QUALITY_VERSION`).

### Assistant access

**Assistant access**:
The per-library switch that lets an AI assistant search the library and make albums through the app's MCP server (spec 0008, ADR 0011). Off by default.
_Avoid_: API, integration, plugin

**Relay**:
The small command an assistant launches; it only forwards messages between the assistant and the app's local socket.

**Assistant album**:
An album the assistant made and the owner hasn't changed since; marked "AI" in the sidebar. Renaming, moving, or adding or removing photos makes it the owner's.
