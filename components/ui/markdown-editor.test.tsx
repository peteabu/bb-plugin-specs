// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { $getRoot, KEY_ENTER_COMMAND, KEY_ESCAPE_COMMAND, KEY_SPACE_COMMAND, PASTE_COMMAND, getNearestEditorFromDOMNode } from "lexical";
import { $convertToMarkdownString } from "@lexical/markdown";
import { INSERT_HORIZONTAL_RULE_COMMAND } from "@lexical/react/LexicalHorizontalRuleNode";
import { $isTableNode, $isTableRowNode, $isTableCellNode } from "@lexical/table";
vi.mock("mermaid", () => ({ default: { initialize: () => {}, render: async () => ({ svg: "<svg></svg>" }) } }));
import { MARKDOWN_TRANSFORMERS, MarkdownEditor, $captureDraftLocation } from "./markdown-editor";

afterEach(cleanup);

describe("Markdown dividers", () => {
  it("handles divider insertion in the mounted editor and serializes it", async () => {
    const changed = vi.fn();
    const view = render(<MarkdownEditor value="Paragraph" onChange={changed} />);
    const editor = getNearestEditorFromDOMNode(view.getByLabelText("Spec content"))!;
    await act(async () => {
      editor.update(() => $getRoot().getFirstChildOrThrow().selectEnd(), { discrete: true });
      expect(editor.dispatchCommand(INSERT_HORIZONTAL_RULE_COMMAND, undefined)).toBe(true);
    });
    await waitFor(() => expect(view.container.querySelector("hr")).not.toBeNull());
    const markdown = editor.getEditorState().read(() => $convertToMarkdownString(MARKDOWN_TRANSFORMERS));
    expect(markdown).toContain("---");
    expect(markdown).toContain("Paragraph");
    expect(changed).toHaveBeenCalledWith(markdown);
  });

  it("loads a persisted divider back into a rich-text rule", async () => {
    const view = render(<MarkdownEditor value={"Before\n\n---\n\nAfter"} onChange={() => {}} />);
    await waitFor(() => expect(view.container.querySelector("hr")).not.toBeNull());
    const editor = getNearestEditorFromDOMNode(view.getByLabelText("Spec content"))!;
    const markdown = editor.getEditorState().read(() => $convertToMarkdownString(MARKDOWN_TRANSFORMERS));
    expect(markdown).toBe("Before\n\n---\n\nAfter");
  });
});

it("round-trips a Mermaid code block without changing its language or source", async () => {
  const source = "Before\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\nAfter";
  const view = render(<MarkdownEditor value={source} onChange={() => {}} />);
  const editor = getNearestEditorFromDOMNode(view.getByLabelText("Spec content"))!;
  const markdown = editor.getEditorState().read(() => $convertToMarkdownString(MARKDOWN_TRANSFORMERS));
  expect(markdown).toBe(source);
});


beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Range.prototype.getBoundingClientRect = () => new DOMRect(10, 10, 100, 20);
  Range.prototype.getClientRects = () => [new DOMRect(10, 10, 100, 20)] as unknown as DOMRectList;
});

