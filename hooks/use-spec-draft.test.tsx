// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSpecDraft, type DraftSpec } from "./use-spec-draft";

let sequence = 0;
function spec(): DraftSpec {
  return { id: `draft-test-${++sequence}`, revision: 1, title: "Title", summary: "Summary", content: "Original" };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup(initial: DraftSpec, save = vi.fn(async () => ({ revision: 2 }))) {
  const onSettled = vi.fn();
  const options = { scope: "test", save, onSettled };
  const hook = renderHook(({ current }: { current: DraftSpec | null }) => useSpecDraft(current, options), {
    initialProps: { current: initial as DraftSpec | null },
  });
  return { ...hook, save, onSettled };
}

beforeEach(() => { vi.useFakeTimers(); sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("spec draft recovery and concurrency", () => {
  it("refreshes an idle editor without writing the old revision back", async () => {
    const initial = spec();
    const view = setup(initial);
    view.rerender({ current: { ...initial, revision: 2, content: "External update" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(view.result.current.values.content).toBe("External update");
    expect(view.result.current.dirty).toBe(false);
    expect(view.result.current.editorVersion).toBe(1);
    expect(view.save).not.toHaveBeenCalled();
  });

  it("retains a dirty draft and refuses to advance its token after an external update", async () => {
    const initial = spec();
    const view = setup(initial);
    act(() => { view.result.current.update({ content: "My draft" }); });
    view.rerender({ current: { ...initial, revision: 2, content: "External update" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(view.result.current.values.content).toBe("My draft");
    expect(view.result.current.conflict).toBe(true);
    expect(view.result.current.saveError).toContain("changed elsewhere");
    await act(async () => { expect(await view.result.current.save()).toBe(false); });
    expect(view.save).not.toHaveBeenCalled();
    expect(JSON.parse(sessionStorage.getItem(`specs:draft:test:${initial.id}`)!)).toMatchObject({
      revision: 1, values: { content: "My draft" },
    });
  });

  it("drains edits during a slow request and makes explicit save await the entire queue", async () => {
    const initial = spec();
    const first = deferred<{ revision: number }>();
    const second = deferred<{ revision: number }>();
    const save = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const view = setup(initial, save);
    act(() => { view.result.current.update({ content: "First edit" }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
    act(() => view.result.current.update({ content: "Second edit" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
    expect(save).toHaveBeenCalledTimes(1);
    let done!: Promise<boolean>;
    act(() => { done = view.result.current.save(); });
    await act(async () => { first.resolve({ revision: 2 }); await Promise.resolve(); });
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[0][0]).toMatchObject({ content: "First edit", expectedRevision: 1 });
    expect(save.mock.calls[1][0]).toMatchObject({ content: "Second edit", expectedRevision: 2 });
    await act(async () => { second.resolve({ revision: 3 }); expect(await done).toBe(true); });
    expect(view.result.current.dirty).toBe(false);
    expect(sessionStorage.getItem(`specs:draft:test:${initial.id}`)).toBeNull();
  });

  it("flushes the old document before its debounce when navigation selects another", async () => {
    const initial = spec();
    const next = { ...spec(), content: "Next document" };
    const pending = deferred<{ revision: number }>();
    const view = setup(initial, vi.fn().mockReturnValue(pending.promise));
    act(() => { view.result.current.update({ content: "Keep me" }); });
    await act(async () => { view.rerender({ current: next }); });
    expect(view.save).toHaveBeenCalledWith(expect.objectContaining({ id: initial.id, content: "Keep me", expectedRevision: 1 }));
    await act(async () => { pending.resolve({ revision: 2 }); await Promise.resolve(); });
    expect(view.result.current.values.content).toBe("Next document");
  });

  it("retains failed saves on Done and recovers them after unmount", async () => {
    const initial = spec();
    const save = vi.fn().mockRejectedValue(new Error("Offline"));
    const view = setup(initial, save);
    act(() => { view.result.current.update({ content: "Offline draft" }); });
    await act(async () => { expect(await view.result.current.save()).toBe(false); });
    expect(view.result.current.saveError).toBe("Offline");
    view.unmount();
    const reopened = setup(initial);
    expect(reopened.result.current.values.content).toBe("Offline draft");
    expect(reopened.result.current.saveError).toBe("Offline");
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("flushes on closing a surface and keeps a recovery copy when that save fails", async () => {
    const initial = spec();
    const pending = deferred<{ revision: number }>();
    const view = setup(initial, vi.fn().mockReturnValue(pending.promise));
    act(() => { view.result.current.update({ content: "Closing draft" }); });
    await act(async () => { view.unmount(); });
    expect(view.save).toHaveBeenCalledTimes(1);
    await act(async () => { pending.reject(new Error("Offline")); await Promise.resolve(); });
    expect(JSON.parse(sessionStorage.getItem(`specs:draft:test:${initial.id}`)!)).toMatchObject({
      revision: 1, values: { content: "Closing draft" },
    });
  });

  it("restores a stored recovery draft after a reload and detects a newer server revision", () => {
    const initial = spec();
    sessionStorage.setItem(`specs:draft:test:${initial.id}`, JSON.stringify({
      revision: 1,
      baseline: { title: initial.title, summary: initial.summary, content: initial.content },
      values: { title: initial.title, summary: initial.summary, content: "Recovered edit" },
    }));
    const view = setup({ ...initial, revision: 2, content: "Changed elsewhere" });
    expect(view.result.current.values.content).toBe("Recovered edit");
    expect(view.result.current.conflict).toBe(true);
    expect(view.save).not.toHaveBeenCalled();
  });

  it("does not mistake its own realtime save notification for a conflicting update", async () => {
    const initial = spec();
    const pending = deferred<{ revision: number }>();
    const view = setup(initial, vi.fn().mockReturnValue(pending.promise));
    act(() => { view.result.current.update({ content: "Saved edit" }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
    view.rerender({ current: { ...initial, revision: 2, content: "Saved edit" } });
    await act(async () => { pending.resolve({ revision: 2 }); await Promise.resolve(); });
    expect(view.result.current.conflict).toBe(false);
    expect(view.result.current.dirty).toBe(false);
    expect(view.result.current.saveState).toBe("saved");
    expect(view.result.current.editorVersion).toBe(0);
  });

  it("keeps an undo typed during an in-flight save when the request fails", async () => {
    const initial = spec();
    const pending = deferred<{ revision: number }>();
    const view = setup(initial, vi.fn().mockReturnValue(pending.promise));
    act(() => { view.result.current.update({ content: "In flight" }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
    act(() => view.result.current.update({ content: initial.content }));
    expect(JSON.parse(sessionStorage.getItem(`specs:draft:test:${initial.id}`)!)).toMatchObject({
      pending: true, values: { content: initial.content },
    });
    await act(async () => { pending.reject(new Error("Connection lost")); await Promise.resolve(); });
    expect(view.result.current.dirty).toBe(true);
    expect(JSON.parse(sessionStorage.getItem(`specs:draft:test:${initial.id}`)!)).toMatchObject({
      pending: true, values: { content: initial.content },
    });
  });

  it("can retry after an RPC client throws before returning a promise", async () => {
    const initial = spec();
    const save = vi.fn().mockImplementationOnce(() => { throw new Error("Client unavailable"); })
      .mockResolvedValue({ revision: 2 });
    const view = setup(initial, save);
    act(() => { view.result.current.update({ content: "Retry this" }); });
    await act(async () => { expect(await view.result.current.save()).toBe(false); });
    await act(async () => { expect(await view.result.current.save()).toBe(true); });
    expect(save).toHaveBeenCalledTimes(2);
    expect(view.result.current.dirty).toBe(false);
  });

  it("updates a reopened surface when its previous in-flight save settles", async () => {
    const initial = spec();
    const pending = deferred<{ revision: number }>();
    const view = setup(initial, vi.fn().mockReturnValue(pending.promise));
    act(() => { view.result.current.update({ content: "Pending reopen" }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
    view.unmount();
    const reopened = setup(initial);
    expect(reopened.result.current.saveState).toBe("saving");
    await act(async () => { pending.resolve({ revision: 2 }); await Promise.resolve(); });
    expect(reopened.result.current.saveState).toBe("saved");
    expect(reopened.result.current.dirty).toBe(false);
    expect(reopened.save).not.toHaveBeenCalled();
  });

  it("retains failed drafts in memory when browser storage is unavailable", async () => {
    const initial = spec();
    const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Quota exceeded"); });
    const view = setup(initial, vi.fn().mockRejectedValue(new Error("Offline")));
    act(() => { view.result.current.update({ content: "Memory recovery" }); });
    expect(view.result.current.storageError).toBe(true);
    await act(async () => { view.unmount(); });
    const reopened = setup(initial);
    expect(reopened.result.current.values.content).toBe("Memory recovery");
    expect(reopened.result.current.storageError).toBe(true);
    expect(reopened.result.current.saveError).toBe("Offline");
    storage.mockRestore();
  });
});
