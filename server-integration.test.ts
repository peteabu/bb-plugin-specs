import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin, { type SpecDetail } from "./server";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup() {
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  let nextThread = 0;
  let spawnGate: Promise<void> | undefined;
  let outputGate: Promise<string> | undefined;
  const spawn = vi.fn(async ({ projectId }: { projectId: string }) => {
    const thread = makeThreadResponse({
      id: `research-thread-${++nextThread}`,
      projectId,
      status: "active",
    });
    threads.set(thread.id, thread);
    if (spawnGate !== undefined) await spawnGate;
    return thread;
  });
  const output = vi.fn(async () => ({
    output: outputGate === undefined ? "## Findings\nOne report." : await outputGate,
  }));
  const send = vi.fn(async () => ({}));
  const stop = vi.fn(async () => ({}));
  const archive = vi.fn(async () => ({}));
  const { bb, harness } = createFakePluginHost({
    pluginId: "specs",
    settings: { autoTriageQuestions: false },
    sdk: {
      projects: {
        list: async () => [
          { id: "project-1", name: "Project", kind: "standard" },
          { id: "personal", name: "Personal", kind: "personal" },
        ],
      },
      threads: {
        get: async ({ threadId }) => threads.get(threadId) ?? null,
        spawn,
        output,
        send,
        stop,
        archive,
      },
    },
  });
  await plugin(bb);
  cleanups.push(() => harness.lifecycle.dispose());
  const rpc = <T>(name: string, input: unknown) =>
    harness.behavior.callRpc(name, input) as Promise<T>;
  const create = (title = "Parent spec") =>
    rpc<{ id: string; slug: string }>("specs_create", {
      title,
      content: "Initial content",
      projectIds: ["project-1"],
    });
  const detail = (id: string) => rpc<SpecDetail>("specs_get", { idOrSlug: id });
  const start = (specId: string) =>
    rpc<{ researchId: string; threadId: string }>("research_start", {
      specId,
      brief: "Investigate a question",
    });
  const rows = (table: string, specId: string) =>
    bb.storage.database().prepare(`SELECT * FROM ${table} WHERE spec_id = ?`).all(specId);
  const reports = (specId: string) =>
    bb.storage.database().prepare("SELECT * FROM specs WHERE parent_spec_id = ?").all(specId);
  return {
    harness, rpc, create, detail, start, rows, reports, threads, db: bb.storage.database(),
    spawn, output, send, stop, archive,
    holdSpawn: (gate: Promise<void>) => { spawnGate = gate; },
    holdOutput: (gate: Promise<string>) => { outputGate = gate; },
  };
}

describe("spec chat initialization", () => {
  it("shares one creation while delivering both concurrent chat messages", async () => {
    const host = await setup();
    const spec = await host.create();
    const gate = deferred<void>();
    host.holdSpawn(gate.promise);
    const first = host.rpc("chat_ask", { specId: spec.id, text: "First question" });
    const second = host.rpc("chat_ask", { specId: spec.id, text: "Second question" });
    await vi.waitFor(() => expect(host.spawn).toHaveBeenCalledTimes(1));
    gate.resolve();
    expect(await first).toEqual(await second);
    expect(host.spawn).toHaveBeenCalledTimes(1);
    expect(host.spawn.mock.calls[0]?.[0]).toMatchObject({
      prompt: expect.stringContaining("First question"),
    });
    expect(host.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      input: [expect.objectContaining({ text: expect.stringContaining("Second question") })],
    }));
    expect(host.rows("chat_threads", spec.id)).toHaveLength(1);
    expect(host.rows("thread_specs", spec.id)).toHaveLength(1);
  });

  it("allows retry after a shared creation fails", async () => {
    const host = await setup();
    const spec = await host.create();
    const gate = deferred<void>();
    host.holdSpawn(gate.promise);
    const first = host.rpc("chat_ensure", { specId: spec.id });
    const second = host.rpc("chat_ensure", { specId: spec.id });
    const failures = Promise.allSettled([first, second]);
    gate.reject(new Error("Host unavailable"));
    expect((await failures).map((result) => result.status)).toEqual(["rejected", "rejected"]);
    host.holdSpawn(Promise.resolve());
    await expect(host.rpc("chat_ensure", { specId: spec.id })).resolves.toMatchObject({ created: true });
    expect(host.spawn).toHaveBeenCalledTimes(2);
  });

  it.each(["chat_ensure", "research_start"])("does not recreate rows when deleted during %s", async (method) => {
    const host = await setup();
    const spec = await host.create();
    const gate = deferred<void>();
    host.holdSpawn(gate.promise);
    const pending = host.rpc(method, {
      specId: spec.id,
      ...(method === "research_start" ? { brief: "Investigate a question" } : {}),
    });
    const rejected = expect(pending).rejects.toThrow(/No spec/);
    await vi.waitFor(() => expect(host.spawn).toHaveBeenCalledTimes(1));
    await host.rpc("specs_delete", { id: spec.id });
    gate.resolve();
    await rejected;
    for (const table of ["research", "thread_specs", "chat_threads"]) {
      expect(host.rows(table, spec.id)).toEqual([]);
    }
    expect(host.stop).toHaveBeenCalledExactlyOnceWith({ threadId: "research-thread-1" });
    expect(host.archive).toHaveBeenCalledExactlyOnceWith({ threadId: "research-thread-1" });
  });
});

