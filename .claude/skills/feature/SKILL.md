---
name: feature
description: Take a feature from idea (or GitHub issue) to a reviewed, tested pull request, with the product, designer, reviewer and qa agents.
disable-model-invocation: true
argument-hint: <idea in words, or #issue-number>
---

Run a feature through the project's workflow. The user approves at two **gates**; everything between runs without asking. The spec's acceptance criteria (AC-1, AC-2, …) are the thread through every step: design maps to them, review checks them, QA proves them.

Input: `$ARGUMENTS`, an idea in words or a GitHub issue (`#12`).

## 1. Set up

- Next spec number: one above the highest in `docs/specs/` (`0001` if none). Pick a short slug.
- From an up-to-date `main`, create branch `feat/NNNN-slug`.

Done when you're on the new branch.

## 2. Spec (product agent) → gate

Dispatch the **product** agent with the input and the target path `docs/specs/NNNN-slug.md`.

Then show the user the summary and acceptance criteria, and ask the open questions (AskUserQuestion, recommended answer first). Record each answer in the spec's Decisions section, set `Status: approved`, and commit the spec.

Done when the user has approved the spec.

## 3. Design (designer agent) → gate, UI features only

Skip for features with no UI change, and say so. Otherwise dispatch the **designer** agent with the spec path. Show the user the Design section's key screens and copy and ask for approval or changes; apply changes to the spec and commit.

Done when the user has approved the design, or the step was skipped.

## 4. Build (you)

Build it test-first, in small commits: one acceptance criterion (or a slice of one) at a time, red then green. Follow `CLAUDE.md`; use `CONTEXT.md` terms in code and copy. Update `CONTEXT.md` when a new term is settled, and add an ADR only for decisions that are hard to reverse, surprising, and a real trade-off.

Done when every acceptance criterion is implemented and `npm run typecheck && npm test && npm run e2e` pass.

## 5. Review (reviewer agent)

Dispatch the **reviewer** agent once with the spec path and base branch `main`. Fix every blocking and should-fix finding (or record in the spec why not). Re-run the reviewer only if the first pass found something **blocking**, and then only on the fixes. Usage is limited: one careful pass beats several shallow ones.

Done when blocking findings are fixed (and, if there were any, a second pass on the fixes says ready).

## 6. QA (qa agent)

Dispatch the **qa** agent once with the spec path. Fix every failing criterion and every bug it ranks above nit, then re-run only the affected tests yourself.

Done when every acceptance criterion passes with named evidence.

## 7. Pull request

Set the spec's `Status: done`, push the branch, and open a PR: summary, the acceptance criteria as a checklist with their evidence, screenshots for UI changes, link to the spec (and `Closes #N`).

Then watch CI to the end (`gh run watch`). CI runs Linux only on PRs; if the change is platform-sensitive (paths, sockets/pipes, native modules, file permissions), also run Windows by hand once it's green on Linux: `gh workflow run CI --ref <branch> -f os=windows-latest`. Actions minutes are limited: push once when ready, not commit by commit. If it fails, read the failing logs, fix, push, and watch again. Failures that only happen on another OS or in CI's environment (locale, no GPU, path limits, timing) are real findings: fix the cause, not just the test.

Done when CI is green (Linux, plus Windows for platform-sensitive changes); give the user the link. The user reviews and merges.
