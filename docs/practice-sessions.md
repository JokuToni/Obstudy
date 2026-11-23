# Practice sessions

Select a note in Studying, choose Study or Practice in the bottom bar, and press
Start. The session opens in a separate native window. Practice settings in the
main window save the selected note's count, difficulty, format, topics, and reuse
preference. Start uses the current options, including unsaved edits. Drafts stay
with their note when switching or closing settings tabs for the rest of the app
session. Save settings persists them across app launches. Without edits, Start
uses the saved profile, or ten easy mixed-format questions with reuse enabled.

Difficulty checkboxes allow one or more of Easy, Medium, and Hard. Reuse accepts
questions at any selected level. Fresh generation splits the total count as
evenly as possible across selected levels; remainders go to the lower selected
levels first (five Medium/Hard questions means three Medium and two Hard).
Study continues to ignore this filter. Migration `0006_practice_difficulties.sql`
preserves existing single-level profiles as one-element arrays. The legacy
`difficulty` field remains for older callers; new sessions use `difficulties`.

`createExercise` in `src/lib/services/exercises.ts` implements `luoHarjoitus`.
Study selects basic questions due before the next local midnight, oldest first,
Learning and relearning cards wait until their exact due time, and scheduled
reviews may return again that day. Historical submissions without a review log
retain the same-day exclusion.
Practice submissions do not remove questions from Study. Study uses the selected
broad topics and their subtopics, filtering before applying the question limit.
It ignores difficulty, format, and reuse and never generates questions. Practice with reuse enabled prefers
matching unanswered questions, then those answered longest ago; ties are shuffled.
Questions can repeat when the matching bank has been covered. Otherwise it generates fresh
additional questions through the existing AI integration. Short selections and
partial generation are explained in the session; empty sessions are rejected.

The native command validates the selection and stores immutable question and
settings snapshots in a transaction. Migration `0004_exercise_sessions.sql` adds
session metadata, revisioned answer drafts, and a self-review completion date.
The child window is bound to its original notes folder, independently of later
main-window folder selection changes.

Users answer and submit by revealing the example answer. Multiple-choice answers
are graded automatically as correct (1) or incorrect (0), using the immutable
question snapshot in native code. Freeform answers can be self graded as Incorrect
(0), Partly correct (0.5), or Correct (1), or graded on request through the active
AI integration. Submitting a freeform answer reveals the example first. The next Right press or
forward action opens a small floating grading prompt
centered within the question-and-answer body, with Skip initially focused. A dark,
blurred glass backdrop covers only that body, leaving the header and footer clear.
The example and criteria remain scrollable behind it.
Skip, self grading, and AI grading advance automatically to the next question or
results; AI runs in the background and never steals the next input's focus.
Skipped answers and AI errors can be handled with the grading controls in results.
Once an answer is graded, results show Graded and its score, source, and feedback,
and remove the self and AI grading controls. Zero-point grades are completed grades.
Cancel and Escape dismiss the prompt without grading or advancing and return focus
to Grade answer in the footer, which reopens the prompt on a submitted answer.
AI requests include the question, example answer, criteria, and student answer as
JSON reference data. Invalid model scores or missing explanations remain ungraded
and offer retry or self grading. No paid grading runs automatically.

The practice header is a compact row with the session label to the right of the
note title. Each new editable question focuses its textarea or first/selected
choice. Within an editable answer, arrows move the text cursor; Right invokes the
forward action only at the end of the text with no selection. Left stays within
the answer even at the start. Outside the input, plain Left/Right invokes Previous
or the current forward action (submit, next, or review); modified arrows and IME input keep their normal editing behavior.
Multiple-choice Up/Down moves focus without selecting and scrolls the focused
answer row into view. Its background and border show keyboard focus even though
input outlines are disabled. Right submits the focused
choice and advances directly to the next question or results. Enter does not select. In the
grading prompt Up/Down wraps through a single column of choices and Right (or
Enter) activates; Escape cancels. Self grades use color-coded labels without
numeric scores. A spacing break separates the grades from Grade with AI, Skip,
and Cancel, in that order.
Question hotkeys pause while a grading prompt or exit confirmation is open.
Opening results resets the scrolling content to the top and focuses that pane,
so Up/Down scrolls it by 120px per press with a 240ms cubic ease-out animation.
Repeated presses accumulate toward the destination, clamped to the content bounds.
Wheel or pointer interaction cancels the animation; reduced motion uses instant scrolling. Grading updates do not reset scroll or focus.

Drafts autosave for recovery, but newly submitted freeform answers enter durable
answer history only after receiving a grade. Migration `0007_answer_grading.sql`
adds grade provenance, grading timestamps, and session closure. Previously saved
multiple-choice submissions are graded from their original question snapshots.
Historical freeform submissions are retained until explicitly closed or graded.

