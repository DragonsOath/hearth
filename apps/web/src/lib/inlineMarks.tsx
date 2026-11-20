import { Fragment, type ReactNode } from "react";

/**
 * The little formatting AI answers use: **bold** and `code`. Everything else stays plain text
 * (React escapes it), so nothing in an answer can become markup.
 */
export function inlineMarks(text: string): ReactNode[] {
  return text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g).map((p, i) => {
    if (/^\*\*[^*\n]+\*\*$/.test(p))
      return (
        <strong key={i} className="font-semibold">
          {p.slice(2, -2)}
        </strong>
      );
    if (/^`[^`\n]+`$/.test(p))
      return (
        <code key={i} className="rounded bg-raised px-1 text-[0.88em]">
          {p.slice(1, -1)}
        </code>
      );
    return <Fragment key={i}>{p}</Fragment>;
  });
}