describe("research completion", () => {
  it("publishes exactly one report when idle events and reconciliation overlap", async () => {
    const host = await setup();
    const spec = await host.create();
    const run = await host.start(spec.id);
    const thread = host.threads.get(run.threadId)!;
    thread.status = "idle";
    const gate = deferred<string>();
    host.holdOutput(gate.promise);
    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread,
      lastAssistantText: "## Findings\nOne report.",
    });
    const pending = host.detail(spec.id);
    await vi.waitFor(() => expect(host.output).toHaveBeenCalledTimes(2));
    gate.resolve("## Findings\nOne report.");
    const detail = await pending;
    expect(host.reports(spec.id)).toHaveLength(1);
    expect(detail.research).toEqual([expect.objectContaining({
      id: run.researchId,
      status: "done",
      resultSpecId: expect.any(String),
    })]);
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread, lastAssistantText: "Repeat" });
    expect(host.reports(spec.id)).toHaveLength(1);
  });

  it("does not publish a report after its parent is deleted while output is pending", async () => {
    const host = await setup();
    const spec = await host.create();
    const run = await host.start(spec.id);
    const gate = deferred<string>();
    host.holdOutput(gate.promise);
    const thread = host.threads.get(run.threadId)!;
    thread.status = "idle";
    const pending = host.detail(spec.id);
    await vi.waitFor(() => expect(host.output).toHaveBeenCalledTimes(1));
    await host.rpc("specs_delete", { id: spec.id });
    gate.resolve("## Findings\nMust not return.");
    await pending;
    expect(host.reports(spec.id)).toEqual([]);
    expect(host.rows("research", spec.id)).toEqual([]);
    await expect(host.detail(spec.id)).rejects.toThrow(/No spec/);
  });

  it.each([
    ["error", "failed", "failed"],
    ["archived", "cancelled", "archived"],
    ["deleted", "cancelled", "deleted"],
    ["missing", "cancelled", "deleted"],
  ] as const)("reconciles a missed %s event", async (state, expectedStatus, error) => {
    const host = await setup();
    const spec = await host.create();
    const run = await host.start(spec.id);
    const thread = host.threads.get(run.threadId)!;
    if (state === "missing") host.threads.delete(run.threadId);
    else if (state === "error") thread.status = "error";
    else if (state === "archived") thread.archivedAt = Date.now();
    else thread.deletedAt = Date.now();
    const detail = await host.detail(spec.id);
    expect(detail.research[0]).toMatchObject({ status: expectedStatus, error: expect.stringContaining(error) });
    expect(host.reports(spec.id)).toEqual([]);
    expect(host.output).not.toHaveBeenCalled();
  });

  it("preserves a retryable run on a transient lookup failure", async () => {
    const host = await setup();
    const spec = await host.create();
    await host.start(spec.id);
    host.harness.inspection.sdk.stub("threads.get", async () => { throw new Error("Host unreachable"); });
    expect((await host.detail(spec.id)).research[0]?.status).toBe("running");
  });

  it.each(["thread.archived", "thread.deleted"] as const)("cancels on %s without allowing pending output to publish", async (event) => {
    const host = await setup();
    const spec = await host.create();
    const run = await host.start(spec.id);
    const thread = host.threads.get(run.threadId)!;
    thread.status = "idle";
    const gate = deferred<string>();
    host.holdOutput(gate.promise);
    const pending = host.detail(spec.id);
    await vi.waitFor(() => expect(host.output).toHaveBeenCalledTimes(1));
    await host.harness.behavior.emitThreadEvent(event, { thread });
    gate.resolve("## Late output");
    expect((await pending).research[0]?.status).toBe("cancelled");
    expect(host.reports(spec.id)).toEqual([]);
  });
});

