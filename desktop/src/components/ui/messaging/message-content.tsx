"use client";

import { memo } from "react";
import { Streamdown, type StreamdownProps } from "streamdown";
import { safeEditorUrl } from "../editor/urls";
import styles from "./message-content.module.css";

const components: NonNullable<StreamdownProps["components"]> = {
  p: "p", strong: "strong", em: "em", del: "del", code: "code",
  pre: ({ children }) => <pre tabIndex={0} aria-label="Code block">{children}</pre>,
  ul: "ul", ol: "ol", li: "li", blockquote: "blockquote", hr: "hr",
  h1: "h1", h2: "h2", h3: "h3", h4: "h4", h5: "h5", h6: "h6",
  thead: "thead", tbody: "tbody", tr: "tr", th: "th", td: "td",
  table: ({ children }) => <div className={styles.tableScroll} tabIndex={0} role="region" aria-label="Message table"><table>{children}</table></div>,
  a: ({ href, children }) => href && safeEditorUrl(href)
    ? <a href={href} target={/^https?:/i.test(href) ? "_blank" : undefined} rel="noopener noreferrer">{children}</a>
    : <span>{children}</span>,
  img: ({ alt }) => <span>[Image{alt ? `: ${alt}` : ""}]</span>,
};
const rehypePlugins: NonNullable<StreamdownProps["rehypePlugins"]> = [];
const allowedElements = ["p", "strong", "em", "del", "code", "pre", "ul", "ol", "li", "blockquote",
  "hr", "h1", "h2", "h3", "h4", "h5", "h6", "table", "thead", "tbody", "tr", "th", "td", "a", "img", "br", "input", "sup"];
const urlTransform: NonNullable<StreamdownProps["urlTransform"]> = (url, key) =>
  key === "href" && safeEditorUrl(url) ? url : "";

export const MessageContent = memo(function MessageContent({ markdown, streaming = false }: { markdown: string; streaming?: boolean }) {
  return <Streamdown className={styles.content} components={components} controls={false} mode={streaming ? "streaming" : "static"}
    parseIncompleteMarkdown={streaming} isAnimating={streaming} skipHtml rehypePlugins={rehypePlugins}
    allowedElements={allowedElements} urlTransform={urlTransform}>
    {markdown}
  </Streamdown>;
});
