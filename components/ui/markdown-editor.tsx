// A rich-text editor that still stores markdown.
//
// Specs are markdown, but people shouldn't have to type markdown syntax. The
// experience is Notion-like: block types come from a slash menu at the caret,
// inline formatting from a floating bar on selection, and markdown shortcuts
// (#, -, >, ```) keep working for people who like them. The value handed back
// to the plugin is serialized markdown, so revisions, diffs, agents, and the
// digest are unchanged.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { LinkPlugin } from "@lexical/react/LexicalLinkPlugin";
import { HorizontalRulePlugin } from "@lexical/react/LexicalHorizontalRulePlugin";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import {
  LexicalTypeaheadMenuPlugin,
  MenuOption,
  useBasicTypeaheadTriggerMatch,
} from "@lexical/react/LexicalTypeaheadMenuPlugin";
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
  $createHorizontalRuleNode,
  $isHorizontalRuleNode,
  INSERT_HORIZONTAL_RULE_COMMAND,
  HorizontalRuleNode,
} from "@lexical/react/LexicalHorizontalRuleNode";
import { $createCodeNode, CodeNode } from "@lexical/code";
import { LinkNode, TOGGLE_LINK_COMMAND } from "@lexical/link";
import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  TRANSFORMERS,
  type ElementTransformer,
} from "@lexical/markdown";
import {
  $createParagraphNode,
  $getSelection,
  $isRangeSelection,
  FORMAT_TEXT_COMMAND,
  type ElementNode,
  type LexicalEditor,
  type EditorState,
  type TextNode,
} from "lexical";
import { $setBlocksType } from "@lexical/selection";
import { cn } from "../../lib/utils";

const EDITOR_THEME = {
  code: "specs-code-block",
  quote: "specs-quote-block",
};

const HORIZONTAL_RULE: ElementTransformer = {
  dependencies: [HorizontalRuleNode],
  type: "element",
  regExp: /^\s*(?:---+|\*\*\*+|___+)\s*$/,
  export: (node) => $isHorizontalRuleNode(node) ? "---" : null,
  replace: (node) => { node.replace($createHorizontalRuleNode()); },
};

export const MARKDOWN_TRANSFORMERS = [HORIZONTAL_RULE, ...TRANSFORMERS];

function setBlock(editor: LexicalEditor, create: () => ElementNode): void {
  editor.update(() => {
    const selection = $getSelection();
    if ($isRangeSelection(selection)) {
      $setBlocksType(selection, create);
    }
  });
}

type BlockKind = "text" | "heading" | "bullet" | "ordered" | "quote" | "code" | "divider";

class SlashOption extends MenuOption {
  constructor(
    readonly title: string,
    readonly glyph: string,
    readonly keywords: string[],
    readonly kind: BlockKind,
  ) {
    super(title);
  }
}

const SLASH_OPTIONS: SlashOption[] = [
  new SlashOption("Text", "¶", ["paragraph", "body", "plain"], "text"),
  new SlashOption("Heading", "H", ["title", "h2"], "heading"),
  new SlashOption("Bulleted list", "•", ["bullet", "unordered", "ul"], "bullet"),
  new SlashOption("Numbered list", "1.", ["ordered", "number", "ol"], "ordered"),
  new SlashOption("Quote", "❝", ["blockquote"], "quote"),
  new SlashOption("Code block", "</>", ["code", "pre"], "code"),
  new SlashOption("Divider", "—", ["horizontal", "rule", "hr"], "divider"),
];

function runBlock(editor: LexicalEditor, kind: BlockKind): void {
  switch (kind) {
    case "text":
      setBlock(editor, () => $createParagraphNode());
      return;
    case "heading":
      setBlock(editor, () => $createHeadingNode("h2"));
      return;
    case "bullet":
      editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined);
      return;
    case "ordered":
      editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined);
      return;
    case "quote":
      setBlock(editor, () => $createQuoteNode());
      return;
    case "code":
      setBlock(editor, () => $createCodeNode());
      return;
    case "divider":
      editor.dispatchCommand(INSERT_HORIZONTAL_RULE_COMMAND, undefined);
      return;
  }
}

