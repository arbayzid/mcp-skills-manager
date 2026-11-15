/** One stretch of a Markdown document: a heading and the text under it, up to the next heading. */
export interface Section {
  /** The heading's text, without its `#` marks; empty for the text before the first heading. */
  heading: string;
  /** The text under the heading, trimmed. */
  text: string;
}

/** An ATX heading line; captures its text without the leading marks or a closing run of `#`. */
const HEADING_RE = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;

/** The line that opens or closes a fenced code block. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Splits a Markdown document at its headings.
 *
 * @param markdown - The document, frontmatter already removed.
 * @returns One section per heading, plus one for any text before the first; sections with neither a heading nor
 * text are dropped.
 *
 * @remarks
 * A `#` line inside a fenced code block is code, not a heading, so it does not split.
 */
export function splitSections(markdown: string): Section[] {
  const sections: Section[] = [];
  let heading = '';
  let lines: string[] = [];
  let fence: string | undefined;

  const flush = () => {
    const text = lines.join('\n').trim();
    if (heading.length > 0 || text.length > 0) {
      sections.push({ heading, text });
    }
  };

  for (const line of markdown.split(/\r?\n/)) {
    const fenceMark = line.match(FENCE_RE)?.[1];
    if (fenceMark !== undefined) {
      if (fence === undefined) {
        fence = fenceMark;
      } else if (fenceMark[0] === fence[0] && fenceMark.length >= fence.length) {
        fence = undefined;
      }
      lines.push(line);
      continue;
    }
    const headingText = fence === undefined ? line.match(HEADING_RE)?.[1] : undefined;
    if (headingText === undefined) {
      lines.push(line);
      continue;
    }
    flush();
    heading = headingText.trim();
    lines = [];
  }
  flush();
  return sections;
}
