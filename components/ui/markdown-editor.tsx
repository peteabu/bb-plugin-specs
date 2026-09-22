// A rich-text editor that still stores markdown.
//
// Specs are markdown, but people shouldn't have to type markdown syntax to
// write a document. This wraps Lexical (Meta's editor engine) with the markdown
// transformers: headings, lists, quotes, and code render as you type, markdown
// shortcuts (##, **, -, >) still work, and the value handed back to the plugin
// is serialized markdown — so revisions, diffs, agents, and the digest are
// unchanged.
import { useCallback, useRef } from "react";
import type { ReactNode } from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { LinkPlugin } from "@lexical/react/LexicalLinkPlugin";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import {
  $createHeadingNode,
  $createQuoteNode,
  HeadingNode,
  QuoteNode,
} from "@lexical/rich-text";
import {
  INSERT_ORDERED_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
  ListItemNode,
  ListNode,
} from "@lexical/list";
import {
  $createCodeNode,
  CodeNode,
} from "@lexical/code";
import { LinkNode, TOGGLE_LINK_COMMAND } from "@lexical/link";
import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  TRANSFORMERS,
} from "@lexical/markdown";
import {
  $createParagraphNode,
  $getSelection,
  $isRangeSelection,
  FORMAT_TEXT_COMMAND,
  type ElementNode,
  type LexicalEditor,
  type EditorState,
} from "lexical";
import { $setBlocksType } from "@lexical/selection";
import { cn } from "../../lib/utils";

const EDITOR_THEME = {
  code: "specs-code-block",
  quote: "specs-quote-block",
};

function setBlock(editor: LexicalEditor, create: () => ElementNode): void {
  editor.update(() => {
    const selection = $getSelection();
    if ($isRangeSelection(selection)) {
      $setBlocksType(selection, create);
    }
  });
}

interface Tool {
  id: string;
  label: string;
  title: string;
  run: (editor: LexicalEditor) => void;
}

const TOOLS: Tool[] = [
  {
    id: "paragraph",
    label: "¶",
    title: "Paragraph",
    run: (editor) => setBlock(editor, () => $createParagraphNode()),
  },
  {
    id: "heading",
    label: "H",
    title: "Heading",
    run: (editor) => setBlock(editor, () => $createHeadingNode("h2")),
  },
  {
    id: "bold",
    label: "B",
    title: "Bold (⌘B)",
    run: (editor) => {
      editor.dispatchCommand(FORMAT_TEXT_COMMAND, "bold");
    },
  },
  {
    id: "italic",
    label: "I",
    title: "Italic (⌘I)",
    run: (editor) => {
      editor.dispatchCommand(FORMAT_TEXT_COMMAND, "italic");
    },
  },
  {
    id: "bullet",
    label: "•",
    title: "Bulleted list",
    run: (editor) => {
      editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined);
    },
  },
  {
    id: "ordered",
    label: "1.",
    title: "Numbered list",
    run: (editor) => {
      editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined);
    },
  },
  {
    id: "quote",
    label: "❝",
    title: "Quote",
    run: (editor) => setBlock(editor, () => $createQuoteNode()),
  },
  {
    id: "code",
    label: "</>",
    title: "Code block",
    run: (editor) => setBlock(editor, () => $createCodeNode()),
  },
  {
    id: "link",
    label: "Link",
    title: "Link",
    run: (editor) => {
      const url = window.prompt("Link URL");
      if (url !== null && url.trim() !== "") {
        editor.dispatchCommand(TOGGLE_LINK_COMMAND, url.trim());
      }
    },
  },
];

function Toolbar() {
  const [editor] = useLexicalComposerContext();
  return (
    <div className="mb-2 flex flex-wrap items-center gap-0.5 border-b border-border pb-2">
      {TOOLS.map((tool) => (
        <button
          key={tool.id}
          type="button"
          title={tool.title}
          aria-label={tool.title}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => tool.run(editor)}
          className="specs-press grid h-7 min-w-7 cursor-pointer place-items-center rounded-md px-1.5 text-xs font-medium text-muted-foreground hover:bg-state-hover hover:text-foreground"
        >
          {tool.label}
        </button>
      ))}
      <span className="ml-auto hidden text-[10px] text-muted-foreground sm:block">
        Markdown shortcuts work too (##, **, -, &gt;)
      </span>
    </div>
  );
}

function MarkdownChanges({
  onChange,
  initialMarkdown,
}: {
  onChange: (markdown: string) => void;
  initialMarkdown: string;
}) {
  const sawContent = useRef(initialMarkdown.trim() !== "");
  const handle = useCallback(
    (editorState: EditorState) => {
      editorState.read(() => {
        const markdown = $convertToMarkdownString(TRANSFORMERS);
        // Safety: an editor that failed to load its initial content serializes
        // as empty. Never let that first empty change overwrite the document.
        if (markdown.trim() === "" && !sawContent.current) return;
        if (markdown.trim() !== "") sawContent.current = true;
        onChange(markdown);
      });
    },
    [onChange],
  );
  return <OnChangePlugin ignoreSelectionChange onChange={handle} />;
}

export function MarkdownEditor({
  value,
  onChange,
  onSave,
  onEscape,
  className,
}: {
  value: string;
  onChange: (markdown: string) => void;
  onSave?: () => void;
  onEscape?: () => void;
  className?: string;
}) {
  return (
    <LexicalComposer
      initialConfig={{
        namespace: "specs-markdown",
        theme: EDITOR_THEME,
        nodes: [HeadingNode, QuoteNode, ListNode, ListItemNode, LinkNode, CodeNode],
        editorState: () => {
          $convertFromMarkdownString(value, TRANSFORMERS);
        },
        onError: (error: Error) => {
          // Keep editor failures contained; the rest of the page still works.
          console.error("[specs] editor error", error);
        },
      }}
    >
      <div
        className={cn("specs-rich-editor", className)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
            event.preventDefault();
            onSave?.();
          }
          if (event.key === "Escape") onEscape?.();
        }}
      >
        <Toolbar />
        <div className="relative">
          <RichTextPlugin
            contentEditable={
              <ContentEditable
                className="specs-doc specs-rich-surface"
                aria-label="Spec content"
              />
            }
            placeholder={
              <p className="specs-rich-placeholder">
                Write normally — use the buttons above, or markdown shortcuts.
              </p>
            }
            ErrorBoundary={LexicalErrorBoundary}
          />
        </div>
        <HistoryPlugin />
        <ListPlugin />
        <LinkPlugin />
        <MarkdownShortcutPlugin transformers={TRANSFORMERS} />
        <MarkdownChanges onChange={onChange} initialMarkdown={value} />
      </div>
    </LexicalComposer>
  );
}

/** Focus the currently mounted rich editor (used by the title's Enter key). */
export function focusSpecEditor(): void {
  const surface = document.querySelector<HTMLElement>(".specs-rich-surface");
  surface?.focus();
}
