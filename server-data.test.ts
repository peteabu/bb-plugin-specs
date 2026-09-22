import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse, type FakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin, { type SpecDetail } from "./server";

const agentContext = { threadId: "agent-thread", projectId: "project-1" };
let host: FakePluginHost;

beforeEach(async () => {
  host = createFakePluginHost({ pluginId: "specs", settings: { autoTriageQuestions: false } });
  await plugin(host.bb);
});

afterEach(async () => { await host.harness.lifecycle.dispose(); });

async function rpc<T>(name: string, input: unknown): Promise<T> {
  return await host.harness.behavior.callRpc(name, input) as T;
}

async function create(title = "Original") {
  return rpc<{ id: string; slug: string }>("specs_create", {
    title, content: "User content", projectIds: ["project-1"],
  });
}

function detail(id: string) { return rpc<SpecDetail>("specs_get", { idOrSlug: id }); }
function agent(name: string, input: unknown) {
  return host.harness.behavior.callAgentTool(name, input, agentContext);
}
function cli(args: string[], asAgent = true) {
  return host.harness.behavior.runCli(args, asAgent ? agentContext : {});
}

describe("proposal concurrency and review", () => {
  it.each(["specs_write", "specs_propose"])("%s rejects a stale expected revision before recording a proposal", async (tool) => {
    const spec = await create();
    await rpc("specs_save", { id: spec.id, content: "New user content", expectedRevision: 1 });
    const result = await agent(tool, { idOrSlug: spec.id, content: "Stale agent content", expectedRevision: 1 });
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("Revision conflict");
    const current = await detail(spec.id);
    expect(current.spec.content).toBe("New user content");
    expect(current.proposals).toEqual([]);
  });

  it("agent CLI writes propose and enforce revisions exactly like the native tool", async () => {
    const spec = await create();
    const result = await cli(["write", spec.id, "--content", "Agent draft", "--expected-revision", "1", "--json"]);
    expect(result.exitCode).toBe(0);
    expect((await detail(spec.id)).spec.content).toBe("User content");
    const proposal = (await detail(spec.id)).proposals[0]!;
    expect(proposal).toMatchObject({ baseRevision: 1, author: "agent", content: "Agent draft" });
    await rpc("specs_save", { id: spec.id, content: "Updated by user", expectedRevision: 1 });
    expect((await cli(["write", spec.id, "--content", "Stale", "--expected-revision", "1"])).exitCode).toBe(1);
    expect((await cli(["propose", spec.id, "--content", "Stale", "--expected-revision", "1"])).exitCode).toBe(1);
    expect((await detail(spec.id)).proposals).toHaveLength(1);
    await expect(rpc("proposals_apply", { proposalId: proposal.id })).rejects.toThrow(/stale/);
    expect((await detail(spec.id)).spec.content).toBe("Updated by user");
  });

  it.each(["native", "CLI"])("%s metadata-only writes require review and preserve all proposed fields", async (surface) => {
    const spec = await create();
    if (surface === "native") {
      await agent("specs_write", { idOrSlug: spec.id, title: "New title", summary: "New summary", icon: "📌", expectedRevision: 1 });
    } else {
      expect((await cli(["write", spec.id, "--title", "New title", "--summary", "New summary", "--icon", "📌", "--expected-revision", "1"])).exitCode).toBe(0);
    }
    const before = await detail(spec.id);
    expect(before.spec).toMatchObject({ title: "Original", summary: "", icon: "📄", revision: 1 });
    const proposal = before.proposals[0]!;
    expect(proposal).toMatchObject({ title: "New title", summary: "New summary", icon: "📌", content: "User content" });
    await rpc("proposals_apply", { proposalId: proposal.id });
    expect((await detail(spec.id)).spec).toMatchObject({ title: "New title", summary: "New summary", icon: "📌", content: "User content", revision: 2 });
  });

  it("agent CLI cannot apply, reject, acknowledge, or revert in proposal mode", async () => {
    const spec = await create();
    await agent("specs_propose", { idOrSlug: spec.id, content: "Proposed" });
    const proposal = (await detail(spec.id)).proposals[0]!;
    for (const args of [["apply", proposal.id], ["reject", proposal.id], ["ack", spec.id, "--revision", "1"], ["revert", spec.id, "--to", "1"]]) {
      const result = await cli(args);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("requires user review");
    }
    expect((await detail(spec.id)).proposals[0]?.status).toBe("pending");
    expect((await detail(spec.id)).spec.revision).toBe(1);
    expect((await cli(["apply", proposal.id], false)).exitCode).toBe(0);
    expect((await detail(spec.id)).spec.content).toBe("Proposed");
  });

  it("reviewing a rejected proposal again leaves its resolution and spec unchanged", async () => {
    const spec = await create();
    await agent("specs_propose", { idOrSlug: spec.id, content: "Proposed" });
    const proposal = (await detail(spec.id)).proposals[0]!;
    await rpc("proposals_reject", { proposalId: proposal.id, note: "Keep the existing wording" });
    const db = host.bb.storage.database();
    const before = db.prepare("SELECT * FROM proposals WHERE id = ?").get(proposal.id);
    await expect(rpc("proposals_apply", { proposalId: proposal.id })).rejects.toThrow(/rejected/);
    await expect(rpc("proposals_reject", { proposalId: proposal.id, note: "Replacement reason" })).rejects.toThrow(/rejected/);
    expect(db.prepare("SELECT * FROM proposals WHERE id = ?").get(proposal.id)).toEqual(before);
    expect((await detail(spec.id)).spec).toMatchObject({ content: "User content", revision: 1 });
  });

  it("direct mode retains agent attribution for CLI write, apply, reject, create, and revert", async () => {
    await host.harness.behavior.setSettings({ agentWriteMode: "direct" });
    const created = await cli(["create", "Agent created", "--json"]);
    const createdId = (JSON.parse(created.stdout) as { id: string }).id;
    expect((await detail(createdId)).agentChange?.author).toBe("agent");
    const spec = await create();
    expect((await cli(["write", spec.id, "--content", "Agent edit", "--expected-revision", "1"])).exitCode).toBe(0);
    expect((await detail(spec.id)).agentChange).toMatchObject({ author: "agent", revision: 2, acked: false });
    await agent("specs_propose", { idOrSlug: spec.id, content: "Applied by agent", expectedRevision: 2 });
    const proposal = (await detail(spec.id)).proposals[0]!;
    expect((await cli(["apply", proposal.id])).exitCode).toBe(0);
    expect(host.bb.storage.database().prepare("SELECT resolved_by FROM proposals WHERE id = ?").get(proposal.id)).toEqual({ resolved_by: "agent" });
    expect((await detail(spec.id)).agentChange).toMatchObject({ author: "agent", revision: 3 });
    await agent("specs_propose", { idOrSlug: spec.id, content: "Rejected" });
    const rejectedId = (await detail(spec.id)).proposals[0]!.id;
    expect((await cli(["reject", rejectedId])).exitCode).toBe(0);
    expect(host.bb.storage.database().prepare("SELECT resolved_by FROM proposals WHERE id = ?").get(rejectedId)).toEqual({ resolved_by: "agent" });
    expect((await cli(["ack", spec.id, "--revision", "3"])).exitCode).toBe(0);
    expect((await detail(spec.id)).agentChange?.acked).toBe(true);
    expect((await cli(["revert", spec.id, "--to", "1"])).exitCode).toBe(0);
    expect((await detail(spec.id)).agentChange).toMatchObject({ author: "agent", revision: 4, acked: false });
  });

  it("rejects proposal questions on another spec, notes, and missing annotations", async () => {
    const spec = await create();
    const other = await create("Other");
    const foreign = await rpc<{ id: string }>("annotations_create", { specId: other.id, quote: "User", body: "Why?", kind: "question" });
    const note = await rpc<{ id: string }>("annotations_create", { specId: spec.id, quote: "User", body: "A note" });
    for (const questionId of [foreign.id, note.id, "ann_missing"]) {
      expect(await agent("specs_propose", { idOrSlug: spec.id, content: "Proposed", questionId })).toMatchObject({ isError: true });
    }
    expect((await detail(spec.id)).proposals).toEqual([]);
    // Legacy invalid pending records must also be rejected before saving.
    await agent("specs_propose", { idOrSlug: spec.id, content: "Proposed" });
    const proposal = (await detail(spec.id)).proposals[0]!;
    host.bb.storage.database().prepare("UPDATE proposals SET question_id = ? WHERE id = ?").run(foreign.id, proposal.id);
    await expect(rpc("proposals_apply", { proposalId: proposal.id })).rejects.toThrow(/belonging to this spec/);
    expect((await detail(spec.id)).spec.revision).toBe(1);
    expect((await detail(other.id)).annotations[0]?.foldedRevision).toBeNull();
  });

  it("applying a proposal links its own question and decision to the applied revision", async () => {
    const spec = await create();
    const question = await rpc<{ id: string }>("annotations_create", { specId: spec.id, quote: "User", body: "Why?", kind: "question" });
    await rpc("questions_resolve", { annotationId: question.id, decision: "Use the proposal" });
    await agent("specs_propose", { idOrSlug: spec.id, content: "Decision implemented", questionId: question.id, expectedRevision: 1 });
    const proposal = (await detail(spec.id)).proposals[0]!;
    await rpc("proposals_apply", { proposalId: proposal.id });
    const current = await detail(spec.id);
    expect(current.annotations[0]).toMatchObject({ id: question.id, foldedRevision: 2 });
    expect(current.decisions[0]).toMatchObject({ questionId: question.id, revision: 2 });
    expect(current.annotations[0]?.events).toContainEqual(expect.objectContaining({ event: "applied", actor: "user", revision: 2 }));
  });

  it("old proposals without an icon retain the existing icon when applied", async () => {
    const spec = await create();
    await rpc("specs_save", { id: spec.id, icon: "📌", expectedRevision: 1 });
    await agent("specs_propose", { idOrSlug: spec.id, content: "Changed content", expectedRevision: 2 });
    const proposal = (await detail(spec.id)).proposals[0]!;
    expect(proposal.icon).toBeNull();
    await rpc("proposals_apply", { proposalId: proposal.id });
    expect((await detail(spec.id)).spec.icon).toBe("📌");
  });

  it("retains valid pending proposals after more than 50 newer rejected proposals", async () => {
    const spec = await create();
    await agent("specs_propose", { idOrSlug: spec.id, content: "Old pending proposal" });
    const pending = (await detail(spec.id)).proposals[0]!;
    for (let index = 0; index < 51; index += 1) {
      const result = await cli(["propose", spec.id, "--content", `New ${index}`, "--json"]);
      const id = (JSON.parse(result.stdout) as { id: string }).id;
      await rpc("proposals_reject", { proposalId: id });
    }
    expect((await detail(spec.id)).proposals.map((proposal) => proposal.id)).toEqual([pending.id]);
    expect(JSON.stringify(await agent("specs_read", { idOrSlug: spec.id }))).toContain(pending.id);
  });
});

