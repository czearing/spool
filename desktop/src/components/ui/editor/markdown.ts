import { $convertFromMarkdownString, $convertToMarkdownString, TRANSFORMERS, CHECK_LIST, HIGHLIGHT,
  type Transformer, type MultilineElementTransformer, type ElementTransformer, type TextMatchTransformer } from "@lexical/markdown";
import { $createHorizontalRuleNode, $isHorizontalRuleNode, HorizontalRuleNode } from "@lexical/extension";
import { $createTextNode, $isTextNode, TextNode, type ElementNode } from "lexical";
import { $createImageNode, $isImageNode, ImageNode } from "./image-node";
import { CalloutNode, ToggleNode, ToggleTitleNode, ToggleContentNode, $createCalloutNode, $createToggleNode,
  $createToggleTitle, $createToggleContent } from "./container-nodes";
import { tableTransformer } from "./table-markdown";
import { safeEditorUrl } from "./urls";

const divider: ElementTransformer = {
  type: "element", dependencies: [HorizontalRuleNode], regExp: /^(?:---|\*\*\*|___)\s*$/, triggerOnEnter: true,
  export: (node) => $isHorizontalRuleNode(node) ? "---" : null,
  replace: (parent) => { parent.replace($createHorizontalRuleNode()); },
};
const image: TextMatchTransformer = {
  type: "text-match", dependencies: [ImageNode], trigger: ")",
  regExp: /!\[((?:\\.|[^\]\\])*)\]\((<?[^)\s]+>?)\)$/, importRegExp: /!\[((?:\\.|[^\]\\])*)\]\((<?[^)\s]+>?)\)/,
  export: (node) => $isImageNode(node) ? `![${node.getAlt().replace(/[\\[\]]/g, "\\$&")}](${node.getSrc().replace(/\(/g, "%28").replace(/\)/g, "%29")})` : null,
  replace: (node, match) => {
    const url = match[2].replace(/^<|>$/g, "");
    if (safeEditorUrl(url, true)) node.replace($createImageNode(url, match[1].replace(/\\([\\[\]])/g, "$1")));
  },
};
const underline: TextMatchTransformer = {
  type: "text-match", dependencies: [TextNode], trigger: ">",
  regExp: /<u>(.*?)<\/u>$/, importRegExp: /<u>(.*?)<\/u>/,
  export: (node, _children, format) => $isTextNode(node) && node.hasFormat("underline") ? `<u>${format(node, node.getTextContent())}</u>` : null,
  replace(node, match) { const text = $createTextNode(match[1]).toggleFormat("underline"); node.replace(text); return text; },
};
function appendContainer(root: ElementNode, toggle: boolean, title: string, markdown: string) {
  if (toggle) {
    const content = $createToggleContent();
    $convertFromMarkdownString(markdown, markdownTransformers, content);
    root.append($createToggleNode().append($createToggleTitle().append($createTextNode(title || "Details")), content));
  } else {
    const callout = $createCalloutNode();
    $convertFromMarkdownString(markdown, markdownTransformers, callout); root.append(callout);
  }
}
function containerTransformer(toggle: boolean): MultilineElementTransformer {
  return {
    type: "multiline-element", dependencies: toggle ? [ToggleNode, ToggleTitleNode, ToggleContentNode] : [CalloutNode],
    regExpStart: toggle ? /^:::toggle(?:\s+(.*))?$/ : /^:::callout\s*$/,
    regExpEnd: /^:::\s*$/,
    handleImportAfterStartMatch({ lines, startLineIndex, rootNode, startMatch }) {
      let depth = 1, fence = "";
      for (let index = startLineIndex + 1; index < lines.length; index++) {
        const marker = lines[index].match(/^(`{3,}|~{3,})/)?.[1];
        if (marker) { if (!fence) fence = marker; else if (marker[0] === fence[0] && marker.length >= fence.length) fence = ""; continue; }
        if (fence) continue;
        if (/^:::(?:toggle|callout)(?:\s|$)/.test(lines[index])) depth++;
        if (/^:::\s*$/.test(lines[index]) && --depth === 0) {
          appendContainer(rootNode, toggle, startMatch[1], lines.slice(startLineIndex + 1, index).join("\n"));
          return [true, index];
        }
      }
      return null;
    },
    replace(root, _children, start, _end, lines) {
      if (!lines) return false;
      appendContainer(root, toggle, start[1], lines.join("\n"));
    },
    export(node) {
      if (!toggle && node instanceof CalloutNode) return `:::callout\n${$convertToMarkdownString(markdownTransformers, node)}\n:::`;
      if (toggle && node instanceof ToggleNode) {
        const content = node.getLastChild<ElementNode>();
        return `:::toggle ${node.getFirstChild()?.getTextContent() || "Details"}\n${content ? $convertToMarkdownString(markdownTransformers, content) : ""}\n:::`;
      }
      return null;
    },
  };
}
export const markdownTransformers: Transformer[] = [containerTransformer(false), containerTransformer(true),
  tableTransformer(() => markdownTransformers), divider, image, underline, CHECK_LIST, HIGHLIGHT, ...TRANSFORMERS];

export function $importMarkdown(markdown: string) {
  $convertFromMarkdownString(markdown.replace(/\r\n?/g, "\n"), markdownTransformers);
}
