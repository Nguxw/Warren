import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkCjkFriendly from "remark-cjk-friendly";
import remarkGfm from "remark-gfm";
import { localLink } from "../model.ts";

/**
 * Text the model wrote, rendered as Markdown: GFM (tables, task lists, strikethrough), and
 * emphasis next to Chinese and Japanese punctuation (`**看点：**AI`), which plain CommonMark
 * leaves as asterisks.
 *
 * Model text is untrusted, so raw HTML is never rendered (react-markdown's default), web links
 * open outside the app, and only web images load. A relative link names a file of the task's
 * workspace and opens it in the interface with `onFile`.
 */
export const Markdown = memo(function Markdown(props: {
  children: string;
  /** `document` for a file preview; `inline` for messages and summaries. */
  variant?: "document" | "inline";
  /** Opens a workspace file a relative link points to. */
  onFile?: ((path: string) => void) | undefined;
  /** For links in a file: its folder in the workspace, which relative links start from. */
  base?: string;
}) {
  const { onFile, base } = props;
  const components: Components = {
    a: ({ href, children }) => {
      const local = href ? localLink(href, base) : undefined;
      if (local !== undefined) {
        return onFile ? (
          <button
            type="button"
            className="md-file-link"
            title={local}
            onClick={() => onFile(local)}
          >
            {children}
          </button>
        ) : (
          <span className="md-file-link static">{children}</span>
        );
      }
      return (
        <a href={href} target="_blank" rel="noreferrer">
          {children}
        </a>
      );
    },
    img: ({ src, alt }) =>
      typeof src === "string" && /^https?:\/\//.test(src) ? (
        <img src={src} alt={alt ?? ""} loading="lazy" />
      ) : (
        <span className="img-placeholder">{alt || src}</span>
      ),
  };
  return (
    <div className={`markdown ${props.variant === "document" ? "document" : "inline"}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkCjkFriendly]} components={components}>
        {props.children}
      </ReactMarkdown>
    </div>
  );
});