describe("CLI validation", () => {
  it.each(["propose", "direct"])("rejects missing or malformed expected revisions without changes in %s mode", async (mode) => {
    await host.harness.behavior.setSettings({ agentWriteMode: mode });
    const spec = await create();
    for (const command of ["write", "propose"]) {
      for (const flag of ["--expected-revision", "--expected-revision=", "--expected-revision=invalid", "--expected-revision=1.5", "--expected-revision=1trailing"]) {
        const result = await cli([command, spec.id, "--content", "Invalid write", flag]);
        expect(result.exitCode, `${command} ${flag}`).toBe(1);
      }
    }
    expect((await detail(spec.id)).spec).toMatchObject({ content: "User content", revision: 1 });
    expect((await detail(spec.id)).proposals).toEqual([]);
  });

  it.each(["pinend", "", "none"])("rejects invalid mode %j before create or link changes storage", async (mode) => {
    const spec = await create();
    const before = await detail(spec.id);
    expect((await cli(["link", spec.id, "--project", "project-1", `--mode=${mode}`])).exitCode).toBe(1);
    expect((await cli(["create", "Invalid mode", `--mode=${mode}`])).exitCode).toBe(1);
    expect((await detail(spec.id)).links).toEqual(before.links);
    expect(host.bb.storage.database().prepare("SELECT COUNT(*) AS n FROM specs").get()).toEqual({ n: 1 });
  });

  it("rejects generic resolve for questions while retaining question lifecycle commands and note resolution", async () => {
    const spec = await create();
    const question = await rpc<{ id: string }>("annotations_create", { specId: spec.id, quote: "User", body: "Why?", kind: "question" });
    expect((await cli(["resolve", question.id])).exitCode).toBe(1);
    expect((await detail(spec.id)).annotations[0]).toMatchObject({ status: "open", state: "open" });
    expect((await cli(["resolve-question", question.id, "Decision"])).exitCode).toBe(0);
    expect((await detail(spec.id)).decisions).toHaveLength(1);
    const note = await rpc<{ id: string }>("annotations_create", { specId: spec.id, quote: "User", body: "Note" });
    expect((await cli(["resolve", note.id])).exitCode).toBe(0);
    expect((await detail(spec.id)).annotations.find((entry) => entry.id === note.id)?.status).toBe("resolved");
  });

  it("rejects a mode flag without a value", async () => {
    const spec = await create();
    expect((await cli(["create", "Invalid mode", "--mode"])).exitCode).toBe(1);
    expect((await cli(["link", spec.id, "--project", "project-1", "--mode"])).exitCode).toBe(1);
  });
});