describe("project context modes", () => {
  it("injects pinned and changed auto specs, and available specs only when attached", async () => {
    const host = await setup();
    const available = await host.create("Available only");
    const auto = await host.create("Automatic");
    const pinned = await host.create("Pinned");
    for (const [spec, mode] of [[available, "available"], [auto, "auto"], [pinned, "pinned"]] as const) {
      await host.rpc("specs_set_projects", { id: spec.id, links: [{ projectId: "project-1", mode }] });
      await host.harness.behavior.callAgentTool("specs_read", { idOrSlug: spec.id }, {
        threadId: "reader",
        projectId: "project-1",
      });
      await host.rpc("specs_save", { id: spec.id, content: "Updated", expectedRevision: 1 });
    }
    const digest = () => host.harness.inspection.registrations.instructionProvider!({
      threadId: "reader", projectId: "project-1",
    });
    expect(digest()).not.toContain(available.slug);
    expect(digest()).toContain(`[updated] ${auto.slug}`);
    expect(digest()).toContain(`[pinned] ${pinned.slug}`);
    await host.rpc("thread_set_spec", { threadId: "reader", specId: available.id, mode: "attached" });
    expect(digest()).toContain(`[attached] ${available.slug}`);
    await host.rpc("thread_set_spec", { threadId: "reader", specId: pinned.id, mode: "detached" });
    expect(digest()).not.toContain(pinned.slug);
  });
});

describe("preparing a missing proposal", () => {
  it("requests a linked proposal once and preserves retry after dispatch failure", async () => {
    const host = await setup();
    const spec = await host.create();
    const question = await host.rpc<{ id: string }>("annotations_create", { specId: spec.id, quote: "Initial", body: "What interval?", kind: "question" });
    await host.rpc("questions_answer", { annotationId: question.id, answer: "Seven days", requiresSpecChange: true });
    const annotation = (await host.detail(spec.id)).annotations[0]!;
    const input = { annotationId: question.id, expectedAnswer: annotation.answer, expectedUpdatedAt: annotation.updatedAt };
    host.spawn.mockRejectedValueOnce(new Error("Offline"));
    await expect(host.rpc("questions_accept", input)).rejects.toThrow(/Try accepting again/);
    expect((await host.detail(spec.id)).annotations[0]!.changeRequested).toBe(false);
    expect(await host.rpc("questions_accept", input)).toEqual({ status: "preparing" });
    expect(await host.rpc("questions_accept", input)).toEqual({ status: "preparing" });
    expect(host.spawn).toHaveBeenCalledTimes(2);
    const current = await host.detail(spec.id);
    expect(current.annotations[0]).toMatchObject({ state: "answered", changeRequested: true });
    expect(current.spec.revision).toBe(1);
    expect(current.decisions).toEqual([]);
    expect(JSON.stringify(host.harness.inspection.sdk.calls)).toContain("The user accepts the answer");
  });
});

