/**
 * Statistical AI Slop and Redundant Comment Detection Engine.
 * Identifies tautological comments, AI lecturing/filler, bloated JSDoc, structural noise, and micro-narration.
 */

const STOP_WORDS = new Set([
  "a", "an", "the", "this", "that", "these", "those",
  "is", "are", "was", "were", "be", "been", "being",
  "to", "of", "in", "for", "on", "with", "at", "by", "from", "as", "into",
  "and", "or", "but", "if", "then", "else", "when", "up", "out",
  "it", "its", "we", "our", "you", "your", "they", "their",
  "can", "will", "should", "would", "could", "may",
]);

const EXEMPT_PATTERNS = [
  /eslint-disable/i,
  /@ts-ignore/i,
  /@ts-expect-error/i,
  /@ts-nocheck/i,
  /istanbul\s+ignore/i,
  /c8\s+ignore/i,
  /prettier-ignore/i,
  /vite-ignore/i,
  /webpackChunkName/i,
  /copyright\s+(?:\(c\))?/i,
  /licensed\s+under/i,
  /spdx-license-identifier/i,
  /https?:\/\//i,
  /\b(?:todo|fixme|bug|hack|workaround|issue\s*#?)\b/i,
];

const AI_FILLER_PATTERNS = [
  {
    regex: /(?:this|the)\s+(?:function|hook|method|class|component|utility|helper)\s+(?:is responsible for|allows (?:you|us) to|serves (?:as|to)|is designed to|is used to|helps (?:to|with)|provides (?:a|the)?|handles)/i,
    reason: "AI boilerplate: 'This function is responsible for / is designed to...'",
    weight: 75,
  },
  {
    regex: /(?:helper|utility)\s+(?:function|method|hook)\s+(?:to|for)\s+/i,
    reason: "AI filler: 'Helper function to...'",
    weight: 75,
  },
  {
    regex: /(?:note(?:\s+that)?|important note|it(?:'s|\s+is)\s+worth\s+noting(?:\s+that)?):/i,
    reason: "AI conversational filler: 'Note that / It is worth noting...'",
    weight: 65,
  },
  {
    regex: /in order to\s+(?:ensure|make sure|handle|provide|allow|prevent)/i,
    reason: "AI padding phrase: 'In order to ensure/handle...'",
    weight: 65,
  },
  {
    regex: /ensure(?:s)?\s+that\s+(?:the|all|we|it)/i,
    reason: "AI padding phrase: 'Ensures that the...'",
    weight: 65,
  },
  {
    regex: /constructs\s+a\s+new\s+(?:instance\s+of)?/i,
    reason: "AI boilerplate constructor comment: 'Constructs a new instance of...'",
    weight: 75,
  },
  {
    regex: /callback\s+(?:function\s+)?(?:for|when|that)\s+handling/i,
    reason: "AI filler: 'Callback function for handling...'",
    weight: 65,
  },
  {
    regex: /safely\s+(?:handles|extracts|checks|returns|accesses|parses)/i,
    reason: "AI buzzword comment: 'Safely handles/extracts...'",
    weight: 60,
  },
  {
    regex: /fallback\s+to\s+(?:default|empty|null|undefined)/i,
    reason: "AI narration: 'Fallback to default/empty...'",
    weight: 60,
  },
  {
    regex: /step\s+\d+:\s+/i,
    reason: "AI step-by-step procedural narration: 'Step 1: ...'",
    weight: 75,
  },
  {
    regex: /we use\s+(?:useeffect|usememo|usecallback|usestate)\s+(?:here\s+)?because/i,
    reason: "AI lecturing on basic framework usage: 'We use useEffect here because...'",
    weight: 80,
  },
  {
    regex: /the purpose of this\s+(?:function|method|class|hook|component)\s+is to/i,
    reason: "AI essay-style commentary: 'The purpose of this function is to...'",
    weight: 80,
  },
];

const STRUCTURAL_NOISE_PATTERNS = [
  {
    regex: /^(?:\/\*+|\/\/)?\s*[-=_#~]{3,}\s*[a-zA-Z0-9_\s]+\s*[-=_#~]{3,}\s*(?:\*\/)?$/i,
    reason: "Section banner noise comment",
    weight: 85,
  },
  {
    regex: /^\/\/\s*(?:state(?:\s+variables|\s+hooks)?|component\s+state|local\s+state|hooks|effects|event\s+handlers|handlers|helper\s+functions|helpers|utilities|constants|types(?:\s+and\s+interfaces)?|interfaces|render(?:\s+method|\s+jsx)?|props|imports)\s*$/i,
    reason: "Redundant section label comment",
    weight: 80,
  },
];

const MICRO_NARRATION_PATTERNS = [
  {
    commentRegex: /^(?:if|check(?:s)? if|check whether)\s+([a-zA-Z0-9_$]+)/i,
    codeRegex: /^if\s*\(/i,
    reason: "Micro-narration: Narrating obvious 'if' condition",
    weight: 80,
  },
  {
    commentRegex: /^(?:loop|iterate|for each|loop through)\s+([a-zA-Z0-9_$]+)/i,
    codeRegex: /^(?:for\s*\(|\.forEach\(|\.map\()/i,
    reason: "Micro-narration: Narrating obvious loop / iteration",
    weight: 80,
  },
  {
    commentRegex: /^(?:return|returns|return the)\s+([a-zA-Z0-9_$]+)/i,
    codeRegex: /^return\b/i,
    reason: "Micro-narration: Narrating obvious return statement",
    weight: 85,
  },
  {
    commentRegex: /^(?:throw|throws|throw error)\b/i,
    codeRegex: /^throw\s+new\s+/i,
    reason: "Micro-narration: Narrating obvious throw statement",
    weight: 85,
  },
  {
    commentRegex: /^(?:try to|try)\b/i,
    codeRegex: /^try\s*\{/i,
    reason: "Micro-narration: Narrating obvious try block",
    weight: 85,
  },
  {
    commentRegex: /^(?:catch|handle error|catch error)\b/i,
    codeRegex: /^\}\s*catch\b/i,
    reason: "Micro-narration: Narrating obvious catch block",
    weight: 85,
  },
];

/**
 * Splits identifier into lower-case words (e.g. getUserById -> ["get", "user", "by", "id"]).
 */
export function splitIdentifier(identifier) {
  if (!identifier) return [];
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-]/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

/**
 * Tokenizes text into lowercase words excluding stop words.
 */
export function tokenizeMeaningful(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

export function isExempt(comment) {
  const text = comment.rawText;
  return EXEMPT_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Evaluates a single comment block for AI slop characteristics.
 */
export function evaluateComment(comment) {
  if (isExempt(comment)) {
    return null;
  }

  const cleanText = comment.cleanText.trim();
  const rawText = comment.rawText;
  const lineCount = comment.lineCount;
  const targetId = comment.targetIdentifier;
  const targetCodeLine = comment.targetCodeLine;

  const reasons = [];
  let score = 0;
  let category = null;

  // 1. Structural Noise Check
  for (const pattern of STRUCTURAL_NOISE_PATTERNS) {
    if (pattern.regex.test(rawText.trim()) || pattern.regex.test(cleanText)) {
      reasons.push(pattern.reason);
      score = Math.max(score, pattern.weight);
      category = "structural_noise";
    }
  }

  // 2. Micro-narration Check
  if (targetCodeLine) {
    for (const pattern of MICRO_NARRATION_PATTERNS) {
      if (pattern.commentRegex.test(cleanText) && pattern.codeRegex.test(targetCodeLine)) {
        reasons.push(pattern.reason);
        score = Math.max(score, pattern.weight);
        category = "micro_narration";
      }
    }
  }

  // 3. Tautological / Echo Comment Check
  if (targetId && cleanText.length > 0) {
    const isConstantOrType = targetCodeLine && /^(?:export\s+)?(?:const|type|interface|readonly\b|\w+\s*:\s*)/i.test(targetCodeLine.trim());
    const idWords = new Set(splitIdentifier(targetId));
    const commentWords = tokenizeMeaningful(cleanText);

    if (commentWords.length > 0 && commentWords.length <= 12) {
      const matchCount = commentWords.filter((w) => idWords.has(w)).length;
      const matchRatio = matchCount / commentWords.length;

      // Only flag tautology if it's an inline echo comment or high overlap on non-constant code
      if (!isConstantOrType && (matchRatio >= 0.75 || (comment.commentType === "inline" && matchRatio >= 0.6))) {
        const tautologyScore = Math.round(60 + matchRatio * 35);
        score = Math.max(score, tautologyScore);
        reasons.push(`Tautological echo: Comment repeats identifier '${targetId}' (${Math.round(matchRatio * 100)}% word overlap)`);
        if (!category || category === "micro_narration") category = "tautology";
      }
    }
  }

  // 4. AI Filler & Conversational Patterns Check
  let aiMarkerHits = 0;
  for (const pattern of AI_FILLER_PATTERNS) {
    if (pattern.regex.test(cleanText)) {
      aiMarkerHits += 1;
      score += pattern.weight;
      reasons.push(pattern.reason);
      if (!category) category = "ai_filler";
    }
  }

  // 5. Bloated / Redundant JSDoc Check
  if (comment.commentType === "jsdoc") {
    const jsDocScore = evaluateJsDocBloat(comment);
    if (jsDocScore.isBloated) {
      score = Math.max(score, jsDocScore.score);
      reasons.push(...jsDocScore.reasons);
      if (!category) category = "bloated_doc";
    }
  }

  // 6. Excessive Verbosity / Comment-to-Code Ratio
  if (lineCount >= 6 && (!comment.targetCodeBlock || comment.targetCodeBlock.length <= 3)) {
    if (aiMarkerHits > 0 || cleanText.length > 200) {
      score += 20;
      reasons.push(`High comment-to-code ratio (${lineCount} comment lines above brief declaration)`);
      if (!category) category = "excessive_length";
    }
  }

  score = Math.min(100, score);

  if (score >= 50) {
    let severity = "low";
    if (score >= 80) severity = "high";
    else if (score >= 65) severity = "medium";

    return {
      startLine: comment.startLine,
      endLine: comment.endLine,
      lineCount,
      commentType: comment.commentType,
      category: category ?? "ai_filler",
      severity,
      score,
      reasons,
      rawText: comment.rawText,
      cleanText: comment.cleanText,
      targetIdentifier: targetId,
      targetCodeLine: comment.targetCodeLine,
    };
  }

  return null;
}

function evaluateJsDocBloat(comment) {
  const text = comment.cleanText;
  const reasons = [];
  let score = 0;
  let isBloated = false;

  // Check for @param tag redundancy (e.g. @param id - The id)
  const paramMatches = [...text.matchAll(/@param\s+(?:\{[^}]+\}\s+)?([a-zA-Z0-9_$]+)\s*(?:-\s*)?([^\n\r*]*)/g)];
  if (paramMatches.length > 0) {
    let redundantParams = 0;
    for (const match of paramMatches) {
      const paramName = match[1];
      const paramDesc = match[2]?.trim();
      if (!paramDesc) continue;

      const descWords = tokenizeMeaningful(paramDesc);
      const nameWords = new Set(splitIdentifier(paramName));
      if (descWords.length <= 4 && descWords.every((w) => nameWords.has(w) || ["param", "parameter", "value", "object", "item"].includes(w))) {
        redundantParams += 1;
      }
    }
    if (redundantParams > 0 && redundantParams >= Math.ceil(paramMatches.length / 2)) {
      isBloated = true;
      score += 40;
      reasons.push(`Redundant @param descriptions (e.g. describing '${paramMatches[0][1]}' simply as '${paramMatches[0][2]?.trim()}')`);
    }
  }

  // Check for trivial @returns (e.g. @returns The result)
  const returnMatch = text.match(/@returns?\s+(?:\{[^}]+\}\s+)?(?:-\s*)?([^\n\r*]*)/);
  if (returnMatch) {
    const returnDesc = returnMatch[1]?.trim();
    if (returnDesc) {
      const descWords = tokenizeMeaningful(returnDesc);
      if (descWords.length <= 3 && descWords.every((w) => ["result", "value", "promise", "returns", "response", "data", "void"].includes(w))) {
        isBloated = true;
        score += 35;
        reasons.push(`Trivial @returns description ('${returnDesc}')`);
      }
    }
  }

  return { isBloated, score, reasons };
}

/**
 * Analyzes all comments in a file and returns aggregated slop findings.
 */
export function analyzeFileComments(comments) {
  const findings = [];
  for (const comment of comments) {
    const evaluation = evaluateComment(comment);
    if (evaluation) {
      findings.push(evaluation);
    }
  }
  return findings;
}