describe("inline agent drafting", () => {
  it.each(["Plain text", "**Bold text**", "## Heading", "- List item", "😀 Hello", ""])("captures the caret without modifying %j", async (value) => {
    const view = render(<MarkdownEditor value={value} onChange={() => {}} />);
    const editor = getNearestEditorFromDOMNode(view.getByLabelText("Spec content"))!;
    let location: ReturnType<typeof $captureDraftLocation> = null;
    await act(async () => {
      editor.update(() => {
        const text = $getRoot().getAllTextNodes()[0];
        if (text) text.select(Math.min(3, text.getTextContentSize()), Math.min(3, text.getTextContentSize()));
        else $getRoot().getFirstChildOrThrow().selectEnd();
        location = $captureDraftLocation();
      }, { discrete: true });
    });
    const after = editor.getEditorState().read(() => $convertToMarkdownString(MARKDOWN_TRANSFORMERS));
    expect(after).toBe(value);
    expect(location).toMatchObject({ content: value, insertionOffset: expect.any(Number) });
    expect((location as unknown as { insertionOffset: number }).insertionOffset).toBeLessThanOrEqual(value.length);
    if (value === "**Bold text**") expect(location).toMatchObject({ insertionOffset: 5 });
  });

  async function mention(value = "Before ", onDraft = vi.fn(async () => {})) {
    const escape = vi.fn();
    const changed = vi.fn();
    const view = render(<MarkdownEditor value={value} onChange={changed} onDraft={onDraft} />);
    const editor = getNearestEditorFromDOMNode(view.getByLabelText("Spec content"))!;
    await act(async () => {
      editor.update(() => {
        const text = $getRoot().getAllTextNodes()[0];
        const selection = text ? text.selectEnd() : $getRoot().getFirstChildOrThrow().selectEnd();
        selection.insertText(" @agent");
      }, { discrete: true });
    });
    return { view, editor, onDraft, escape, changed };
  }

  it("removes the trigger, keeps a failed request, and allows retry", async () => {
    const onDraft = vi.fn().mockRejectedValueOnce(new Error("Agent unavailable")).mockResolvedValue(undefined);
    const { view, editor, changed } = await mention("Before", onDraft);
    fireEvent.click(await view.findByRole("option", { name: "@ Agent · Draft here" }));
    const input = await view.findByLabelText("What should the agent draft?");
    expect(editor.isEditable()).toBe(false);
    fireEvent.change(input, { target: { value: "Add a Mermaid diagram" } });
    fireEvent.click(view.getByRole("button", { name: "Draft" }));
    await view.findByText("Agent unavailable");
    expect((input as HTMLTextAreaElement).value).toBe("Add a Mermaid diagram");
    expect(onDraft).toHaveBeenCalledWith({ content: "Before ", insertionOffset: 7 }, "Add a Mermaid diagram");
    expect(changed.mock.calls.some(([text]) => text.includes("SPECSINSERT"))).toBe(false);
    fireEvent.click(view.getByRole("button", { name: "Draft" }));
    await waitFor(() => expect(view.queryByRole("form", { name: "Draft with agent" })).toBeNull());
    expect(editor.isEditable()).toBe(true);
  });

  it("cancels with Escape without dispatching or leaving the editor", async () => {
    const { view, editor, onDraft, escape } = await mention();
    fireEvent.click(await view.findByRole("option"));
    fireEvent.keyDown(await view.findByLabelText("What should the agent draft?"), { key: "Escape" });
    expect(onDraft).not.toHaveBeenCalled();
    expect(escape).not.toHaveBeenCalled();
    expect(editor.isEditable()).toBe(true);
  });

  it("opens from the keyboard and preserves text on both sides of the cursor", async () => {
    const onDraft = vi.fn(async () => {});
    const view = render(<MarkdownEditor value="Left right" onChange={() => {}} onDraft={onDraft} />);
    const editor = getNearestEditorFromDOMNode(view.getByLabelText("Spec content"))!;
    await act(async () => { editor.update(() => { $getRoot().getAllTextNodes()[0]!.select(5, 5).insertText("@agent"); }, { discrete: true }); });
    await view.findByRole("option");
    await act(async () => { editor.dispatchCommand(KEY_ENTER_COMMAND, new KeyboardEvent("keydown", { key: "Enter" })); });
    fireEvent.change(await view.findByLabelText("What should the agent draft?"), { target: { value: "Insert a phrase" } });
    fireEvent.click(view.getByRole("button", { name: "Draft" }));
    await waitFor(() => expect(onDraft).toHaveBeenCalledWith({ content: "Left right", insertionOffset: 5 }, "Insert a phrase"));
  });

  it("dismisses the mention menu with Escape without invoking an agent", async () => {
    const { view, editor, onDraft } = await mention();
    await view.findByRole("option");
    await act(async () => { editor.dispatchCommand(KEY_ESCAPE_COMMAND, new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(view.queryByRole("option")).toBeNull();
    expect(onDraft).not.toHaveBeenCalled();
  });

  it("leaves @agent in code blocks as literal text", async () => {
    const { view, editor } = await mention("```js\nconst value = 1;\n```");
    expect(view.queryByRole("option")).toBeNull();
    expect(editor.getEditorState().read(() => $convertToMarkdownString(MARKDOWN_TRANSFORMERS))).toContain("@agent");
  });
});

describe("one document surface", () => {
  it.each([
    "Before\n\n```mermaid\nflowchart LR\n A --> B\n```\n\nAfter",
    "| Name | Value |\n| --- | --- |\n| A | 1 |\n\n![Preview](https://example.com/image.png)\n\n[Guide][ref]\n\n[ref]: https://example.com",
    "# Heading\n\nParagraph with **bold**, *italic*, and `code`.\n\n- First\n- Second",
  ])("does not publish a rewrite just by opening Markdown", async (source) => {
    const changed = vi.fn();
    render(<MarkdownEditor value={source} onChange={changed} />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(changed).not.toHaveBeenCalled();
  });

  it("renders Mermaid in the editor and persists source edits without losing surrounding text", async () => {
    const source = "Before\n\n```mermaid\nflowchart LR\n A --> B\n```\n\nAfter";
    const changed = vi.fn();
    const discuss = vi.fn();
    const view = render(<MarkdownEditor value={source} onChange={changed} onDiscussDiagram={discuss} />);
    await view.findByRole("img", { name: "Spec diagram" });
    fireEvent.click(view.getByRole("button", { name: "Discuss diagram" }));
    expect(discuss).toHaveBeenCalledWith("flowchart LR\n A --> B");
    fireEvent.click(view.getByRole("button", { name: "Edit source" }));
    fireEvent.change(view.getByLabelText("Mermaid source"), { target: { value: "flowchart TD\n A --> C" } });
    fireEvent.click(view.getByRole("button", { name: "Save diagram" }));
    await waitFor(() => expect(changed).toHaveBeenLastCalledWith("Before\n\n```mermaid\nflowchart TD\n A --> C\n```\n\nAfter"));
    fireEvent.click(view.getByRole("button", { name: "Edit source" }));
    fireEvent.change(view.getByLabelText("Mermaid source"), { target: { value: "Unwanted edit" } });
    fireEvent.click(view.getByRole("button", { name: "Cancel" }));
    expect(changed).not.toHaveBeenLastCalledWith(expect.stringContaining("Unwanted edit"));
  });

  it("offers formatting, comments, and agent actions on the same text selection", async () => {
    const comment = vi.fn(); const ask = vi.fn();
    const view = render(<MarkdownEditor value="Selected words" onChange={() => {}} onComment={comment} onAsk={ask} />);
    const root = view.getByLabelText("Spec content");
    const text = root.querySelector('[data-lexical-text]')!.firstChild!;
    const selection = window.getSelection()!;
    const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 8);
    selection.removeAllRanges(); selection.addRange(range);
    fireEvent(document, new Event("selectionchange"));
    await view.findByRole("button", { name: "Comment" });
    expect(view.getByTitle("Bold (⌘B)")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Comment" }));
    expect(comment).toHaveBeenCalledWith(expect.objectContaining({ quote: "Selected" }), expect.anything(), "note");
    fireEvent.click(view.getByRole("button", { name: "Ask agent" }));
    expect(ask).toHaveBeenCalledWith("Selected");
  });
});

it("renders tilde-fenced diagrams without treating fenced examples as diagrams", async () => {
  const source = "~~~mermaid\nflowchart LR\n A --> B\n~~~\n\n````md\n```mermaid\nexample\n```\n````";
  const view = render(<MarkdownEditor value={source} onChange={() => {}} />);
  expect(await view.findAllByRole("region", { name: "Mermaid diagram" })).toHaveLength(1);
  const editor = getNearestEditorFromDOMNode(view.getByLabelText("Spec content"))!;
  const markdown = editor.getEditorState().read(() => $convertToMarkdownString(MARKDOWN_TRANSFORMERS));
  expect(markdown).toContain("flowchart LR\n A --> B");
  expect(markdown).toContain("````md\n```mermaid\nexample\n```\n````");
});

describe("Markdown tables and task lists", () => {
  it("pastes Markdown tables and checklists at the caret and preserves cell line breaks", async () => {
    const source = "| Name | Notes |\n| --- | --- |\n| One | First<br>Second |\n\n- [ ] Follow up";
    const changed = vi.fn();
    const view = render(<MarkdownEditor value={"Before\n\nAfter"} onChange={changed} />);
    const editor = getNearestEditorFromDOMNode(view.getByLabelText("Spec content"))!;
    await act(async () => {});
    const event = { clipboardData: { getData: (type: string) => type === "text/plain" ? source : "" }, preventDefault: vi.fn() };
    await act(async () => { editor.update(() => {
      $getRoot().getFirstChildOrThrow().selectEnd();
      editor.dispatchCommand(PASTE_COMMAND, event as unknown as ClipboardEvent);
    }, { discrete: true }); });
    expect(event.preventDefault).toHaveBeenCalled();
    expect(view.getByRole("table")).toBeTruthy();
    expect(view.getByRole("checkbox", { name: "Follow up" })).toBeTruthy();
    const saved = changed.mock.lastCall![0] as string;
    expect(saved).toContain("First<br>Second");
    expect(saved.indexOf("Before")).toBeLessThan(saved.indexOf("| Name"));
    expect(saved).toMatch(/^Before\n\n\|[\s\S]*Follow up\n\nAfter$/);
    view.unmount();
    const reopened = render(<MarkdownEditor value={saved} onChange={() => {}} />);
    const cell = reopened.getByRole("cell", { name: "First Second" });
    expect(cell.querySelectorAll("p")).toHaveLength(2);
  });

  it("renders aligned, formatted table cells and round-trips edits, escaped pipes, and empty cells", async () => {
    const source = "Before\n\n| Name | Value | Notes |\n| :--- | ---: | :---: |\n| **Alpha** | `a\\|b` | |\n| [Guide](https://example.com) | 12 | A\\|B |\n\nAfter";
    const changed = vi.fn();
    const view = render(<MarkdownEditor value={source} onChange={changed} />);
    const table = await view.findByRole("table");
    expect(table.querySelectorAll("th")).toHaveLength(3);
    expect(table.querySelectorAll("td")).toHaveLength(6);
    expect(table.querySelector("strong")?.textContent).toBe("Alpha");
    expect(table.querySelector("code")?.textContent).toBe("a|b");
    expect(table.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
    expect(Array.from(table.querySelectorAll("th"), (cell) => cell.style.textAlign)).toEqual(["left", "right", "center"]);
    const editor = getNearestEditorFromDOMNode(view.getByLabelText("Spec content"))!;
    expect(editor.getEditorState().read(() => $convertToMarkdownString(MARKDOWN_TRANSFORMERS))).toBe(source.replace("`a\\|b` | |", "`a\\|b` |  |"));
    await act(async () => { editor.update(() => {
      const node = $getRoot().getChildren().find($isTableNode)!;
      const row = node.getChildren().filter($isTableRowNode)[1]!;
      row.getChildren().filter($isTableCellNode)[2]!.selectEnd().insertText("Updated");
    }, { discrete: true }); });
    const saved = changed.mock.lastCall![0] as string;
    expect(saved).toBe(source.replace("`a\\|b` | |", "`a\\|b` | Updated |"));
    view.unmount();
    const reopened = render(<MarkdownEditor value={saved} onChange={() => {}} />);
    expect(await reopened.findByRole("cell", { name: "Updated" })).toBeTruthy();
    expect(reopened.getByRole("cell", { name: "a|b" })).toBeTruthy();
  });

  it("supports tables without outer pipes, pads short rows, and leaves invalid tables and code literal", async () => {
    const source = "Name | Count\n--- | ---\nOne | 1\nTwo |\n\nNot | table\n--- | invalid\n\n```md\n| Code | Example |\n| --- | --- |\n```";
    const view = render(<MarkdownEditor value={source} onChange={() => {}} />);
    expect(view.getAllByRole("table")).toHaveLength(1);
    expect(view.getAllByRole("cell")).toHaveLength(4);
    expect(view.getByLabelText("Spec content").textContent).toContain("Not | table");
    const editor = getNearestEditorFromDOMNode(view.getByLabelText("Spec content"))!;
    const saved = editor.getEditorState().read(() => $convertToMarkdownString(MARKDOWN_TRANSFORMERS));
    expect(saved).toContain("| Two |  |");
    expect(saved).toContain("```md\n| Code | Example |\n| --- | --- |\n```");
  });

  it("renders accessible nested checklists and saves mouse and keyboard toggles", async () => {
    const source = "- [ ] First\n- [x] Finished\n  - [ ] Nested\n\nAfter";
    const changed = vi.fn();
    const view = render(<MarkdownEditor value={source} onChange={changed} />);
    const editor = getNearestEditorFromDOMNode(view.getByLabelText("Spec content"))!;
    const checkboxes = view.getAllByRole("checkbox");
    expect(checkboxes.map((box) => box.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
    const first = checkboxes[0]!;
    first.getBoundingClientRect = () => new DOMRect(0, 0, 300, 28);
    const computedStyle = window.getComputedStyle.bind(window);
    const styles = vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
      if (pseudo) return { width: "18px" } as CSSStyleDeclaration;
      const style = computedStyle(element);
      const getProperty = style.getPropertyValue.bind(style);
      style.getPropertyValue = (name) => name === "zoom" ? "1" : getProperty(name);
      return style;
    });
    await act(async () => {});
    fireEvent.click(first, { clientX: 5, clientY: 10 });
    await waitFor(() => expect(first.getAttribute("aria-checked")).toBe("true"));
    styles.mockRestore();
    expect(changed.mock.lastCall![0]).toContain("- [x] First");
    await act(async () => { first.focus(); editor.dispatchCommand(KEY_SPACE_COMMAND, new KeyboardEvent("keydown", { key: " " })); });
    await waitFor(() => expect(first.getAttribute("aria-checked")).toBe("false"));
    const saved = changed.mock.lastCall![0] as string;
    expect(saved).toContain("- [x] Finished");
    expect(saved).toMatch(/\n +\- \[ \] Nested/);
    view.unmount();
    const reopened = render(<MarkdownEditor value={saved} onChange={() => {}} />);
    expect(reopened.getAllByRole("checkbox").map((box) => box.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
  });

  it.each(["Table", "Checklist"])("inserts a %s with the slash menu", async (kind) => {
    const changed = vi.fn();
    const view = render(<MarkdownEditor value="" onChange={changed} />);
    const editor = getNearestEditorFromDOMNode(view.getByLabelText("Spec content"))!;
    await act(async () => { editor.update(() => { $getRoot().getFirstChildOrThrow().selectEnd().insertText(`/${kind.toLowerCase()}`); }, { discrete: true }); });
    fireEvent.click(await view.findByRole("option", { name: new RegExp(kind) }));
    await view.findByRole(kind === "Table" ? "table" : "checkbox");
    expect(changed.mock.lastCall![0]).toContain(kind === "Table" ? "| --- | --- | --- |" : "- [ ]");
  });

  it("renders ordinary Markdown formatting and preserves it when adjacent prose changes", async () => {
    const source = "## Heading\n\n**Bold** and *italic* and ~~removed~~ and `code` and [Link](https://example.com).\n\n> Quote\n\n3. Third\n4. Fourth\n\n- Parent\n  - Child\n\n```ts\nconst value = 1;\n```\n\n---\n\nAfter";
    const changed = vi.fn();
    const view = render(<MarkdownEditor value={source} onChange={changed} />);
    expect(view.getByRole("heading", { level: 2 }).textContent).toBe("Heading");
    expect(view.container.querySelector("strong")?.textContent).toBe("Bold");
    expect(view.container.querySelector("em")?.textContent).toBe("italic");
    expect(view.container.querySelector(".specs-strikethrough")?.textContent).toBe("removed");
    expect(view.container.querySelector("blockquote")?.textContent).toBe("Quote");
    expect(view.container.querySelector("ol")?.start).toBe(3);
    expect(view.container.querySelector("ul ul")?.textContent).toBe("Child");
    expect(view.container.querySelector("hr")).toBeTruthy();
    const editor = getNearestEditorFromDOMNode(view.getByLabelText("Spec content"))!;
    await act(async () => {});
    await act(async () => { editor.update(() => { $getRoot().getLastChildOrThrow().selectEnd().insertText(" edit"); }, { discrete: true }); });
    expect(changed.mock.lastCall![0]).toContain("~~removed~~");
    expect(changed.mock.lastCall![0]).toContain("3. Third");
    expect(changed.mock.lastCall![0]).toContain("```ts\nconst value = 1;\n```");
    expect(changed.mock.lastCall![0]).toContain("After edit");
  });
});
