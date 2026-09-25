import { $generateNodesFromMarkdownString, $convertToMarkdownString, TEXT_FORMAT_TRANSFORMERS, TEXT_MATCH_TRANSFORMERS, type MultilineElementTransformer } from "@lexical/markdown";
import {
  $createTableNode, $createTableRowNode, $createTableCellNode,
  $isTableNode, $isTableRowNode, $isTableCellNode,
  TableNode, TableRowNode, TableCellNode, TableCellHeaderStates,
} from "@lexical/table";

// Cell content is inline Markdown: a leading # or - is cell text, not a block.
const CELL_TRANSFORMERS = [...TEXT_FORMAT_TRANSFORMERS, ...TEXT_MATCH_TRANSFORMERS];

function cells(line: string): string[] {
  const result: string[] = [];
  let value = "";
  let escaped = false;
  for (const char of line.trim()) {
    if (char === "|" && !escaped) { result.push(value.trim()); value = ""; }
    else value += char;
    escaped = char === "\\" && !escaped;
  }
  result.push(value.trim());
  if (result[0] === "") result.shift();
  if (result.at(-1) === "") result.pop();
  return result;
}

export const MARKDOWN_TABLE: MultilineElementTransformer = {
  type: "multiline-element",
  dependencies: [TableNode, TableRowNode, TableCellNode],
  regExpStart: /^ {0,3}\S.*\|.*$/,
  handleImportAfterStartMatch: ({ lines, startLineIndex, rootNode }) => {
    const headers = cells(lines[startLineIndex]!);
    const separators = cells(lines[startLineIndex + 1] ?? "");
    if (!headers.length || headers.length !== separators.length || !separators.every((cell) => /^:?-+:?$/.test(cell))) return null;
    const table = $createTableNode();
    rootNode.append(table);
    const appendRow = (values: string[], header: boolean) => {
      const row = $createTableRowNode();
      table.append(row);
      headers.forEach((_, index) => {
        const cell = $createTableCellNode(header ? TableCellHeaderStates.ROW : TableCellHeaderStates.NO_STATUS);
        const separator = separators[index]!;
        cell.setFormat(separator.endsWith(":") ? (separator.startsWith(":") ? "center" : "right") : separator.startsWith(":") ? "left" : "");
        row.append(cell);
        cell.append(...$generateNodesFromMarkdownString((values[index] ?? "").replace(/\\\|/g, "|").replace(/<br\s*\/?>/gi, "\n"), CELL_TRANSFORMERS, true));
      });
    };
    appendRow(headers, true);
    let end = startLineIndex + 1;
    while (end + 1 < lines.length && /^ {0,3}\S.*\|/.test(lines[end + 1]!)) {
      appendRow(cells(lines[++end]!), false);
    }
    return [true, end];
  },
  export: (node) => {
    if (!$isTableNode(node)) return null;
    const rows = node.getChildren().filter($isTableRowNode);
    const header = rows[0]?.getChildren().filter($isTableCellNode);
    if (!header?.length) return "";
    const result = rows.map((row) => `| ${row.getChildren().filter($isTableCellNode).map((cell) => $convertToMarkdownString(CELL_TRANSFORMERS, cell, true).replace(/\|/g, "\\|").replace(/\n/g, "<br>").trim()).join(" | ")} |`);
    result.splice(1, 0, `| ${header.map((cell) => {
      const format = cell.getFormatType();
      return format === "center" ? ":---:" : format === "right" ? "---:" : format === "left" ? ":---" : "---";
    }).join(" | ")} |`);
    return result.join("\n");
  },
  replace: () => false,
};
