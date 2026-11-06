# Photo Library: product brief

Status: agreed with the owner, 2026-11-06. Every spec should fit this; if one doesn't, change the brief deliberately or change the spec.

## In one sentence

Point Photo Library at the folder where your camera photos pile up, and it organises them for you and turns them into things you want (a trip slideshow, a year's photobook), without moving a file or sending anything to the cloud.

## Who it's for

People like the owner: they take photos with a **digital camera**, the photos end up in **folders on their computer** (copied off the card, half-sorted at best), they **don't want to put them in Google Photos, iCloud or a drive**, and they **don't know how, or don't have time, to organise them**. They aren't professionals and don't want to learn a catalogue tool.

Also served, but not designed for first: enthusiast photographers with big archives, and privacy-first people who would otherwise run a server like Immich.

## What we want people to say

1. **"It organises itself."** Point it at a messy folder: it suggests albums from your folders and trips, fixes wrong camera dates, finds the people, and lets you find any photo by what's in it. Close to zero effort, never needs a folder rule.
2. **"It made my photobook."** It turns photos into outcomes: the best of a trip as a slideshow, the best of the year for a photobook or a present, chosen well (no near-duplicates, sharp, everyone included) and approved by you in a minute.

A third, later: **"ask it anything"** (natural-language questions about your life in photos). Valuable, but it follows the first two.

## Principles (non-negotiable)

- **Your files are never touched** (ADR 0001): nothing is moved, renamed, edited or deleted. Organisation is virtual and survives you reorganising files yourself (ADR 0002).
- **Nothing leaves your computer** by default (ADR 0003). Anything that would (a print shop, a share) is an explicit step you take.
- **Effort-free beats powerful.** Prefer a good automatic result you can correct over a setting you must configure. Suggestions over chores.
- **Outcomes over management.** A feature earns its place by getting someone closer to "I found it" or "I made something with it".

## Where it stands against the alternatives

|                               | What it does well                                                                            | Why someone like the owner might pick Photo Library instead                                            |
| ----------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Google Photos / iCloud Photos | Excellent search, faces, memories                                                            | They require uploading everything to the cloud and importing it into their library.                    |
| Peakto (Mac)                  | Catalogues folders and photo apps in place, local AI search, duplicates; ~$10/month or ~$189 | Search-first rather than organising-first; Mac-only; no "make something" outcomes. Closest competitor. |
| Excire Foto                   | Local AI search, faces, culling; ~$199 lifetime                                              | Built for photographers (keywording, culling workflows); more tool than outcome.                       |
| Mylio Photos                  | Local-first, AI search, sync across your devices                                             | Wants to manage and sync your library across devices; heavier.                                         |
| Immich / PhotoPrism           | Free, powerful, "Google Photos at home"                                                      | You run a server (Docker); not for most people.                                                        |
| digiKam                       | Free, full catalogue                                                                         | Complex; dated.                                                                                        |

Honest assessment: local AI search over folders is **not a gap by itself** (Peakto and Excire do it). The bet is the combination of **self-organising** (suggested albums, date fixes, people, content identity that survives reorganising) and **outcomes** (slideshows, photobooks), for people who would never set up a catalogue.

## Not doing (now)

Editing photos; culling workflows for professionals; phone backup or syncing between devices; sharing or social features; a cloud version; a mobile app.

## What success looks like

- **For the owner (the real test):** uses it to find photos without thinking about folders, and makes a real photobook or slideshow with it (for example, Christmas 2026) in under 30 minutes, most of it approving choices.
- **Product signals, before investing in a release:** a handful of people like the owner try it on their own folders; most of them make something with it in the first session; some ask to keep using it.

## Pricing hypothesis (to test, not decided)

Free up to a library size, paid above. Competitors anchor at roughly $10/month (Peakto) or $189–199 one-time (Peakto, Excire). Subscriptions for an offline app are a harder sell; a one-time licence with paid upgrades, or a subscription that funds new "recipes", are both worth testing. Licensing (closed vs source-available) follows from this decision.

## What this means for the roadmap

1. Finish **0002 search by content** (in progress).
2. **0003 best photos** (near-duplicates, quality, a diverse selection): the engine behind both hooks.
3. **Recipes:** the trip slideshow first, then the photobook selection. Built so they work in the app; n8n is where new recipes are prototyped (README roadmap).
4. Then **"ask your library"**, then places.

## Open questions

- Is the camera-in-folders audience big enough as phones take over? Find out by asking people like the owner before a release.
- One-time licence or subscription?
- How much of "organises itself" can be done before the first use feels slow (first analysis of a large library)?
