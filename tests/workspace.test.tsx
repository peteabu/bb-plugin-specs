// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SpecDetail } from "../server";

let Workspace: typeof import("../app").SpecsWorkspace;
beforeAll(async () => {
  await loadPluginApp(() => import("../app"));
  Workspace = (await import("../app")).SpecsWorkspace;
});
afterEach(() => { cleanup(); sessionStorage.clear(); });

let sequence = 0;
function detail(title: string): SpecDetail {
  const id = `workspace-test-${++sequence}`;
  return {
    spec: {
      id, title, slug: title.toLowerCase().replaceAll(" ", "-"), summary: "", content: `${title} content`,
      revision: 1, status: "active", icon: "📄", updatedAt: "2026-09-22T10:00:00Z",
      projectIds: [], openAnnotations: 0,
      contextMode: "none",
    },
    annotations: [], links: [], chatThreadId: null, textQuestions: [], textDecisions: [],
    proposals: [], decisions: [], research: [], discussion: [], agentChange: null,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const workspaceProps = {
  tabPart: "document", showSidebar: true, chrome: "route" as const,
  onSelectSpec: vi.fn(), onSelectTab: vi.fn(), onOpenThread: vi.fn(),
};
function Host({ initial }: { initial: string }) {
  const [selected, setSelected] = useState(initial);
  return <Workspace {...workspaceProps} selectedSlug={selected} onSelectSpec={setSelected} />;
}

describe("workspace selection and saving", () => {
  it.each(["success", "failure"])("ignores a stale detail %s after selecting another spec", async (outcome) => {
    const first = detail("First");
    const second = detail("Second");
    const pending = deferred<SpecDetail>();
    const view = renderSlot({ component: Workspace }, { ...workspaceProps, selectedSlug: first.spec.id }, {
      rpc: {
        specs_list: () => ({ specs: [first.spec, second.spec], projects: [] }),
        specs_get: (input) => (input as { idOrSlug: string }).idOrSlug === first.spec.id ? pending.promise : second,
      },
    });
    view.rerender(<Workspace {...workspaceProps} selectedSlug={second.spec.id} />);
    await waitFor(() => expect(view.getByRole("heading", { name: "Second" })).toBeTruthy());
    await act(async () => {
      if (outcome === "success") pending.resolve(first);
      else pending.reject(new Error("Old request failed"));
      await Promise.resolve();
    });
    expect(view.getByRole("heading", { name: "Second" })).toBeTruthy();
    expect(view.queryByRole("heading", { name: "First" })).toBeNull();
    expect(view.queryByText("Old request failed")).toBeNull();
  });

  it("uses the immutable ID when renaming an Untitled spec and refreshing realtime", async () => {
    let current = detail("Untitled");
    const originalSlug = current.spec.slug;
    const view = renderSlot({ component: Host }, { initial: originalSlug }, {
      rpc: {
        specs_list: () => ({ specs: [current.spec], projects: [] }),
        specs_get: (input) => {
          const { idOrSlug } = input as { idOrSlug: string };
          if (idOrSlug !== current.spec.id && idOrSlug !== current.spec.slug) throw new Error("No spec matches");
          return current;
        },
        specs_save: (raw) => {
          const input = raw as { id: string; title: string; content: string; expectedRevision: number };
          expect(input.id).toBe(current.spec.id);
          expect(input.expectedRevision).toBe(current.spec.revision);
          current = { ...current, spec: { ...current.spec, title: input.title, content: input.content, slug: "project-requirements", revision: 2 } };
          return { revision: 2, updatedAt: current.spec.updatedAt };
        },
      },
    });
    await waitFor(() => expect(view.getByRole("heading", { name: "Untitled" })).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Edit" }));
    fireEvent.change(view.getByPlaceholderText("Untitled"), { target: { value: "Project requirements" } });
    fireEvent.click(view.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(view.getByRole("heading", { name: "Project requirements" })).toBeTruthy());
    await view.emitRealtime("specs-changed", {});
    expect(view.queryByText("No spec matches")).toBeNull();
    const gets = view.rpcCalls.filter((call) => call.method === "specs_get");
    expect(gets.length).toBeGreaterThan(2);
    expect(gets.slice(1).every((call) => (call.input as { idOrSlug: string }).idOrSlug === current.spec.id)).toBe(true);
  });

  it("flushes pending edits when a sidebar click changes documents", async () => {
    const first = detail("First draft");
    const second = detail("Next document");
    const save = vi.fn(async () => ({ revision: 2, updatedAt: first.spec.updatedAt }));
    const view = renderSlot({ component: Host }, { initial: first.spec.id }, {
      rpc: {
        specs_list: () => ({ specs: [first.spec, second.spec], projects: [] }),
        specs_get: (input) => (input as { idOrSlug: string }).idOrSlug === first.spec.id ? first : second,
        specs_save: save,
      },
    });
    await waitFor(() => expect(view.getByRole("heading", { name: "First draft" })).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Edit" }));
    fireEvent.change(view.getByPlaceholderText("Untitled"), { target: { value: "Pending before navigation" } });
    fireEvent.click(view.getByRole("button", { name: /📄 Next document/ }));
    await waitFor(() => expect(view.getByRole("heading", { name: "Next document" })).toBeTruthy());
    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      id: first.spec.id, title: "Pending before navigation", expectedRevision: 1,
    }));
  });

  it("shows an external idle update inside the mounted rich editor without saving old text", async () => {
    let current = detail("Live document");
    const save = vi.fn(async () => ({ revision: 3, updatedAt: current.spec.updatedAt }));
    const view = renderSlot({ component: Host }, { initial: current.spec.id }, {
      rpc: {
        specs_list: () => ({ specs: [current.spec], projects: [] }),
        specs_get: () => current,
        specs_save: save,
      },
    });
    await waitFor(() => expect(view.getByRole("heading", { name: "Live document" })).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Edit" }));
    await waitFor(() => expect(view.getByLabelText("Spec content").textContent).toContain("Live document content"));
    current = { ...current, spec: { ...current.spec, revision: 2, content: "Latest text from another editor" } };
    await view.emitRealtime("specs-changed", {});
    await waitFor(() => expect(view.getByLabelText("Spec content").textContent).toContain("Latest text from another editor"));
    fireEvent.click(view.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(view.getByRole("heading", { name: "Live document" })).toBeTruthy());
    expect(save).not.toHaveBeenCalled();
  });

  it("shows proposed title, summary, and icon changes before applying an unchanged body", async () => {
    const current = detail("Current title");
    current.spec.summary = "Current summary";
    current.proposals = [{
      id: "metadata-proposal", specId: current.spec.id, baseRevision: current.spec.revision,
      title: "Proposed title", summary: "Proposed summary", icon: "🧭", content: current.spec.content,
      note: "Update document metadata", author: "agent", questionId: null, status: "pending",
      resolutionNote: "", resolvedBy: "", resolvedAt: null, appliedRevision: null,
      createdAt: current.spec.updatedAt,
    }];
    const apply = vi.fn(async () => ({ revision: 2 }));
    const view = renderSlot({ component: Host }, { initial: current.spec.id }, {
      rpc: {
        specs_list: () => ({ specs: [current.spec], projects: [] }),
        specs_get: () => current,
        proposals_apply: apply,
      },
    });
    await waitFor(() => expect(view.getByText("Update document metadata")).toBeTruthy());
    const rows = Array.from(view.container.querySelectorAll("dl > div"));
    expect(rows.map((row) => ({
      label: row.querySelector("dt")?.textContent,
      before: row.querySelector("dd del")?.textContent,
      after: row.querySelector("dd span")?.textContent,
    }))).toEqual([
      { label: "Title", before: "Current title", after: "Proposed title" },
      { label: "Summary", before: "Current summary", after: "Proposed summary" },
      { label: "Icon", before: "📄", after: "🧭" },
    ]);
    expect(apply).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(apply).toHaveBeenCalledWith({ proposalId: "metadata-proposal" }));
  });
});

function questionFixture(current: SpecDetail, overrides: Partial<SpecDetail["annotations"][number]> = {}) {
  return {
    id: "question-1", specId: current.spec.id, quote: "content", prefix: "", suffix: "", body: "What interval?",
    author: "user", status: "open" as const, kind: "question" as const, state: "answered" as const,
    answer: "Seven days", requiresSpecChange: false, changeRequested: false, answeredBy: "agent", answeredAt: current.spec.updatedAt,
    parentId: null, decision: "", foldedRevision: null, resolvedBy: "", resolvedAt: null, dispatchedAt: null,
    createdAt: current.spec.updatedAt, updatedAt: current.spec.updatedAt, comments: [], events: [], ...overrides,
  };
}

describe("conversation-first decisions", () => {
  it("offers acceptance and keeps response and decision queues disjoint", async () => {
    const current = detail("Decisions");
    current.annotations = [questionFixture(current), questionFixture(current, { id: "question-2", body: "Unanswered question", state: "open", answer: "" })];
    const accept = vi.fn(async () => ({ status: "resolved" }));
    const view = renderSlot({ component: Host }, { initial: current.spec.id }, { rpc: {
      specs_list: () => ({ specs: [current.spec], projects: [] }), specs_get: () => current, questions_accept: accept,
    } });
    await view.findByRole("heading", { name: "Decisions" });
    fireEvent.click(view.getByRole("button", { name: "Comments" }));
    expect(view.queryByRole("button", { name: "Edit answer" })).toBeNull();
    expect(view.queryByRole("button", { name: "Needs clarification" })).toBeNull();
    expect(view.queryByText("Unanswered question")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Accept decision" }));
    await waitFor(() => expect(accept).toHaveBeenCalledWith({ annotationId: "question-1", expectedAnswer: "Seven days", expectedUpdatedAt: current.spec.updatedAt }));
    fireEvent.click(view.getByRole("button", { name: "Needs response 1" }));
    expect(view.getByText("Unanswered question")).toBeTruthy();
    expect(view.queryByText("What interval?")).toBeNull();
  });
  it("shows content and metadata review before applying and closing", async () => {
    const current = detail("Review decision");
    current.annotations = [questionFixture(current, { requiresSpecChange: true })];
    current.proposals = [{ id: "question-proposal", specId: current.spec.id, baseRevision: 1, title: "Changed title", summary: "Changed summary", icon: "🧭", content: "Seven days in the spec", note: "Set interval", author: "agent", questionId: "question-1", status: "pending", resolutionNote: "", resolvedBy: "", resolvedAt: null, appliedRevision: null, createdAt: current.spec.updatedAt }];
    const apply = vi.fn(async () => ({ revision: 2 }));
    const view = renderSlot({ component: Host }, { initial: current.spec.id }, { rpc: {
      specs_list: () => ({ specs: [current.spec], projects: [] }), specs_get: () => current,
      specs_diff: () => ({ from: 1, to: null, truncated: false, rows: [{ type: "add", text: "Seven days in the spec" }] }), questions_apply: apply,
    } });
    await view.findByRole("heading", { name: "Review decision" });
    expect(view.queryByRole("button", { name: "Apply" })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Comments" }));
    fireEvent.click(view.getByRole("button", { name: "Review change" }));
    await view.findByText("+ Seven days in the spec");
    expect(view.getByText("Changed title", { exact: false })).toBeTruthy();
    expect(apply).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("button", { name: "Apply and close" }));
    await waitFor(() => expect(apply).toHaveBeenCalledWith({ annotationId: "question-1", proposalId: "question-proposal", expectedAnswer: "Seven days", expectedUpdatedAt: current.spec.updatedAt }));
  });
  it("preserves failed replies and prevents acceptance with an unsent challenge", async () => {
    const current = detail("Reply failure"); current.annotations = [questionFixture(current)];
    const view = renderSlot({ component: Host }, { initial: current.spec.id }, { rpc: {
      specs_list: () => ({ specs: [current.spec], projects: [] }), specs_get: () => current,
      annotations_comment: () => { throw new Error("Connection failed"); },
    } });
    await view.findByRole("heading", { name: "Reply failure" });
    fireEvent.click(view.getByRole("button", { name: "Comments" }));
    fireEvent.change(view.getByPlaceholderText("Reply or ask a follow-up…"), { target: { value: "Make it three days" } });
    expect((view.getByRole("button", { name: "Accept decision" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(view.getByRole("button", { name: "Reply" }));
    await waitFor(() => expect(view.getByRole("alert").textContent).toContain("Connection failed"));
    expect((view.getByPlaceholderText("Reply or ask a follow-up…") as HTMLInputElement).value).toBe("Make it three days");
  });
  it("prefills answer editing and preserves a failed save", async () => {
    const current = detail("Edit recorded answer"); current.annotations = [questionFixture(current)];
    const view = renderSlot({ component: Host }, { initial: current.spec.id }, { rpc: {
      specs_list: () => ({ specs: [current.spec], projects: [] }), specs_get: () => current,
      questions_answer: () => { throw new Error("Save failed"); },
    } });
    await view.findByRole("heading", { name: "Edit recorded answer" });
    fireEvent.click(view.getByRole("button", { name: "Comments" }));
    fireEvent.keyDown(view.getByRole("button", { name: "More actions" }), { key: "Enter" });
    fireEvent.click(await view.findByRole("menuitem", { name: "Edit answer" }));
    expect((view.getByLabelText("Recorded answer") as HTMLTextAreaElement).value).toBe("Seven days");
    expect(view.queryByRole("button", { name: "Accept decision" })).toBeNull();
    fireEvent.change(view.getByLabelText("Recorded answer"), { target: { value: "Three days" } });
    fireEvent.click(view.getByRole("button", { name: "Save answer" }));
    await waitFor(() => expect(view.getByRole("alert").textContent).toContain("Save failed"));
    expect((view.getByLabelText("Recorded answer") as HTMLTextAreaElement).value).toBe("Three days");
  });
});
