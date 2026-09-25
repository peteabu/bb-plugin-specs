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

1. Fetch questions with `specs_questions`.
2. Reply with `specs_reply` in the question's own conversation. Ask any follow-up
   there too; do not create another question merely to clarify the answer.
3. When the context supports an answer, record `specs_answer` with
   `requiresSpecChange: false` if no document edit is needed, or `true` if it is.
   Omission conservatively requires checking document impact. CLI equivalent:
   `bb specs answer <id> --text <answer> --no-spec-change` for answer-only decisions.
4. If a spec change is needed, create a proposal with `specs_propose`, `questionId`,
   and `expectedRevision`. Leave the question open for user review.
5. The user chooses **Accept decision** for an answer-only decision, or
   **Review change → Apply and close** for a linked proposal. Apply and close
   saves the document, attributed decision, and question resolution atomically.
   If the proposal is missing, acceptance asks the agent to prepare it; the
   question remains pending until reviewed. Do not resolve on the user's behalf.

A user reply continues the same conversation, returns the question to waiting
for a response, and supersedes its pending proposal. Record a fresh answer and
proposal after incorporating the reply. Closed questions must be explicitly
reopened before answering again. Existing clarification tools remain available
for distinct linked questions, but are not the normal follow-up path.

The UI keeps Edit answer, Dismiss, Reopen, Delete, and History in More. Discussion,
answers, decisions, and revision events remain separate records in the audit
trail. `specs_resolve` remains available for explicitly authorized decisions
outside the user-review flow; do not use it to bypass acceptance.

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

## Proposals, decisions, and research

- **People own the document.** With the default `agentWriteMode=propose`,
  `specs_write` and agent-thread `bb specs write` calls record a proposal the user reviews and applies, including title, summary, and icon edits (the UI shows a
  diff with Apply / Reject). Link a proposal to the question it answers with
  `questionId`; **Apply and close** records the decision, links its revision, and closes
  the question together. Standalone proposals retain Apply / Reject. Use `specs_propose` for edits you initiate and
  `specs_write` when the user explicitly asked for the edit.
  Pass the revision you read as `expectedRevision` (CLI: `--expected-revision`)
  on writes and proposals; stale submissions are rejected. A linked question
  must belong to the same spec. In proposal mode, agents cannot use the CLI to
  apply, reject, acknowledge, or revert changes; those are user review actions.
  With `agentWriteMode=direct`, agent CLI mutations retain agent attribution.
- **Decisions are the record.** `specs_resolve`/`specs_dismiss` write an
  attributed decision (decider, revision, rationale, accepted comments) that
  survives later rewrites; `specs_decide` records one without a question and
  `specs_decisions` lists them. Check `specs_decisions` before re-litigating.
- **Research runs are durable.** `specs_research` starts a read-only
  investigation; when it finishes the report is published as a child spec with
  its own chat, questions, and decisions, nested beneath the parent in the UI.
  Once all report questions and proposals are settled, a synthesis thread
  prepares a parent proposal automatically. In that thread, use `specs_propose`
  with the supplied `researchId`, `researchKey`, and the parent revision you
  read as `expectedRevision`. Never apply the update yourself. User acceptance
  records the incorporated parent revision; changed findings invalidate old
  updates. Historical reports start preparation on a later change or explicit
  user request, not merely because the plugin was installed.
- **Chat has one Send action.** Each message asks the spec's agent to reply.
  No mention syntax is required. When a question is dispatched, reply with
  `specs_reply` and record a settled answer with `specs_answer`.
- **Inline drafting has an explicit insertion point.** Requests from the editor
  include the saved revision and a temporary marker in a document snapshot.
  Propose the full document with the requested content at that position;
  preserve existing text and exclude the marker. Use `specs_propose` even
  when direct writes are configured. If the revision changed, ask the user
  to choose the position again instead of guessing.
- **Diagrams are document content.** Use standalone fenced `mermaid` blocks.
  For diagram iterations, preserve surrounding prose and propose the full
  revised document against the revision you read.
- Agent-made revisions show a review banner in the UI with Keep / Revert, so a
  direct write (or an applied proposal) is never silently accepted.

## Conventions

- **Read before writing.** `specs_read` returns the current revision; use it as
  `expectedRevision` on `specs_write` or `specs_propose`. Never force-overwrite on conflict.
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