Save and exit and the native window close control use the same flow. If an entered
answer lacks a grade (including an unrevealed draft), a modal offers to review it
or discard ungraded answers and exit. Confirming exit removes ungraded answer rows
and their text from the session's drafts in a transaction, retains graded work,
updates question statistics, and creates a scored performance when graded answers
exist. Incorrect answers worth zero are still retained. Closing is revision checked
and idempotent; a closed session rejects later edits and late AI results are ignored.
Graded answer text remains locked after revealing; grades may be revised until exit.
Closing waits for saves and finalization, then destroys the native window. Errors
keep the session open with retry. There is no session-history launcher yet.

The note tab refreshes after native grading/closure notifications and when returning
to the main window. It shows answered questions, saved submissions, and last answer
time. Score averages include graded answers only. Closing records total points;
voided or unanswered questions do not count toward the saved performance maximum.
Legacy ungraded history is not given an invented zero score. Practice reuse
priority uses saved graded answers. Images remain subject to network/file availability.

The shared `StudyText` renderer typesets math in questions, choices, examples,
and review answers. It supports `$...$`, `$$...$$`, `\(...\)`, and `\[...\]`,
and recognizes common undelimited legacy expressions, Unicode set notation,
superscripts, and bare LaTeX commands. This compatibility detection is limited
to recognizable notation; ambiguous prose is preserved. Entire mathematical
choices (including a single variable or number) are also typeset. Inline and
fenced code remain literal. Display formatting does not rewrite stored questions
or answers, and newly generated content uses explicit delimiters.

Verification: `npm run check`, `npm run build`, `npm run test:unit`,
`npm run test:ui`, and `cargo test --manifest-path src-tauri/Cargo.toml --lib`.
Browser tests mock Tauri IPC and AI responses; they do not launch a real native
window or call paid providers. Rust tests cover transactions, due selection,
snapshots, draft validation, and unchanged FSRS state after self-review.

Early exit also supports sessions with no graded answers, including empty sessions
and sessions containing only discarded drafts or ungraded submissions. The closing
score query explicitly returns SQLite REAL so its zero total decodes as Rust f64.
These sessions close without creating an empty performance.

Freeform answers use CodeMirror with a compact toolbar: Equation, fraction,
exponent, square root, and Symbols. KaTeX renders equations directly inside the
editable answer, while the document retains its original text and LaTeX. Clicking
a rendered equation reopens it in MathQuill. Cursor movement and deletion treat
equations as atomic units; undo and copy/paste operate on the underlying document.
MathQuill opens as an inline visual composer; Insert equation or Enter inserts `$...$` at the captured cursor/selection.
Cancel or Escape leaves the answer unchanged. Equation arrows never navigate
questions. Inserting restores text focus and respects the answer character limit.
Answers remain plain text with LaTeX for autosave, grading, and KaTeX rendering.
Inputs and editors have no focus outline; buttons and tabs retain theirs.
MathQuill and jQuery 3 are bundled locally with their required vendor CSS/fonts.
The MathQuill dependency uses the same jQuery 3 version via an npm override.

The question-and-answer body keeps a stable height between the header and footer.
Grading controls share the footer navigation row, and grading errors appear in
the scrolling body. The editor grows into the remaining space below the question.
At its maximum height the gap above the footer matches horizontal content padding:
16px in compact windows, 24px otherwise. Further text scrolls inside the editor;
its toolbar stays outside the editor’s scroll area.

Freeform answers offer Text / Draw tabs and retain both kinds of content. Draw
embeds Excalidraw through a lazy React root with only an application-owned top
tool strip. A 1200 × 800 logical sheet fits the editor and remains fixed when
panning or zoom shortcuts are attempted. Canvas backgrounds are transparent over
the shared input surface. Fonts are copied locally by the prepare/dev/build asset
script; no CDN is needed. Migration 0008 stores drawings with graded submissions
and includes them in note answer history. Drafts retain drawings and editor mode;
empty text with a non-empty drawing can be submitted. Drawings remain immutable
after submission. Results render a saved SVG preview. Ungraded drawings participate
in exit confirmation/discard, and drawing answers use self grading until visual
AI grading is implemented. Text-only AI grading is explicitly disabled for them.

Start opens Quick tweak before creating or launching a session. Its Start session
button confirms launch with the current draft; Close or Escape cancels launching
and returns focus to Start. Invalid question counts disable confirmation. The
separate Quick tweak shortcut also opens this popup, scoped to the tab content body.
It edits the same per-note draft as the full settings tab, immediately affecting
the next Start without saving a default. Controls appear in this order: question
count, multiple difficulties, format, and Included / Excluded topic columns.
The shared selector in Quick tweak and the full settings tab shows broad topics
only. Moving a group includes/excludes all its subtopics. Legacy subtopic filters
are shown under their broad parent; editing the selection saves whole groups.
Include all is beside Included; Exclude all is beside Excluded. Excluding all
leaves the selection empty and blocks Practice launch, including fresh generation,
until a topic is included again. The optional `excludeAllTopics` flag distinguishes
this from legacy empty `topicIds` meaning all topics. Migration
`0009_empty_topic_selection.sql` persists the flag with a backward-compatible false
default. Both Study and Practice honor this flag and topic filters.
Difficulty and compact format buttons share one row, with a 4px gap above Topics.
Close and Start session sit together at the top-right, in that order. Taller topic
columns fill the remaining popup height through the removed bottom action area.
Only topic columns scroll; the fields remain visible in compact windows.
Close and Escape preserve edits and return focus; changing notes or tabs closes
the popup. Reuse and saving defaults remain in the full settings tab.

