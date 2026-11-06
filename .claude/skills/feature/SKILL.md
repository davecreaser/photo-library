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

Dispatch the **reviewer** agent with the spec path and base branch `main`. Fix every blocking and should-fix finding (or record in the spec why not), then re-run the reviewer until the verdict is ready.

Done when the reviewer's verdict is ready.

## 6. QA (qa agent)

Dispatch the **qa** agent with the spec path. Fix every failing criterion and every bug it ranks above nit; re-run QA until every criterion passes.

Done when the QA table shows every acceptance criterion passing with named evidence.

## 7. Pull request

Set the spec's `Status: done`, push the branch, and open a PR: summary, the acceptance criteria as a checklist with their evidence, screenshots for UI changes, link to the spec (and `Closes #N`). The user reviews and merges; CI must be green.

Done when the PR is open and CI is green; give the user the link.
