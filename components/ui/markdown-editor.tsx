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
import { CheckListPlugin } from "@lexical/react/LexicalCheckListPlugin";
import { TablePlugin } from "@lexical/react/LexicalTablePlugin";
import { TableNode, TableRowNode, TableCellNode, INSERT_TABLE_COMMAND, $isTableNode, $isTableCellNode } from "@lexical/table";
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
  INSERT_CHECK_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
  ListItemNode,
  ListNode,
  $isListNode,
} from "@lexical/list";
import {
  $createHorizontalRuleNode,
  $isHorizontalRuleNode,
  INSERT_HORIZONTAL_RULE_COMMAND,
  HorizontalRuleNode,
} from "@lexical/react/LexicalHorizontalRuleNode";
import { $createCodeNode, $isCodeNode, CodeNode } from "@lexical/code";
import { LinkNode, TOGGLE_LINK_COMMAND } from "@lexical/link";
import {
  $convertFromMarkdownString,
  $generateNodesFromMarkdownString,
  $convertToMarkdownString,
  TRANSFORMERS,
  CHECK_LIST,
  type ElementTransformer,
  type MultilineElementTransformer,
} from "@lexical/markdown";
import {
  $createParagraphNode,
  $createTextNode,
  $getSelection,
  $setSelection,
  $isRangeSelection,
  FORMAT_TEXT_COMMAND,
  PASTE_COMMAND,
  COMMAND_PRIORITY_HIGH,
  type ElementNode,
  type LexicalEditor,
  type EditorState,
  type TextNode,
  type RangeSelection,
  $getRoot,
} from "lexical";
import { $setBlocksType } from "@lexical/selection";
import { cn } from "../../lib/utils";
import { Button } from "./button";
import { MermaidNode, DiagramDiscussion } from "./mermaid-node";
import { MARKDOWN_TABLE } from "./markdown-table";
import { captureSelection, type QuoteLocation } from "../../lib/annotations";
import type { RefObject } from "react";

const EDITOR_THEME = {
  code: "specs-code-block",
  quote: "specs-quote-block",
  text: { strikethrough: "specs-strikethrough", underline: "specs-underline", underlineStrikethrough: "specs-underline-strikethrough", highlight: "specs-highlight" },
  list: {
    checklist: "specs-checklist",
    listitemChecked: "specs-checklist-checked",
    listitemUnchecked: "specs-checklist-unchecked",
    nested: { listitem: "specs-nested-list-item" },
  },
  tableScrollableWrapper: "specs-table-scroll",
  tableCellSelected: "specs-table-cell-selected",
};

const HORIZONTAL_RULE: ElementTransformer = {
  dependencies: [HorizontalRuleNode],
  type: "element",
  regExp: /^\s*(?:---+|\*\*\*+|___+)\s*$/,
  export: (node) => $isHorizontalRuleNode(node) ? "---" : null,
  replace: (node) => { node.replace($createHorizontalRuleNode()); },
};