function SlashMenu() {
  const [editor] = useLexicalComposerContext();
  const [query, setQuery] = useState<string | null>(null);
  const triggerFn = useBasicTypeaheadTriggerMatch("/", { minLength: 0 });
  const options = useMemo(() => {
    if (query === null) return [];
    const needle = query.toLowerCase();
    return SLASH_OPTIONS.filter((option) =>
      `${option.title} ${option.keywords.join(" ")}`.toLowerCase().includes(needle),
    );
  }, [query]);

  return (
    <LexicalTypeaheadMenuPlugin<SlashOption>
      onQueryChange={setQuery}
      onSelectOption={(
        option: SlashOption,
        nodeToRemove: TextNode | null,
        closeMenu: () => void,
      ) => {
        editor.update(() => {
          nodeToRemove?.remove();
        });
        runBlock(editor, option.kind);
        closeMenu();
      }}
      triggerFn={triggerFn}
      options={options}
      menuRenderFn={(anchorRef, { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex }) =>
        anchorRef.current !== null && options.length > 0
          ? createPortal(
              <div className="specs-slash-menu" role="listbox">
                {options.map((option, index) => (
                  <button
                    key={option.key}
                    type="button"
                    role="option"
                    aria-selected={index === selectedIndex}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setHighlightedIndex(index)}
                    onClick={() => selectOptionAndCleanUp(option)}
                    className={cn(
                      "specs-slash-item",
                      index === selectedIndex && "specs-slash-item-active",
                    )}
                  >
                    <span className="specs-slash-icon">{option.glyph}</span>
                    {option.title}
                  </button>
                ))}
              </div>,
              anchorRef.current,
            )
          : null
      }
    />
  );
}

/** Floating inline-format bar over a text selection, like Notion's. */
function SelectionBar() {
  const [editor] = useLexicalComposerContext();
  const [position, setPosition] = useState<{ top: number; left: number } | null>(
    null,
  );

  useEffect(() => {
    const update = () => {
      const selection = window.getSelection();
      const root = editor.getRootElement();
      if (
        selection === null ||
        selection.isCollapsed ||
        selection.rangeCount === 0 ||
        root === null
      ) {
        setPosition(null);
        return;
      }
      const range = selection.getRangeAt(0);
      if (!root.contains(range.commonAncestorContainer)) {
        setPosition(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        setPosition(null);
        return;
      }
      const above = rect.top - 44;
      setPosition({
        top: above < 8 ? rect.bottom + 10 : above,
        left: rect.left + rect.width / 2,
      });
    };
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, [editor]);

  if (position === null) return null;
  return (
    <div
      className="specs-toolbar"
      style={{ top: position.top, left: position.left }}
      onMouseDown={(event) => event.preventDefault()}
    >
      <button
        type="button"
        title="Bold (⌘B)"
        onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "bold")}
        className="specs-toolbar-button font-semibold"
      >
        B
      </button>
      <button
        type="button"
        title="Italic (⌘I)"
        onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "italic")}
        className="specs-toolbar-button italic"
      >
        I
      </button>
      <button
        type="button"
        title="Inline code"
        onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "code")}
        className="specs-toolbar-button font-mono text-[11px]"
      >
        {"</>"}
      </button>
      <span className="mx-0.5 h-4 w-px bg-border" />
      <button
        type="button"
        title="Link"
        onClick={() => {
          const url = window.prompt("Link URL");
          if (url !== null && url.trim() !== "") {
            editor.dispatchCommand(TOGGLE_LINK_COMMAND, url.trim());
          }
        }}
        className="specs-toolbar-button"
      >
        Link
      </button>
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
        const markdown = $convertToMarkdownString(MARKDOWN_TRANSFORMERS);
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
        nodes: [
          HeadingNode,
          QuoteNode,
          ListNode,
          ListItemNode,
          LinkNode,
          CodeNode,
          HorizontalRuleNode,
        ],
        editorState: () => {
          $convertFromMarkdownString(value, MARKDOWN_TRANSFORMERS);
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
                Write, or type / for headings, lists, and more…
              </p>
            }
            ErrorBoundary={LexicalErrorBoundary}
          />
          <SelectionBar />
        </div>
        <HistoryPlugin />
        <ListPlugin />
        <LinkPlugin />
        <HorizontalRulePlugin />
        <MarkdownShortcutPlugin transformers={MARKDOWN_TRANSFORMERS} />
        <SlashMenu />
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
