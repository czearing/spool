import { $convertFromMarkdownString, $convertToMarkdownString, type MultilineElementTransformer, type Transformer } from "@lexical/markdown";
import { $createTableCellNode, $createTableNode, $createTableRowNode, $isTableNode, TableCellHeaderStates,
  TableNode, TableRowNode, TableCellNode } from "@lexical/table";

function cells(line: string) {
  return line.trim().replace(/^\||(?<!\\)\|$/g, "").split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}
export function tableTransformer(getTransformers: () => Transformer[]): MultilineElementTransformer {
  return {
    type: "multiline-element", dependencies: [TableNode, TableRowNode, TableCellNode],
    regExpStart: /^.*\|.*$/, replace: () => false,
    handleImportAfterStartMatch({ lines, startLineIndex, rootNode }) {
      const separator = lines[startLineIndex + 1];
      if (!separator || !cells(separator).every((cell) => /^:?-{3,}:?$/.test(cell))) return null;
      const alignment = cells(separator), headers = cells(lines[startLineIndex]);
      if (headers.length !== alignment.length) return null;
      const table = $createTableNode();
      let end = startLineIndex + 1;
      const append = (values: string[], header: boolean) => {
        const row = $createTableRowNode();
        headers.forEach((_, index) => {
          const cell = $createTableCellNode(header ? TableCellHeaderStates.ROW : TableCellHeaderStates.NO_STATUS);
          const align = alignment[index];
          cell.setFormat(align.endsWith(":") ? (align.startsWith(":") ? "center" : "right") : "left");
          $convertFromMarkdownString((values[index] || "").replace(/<br\s*\/?>/g, "\n"), getTransformers(), cell);
          row.append(cell);
        });
        table.append(row);
      };
      append(headers, true);
      while (end + 1 < lines.length && lines[end + 1].includes("|")) { append(cells(lines[++end]), false); }
      rootNode.append(table);
      return [true, end];
    },
    export(node) {
      if (!$isTableNode(node)) return null;
      const rows = node.getChildren<TableRowNode>().map((row) => row.getChildren<TableCellNode>().map((cell) =>
        $convertToMarkdownString(getTransformers(), cell).replace(/\|/g, "\\|").replace(/\n/g, "<br>")));
      if (!rows.length) return "";
      const first = node.getFirstChild<TableRowNode>()!;
      const separator = first.getChildren<TableCellNode>().map((cell) => cell.getFormatType() === "center" ? ":---:" : cell.getFormatType() === "right" ? "---:" : "---");
      return [rows[0], separator, ...rows.slice(1)].map((row) => `| ${row.join(" | ")} |`).join("\n");
    },
  };
}
