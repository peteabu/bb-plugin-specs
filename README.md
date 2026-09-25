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

## Research, conversation, and diagrams

Research reports appear beneath their parent in navigation, with a parent link
and incorporation status in the report. Once the report has no unresolved
questions (including questions still in its text) or pending proposals, Specs
prepares a parent update automatically. Review the diff and **Apply to parent**
to incorporate it. The report then links to that exact parent revision.
Changes to findings invalidate older updates; interruptions and parent revision
conflicts offer **Prepare parent update** to retry. Existing reports are not
all dispatched on installation: preparation starts after a report changes or
when explicitly requested.

Specs open ready to edit: click the title, summary, or document and type.
Changes autosave, with revision conflicts and recovery controls shown when
needed. There is no Edit/Done mode. Select text for formatting, comments, or
**Ask agent**; `/` and `@agent` are always available.

Markdown tables render as editable cells, retaining header alignment, inline
formatting, and escaped pipes when saved. Task lists have interactive checkboxes;
Click a checkbox to toggle it. For keyboard use, press Left at the start of
the task text to focus its checkbox, then Space to toggle it.
Use `/table` or `/checklist` to insert these blocks, or paste their Markdown.
Nested lists and strikethrough retain their formatting in the editor.

In the document, type `@agent` and choose **Draft here** (Enter also
selects it). Describe the prose, code, or Mermaid diagram you want at that
position, then click **Draft**. Current edits save first, and the request goes
to the spec's agent. Review and apply its document proposal when ready.
Cancel/Escape dismisses the prompt; failed requests stay available to retry.
Mentions inside code are literal text. `@agent` uses this spec's existing agent;
it is not a picker for other agents.

The spec chat has one **Send** action. Sending the first message creates its
conversation; subsequent messages continue it. Document edits use the normal
proposal review flow (unless direct editing is configured).

Standalone fenced `mermaid` blocks render as diagrams. **Edit source** gives a
live preview within the document; **Save diagram** updates the same autosaved draft. **Discuss
diagram** attaches the source to a chat draft; **Add diagram**
starts a draft asking the agent to propose one in the document. The editor's
`/diagram` command inserts a diagram block with its source editor open. Rendering uses Mermaid's
strict mode and displays SVG as an isolated image; invalid source remains
readable and editable.

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
