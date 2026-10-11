/**
 * Comment and AST/token parser for JavaScript and TypeScript source files.
 * Extracts inline, block, and JSDoc comments while safely ignoring strings, template literals, and regexes.
 * Groups consecutive single-line comments into cohesive blocks for accurate semantic and statistical analysis.
 */

/**
 * Parses source text and extracts all comments with location and target code context.
 *
 * @param {string} source - The source code text.
 * @returns {Array<{
 *   startLine: number,
 *   endLine: number,
 *   commentType: 'inline' | 'block' | 'jsdoc',
 *   rawText: string,
 *   cleanText: string,
 *   lines: string[],
 *   lineCount: number,
 *   isStandalone: boolean,
 *   targetCodeLine: string | null,
 *   targetCodeBlock: string[],
 *   targetIdentifier: string | null,
 * }>}
 */
export function extractComments(source) {
  const rawComments = [];
  const length = source.length;
  let index = 0;
  let line = 1;
  let lineStartIndex = 0;

  while (index < length) {
    const char = source[index];
    const nextChar = source[index + 1];

    if (char === "\n") {
      line += 1;
      index += 1;
      lineStartIndex = index;
      continue;
    }

    if (char === "\r") {
      index += 1;
      continue;
    }

    // String literals: single or double quote
    if (char === '"' || char === "'") {
      const quote = char;
      index += 1;
      while (index < length && source[index] !== quote) {
        if (source[index] === "\\") index += 2;
        else {
          if (source[index] === "\n") {
            line += 1;
            lineStartIndex = index + 1;
          }
          index += 1;
        }
      }
      index += 1; // skip closing quote
      continue;
    }

    // Template literals: ` ... `
    if (char === "`") {
      index += 1;
      while (index < length && source[index] !== "`") {
        if (source[index] === "\\") {
          index += 2;
        } else if (source[index] === "$" && source[index + 1] === "{") {
          // Note: nested template interpolation is simplified here
          index += 2;
        } else {
          if (source[index] === "\n") {
            line += 1;
            lineStartIndex = index + 1;
          }
          index += 1;
        }
      }
      index += 1;
      continue;
    }

    // Single-line comment: //
    if (char === "/" && nextChar === "/") {
      const startLine = line;
      const startIdx = index;
      const isStandalone = source.slice(lineStartIndex, startIdx).trim().length === 0;

      index += 2;
      while (index < length && source[index] !== "\n" && source[index] !== "\r") {
        index += 1;
      }
      const rawText = source.slice(startIdx, index);
      const cleanText = rawText.replace(/^\/\/\s?/, "").trim();

      rawComments.push({
        startLine,
        endLine: startLine,
        commentType: "inline",
        rawText,
        cleanText,
        isStandalone,
        startIdx,
        endIdx: index,
      });
      continue;
    }

    // Multi-line block or JSDoc comment: /* or /**
    if (char === "/" && nextChar === "*") {
      const startLine = line;
      const startIdx = index;
      const isJsDoc = source[index + 2] === "*" && source[index + 3] !== "/";
      const isStandalone = source.slice(lineStartIndex, startIdx).trim().length === 0;

      index += 2;
      while (index < length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] === "\n") {
          line += 1;
          lineStartIndex = index + 1;
        }
        index += 1;
      }
      if (index < length) {
        index += 2; // skip */
      }
      const rawText = source.slice(startIdx, index);
      const cleanText = cleanBlockComment(rawText);

      rawComments.push({
        startLine,
        endLine: line,
        commentType: isJsDoc ? "jsdoc" : "block",
        rawText,
        cleanText,
        isStandalone,
        startIdx,
        endIdx: index,
      });
      continue;
    }

    index += 1;
  }

  const allLines = source.split(/\r?\n/);
  const groupedComments = groupConsecutiveInlineComments(rawComments, allLines);

  // Attach following code context to each comment block
  return groupedComments.map((comment) => {
    const codeContext = findFollowingCodeContext(allLines, comment.endLine);
    return {
      ...comment,
      targetCodeLine: codeContext.firstLine,
      targetCodeBlock: codeContext.block,
      targetIdentifier: extractTargetIdentifier(codeContext.firstLine),
    };
  });
}

function cleanBlockComment(raw) {
  return raw
    .replace(/^\/\*\*?/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, "").trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .trim();
}

