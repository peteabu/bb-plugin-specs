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
| `specs_annotate` | Leave a quoted review note without changing the text. |
| `specs_attach` / `specs_detach` | Add or remove a spec from this thread's context. |
| `specs_delete` | Permanently delete a spec, its revisions, and its annotations. Its chat thread is archived. Only on explicit request. |

The same operations exist as `bb specs ...` (see `bb specs help`) for scripts
and manual runs.

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
