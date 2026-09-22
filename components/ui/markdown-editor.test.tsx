// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { $getRoot, getNearestEditorFromDOMNode } from "lexical";
import { $convertToMarkdownString } from "@lexical/markdown";
import { INSERT_HORIZONTAL_RULE_COMMAND } from "@lexical/react/LexicalHorizontalRuleNode";
import { MARKDOWN_TRANSFORMERS, MarkdownEditor } from "./markdown-editor";

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
