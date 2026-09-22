# bb-plugin-specs

Spec documents that any BB project can read, annotate, discuss, and update.

Specs live in the plugin's own SQLite store (`<dataDir>/plugins/specs/data.db`),
so they exist across projects without living in any one repo. Every surface is
backed by the same store:

- **Specs page** (left sidebar, `app.slots.navPanel`) — browse, read, edit,
  annotate selected text, reply to annotations, and chat in the spec's own
  agent thread.
- **Specs panel tab** (`threadPanelAction` "Specs") — the same workspace as a
  flush tab in a thread's right panel, so a spec sits beside the conversation.
- **Full-screen overlay** (`experimental_appOverlay`) — a chrome-less Specs
  surface over the whole app, opened from the command palette
  ("Specs: open the workspace") or the composer's `+` menu; Esc returns.
- **Thread action "Spec context"** (`app.slots.threadPanelAction`) — see and
  edit exactly which specs the current thread receives, with a preview of the
  injected context block.
- **Agent tools** — `specs_search`, `specs_read`, `specs_write`,
  `specs_create`, `specs_annotate`, `specs_attach`, `specs_detach`. Tool
  availability and the context digest resolve per thread.
- **`bb specs ...` CLI** — the same operations for humans and scripts
  (`bb specs help`).
- **Skill** `skills/specs/SKILL.md` — teaches agents the conventions; injected
  into agent threads.

## Context scoping

Specs are linked to projects with one of three modes:

- `pinned` — always listed in every thread of the project
- `auto` — listed when the thread read an older revision (the "doc changed"
  signal) or, for fresh threads, when recently updated
- `available` — searchable and readable, never injected

Threads can also attach/detach individual specs (UI or tools). The injected
digest is **index-only** — slug, revision, title, one-line summary — capped by
`digestMaxRows` / `digestMaxChars`; full content is only fetched by
`specs_read`. A 50-spec project typically injects a handful of rows.

## Editing and review

`agentWriteMode=propose` is the default for native agent tools and CLI commands
run from agent threads. Content, title, summary, and icon changes create a
proposal for the user to apply or reject. Agents cannot apply, reject,
acknowledge, or revert changes in this mode. `agentWriteMode=direct` enables
direct edits and retains agent attribution in revision history and the review
banner. Human CLI commands continue to apply edits directly.

Use `expectedRevision` (CLI: `--expected-revision`) with writes and proposals;
an intervening edit rejects the submission before it changes the document or
creates a proposal. Proposal question links must name a question on that spec.

Permanent deletion removes the spec's revisions, annotations, discussions,
proposals, decisions, and research records, and stops and archives active
research and chat threads. Completed research reports remain as independent
specs; their parent reference is cleared. Archived thread history is retained.

## Development

```
npm install
bb plugin install .
bb plugin dev          # rebuild + reload on every save
```

Typecheck with `npx tsc --noEmit`; build with `bb plugin build`.

## Settings

```
bb plugin config specs
bb plugin config specs set digestMaxRows 12
bb plugin config specs set digestMaxChars 1800
bb plugin config specs set recentSpecsPerProject 3
bb plugin config specs set contributeContext false
bb plugin reload specs
```

The Plugin SDK type surface lives at
`node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts` (backend) and
`...-app.d.ts` (frontend).
