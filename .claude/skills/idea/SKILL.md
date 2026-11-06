---
name: idea
description: Turn the owner's feature idea, said in plain words, into a validated `idea` issue on GitHub. Explores and checks the idea first and records the reasoning in the issue.
disable-model-invocation: true
argument-hint: <the idea in your own words>
---

The owner describes an idea casually. You work out whether it is worth building, and in what shape, then write it up as an `idea` issue that a later `/feature` run (or the headless `approved` comment) can start from. The validation is the point: the issue records what you checked and what you found, so the owner can decide without redoing the thinking.

Input: `$ARGUMENTS`, the owner's words. When run headlessly, it is the body (and title) of the issue the owner opened.

You don't write a spec, design screens or change code here. Stay focused: usage is limited, so an hour of exploration is too much. Aim for a careful 10–20 minutes.

## 1. Understand

Restate the idea as a problem a person has ("I copied the last day off the card and …"), plus what the app would do about it. If the words could mean two quite different features, pick the one that best fits the brief and say in the issue which one you picked and why. Headless runs can't ask, and interactive ones should only ask if the two readings lead to different verdicts.

## 2. Explore

Read, as far as the idea needs:

- `docs/product/brief.md`: audience, the hooks, principles, Not doing, roadmap.
- `CONTEXT.md` (use its terms), the ADRs in `docs/adr/`, and the specs in `docs/specs/` that touch the area.
- Every existing issue, open and closed: `gh issue list --state all --limit 300 --json number,title,state,labels`. Read the bodies of any that look related.
- The code that would change: what already exists to build on, and what would be new.

Measuring the owner's real library is allowed, read-only, if a number would settle a question (e.g. "how many albums came from suggestions?"). Never view the owner's photos.

## 3. Validate

Answer each check in a sentence or two, with evidence (a file, a spec, an issue number, a measurement):

1. **Problem:** is it a real problem for the brief's audience (camera photos in folders, no time to organise), or only for power users? How often would it come up?
2. **Fit:** which hook it serves (Organises, Photobook, Ask, or foundation/productisation work), and whether it moves someone closer to "I found it" or "I made something with it".
3. **Principles:** any conflict with the photo folder being read-only (ADR 0001), nothing leaving the computer (ADR 0003), "effort-free beats powerful", or the brief's Not doing list. A conflict usually means reshaping it, not dropping it.
4. **Already covered:** does the app, a spec or an existing issue already do this, or most of it? Name it.
5. **Feasibility:** what it builds on, the hard part, rough size (S about a day, M a few days, L a week or more), and what it depends on.
6. **Smallest useful version:** the version that solves the problem with the least new surface. Put the bigger ideas under "Later".
7. **Risks and unknowns:** what could make it disappointing (accuracy, speed on 100,000 photos, confusing UI), and how a spec could find out.

Then give a **verdict**:

- **Build** (priority now, next or later against the brief's roadmap),
- **Reshape** (build a different version, which you describe),
- **Already covered** (by #N or a shipped feature; say what, if anything, is missing), or
- **Don't build** (why, against the brief).

Be candid: a "don't build" with good reasons is a useful result.

## 4. Write the issue

Title: a short noun phrase, like the existing ideas ("New photos for an album", "More like this").

Body, in this order:

```markdown
- **Problem:** "<the problem in the owner's voice>"
- **What it does:** <the smallest useful version, with example wording if it has UI>
- **Hook:** <Organises / Photobook / Ask / Foundation / Productisation>.
- **Size:** <S / M / L>.
- **Depends on:** <specs or issues, or "nothing">.
- **Priority:** <Now / Next / Later>. <one-line reason>

## Validation

**Verdict:** <Build / Reshape / Already covered / Don't build>: <one sentence>.

<The seven checks, one short paragraph or bullet each, with evidence.>

**Later:** <bigger versions left out, if any>.

**Open questions:** <numbered, each with your recommended answer; for the spec stage to settle>.

## The owner's words

> <exactly what the owner said, unchanged>

---

From `/idea`, <today's date, YYYY-MM-DD>. See `docs/product/brief.md`.
```

Labels: `idea` plus one priority (`now`, `next`, `later`), one size (`size/S`, `size/M`, `size/L`) and one hook label (`hook/organises`, `hook/photobook`, `hook/ask`, `foundation`, `productisation`) when it fits. For **Already covered** by an issue, don't add `idea`: add `duplicate` and link the issue in the Verdict. The owner decides whether to close it.

## Interactive (`/idea <words>`)

Show the owner the title, the verdict and the "What it does" line, and ask (AskUserQuestion): create it, create it with changes, or don't create it. Then create it with `gh issue create --title … --body-file … --label …`, writing the body to a file in the scratchpad first. Give them the link and how to start it: comment `approved` (spec and design first) or `approved, no spec` (small change, build straight away).

## Headless (the owner opened an unlabelled issue)

Nobody can answer questions. Rewrite the same issue in place: `gh issue edit N --title … --body-file …`, keeping the owner's original words verbatim in "The owner's words", then add the labels. Post one short comment: the verdict in one sentence, and "Comment `approved` to write the spec, `approved, no spec` to build it straight away, or comment `idea` with more detail to validate it again." Never close the issue, and never create a branch or PR.

Done when the issue has the write-up, the Validation section and its labels.
