// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiagramPreview } from "./diagram-preview";

vi.mock("@get-bb/plugin-sdk/app", () => ({ Markdown: ({ content }: { content: string }) => <div>{content}</div> }));
const { draw, initialize } = vi.hoisted(() => ({ draw: vi.fn(async (_id: string, _source: string) => ({ svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Diagram</text></svg>' })), initialize: vi.fn() }));
vi.mock("mermaid", () => ({ default: { initialize, render: draw } }));
afterEach(() => { cleanup(); draw.mockClear(); initialize.mockClear(); });

describe("spec diagrams", () => {
  it("isolates rendered SVG as an image", async () => {
    const view = render(<DiagramPreview source={"flowchart LR\n A --> B"} />);
    const img = await view.findByRole("img", { name: "Spec diagram" });
    expect(img.getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
    expect(view.container.querySelector("svg")).toBeNull();
    expect(initialize).toHaveBeenCalledWith(expect.objectContaining({ securityLevel: "strict", htmlLabels: false }));
  });
  it("keeps malformed source visible and recovers when it is corrected", async () => {
    draw.mockRejectedValueOnce(new Error("Parse error"));
    const view = render(<DiagramPreview source="malformed" />);
    await view.findByRole("alert");
    expect(view.getByText("malformed")).toBeTruthy();
    view.rerender(<DiagramPreview source="flowchart TD\n A --> B" />);
    await waitFor(() => expect(view.getByRole("img")).toBeTruthy());
    expect(view.queryByRole("alert")).toBeNull();
  });
});
