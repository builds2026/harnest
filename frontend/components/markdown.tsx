import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import styles from "./markdown.module.css";

export const safeMarkdownHref = (href: string) => /^(?:https?:\/\/|mailto:|\/|#)/i.test(href.trim())
  ? defaultUrlTransform(href.trim()) || undefined
  : undefined;

export function Markdown({ children, className = "" }: { children: string; className?: string }) {
  return <div className={`${styles.markdown} ${className}`.trim()}>
    <ReactMarkdown
      skipHtml
      urlTransform={(url) => safeMarkdownHref(url) ?? ""}
      components={{
        a: ({ children, href, title }) => <a
          href={href}
          target={href?.startsWith("http") ? "_blank" : undefined}
          rel={href?.startsWith("http") ? "noreferrer" : undefined}
          title={title}
        >{children}</a>,
      }}
    >{children}</ReactMarkdown>
  </div>;
}
