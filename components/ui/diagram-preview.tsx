import { useEffect, useId, useState } from "react";

// Serialize rendering because Mermaid has shared configuration and DOM work.
let renderQueue: Promise<unknown> = Promise.resolve();
async function renderDiagram(id: string, source: string): Promise<string> {
  const render = async () => {
    if (source.length > 30_000) throw new Error("Diagram is too large to preview.");
    const { default: mermaid } = await import("mermaid");
    mermaid.initialize({
      startOnLoad: false, securityLevel: "strict", theme: "neutral",
      maxTextSize: 30_000, suppressErrorRendering: true, htmlLabels: false,
      secure: ["securityLevel", "startOnLoad", "maxTextSize", "suppressErrorRendering", "htmlLabels"],
      flowchart: { htmlLabels: false },
    });
    const { svg } = await mermaid.render(id, source);
    // Display as an image, never executable markup in the document DOM.
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  };
  const result = renderQueue.then(render, render);
  renderQueue = result.catch(() => {});
  return result;
}

export function DiagramPreview({ source }: { source: string }) {
  const id = `spec-diagram-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [result, setResult] = useState<{ source: string; url?: string; error?: string } | null>(null);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      void renderDiagram(id, source).then(
        (url) => { if (active) setResult({ source, url }); },
        (error: unknown) => { if (active) setResult({ source, error: error instanceof Error ? error.message : String(error) }); },
      );
    }, 150);
    return () => { active = false; clearTimeout(timer); };
  }, [id, source]);
  if (result?.source !== source) return <p className="text-xs text-muted-foreground">Rendering diagram…</p>;
  if (result.error !== undefined) return <div><p role="alert" className="text-xs text-destructive">Cannot render this diagram: {result.error}</p><pre className="overflow-auto text-xs">{source}</pre></div>;
  return <img src={result.url} alt="Spec diagram" className="mx-auto max-h-[60vh] max-w-full rounded-lg bg-white p-3" />;
}
