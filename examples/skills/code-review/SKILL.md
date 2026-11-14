---
name: code-review
description: Review a change for correctness bugs before it is merged. Use when asked to review a branch, a diff or a pull request, or to check work before publishing it.
---

# Code review

Review what changed against its base, not the whole repository.

## Steps

1. List the changed files and read each change in full, with enough surrounding code to know
   what it calls and what calls it.
2. For each change, ask what input or state would make it wrong: empty and very large values,
   errors from what it calls, concurrent use, a crash halfway through.
3. Run the tests that cover the changed code. Where a suspected bug has no test, write a small
   one that shows it.
4. Report only problems you can show. For each: the file and line, what goes wrong, the input
   that causes it, and the smallest fix.

## Report

Order findings by how much harm they do. Keep style remarks out unless they hide a bug. If
nothing is wrong, say so plainly and say what you checked.