describe("research incorporation", () => {
  async function completed(report = "## Findings\nUse the simpler design.") {
    const host = await setup();
    const parent = await host.create();
    host.holdOutput(Promise.resolve(report));
    const run = await host.start(parent.id);
    host.threads.get(run.threadId)!.status = "idle";
    await host.detail(parent.id);
    await vi.waitFor(() => expect(host.reports(parent.id)).toHaveLength(1));
    const child = (await host.detail(parent.id)).research[0]!.resultSpecId!;
    return { host, parent, run, child };
  }
  async function propose(context: Awaited<ReturnType<typeof completed>>, content = "Settled parent requirements") {
    const { host, parent, run } = context;
    await vi.waitFor(() => expect(host.rows("research", parent.id)[0]).toMatchObject({ integration_state: "preparing", synthesis_thread_id: expect.any(String) }));
    const record = host.rows("research", parent.id)[0] as { integration_key: string; synthesis_thread_id: string };
    return host.harness.behavior.callAgentTool("specs_propose", {
      idOrSlug: parent.id, content, expectedRevision: (await host.detail(parent.id)).spec.revision,
      researchId: run.researchId, researchKey: record.integration_key,
    }, { threadId: record.synthesis_thread_id, projectId: "project-1" });
  }

  it("prepares one parent proposal and records the exact incorporated revision only on apply", async () => {
    const context = await completed();
    const { host, parent, child, run } = context;
    expect((await host.detail(child)).spec.parent).toMatchObject({ id: parent.id, title: "Parent spec" });
    expect(await propose(context)).not.toMatchObject({ isError: true });
    const review = await host.detail(parent.id);
    expect(review.spec.content).toBe("Initial content");
    expect(review.research[0]).toMatchObject({ integrationState: "review", incorporatedRevision: null });
    expect(review.proposals[0]).toMatchObject({ researchId: run.researchId, specId: parent.id });
    await host.rpc("proposals_apply", { proposalId: review.proposals[0]!.id });
    expect((await host.detail(parent.id)).spec).toMatchObject({ content: "Settled parent requirements", revision: 2 });
    expect((await host.detail(child)).sourceResearch).toMatchObject({ integrationState: "incorporated", incorporatedRevision: 2 });
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread: host.threads.get(run.threadId)!, lastAssistantText: "Done" });
    expect(host.spawn).toHaveBeenCalledTimes(2);
  });

  it("waits for prose questions and reviewed answers before preparing a parent update", async () => {
    const { host, parent, child } = await completed("## Open questions\n- Should we cache?\n");
    expect((await host.detail(child)).sourceResearch?.integrationState).toBe("waiting");
    expect(host.spawn).toHaveBeenCalledTimes(1);
    const question = await host.rpc<{ id: string }>("annotations_create", { specId: child, kind: "question", quote: "Should we cache?", body: "Should we cache?" });
    await host.rpc("specs_save", { id: child, content: "## Findings\nCaching is optional.", expectedRevision: 1 });
    await host.rpc("questions_answer", { annotationId: question.id, answer: "No caching", requiresSpecChange: false });
    expect((await host.detail(child)).sourceResearch?.integrationState).toBe("waiting");
    const annotation = (await host.detail(child)).annotations[0]!;
    await host.rpc("questions_accept", { annotationId: annotation.id, expectedAnswer: annotation.answer, expectedUpdatedAt: annotation.updatedAt });
    await vi.waitFor(() => expect(host.spawn).toHaveBeenCalledTimes(2));
    expect((await host.detail(parent.id)).research[0]?.integrationState).toBe("preparing");
  });

  it("invalidates prepared updates when report questions reopen and rejects stale worker output", async () => {
    const context = await completed();
    const { host, parent, child, run } = context;
    await propose(context);
    const proposal = (await host.detail(parent.id)).proposals[0]!;
    const oldKey = (host.rows("research", parent.id)[0] as { integration_key: string }).integration_key;
    await host.rpc("annotations_create", { specId: child, kind: "question", quote: "simpler", body: "What about concurrency?" });
    await expect(host.rpc("proposals_apply", { proposalId: proposal.id })).rejects.toThrow();
    expect((await host.detail(child)).sourceResearch?.integrationState).toBe("waiting");
    const stale = await host.harness.behavior.callAgentTool("specs_propose", { idOrSlug: parent.id, content: "Stale", expectedRevision: 1, researchId: run.researchId, researchKey: oldKey });
    expect(stale).toMatchObject({ isError: true });
    expect((await host.detail(parent.id)).spec.content).toBe("Initial content");
  });

  it("offers a retry after the parent changes or review rejects an update", async () => {
    const context = await completed();
    const { host, parent, child, run } = context;
    await propose(context);
    await host.rpc("specs_save", { id: parent.id, content: "New user requirement", expectedRevision: 1 });
    expect((await host.detail(child)).sourceResearch).toMatchObject({ integrationState: "failed", integrationError: expect.stringContaining("parent changed") });
    await host.rpc("research_prepare", { researchId: run.researchId });
    await propose(context, "New user requirement plus findings");
    const proposal = (await host.detail(parent.id)).proposals[0]!;
    await host.rpc("proposals_reject", { proposalId: proposal.id, note: "Needs better evidence" });
    expect((await host.detail(child)).sourceResearch?.integrationState).toBe("rejected");
    expect(host.spawn).toHaveBeenCalledTimes(3);
    await host.rpc("research_prepare", { researchId: run.researchId });
    expect(host.spawn).toHaveBeenCalledTimes(4);
  });

  it("reconciles a stopped synthesis on report read without silently restarting it", async () => {
    const { host, parent, child, run } = await completed();
    await vi.waitFor(() => expect(host.spawn).toHaveBeenCalledTimes(2));
    const record = host.rows("research", parent.id)[0] as { synthesis_thread_id: string };
    host.threads.get(record.synthesis_thread_id)!.status = "idle";
    expect((await host.detail(child)).sourceResearch?.integrationState).toBe("failed");
    expect(host.spawn).toHaveBeenCalledTimes(2);
    await host.rpc("research_prepare", { researchId: run.researchId });
    expect((await host.detail(child)).sourceResearch?.integrationState).toBe("preparing");
  });

  it("leaves historical reports pending when read or when a sibling research run completes", async () => {
    const { host, parent, child, run } = await completed();
    await vi.waitFor(() => expect(host.spawn).toHaveBeenCalledTimes(2));
    host.db.prepare("UPDATE research SET integration_state = 'pending', integration_key = NULL, synthesis_thread_id = NULL WHERE id = ?").run(run.researchId);
    expect((await host.detail(child)).sourceResearch?.integrationState).toBe("pending");
    const next = await host.start(parent.id);
    host.threads.get(next.threadId)!.status = "idle";
    await host.detail(parent.id);
    await vi.waitFor(() => expect(host.spawn).toHaveBeenCalledTimes(4));
    expect((await host.detail(child)).sourceResearch?.integrationState).toBe("pending");
  });

  it("picks up changed findings after an in-flight preparation spawn finishes", async () => {
    const { host, parent, child, run } = await completed("## Open questions\n- Cache?\n");
    const gate = deferred<void>();
    host.holdSpawn(gate.promise);
    await host.rpc("specs_save", { id: child, content: "First findings", expectedRevision: 1 });
    await vi.waitFor(() => expect(host.spawn).toHaveBeenCalledTimes(2));
    await host.rpc("specs_save", { id: child, content: "Revised findings", expectedRevision: 2 });
    host.holdSpawn(Promise.resolve());
    gate.resolve();
    await vi.waitFor(() => expect(host.spawn).toHaveBeenCalledTimes(3));
    expect(host.stop).toHaveBeenCalledWith({ threadId: "research-thread-2" });
    expect((await host.detail(child)).sourceResearch?.integrationState).toBe("preparing");
    expect((await host.detail(parent.id)).research.find((item) => item.id === run.researchId)?.proposalId).toBeNull();
  });

  it("supersedes a parent update when its report is deleted", async () => {
    const context = await completed();
    const { host, parent, child } = context;
    await propose(context);
    await host.rpc("specs_delete", { id: child });
    const detail = await host.detail(parent.id);
    expect(detail.proposals).toEqual([]);
    expect(detail.research[0]).toMatchObject({ resultSpecId: null, integrationState: "failed" });
  });
});

