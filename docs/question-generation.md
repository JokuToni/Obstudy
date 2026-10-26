# Question generation

The `luoKysymyksiä` function is exported as `generateQuestions` from
`src/lib/services/questions.ts`. It uses the active integration through `promptAi`.
The note tab’s Manage questions button, aligned to the right of its title row,
opens a popup centered within the tab content body. Its backdrop covers only that
body, leaving the tab bar, notes sidebar, and bottom controls unaffected. Switching
tabs closes the popup. It contains
generation settings, Generate questions, Remove questions, Reset study schedule,
confirmations, and generation feedback. Close or Escape dismisses it and returns
focus to the trigger; closing it does not interrupt generation. AI setup actions
close the popup before navigating to integrations. The Generate questions button
calls this service. Generation progress
is kept in the workspace so switching or closing tabs does not interrupt it.
The UI updates the saved question count after each batch and displays partial
results, errors, and provider notices. Additional generation offers count,
difficulty, and format controls; all note topics are included. Partial additional
requests prefill the remaining count for retry.

```ts
import { generateQuestions } from "$lib/services/questions";

const result = await generateQuestions(
    10,
    noteId,
    selectedTopicIds,
    2, // 0: multiple choice, 1: free text, 2: mixed
    1, // 0: easy, 1: medium, 2: hard
    {
        outputLanguage: "Finnish", // Default: the source notes' language
        onNoteUpdated: (note) => {
            // Replace the workspace note's questions and FSRS cards here.
        },
        onProgress: ({ generatedCount, requestedCount }) => {
            console.log(`${generatedCount}/${requestedCount}`);
        },
    },
);
// Update the workspace's note with result.note.
// Inspect result.complete and result.warnings before reporting completion.
```

The first call creates the full basic question set for the note. It ignores the
requested count, topics, format, and difficulty for that set. Easy questions total
three per subtopic, with multiple-choice counts alternating two and one across
subtopics. Medium questions total twice each broad topic's subtopic count, with
one third of the total medium count rounded to the nearest integer being multiple
choice, distributed across broad topics. Hard questions
total twice the number of broad topics and are all free text. Each basic question
has `isBasicQuestion: true` and a new `ts-fsrs` card stored atomically with it.

An incomplete basic set is resumed on the next call. Saved scope, difficulty,
and format identify completed slots. Once all basic targets are filled, calls
create additional questions using the requested count and filters. Defaults are
easy difficulty and mixed format; mixed requests use half multiple choice,
rounded up, and the rest free text. Additional questions have
`isBasicQuestion: false` and never get FSRS cards. Their difficulty does not
determine whether they are basic.

Fresh practice sessions explicitly pass `generationMode: "additional"`. This
creates only the requested additional questions, even when the note's basic set
is incomplete. It never creates or changes FSRS cards.

Broad-topic selections include their children. Subtopic selections include only
those subtopics, along with their parent titles for context. Empty selections
mean all topics. Missing notes, parse errors, and unresolved synchronization
issues prevent generation. Basic generation covers parentless subtopics at easy
difficulty; medium and hard counts follow the documented broad-topic rules.

Deployable prompt copies are in `src/lib/prompts/questions.ts`, taken from
`1details/project.md` under `KYSYMYS PROMPTIT`. Update those copies when the
requirements change. The application does not need the private project document
at runtime. The relevant source text and existing questions are inserted as JSON
reference data into each request. Local validation checks formats, topic IDs,
required answer fields, and exact duplicates after whitespace/case normalization;
it does not prove factual accuracy or detect all semantic duplicates.

The shared prompt requires KaTeX-compatible LaTeX for all mathematical notation
in question text, choices, example answers, and grading criteria, with `$...$`
inline delimiters or `$$...$$` display delimiters. Even single-symbol choices
must be delimited. LaTeX backslashes must be escaped in the provider's JSON.

Requests generate up to four questions at a time and make at most one corrective
request per batch for missing or rejected questions. Each valid subset is saved
immediately. Insufficient content can return `complete: false` with warnings.
Network, provider, or storage failures throw `QuestionGenerationError`; its
`result` contains saved progress and usage from successful API responses.
Additional-question retries should request only the remaining count. Basic
retries automatically fill missing slots. An optional `AbortSignal` stops work
between requests; it does not cancel an already-running provider request.

SQLite migration `0003_question_generation.sql` adds the basic flag, generation
time, model name, and scope. Existing questions with FSRS cards retain their
cards and become basic. Other existing questions remain additional; their legacy
generation metadata is null. Database triggers reject FSRS cards for additional
questions. Archived questions retain their stored history, but their cards are
excluded from active note snapshots.

Verification uses `npm run test:unit` and `cargo test --lib` in `src-tauri`.
AI responses are mocked; no paid generation is performed by these tests.

## Managing note questions

The note tab also provides Remove questions and Reset study schedule. Both ask
for inline confirmation and block conflicting operations for the same note.
Removal archives all active questions for that note; answers, exercise snapshots,
and performance history remain stored. Reset replaces active basic-question
cards with new `ts-fsrs` cards due now. It keeps questions, scores, answers,
archived schedules, and practice-only questions unchanged.

`manageNoteQuestions` in `src/lib/services/questions.ts` calls the transactional
`manage_note_questions` native command. Confirmation captures the active question
IDs; the backend rejects stale confirmations before applying changes. These
operations do not require an AI integration. Their buttons are disabled when
there are no applicable questions or while another operation is running.

Generate questions opens AI configuration when a model or integration is missing.
A signed-in integration with no model opens directly in its editor, where the
user chooses and saves a model before returning to generation.

## Streaming responses and errors

ChatGPT sign-in requests use SSE. The parser retains output items, completed
content parts, finalized text, and text deltas, then fills text omitted from the
terminal response. It preserves output/content order and avoids duplicating
text repeated across stream snapshots. It requires `response.completed` with
completed status before accepting the answer; interrupted, failed, incomplete,
and refused responses remain errors. Reasoning and tool arguments are not used
as question text.

A genuinely empty completed response reports `empty_output`. The generation
error preserves safe error codes, HTTP status, and request ID in the optional
Technical details section. Prompts, credentials, and raw provider payloads are
excluded from those details. Recovery tests use simulated streams, not paid
live requests.

Reference: [OpenAI Responses streaming events](https://developers.openai.com/api/reference/resources/responses/streaming-events).