it("deletes all owned records, cancels active research, and detaches retained child specs", async () => {
  const spec = await create();
  const child = await create("Retained research report");
  const question = await rpc<{ id: string }>("annotations_create", { specId: spec.id, quote: "User", body: "Why?", kind: "question" });
  await rpc("annotations_comment", { annotationId: question.id, body: "An answer" });
  await rpc("questions_resolve", { annotationId: question.id, decision: "A decision" });
  await rpc("discussion_post", { specId: spec.id, body: "Discussion" });
  await agent("specs_propose", { idOrSlug: spec.id, content: "Proposed", questionId: question.id });
  await agent("specs_read", { idOrSlug: spec.id });
  host.harness.sdk.stub("threads.spawn", async () => makeThreadResponse({ id: "research-thread", status: "active" }));
  await rpc("research_start", { specId: spec.id, brief: "Investigate" });
  const db = host.bb.storage.database();
  db.prepare("UPDATE specs SET parent_spec_id = ? WHERE id = ?").run(spec.id, child.id);
  db.prepare("INSERT INTO chat_threads (spec_id, thread_id, created_at) VALUES (?, 'chat-thread', '2026-09-22')").run(spec.id);
  const stop = vi.fn(async () => { throw new Error("Thread already stopped"); });
  const archive = vi.fn(async () => ({ archivedThreadIds: [], ok: true as const }));
  host.harness.sdk.stub("threads.stop", stop);
  host.harness.sdk.stub("threads.archive", archive);
  await rpc("specs_delete", { id: spec.id });
  for (const table of ["annotations", "question_events", "proposals", "decisions", "research", "spec_messages", "spec_revisions", "spec_projects", "thread_specs", "thread_reads", "chat_threads"]) {
    expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE spec_id = ?`).get(spec.id), table).toEqual({ n: 0 });
  }
  expect(db.prepare("SELECT COUNT(*) AS n FROM annotation_comments").get()).toEqual({ n: 0 });
  expect(db.prepare("SELECT parent_spec_id FROM specs WHERE id = ?").get(child.id)).toEqual({ parent_spec_id: null });
  expect((await detail(child.id)).spec.title).toBe("Retained research report");
  expect(stop.mock.calls).toHaveLength(2);
  expect(archive.mock.calls).toHaveLength(2);
  expect(await rpc("decisions_list", {})).toEqual({ decisions: [] });
  await expect(detail(spec.id)).rejects.toThrow(/No spec matches/);
});
