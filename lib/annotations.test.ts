// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { captureSelection, findAnnotationRange } from "./annotations";

afterEach(() => { window.getSelection()?.removeAllRanges(); document.body.replaceChildren(); });

function select(container: HTMLElement, node: Node, from: number, to: number) {
  document.body.append(container);
  const range = document.createRange();
  range.setStart(node, from);
  range.setEnd(node, to);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
}

describe("annotation selection anchors", () => {
  it("anchors the selected repeated phrase, not the first match", () => {
    const container = document.createElement("div");
    container.textContent = "First repeated phrase before. Later repeated phrase after.";
    const node = container.firstChild!;
    const at = container.textContent.lastIndexOf("repeated phrase");
    select(container, node, at, at + "repeated phrase".length);
    const quote = captureSelection(container)!;
    expect(quote.prefix).toContain("Later ");
    expect(quote.suffix).toBe(" after.");
    const found = findAnnotationRange(container, quote)!;
    expect(found.startContainer).toBe(node);
    expect(found.startOffset).toBe(at);
  });

  it("uses normalized context across nested nodes and whitespace", () => {
    const container = document.createElement("div");
    container.innerHTML = "First <em>repeated phrase</em>.\n\nSecond <strong>repeated\n  phrase</strong> after.";
    const node = container.querySelector("strong")!.firstChild!;
    select(container, node, 0, node.textContent!.length);
    const quote = captureSelection(container)!;
    expect(quote.quote).toBe("repeated phrase");
    const found = findAnnotationRange(container, quote)!;
    expect(found.startContainer).toBe(node);
    expect(found.toString()).toBe("repeated\n  phrase");
  });

  it("keeps the suffix adjacent to the stored truncated quote", () => {
    const container = document.createElement("div");
    container.textContent = "prefix " + "a".repeat(2000) + " suffix";
    select(container, container.firstChild!, 7, 2007);
    const quote = captureSelection(container)!;
    expect(quote.quote.length).toBe(1900);
    expect(quote.suffix).toBe("a".repeat(48));
  });

  it("ignores whitespace-only selections", () => {
    const container = document.createElement("div");
    container.textContent = "one   two";
    select(container, container.firstChild!, 3, 6);
    expect(captureSelection(container)).toBeNull();
  });

  it("matches context when punctuation immediately follows the selected phrase", () => {
    const container = document.createElement("div");
    container.textContent = "First repeated phrase! Later repeated phrase?";
    const at = container.textContent.lastIndexOf("repeated phrase");
    select(container, container.firstChild!, at, at + "repeated phrase".length);
    const quote = captureSelection(container)!;
    expect(quote.suffix).toBe("?");
    expect(findAnnotationRange(container, quote)?.startOffset).toBe(at);
  });

  it("finds the selected occurrence beyond the first 25 matches", () => {
    const container = document.createElement("div");
    container.textContent = Array.from({ length: 30 }, (_, index) => `Row ${index}: repeated phrase. `).join("");
    const at = container.textContent.lastIndexOf("repeated phrase");
    select(container, container.firstChild!, at, at + "repeated phrase".length);
    const quote = captureSelection(container)!;
    expect(findAnnotationRange(container, quote)?.startOffset).toBe(at);
  });
});
