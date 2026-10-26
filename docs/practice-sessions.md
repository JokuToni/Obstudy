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
excluding questions already submitted in Study during the current local day.
Practice submissions do not remove questions from Study. It ignores practice
filters and never generates questions. Practice with reuse enabled prefers
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
AI integration. The same controls appear immediately after submission and in the
results view. Users may move on without grading and finish grading in results.
AI requests include the question, example answer, criteria, and student answer as
JSON reference data. Invalid model scores or missing explanations remain ungraded
and offer retry or self grading. No paid grading runs automatically.

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
Legacy ungraded history is not given an invented zero score. FSRS rescheduling is
still deferred; the existing same-day Study exclusion and Practice reuse priority
use saved graded answers. Images remain subject to network/file availability.

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
