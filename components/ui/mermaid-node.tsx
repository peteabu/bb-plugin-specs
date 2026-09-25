import { createContext, useContext, useState, type ReactNode } from "react";
import { $getNodeByKey, DecoratorNode, type NodeKey, type SerializedLexicalNode } from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { DiagramPreview } from "./diagram-preview";
import { Button } from "./button";

export const DiagramDiscussion = createContext<((source: string) => void) | undefined>(undefined);

type SerializedMermaid = SerializedLexicalNode & { source: string };
export class MermaidNode extends DecoratorNode<ReactNode> {
  __source: string;
  static getType() { return "mermaid"; }
  static clone(node: MermaidNode) { return new MermaidNode(node.__source, node.__key); }
  constructor(source = "", key?: NodeKey) { super(key); this.__source = source; }
  static importJSON(value: SerializedMermaid) { return new MermaidNode(value.source); }
  exportJSON(): SerializedMermaid { return { ...super.exportJSON(), type: "mermaid", version: 1, source: this.getSource() }; }
  createDOM() { const element = document.createElement("div"); element.className = "my-5"; return element; }
  updateDOM() { return false; }
  isInline() { return false; }
  getSource() { return this.getLatest().__source; }
  setSource(source: string) { this.getWritable().__source = source; }
  getTextContent() { return this.getSource(); }
  decorate() { return <MermaidBlock nodeKey={this.getKey()} source={this.getSource()} />; }
}

function MermaidBlock({ nodeKey, source }: { nodeKey: NodeKey; source: string }) {
  const [editor] = useLexicalComposerContext();
  const discuss = useContext(DiagramDiscussion);
  const [draft, setDraft] = useState<string | null>(source.trim() === "" ? source : null);
  return <section aria-label="Mermaid diagram" contentEditable={false} className="space-y-2 rounded-xl border border-border p-3" onKeyDown={(event) => event.stopPropagation()}>
    <DiagramPreview source={draft ?? source} />
    {draft === null ? <div className="flex justify-end gap-2">
      <Button size="sm" variant="ghost" onClick={() => setDraft(source)}>Edit source</Button>
      {discuss === undefined ? null : <Button size="sm" variant="outline" onClick={() => discuss(source)}>Discuss diagram</Button>}
    </div> : <>
      <textarea aria-label="Mermaid source" autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} className="min-h-32 w-full rounded-lg border border-input bg-background p-2 font-mono text-xs" />
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
        <Button size="sm" disabled={!draft.trim()} onClick={() => {
          editor.update(() => { const node = $getNodeByKey(nodeKey); if (node instanceof MermaidNode) node.setSource(draft); });
          setDraft(null);
        }}>Save diagram</Button>
      </div>
    </>}
  </section>;
}
