---
name: specs
description: Read, search, annotate, and update project spec documents through the Specs plugin. Use when thread context lists linked specs, when the user mentions a spec/design doc/requirements, before changing code a spec covers, or when asked to write or review a spec.
---

# Specs

Specs are markdown documents stored centrally by the Specs plugin. They can be
linked to projects, attached to individual threads, annotated, and discussed in
a dedicated chat thread. Threads receive a compact index of their linked specs
in the injected context; full content is pulled on demand.

## When to use

- The thread instructions include a `Specs context` block: those documents are
  in scope. Read one before changing code it covers.
- The user mentions a spec, design doc, requirements, RFC, or plan.
- You are asked to review, update, or annotate a spec.

## Tools

| Tool | Use |
| --- | --- |
| `specs_search` | Find specs by text; returns ids, slugs, revisions. |
| `specs_read` | Full content plus open annotations. Accepts id or slug. Marks the revision as seen. |
| `specs_write` | Update content/title/summary. Pass `expectedRevision` from the read; a conflict means re-read and merge. |
| `specs_create` | Create a spec, link it to a project, attach it to this thread. |
| `specs_annotate` | Leave a quoted note, or `kind: "question"` to open one that enters the question loop. |
| `specs_reply` | Reply inside a question's or note's comment thread. |
| `specs_questions` | The loop's inbox: list questions by state across a spec or project. |
| `specs_answer` | Answer an open question; it moves to answered and waits for triage. |
| `specs_clarify` | Ask a follow-up when an answer is not enough to decide. |
| `specs_resolve` | Close a question with a decision, linked to the spec revision that carries it. |
| `specs_dismiss` | Drop a question without deciding (out of scope, duplicate). |
| `specs_promote` | Turn a question written in the spec text into a loop question (see below). |
| `specs_attach` / `specs_detach` | Add or remove a spec from this thread's context. |
| `specs_delete` | Permanently delete a spec, its revisions, and its annotations. Its chat thread is archived. Only on explicit request. |

The same operations exist as `bb specs ...` (see `bb specs help`) for scripts
and manual runs.

## The question loop

Questions are annotations with `kind: "question"` and a lifecycle. Run the loop
instead of answering once and moving on:

1. **Fetch** with `specs_questions` (or `bb specs questions`). States sort as
   `answered` (triage inbox) → `open` → `clarify` → closed.
2. **Questions asked by the user are dispatched to you.** When the user asks in
   the UI or from a standalone CLI, the plugin sends the question to the spec's
   agent thread; a user reply in the thread dispatches another turn. When that
   happens:
   - **Reply in the question's own thread** with
     `specs_reply({ annotationId, body })` — that is where the user is reading.
   - Then record `specs_answer` if the spec and project context settle it, or
     `specs_clarify` with one sharp follow-up if not.
   - Never edit the spec unless the question asks for it. CLI runs inside a
     thread do not re-dispatch, so replies made with `bb specs reply` cannot
     loop.
3. **Answer** with `specs_answer` when the spec and project context settle it.
   The question moves to `answered` and waits for triage.
3. **Triage the answer**: is it enough to decide?
   - No → `specs_clarify` with one sharp follow-up. The parent moves to
     `clarify` and the follow-up appears as a new open question.
   - Yes → fold the decision into the document:
     `specs_write` the changed content, then `specs_resolve` with the decision
     and the new revision as `foldedRevision`.
4. **Dismiss** (`specs_dismiss`) only when no decision is needed; the reason is
   recorded.

Every transition is append-only in each question's `events` history: who asked,
answered, clarified, decided, or dismissed, when, and which revision carries a
folded decision. `specs_read` returns open questions and the decision audit
trail, so a later thread can see why the spec says what it says. Never edit a
decided question's decision into silence — reopen it (`specs_reopen`) or open a
new question that references it.

## Questions written in the text

Questions can also be posed in the document itself. The plugin detects:

- list items under a `## Open questions` (or `## Questions`) heading
- inline `TBD:`, `TODO(question):`, and `OPEN QUESTION:` markers

They show up in `specs_questions` as "Questions in text (not yet in the loop)",
in the digest as an `in text` count, and in the comments rail under **From
text**. A question already carrying a `→ ann_...` reference is treated as
promoted and is not detected again.

**Promote before answering.** `specs_promote({ idOrSlug, text })` creates a real
loop question anchored to that line and replaces the prose with
`<question> → ann_...`, so the answer, decision, and audit trail attach to it
instead of living in prose. Use the exact wording from the spec; if the text
changed, re-read first.

Decisions written under a `## Decisions` heading are listed read-only in the
History view. Record new decisions through `specs_resolve` — prose decisions
are labelled "not audited".

## Conventions

- **Read before writing.** `specs_read` returns the current revision; use it as
  `expectedRevision` on `specs_write`. Never force-overwrite on conflict.
- **Every content change bumps the revision.** Downstream threads see the bump
  in their context and re-read.
- **Annotate, don't silently rewrite.** If feedback is a question or a concern,
  use `specs_annotate` with the exact quoted text.
- **Keep summaries one line.** The summary is what other threads see in the
  context index.
- **Scoping modes** when linking to a project: `pinned` (always in every
  thread's index), `auto` (in the index when updated since the thread last read
  it, or recently updated), `available` (searchable/readable, never injected).
- A spec's chat thread is attached automatically; changes agreed there should be
  applied with `specs_write` in that thread.
- Deletion (`specs_delete`, `bb specs delete <id> --yes`) is permanent and is
  only performed when the user explicitly asks for it.
