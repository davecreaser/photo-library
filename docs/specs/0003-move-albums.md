# 0003: Move albums into other albums

Status: approved
Issue: #42

## Problem

"I have a few different types of albums (trips, compilations, WIP photobooks) and they all sit in one long list." Albums can nest, but an existing album can't be moved.

## User stories

- As the owner I want to put an existing album inside another (e.g. into "Trips") so that the album list has structure.
- As the owner I want to take an album back out to the top level.

## Acceptance criteria

- **AC-1** Given two albums, when I drag one onto the other in the sidebar, then it becomes a sub-album of the other.
- **AC-2** Given a sub-album, when I drag it onto the "Albums" heading, then it moves to the top level.
- **AC-3** Given an album, when I choose "Move to…" in its menu and pick an album (or "Top level"), then it moves there. The picker doesn't offer the album itself or its sub-albums.
- **AC-4** Moving an album into itself or one of its own sub-albums is refused (also in the data layer); nothing changes.
- **AC-5** Moving keeps the album's photos and sub-albums; no photo file is touched.
- **AC-6** Deleting an album keeps its sub-albums: they move up one level, and the delete confirmation says so when there are any.

## Non-goals

Manual ordering; a group type that only holds albums; dragging photos onto sidebar albums; undo.

## Safety & privacy

Only `albums.parent_id` changes. Nothing reads or writes the photo folder; nothing leaves the machine.

## Product

No tier impact.

## Design

Sidebar album rows are draggable; the row under the pointer highlights as a drop target, as does the "Albums" heading (top level). Each row's actions get a "Move to…" button (⇥) opening the album picker, with a "Top level" entry first. UI wording says "album"/"inside", never "folder". Delete confirmation: "Delete album “X”? Its N sub-albums move up one level. Photos stay on disk."

## Open questions

1. Deleting a parent: delete sub-albums? 2. Parent view includes children's photos? 3. Drag only or also "Move to…"?

## Decisions

- 2026-11-06: (1) No: sub-albums move up one level, confirm says so. (2) No: a parent shows only its own photos. (3) Both drag and "Move to…". Owner approved without a spec, so recommended answers apply.
