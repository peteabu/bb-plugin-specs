export interface QuoteLocation {
  quote: string;
  prefix: string;
  suffix: string;
}

function collectTextNodes(container: HTMLElement): Text[] {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let node = walker.nextNode();
  while (node !== null) {
    if (!(node.parentElement?.closest('[contenteditable="false"]'))) nodes.push(node as Text);
    node = walker.nextNode();
  }
  return nodes;
}

function normalizeQuote(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

// Rendered markdown can differ from stored quotes in whitespace (soft line
// breaks, indentation), and quotes can repeat. Normalize both sides and map
// offsets back to real text nodes so ranges stay exact.
function normalizeTextNodes(nodes: Text[]): {
  text: string;
  positions: Array<{ node: Text; offset: number }>;
} {
  let text = "";
  const positions: Array<{ node: Text; offset: number }> = [];
  let pendingSpace: { node: Text; offset: number } | null = null;
  for (const node of nodes) {
    const data = node.data;
    for (let index = 0; index < data.length; index += 1) {
      const char = data[index] ?? "";
      if (/\s/u.test(char)) {
        if (pendingSpace === null) pendingSpace = { node, offset: index };
        continue;
      }
      if (pendingSpace !== null) {
        if (text !== "" && !text.endsWith(" ")) {
          text += " ";
          positions.push(pendingSpace);
        }
        pendingSpace = null;
      }
      text += char;
      positions.push({ node, offset: index });
    }
  }
  return { text, positions };
}

function locateQuote(text: string, annotation: QuoteLocation): number {
  const quote = normalizeQuote(annotation.quote);
  if (quote === "") return -1;
  const prefix = normalizeQuote(annotation.prefix);
  const suffix = normalizeQuote(annotation.suffix);
  const first = text.indexOf(quote);
  let candidate = first;
  while (candidate !== -1) {
    const before = text
      .slice(Math.max(0, candidate - prefix.length - 1), candidate)
      .trim();
    const after = text
      .slice(candidate + quote.length, candidate + quote.length + suffix.length + 1)
      .trim();
    if (
      (prefix === "" || before.endsWith(prefix)) &&
      (suffix === "" || after.startsWith(suffix))
    ) {
      return candidate;
    }
    candidate = text.indexOf(quote, candidate + 1);
  }
  return first;
}

export function findAnnotationRange(
  container: HTMLElement,
  annotation: QuoteLocation,
): Range | null {
  const { text, positions } = normalizeTextNodes(collectTextNodes(container));
  const quoteStart = locateQuote(text, annotation);
  if (quoteStart === -1) return null;
  const quote = normalizeQuote(annotation.quote);
  const start = positions[quoteStart];
  const end = positions[quoteStart + quote.length - 1];
  if (start === undefined || end === undefined) return null;
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset + 1);
  return range;
}

export function captureSelection(container: HTMLElement): QuoteLocation | null {
  const selection = window.getSelection();
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }
  const range = selection.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;
  const quote = normalizeQuote(selection.toString());
  if (quote === "") return null;
  const { text, positions } = normalizeTextNodes(collectTextNodes(container));
  // Map the actual selection boundary into the same normalized text used by
  // highlighting. Searching by quote alone would anchor repeated text at its
  // first occurrence instead of the passage the user selected.
  const at = positions.findIndex(({ node, offset }, index) =>
    text[index] !== " " && range.comparePoint(node, offset) === 0,
  );
  if (at === -1 || !text.startsWith(quote, at)) return null;
  const storedQuote = quote.slice(0, 1900);
  return {
    quote: storedQuote,
    prefix: text.slice(Math.max(0, at - 48), at),
    suffix:
      text.slice(at + storedQuote.length, at + storedQuote.length + 48),
  };
}