describe("inline draft dispatch", () => {
  it("anchors the requested insertion to a revision and reuses the spec conversation", async () => {
    const host = await setup();
    const spec = await host.create();
    await host.rpc("chat_draft", { specId: spec.id, text: "Add a diagram", expectedRevision: 1, insertionOffset: 7 });
    const prompt = (host.spawn.mock.calls[0]![0] as unknown as { prompt: string }).prompt;
    expect(prompt).toMatch(/Initial\[\[INSERT_[^\]]+\]\] content/);
    expect(prompt).toContain('expectedRevision: 1');
    expect(prompt).toContain(`idOrSlug: "${spec.id}"`);
    expect(prompt).toContain("Do not use specs_write or apply the proposal");
    expect((await host.detail(spec.id)).spec).toMatchObject({ content: "Initial content", revision: 1 });
    await host.rpc("chat_draft", { specId: spec.id, text: "Add an example", expectedRevision: 1, insertionOffset: 15 });
    expect(host.spawn).toHaveBeenCalledTimes(1);
    expect(host.send).toHaveBeenCalledOnce();
  });

  it("rejects outdated revisions and invalid positions before invoking an agent", async () => {
    const host = await setup();
    const spec = await host.create();
    await host.rpc("specs_save", { id: spec.id, content: "Updated", expectedRevision: 1 });
    await expect(host.rpc("chat_draft", { specId: spec.id, text: "Add a diagram", expectedRevision: 1, insertionOffset: 0 })).rejects.toThrow(/Revision conflict/);
    await expect(host.rpc("chat_draft", { specId: spec.id, text: "Add a diagram", expectedRevision: 2, insertionOffset: 100 })).rejects.toThrow(/outside/);
    expect(host.spawn).not.toHaveBeenCalled();
    expect(host.send).not.toHaveBeenCalled();
  });
});