Study scheduling uses the installed ts-fsrs 5.4.2 scheduler with 90% target
retention, default learning/relearning steps and maximum interval, and deterministic
intervals (`enable_fuzz: false`). The correctness grade directly determines the
FSRS rating: 0 = Again, 0.5 = Hard, 1 = Good. This applies to multiple choice,
self grading, and AI grading, including grading in results. There is no separate
recall step. Self grading and AI actions continue to the next question; AI may
finish in the background. Practice answers never change schedules. Ungraded
answers still use the existing review/discard confirmation.

Existing completed reviews retain their stored ratings (including manual Easy)
and do not run again. Old pending grades are scheduled automatically when an open
session is reloaded. Other historical grades are not retroactively rescheduled.
The former pending-rating flag now tracks incomplete schedule saves, not a
required user input. No migration files change for this behavior update.

`prepare_study_reviews` loads current cards and a native review timestamp.
The frontend calls ts-fsrs `next`, then sends the before/after card and review log
with the answer save. Native code checks card versions, ratings, grade finality,
review dates, and card invariants. The answer, card update, and unique review log
commit in one transaction. A changed card causes one recalculation against the
latest state; repeated saves/reloads never apply a second review. Once scheduled,
the Study grade points are final. Scheduler failures preserve
the answer for retry. Schedule reset starts fresh cards while keeping review history.
Migration `0010_fsrs_reviews.sql` adds review logs; `0011_pending_fsrs_ratings.sql`
adds pending-rating state. Keep applied migration files unchanged: development
reloads may already have recorded their checksums.

Note tabs show broad topics with due-today and total card counts, next review date,
and expandable per-date schedules. Letter grades average the latest 50 graded
answers across Study and Practice, using available answers when fewer than 50.
No answers shows an em dash. The thresholds are A+ 97, A 93, A− 90, B+ 87, B 83,
B− 80, C+ 77, C 73, C− 70, D+ 67, D 63, D− 60; lower percentages are F. The score
is classified before display rounding. Question snapshots retain broad-topic
membership so archived questions and later hierarchy edits keep historical grades.
Both grades and schedules refresh through the existing native progress event and
window-focus refresh.

Cmd+E in the editable answer text opens and focuses the MathQuill equation input
at the current cursor/selection. It reuses an open composer, preserves its draft,
and leaves submitted answers read-only. The Equation action exposes the shortcut
in its tooltip and accessibility metadata.

Overview derives current and longest streaks from persisted graded answers in both
Study and Practice. Incorrect answers count; drafts and ungraded/discarded work do
not. Deduplicate saved answer IDs, ignore invalid/future timestamps, and group by
local calendar day. A streak remains current when the last active day was today
or yesterday. Calendar-day identities handle 23/25-hour daylight-saving days.
Activity shows the latest 14 days with actual answer counts.

Today’s reviews appears directly below the streak summary, before activity. It
lists every Studying note, including zero counts, and the combined remaining total.
Counts include overdue cards and all cards due before the next local midnight,
including learning/relearning cards scheduled later today. Study sessions still
wait until a learning card’s exact due time. The shared eligibility helper excludes
additional questions, invalid cards, and historical submissions already answered
today without a review log, before topic filters and question limits. Unavailable
or unresolved notes show a status and zero reviews. Rows open the corresponding
note tab. Totals refresh on saved progress, focus/visibility changes, and midnight.

Overview includes a full-month Review calendar between Today’s reviews and Study
activity. The Monday-first table shows every date and a numeric remaining-card
count, including zero, from available Studying notes without unresolved changes.
Use saved FSRS due dates in the local timezone. Overdue cards roll into today and
respect the same historical-answer exclusions as Today’s reviews; additional and
invalid cards are excluded. Each card contributes once at its current due date,
without predicting later repetitions. Past dates do not show completion history.
Previous month, Next month, and Today navigate across months and years. The default
month follows the current date at midnight; an explicitly browsed month stays
selected. Counts react to refreshed note data and local day changes. Highlight
today visibly and semantically; expose full dates and counts to screen readers.

The review calendar uses a compact bordered sidebar-colored panel, up to 576px
wide, with 12–16px padding. Align its title and month controls on a single centered
32px header row above a divider. Day cells are approximately 48px high, keeping
the full month readable while separating it from the surrounding Overview content.

Today’s reviews, Review calendar, and Study activity share `tabSection`,
`tabSectionHeader`, and `tabSectionTitle` styles. Each uses the same compact
sidebar-colored panel, border, 8px corners, 576px width cap, 12–16px padding,
and vertically centered header above a divider. Activity uses two rows of seven
compact day tiles. Empty states stay within the panel without nested cards.
The reusable styling contract is recorded in `1details/stylingRules.md`.
