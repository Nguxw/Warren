---
name: research-report
description: Write a sourced research report in Markdown. Use when asked to research a topic, compare options or summarise what is new in a field.
---

# Research report

Produce one Markdown report in the workspace, named after the topic and the date, for example
`github-trending-2026-11-14.md`.

## Gather

- Prefer primary sources: official sites, release notes, repositories, papers. Keep what you
  fetch in a `sources/` folder next to the report, so every claim can be checked later.
- Note when each source was read; numbers that change (stars, prices, rankings) need a time.

## Write

Follow `template.md` in this skill's folder:

1. **Summary**: three to five sentences a busy reader can stop after.
2. **Findings**: one section per finding, each with its evidence and a link.
3. **What this means**: recommendations or open questions, kept apart from the facts.
4. **Method and limits**: what was checked, what was not, and why.

Write in the language the user wrote the task in. Link every source inline.

## Check before finishing

- Every number has a source and a time.
- Nothing is claimed that the sources do not say; guesses are marked as such.
- The summary in `complete_task` states the main findings themselves and names the report file.
