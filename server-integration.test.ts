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
    harness, rpc, create, detail, start, rows, reports, threads,
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