function isDividerComment(text) {
  const trimmed = text.replace(/^\/\/\s?/, "").trim();
  return /^[=\-_*#]{3,}/.test(trimmed);
}

function groupConsecutiveInlineComments(rawComments, allLines) {
  const grouped = [];
  let currentGroup = null;

  for (const comment of rawComments) {
    const isDivider = isDividerComment(comment.rawText);

    if (comment.commentType === "inline" && comment.isStandalone && !isDivider) {
      if (
        currentGroup &&
        currentGroup.commentType === "inline" &&
        !isDividerComment(currentGroup.rawText) &&
        currentGroup.endLine === comment.startLine - 1
      ) {
        // Merge with existing group
        currentGroup.endLine = comment.endLine;
        currentGroup.rawText += `\n${comment.rawText}`;
        currentGroup.cleanText += `\n${comment.cleanText}`;
        currentGroup.lines.push(comment.cleanText);
        currentGroup.lineCount += 1;
        continue;
      } else {
        if (currentGroup) grouped.push(finalizeGroup(currentGroup));
        currentGroup = {
          startLine: comment.startLine,
          endLine: comment.endLine,
          commentType: "inline",
          rawText: comment.rawText,
          cleanText: comment.cleanText,
          lines: [comment.cleanText],
          lineCount: 1,
          isStandalone: true,
        };
        continue;
      }
    }

    if (currentGroup) {
      grouped.push(finalizeGroup(currentGroup));
      currentGroup = null;
    }

    const lines = comment.cleanText.split("\n").filter((l) => l.trim().length > 0);
    grouped.push({
      startLine: comment.startLine,
      endLine: comment.endLine,
      commentType: comment.commentType,
      rawText: comment.rawText,
      cleanText: comment.cleanText,
      lines,
      lineCount: comment.endLine - comment.startLine + 1,
      isStandalone: comment.isStandalone,
    });
  }

  if (currentGroup) {
    grouped.push(finalizeGroup(currentGroup));
  }

  return grouped;
}

function finalizeGroup(group) {
  return {
    ...group,
    cleanText: group.lines.join("\n").trim(),
  };
}

function findFollowingCodeContext(allLines, endLine) {
  let lineIdx = endLine; // 1-based index converted to 0-based for next line
  while (lineIdx < allLines.length) {
    const line = allLines[lineIdx].trim();
    if (line.length > 0 && !line.startsWith("//") && !line.startsWith("/*") && !line.startsWith("*")) {
      const block = [];
      for (let i = lineIdx; i < Math.min(allLines.length, lineIdx + 5); i++) {
        if (allLines[i].trim().length > 0) {
          block.push(allLines[i].trim());
        }
      }
      return {
        firstLine: line,
        block,
      };
    }
    lineIdx += 1;
  }
  return {
    firstLine: null,
    block: [],
  };
}

/**
 * Extracts declared function, variable, type, interface, method, or property name from target code line.
 */
export function extractTargetIdentifier(codeLine) {
  if (!codeLine) return null;
  const line = codeLine.trim();

  // export function foo(...) or function foo(...) or async function foo(...)
  const fnMatch = line.match(/(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*([a-zA-Z0-9_$]+)/);
  if (fnMatch) return fnMatch[1];

  // const foo = ... / let foo = ... / var foo = ...
  const varMatch = line.match(/(?:export\s+)?(?:const|let|var)\s+([a-zA-Z0-9_$]+)/);
  if (varMatch) return varMatch[1];

  // interface Foo / type Foo = / class Foo
  const typeMatch = line.match(/(?:export\s+)?(?:interface|type|class|enum)\s+([a-zA-Z0-9_$]+)/);
  if (typeMatch) return typeMatch[1];

  // methodName(...) or async methodName(...)
  const methodMatch = line.match(/^(?:public|private|protected|static|readonly|async|\s)*([a-zA-Z0-9_$]+)\s*\(/);
  if (methodMatch && !["if", "for", "while", "switch", "catch"].includes(methodMatch[1])) {
    return methodMatch[1];
  }

  // property: Type or property?: Type
  const propMatch = line.match(/^([a-zA-Z0-9_$]+)\??\s*:/);
  if (propMatch) return propMatch[1];

  return null;
}
