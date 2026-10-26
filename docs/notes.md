# Obsidian note synchronization

`src/lib/services/notes.ts` exposes `fetchObsidianNotes(folderPath?)`, the English
implementation of `haeObsidianMuistiinpanot()`, and `extractTopics(text)`, the
implementation of `hankiAiheet()`.

Startup reads the notes-folder setting and awaits synchronization before rendering
HomeView. Completing first-time folder selection also runs synchronization. The
backend creates/migrates `obstudy.db` in that folder when necessary. No API key or
AI request is involved in parsing or synchronization.

## Study tags and scanning

Markdown files are scanned recursively. The case-sensitive `STUDY` tag is accepted
in YAML `tags` (a string or list) or as an inline `#STUDY` tag in prose. Code blocks,
inline code and link destinations do not count as tags. `.obsidian`, `.git`, and
`.trash` directories are excluded; symlinks are not followed outside the vault.

A failed directory/file read aborts the scan before applying missing-note changes.
Malformed YAML is reported as a sync notice and existing data for that file is
left unchanged. Missing or untagged notes become unavailable; their saved study
status, questions and history remain in SQLite.

File paths identify notes. A unique unchanged note moved within the vault retains
its identity when both the old and new content match unambiguously. Simultaneous
moves and edits, or ambiguous identical copies, are treated as new notes while the
old records are retained as unavailable.

## Topic structure

```markdown
---
tags: [STUDY]
---

**Mathematics**

1. **Derivatives**
    - Rates of change
    - Further explanation
2. **Integrals**
    - Accumulation
```

Broad topics are standalone bold titles. Broad and subtopic titles start at column
zero, without leading spaces or tabs. Subtopics use a number followed by a period
and a space (`1. **Subtopic**`); content bullets remain indented as shown above.
Titles may be wrapped in double quotes inside the bold markers, as in the project
notes. Subtopic titles also accept trailing annotations, such as
`1. **Sets** ★ (handout 1.1.1, pp. 5–6)`. Only the bold text becomes the title;
the annotation is preserved as the first line of subtopic content. Subtopic
content extends to the next broad or subtopic title. Fenced and
indented code blocks and HTML are excluded from title detection. A subtopic before any broad title is retained
with a missing-parent warning.

No numbered bold subtopics produces a parsing error. Coverage below the confirmed
50% threshold produces a warning, measured against non-empty body lines excluding
a standalone `#STUDY` tag. Valid partial results are retained. If an edited note
cannot be parsed, its old topics remain intact and the parsing error is shown.

## Reconciliation and user decisions

Synchronization is serialized within the app, applies a complete scan inside an
SQLite transaction, and preserves topic IDs by title and occurrence (preferring
the same parent for duplicate subtopic titles). Topic rows that disappear are
marked absent instead of being immediately deleted. Reordering identical titles
is inherently ambiguous; explicit topic IDs in Markdown are not implemented.

Changed subtopic text and changed broad-topic contents record pending decisions
when active questions are affected. Removed topics also create pending decisions
for linked questions. These decisions survive app restarts. Selecting a note opens
a review dialog; Review later defers it without discarding the pending changes.

- Changed topic: keep its questions, or remove them from the active question bank.
- Removed topic: keep questions without the obsolete topic link, or remove them.
- Missing broad topic with surviving subtopics: assign their questions to a current
  broad topic in the same note, or detach missing broad-topic links.

Removal from the question bank is archival (`isArchived`), preserving question IDs,
past answers, exercise snapshots, and FSRS history. Archived questions are excluded
from the returned active question bank. No source Markdown is modified.

The result includes notes, active topics/questions, saved settings, exercises,
performances, answers, FSRS data, parsing diagnostics and pending issues. HomeView
receives this snapshot, renders real note rows and allows selection/review.

## Study status and note tabs

Move notes between Studying and Not studying by dragging a row into the other
group. Category changes use drag-and-drop only.
`setNoteStudying(noteId, isStudying)` saves the change to SQLite before updating
the UI. Failed saves leave the note in its original group and show a retryable
error; duplicate moves are blocked while saving. The native file-drop handler is
disabled for the main window so HTML note dragging works in the webview.

Clicking a Studying note opens or focuses a tab keyed by that note's ID. Each note
has its own tab and data; duplicate filenames in different folders remain separate.
Tab labels omit `.md`, shorten names longer than 22 characters with `...`, and
expose the full name through the tooltip and accessible label. Moving a note out
of Studying closes its tab and clears its selection when applicable. Tabs remain
session-local; study status survives restarts.

Note tabs show saved question and answer counts and average points per answer
across all time. Generation, removal, schedule reset, time-range analytics, and
exercise workflows remain unimplemented; their future actions are disabled and
labeled accordingly.

## Verification

`cargo test --manifest-path src-tauri/Cargo.toml --lib` covers parsing, tag matching,
recursive scanning, idempotency, saved-data retention, moves, untagged files,
invalid parsing, failed scans, pending decisions and parent reassignment.