const MERMAID: MultilineElementTransformer = {
  dependencies: [MermaidNode], type: "multiline-element",
  regExpStart: /^ {0,3}(`{3,}|~{3,})mermaid[ \t]*$/i,
  handleImportAfterStartMatch: ({ lines, startLineIndex, startMatch, rootNode }) => {
    const fence = startMatch[1]!;
    const close = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`);
    for (let index = startLineIndex + 1; index < lines.length; index++) {
      if (close.test(lines[index]!)) {
        rootNode.append(new MermaidNode(lines.slice(startLineIndex + 1, index).join("\n")));
        return [true, index];
      }
    }
    return null;
  },
  export: (node) => {
    if (!(node instanceof MermaidNode)) return null;
    const source = node.getSource();
    const fence = "`".repeat(Math.max(3, ...Array.from(source.matchAll(/`+/g), (match) => match[0].length + 1)));
    return `${fence}mermaid\n${source}\n${fence}`;
  },
  replace: () => false,
};
export const MARKDOWN_TRANSFORMERS = [MERMAID, MARKDOWN_TABLE, HORIZONTAL_RULE, CHECK_LIST, ...TRANSFORMERS];

function StructuredMarkdownPaste() {
  const [editor] = useLexicalComposerContext();
  useEffect(() => editor.registerCommand(PASTE_COMMAND, (event) => {
    if (!event || !("clipboardData" in event) || !event.clipboardData || event.clipboardData.getData("text/html")) return false;
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return false;
    const anchor = selection.anchor.getNode();
    if ([anchor, ...anchor.getParents()].some((node) => $isCodeNode(node) || $isTableCellNode(node))) return false;
    const text = event.clipboardData.getData("text/plain");
    const nodes = $generateNodesFromMarkdownString(text, MARKDOWN_TRANSFORMERS);
    if (!nodes.some((node) => $isTableNode(node) || ($isListNode(node) && node.getListType() === "check"))) return false;
    event.preventDefault();
    selection.insertNodes(nodes);
    return true;
  }, COMMAND_PRIORITY_HIGH), [editor]);
  return null;
}

function EditorBlocks({ rootRef }: { rootRef?: RefObject<HTMLDivElement | null> }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    const convert = (node: CodeNode) => {
      if (node.getLanguage()?.toLowerCase() === "mermaid") node.replace(new MermaidNode(node.getTextContent()));
    };
    const unregister = editor.registerNodeTransform(CodeNode, convert);
    editor.update(() => { for (const node of $getRoot().getChildren()) if ($isCodeNode(node)) convert(node); });
    const unregisterRoot = editor.registerRootListener((root) => { if (rootRef) rootRef.current = root as HTMLDivElement | null; });
    return () => { unregister(); unregisterRoot(); if (rootRef) rootRef.current = null; };
  }, [editor, rootRef]);
  return null;
}

export interface DraftLocation {
  content: string;
  insertionOffset: number;
}

// Serialize a temporary marker in the same transaction, then remove it before
// any editor update is published. The saved document never contains the marker.
export function $captureDraftLocation(): DraftLocation | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;
  const caret = selection.clone();
  const marker = `SPECSINSERT${crypto.randomUUID().replaceAll("-", "")}HERE`;
  const node = $createTextNode(marker).setFormat(selection.format).setStyle(selection.style);
  selection.insertNodes([node]);
  const marked = $convertToMarkdownString(MARKDOWN_TRANSFORMERS);
  node.remove();
  $setSelection(caret);
  const content = $convertToMarkdownString(MARKDOWN_TRANSFORMERS);
  const markerOffset = marked.indexOf(marker);
  if (markerOffset < 0) return null;
  // Empty blocks/formatting can disappear when the marker is removed. Stop at
  // their boundary rather than pointing beyond the actual serialized content.
  let insertionOffset = 0;
  while (insertionOffset < markerOffset && content[insertionOffset] === marked[insertionOffset]) insertionOffset++;
  return { content, insertionOffset };
}

function AgentDraftMenu({ onDraft }: { onDraft: (location: DraftLocation, request: string) => Promise<void> }) {
  const [editor] = useLexicalComposerContext();
  const [query, setQuery] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<{ location: DraftLocation; selection: RangeSelection; top: number } | null>(null);
  const [request, setRequest] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const option = useMemo(() => new MenuOption("agent"), []);
  const matchMention = useBasicTypeaheadTriggerMatch("@", { minLength: 0 });
  const options = query !== null && "agent".startsWith(query.toLowerCase()) ? [option] : [];
  useEffect(() => {
    if (prompt === null) return;
    editor.setEditable(false);
    return () => { editor.setEditable(true); };
  }, [editor, prompt]);
  const close = () => {
    if (sending.current) return;
    setPrompt(null);
    editor.setEditable(true);
    editor.update(() => { if (prompt !== null) $setSelection(prompt.selection.clone()); });
    editor.focus();
  };
  return <>
    <LexicalTypeaheadMenuPlugin<MenuOption>
      onQueryChange={setQuery}
      options={options}
      triggerFn={(text, currentEditor) => {
        if (prompt !== null) return null;
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || selection.hasFormat("code")) return null;
        const node = selection.anchor.getNode();
        if ([node, ...node.getParents()].some($isCodeNode)) return null;
        return matchMention(text, currentEditor);
      }}
      onSelectOption={(_option, nodeToRemove, closeMenu) => {
        editor.update(() => {
          nodeToRemove?.remove();
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) return;
          const element = editor.getElementByKey(selection.anchor.getNode().getKey());
          const root = editor.getRootElement();
          const top = element === null || root === null ? 0 : Math.max(0, element.getBoundingClientRect().bottom - root.getBoundingClientRect().top + 8);
          const location = $captureDraftLocation();
          const caret = $getSelection();
          if (location !== null && $isRangeSelection(caret)) {
            setRequest(""); setError(null);
            setPrompt({ location, selection: caret.clone(), top });
          }
        });
        closeMenu();
      }}
      menuRenderFn={(anchorRef, { selectOptionAndCleanUp }) => anchorRef.current !== null && options.length > 0 ? createPortal(
        <div className="specs-slash-menu" role="listbox" aria-label="Agent">
          <button ref={option.setRefElement} id="typeahead-item-0" type="button" role="option" aria-selected className="specs-slash-item specs-slash-item-active" onMouseDown={(event) => event.preventDefault()} onClick={() => selectOptionAndCleanUp(option)}>
            <span className="specs-slash-icon">@</span><span>Agent · Draft here</span>
          </button>
        </div>, anchorRef.current) : null}
    />
    {prompt === null ? null : <form aria-label="Draft with agent" className="specs-pop absolute left-0 z-50 w-full max-w-md space-y-3 rounded-xl bg-popover p-3 text-popover-foreground" style={{ top: prompt.top }} onKeyDown={(event) => {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); close(); }
    }} onSubmit={async (event) => {
      event.preventDefault();
      if (sending.current || request.trim() === "") return;
      sending.current = true; setBusy(true); setError(null);
      try { await onDraft(prompt.location, request.trim()); setPrompt(null); }
      catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { sending.current = false; setBusy(false); }
    }}>
      <label className="block text-sm font-medium">Draft here with agent
        <textarea autoFocus aria-label="What should the agent draft?" placeholder="Describe the section, code, or diagram…" value={request} maxLength={5000} disabled={busy} onChange={(event) => setRequest(event.target.value)} className="mt-2 min-h-24 w-full resize-y rounded-lg border border-input bg-background p-2 text-sm font-normal outline-none focus:ring-1 focus:ring-ring" />
      </label>
      <p className="text-xs text-muted-foreground">You’ll review the proposed insertion before it changes the document.</p>
      {error === null ? null : <p role="alert" className="text-xs text-destructive">{error}</p>}
      <div className="flex justify-end gap-2"><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={close}>Cancel</Button><Button type="submit" size="sm" disabled={busy || !request.trim()}>{busy ? "Sending…" : "Draft"}</Button></div>
    </form>}
  </>;
}

function setBlock(editor: LexicalEditor, create: () => ElementNode): void {
  editor.update(() => {
    const selection = $getSelection();
    if ($isRangeSelection(selection)) {
      $setBlocksType(selection, create);
    }
  });
}

type BlockKind = "text" | "heading" | "bullet" | "ordered" | "checklist" | "table" | "quote" | "code" | "diagram" | "divider";

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
  new SlashOption("Checklist", "☑", ["task", "todo", "checkbox"], "checklist"),
  new SlashOption("Table", "▦", ["table", "rows", "columns"], "table"),
  new SlashOption("Quote", "❝", ["blockquote"], "quote"),
  new SlashOption("Diagram", "◇", ["mermaid", "diagram", "flowchart"], "diagram"),
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
    case "checklist":
      editor.dispatchCommand(INSERT_CHECK_LIST_COMMAND, undefined);
      return;
    case "table":
      editor.dispatchCommand(INSERT_TABLE_COMMAND, { rows: "3", columns: "3", includeHeaders: { rows: true, columns: false } });
      return;
    case "quote":
      setBlock(editor, () => $createQuoteNode());
      return;
    case "code":
      setBlock(editor, () => $createCodeNode());
      return;
    case "diagram":
      editor.update(() => { const selection = $getSelection(); if ($isRangeSelection(selection)) selection.insertNodes([new MermaidNode()]); });
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
function SelectionBar({ onComment, onAsk }: {
  onComment?: (location: QuoteLocation, position: { x: number; y: number }, kind: "note" | "question") => void;
  onAsk?: (quote: string) => void;
}) {
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
      {onComment === undefined ? null : <>
        <button type="button" className="specs-toolbar-button" onClick={() => {
          const root = editor.getRootElement(); const location = root && captureSelection(root);
          if (location) onComment(location, { x: position.left, y: position.top }, "note");
        }}>Comment</button>
        <button type="button" className="specs-toolbar-button" onClick={() => {
          const root = editor.getRootElement(); const location = root && captureSelection(root);
          if (location) onComment(location, { x: position.left, y: position.top }, "question");
        }}>Question</button>
      </>}
      {onAsk === undefined ? null : <button type="button" className="specs-toolbar-button" onClick={() => { const text = window.getSelection()?.toString(); if (text) onAsk(text); }}>Ask agent</button>}
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
  const [editor] = useLexicalComposerContext();
  const lastMarkdown = useRef(editor.getEditorState().read(() => $convertToMarkdownString(MARKDOWN_TRANSFORMERS)));
  const sawContent = useRef(initialMarkdown.trim() !== "");
  const handle = useCallback(
    (editorState: EditorState) => {
      editorState.read(() => {
        const markdown = $convertToMarkdownString(MARKDOWN_TRANSFORMERS);
        if (markdown === lastMarkdown.current) return;
        lastMarkdown.current = markdown;
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
  onDraft,
  rootRef, onComment, onAsk, onDiscussDiagram,
  className,
}: {
  value: string;
  onChange: (markdown: string) => void;
  onSave?: () => void;
  onDraft?: (location: DraftLocation, request: string) => Promise<void>;
  rootRef?: RefObject<HTMLDivElement | null>;
  onComment?: (location: QuoteLocation, position: { x: number; y: number }, kind: "note" | "question") => void;
  onAsk?: (quote: string) => void;
  onDiscussDiagram?: (source: string) => void;
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
          MermaidNode,
          TableNode,
          TableRowNode,
          TableCellNode,
        ],
        editorState: () => {
          $convertFromMarkdownString(value, MARKDOWN_TRANSFORMERS);
          for (const node of $getRoot().getChildren()) {
            if ($isCodeNode(node) && node.getLanguage()?.toLowerCase() === "mermaid") node.replace(new MermaidNode(node.getTextContent()));
          }
        },
        onError: (error: Error) => {
          // Keep editor failures contained; the rest of the page still works.
          console.error("[specs] editor error", error);
        },
      }}
    >
      <DiagramDiscussion.Provider value={onDiscussDiagram}>
      <div
        className={cn("specs-rich-editor", className)}
        onKeyDown={(event) => {
          if (event.defaultPrevented) return;
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
            event.preventDefault();
            onSave?.();
          }
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
                Write, type / for blocks, or @agent to draft…
              </p>
            }
            ErrorBoundary={LexicalErrorBoundary}
          />
          <SelectionBar onComment={onComment} onAsk={onAsk} />
        </div>
        <EditorBlocks rootRef={rootRef} />
        <HistoryPlugin />
        <ListPlugin />
        <CheckListPlugin />
        <TablePlugin hasCellMerge={false} hasCellBackgroundColor={false} hasHorizontalScroll />
        <LinkPlugin />
        <HorizontalRulePlugin />
        <MarkdownShortcutPlugin transformers={MARKDOWN_TRANSFORMERS} />
        <StructuredMarkdownPaste />
        <SlashMenu />
        {onDraft === undefined ? null : <AgentDraftMenu onDraft={onDraft} />}
        <MarkdownChanges onChange={onChange} initialMarkdown={value} />
      </div>
      </DiagramDiscussion.Provider>
    </LexicalComposer>
  );
}

/** Focus the currently mounted rich editor (used by the title's Enter key). */
export function focusSpecEditor(): void {
  const surface = document.querySelector<HTMLElement>(".specs-rich-surface");
  surface?.focus();
}
