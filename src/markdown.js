// Zero-dependency Markdown renderer for pagecast.
//
// Renders a solid common Markdown subset to a self-contained, security-hardened
// HTML document. Published pages are PUBLIC, so the renderer never passes raw
// HTML through from the source: every text/code run is escaped before emit, and
// link/image URLs are restricted to a safe scheme allowlist. The renderer is
// intentionally tolerant of malformed input — it degrades to paragraphs rather
// than throwing.

const ESCAPE_MAP = new Map([
  ["&", "&amp;"],
  ["<", "&lt;"],
  [">", "&gt;"]
]);

// Escape the three structural HTML characters in text/code content. Quotes are
// left alone here (only relevant inside attribute values; see escapeAttribute).
function escapeHtml(value) {
  return String(value).replace(/[&<>]/g, (char) => ESCAPE_MAP.get(char));
}

// Escape a value destined for a double-quoted attribute. Adds quote escaping on
// top of the structural characters so a crafted URL/alt text can't break out.
function escapeAttribute(value) {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

// Allow only schemes that are safe to navigate to from a public page. Relative
// paths, fragment links, and query-only links are permitted (no scheme); any
// other explicit scheme (javascript:, data:, vbscript:, file:, etc.) is dropped
// and neutralized to "#" so the markup stays well-formed but inert.
function sanitizeUrl(rawUrl) {
  const url = String(rawUrl || "").trim();
  if (url === "") {
    return "#";
  }

  // A leading scheme looks like `name:` at the very start. Control characters
  // (e.g. embedded tabs/newlines used to smuggle `java\nscript:`) are stripped
  // before the test so they can't hide a dangerous scheme.
  const stripped = url.replace(/[\x00-\x20]+/g, "");
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(stripped);
  if (!schemeMatch) {
    // No scheme → relative path, fragment, or query. Safe.
    return url;
  }

  const scheme = schemeMatch[1].toLowerCase();
  const ALLOWED = new Set(["http", "https", "mailto"]);
  if (ALLOWED.has(scheme)) {
    return url;
  }

  return "#";
}

// --- Inline rendering -------------------------------------------------------

// Renders inline markdown (emphasis, code, links, images) within an already
// block-classified line. Input text is treated as untrusted and escaped before
// any markup is woven in. Order matters: code spans are extracted first so their
// contents are not re-parsed for emphasis.
function renderInline(text) {
  // Build inline markup with a placeholder/token strategy: every piece of markup
  // WE generate (code spans, images, links) is stashed under an opaque token and
  // pulled out of the text stream. Whatever remains is, by definition, untrusted
  // author text and is escaped wholesale before any markup is restored. This is
  // what stops literal HTML typed in the source (for example a raw <img onerror>)
  // from ever reaching the output as live markup: it is not a token, so it gets
  // escaped like any other text. The NUL sentinel cannot occur in real source and
  // is left untouched by escapeHtml/applyEmphasis, so tokens survive those passes.
  const tokens = [];
  const stash = (html) => {
    const index = tokens.push(html) - 1;
    return `%%NUL%%T${index}%%NUL%%`;
  };

  // Inline code spans first; their literal contents must NOT be parsed for other
  // inline syntax.
  let working = String(text).replace(/`([^`]+)`/g, (match, code) =>
    stash(`<code>${escapeHtml(code)}</code>`)
  );

  // Images: ![alt](url) — must run before links so the leading ! is consumed.
  working = working.replace(/!\[([^\]]*)\]\(([^)\s]*)\)/g, (match, alt, url) =>
    stash(`<img src="${escapeAttribute(sanitizeUrl(url))}" alt="${escapeAttribute(alt)}">`)
  );

  // Links: [text](url)
  working = working.replace(/\[([^\]]*)\]\(([^)\s]*)\)/g, (match, label, url) =>
    stash(`<a href="${escapeAttribute(sanitizeUrl(url))}">${escapeInlineText(label)}</a>`)
  );

  // Everything left is untrusted text. Escape it, then apply emphasis. Any raw
  // HTML the author typed is escaped here and can never become markup.
  working = applyEmphasis(escapeHtml(working));

  // Restore the safe, pre-built markup. Loop so tokens nested inside other tokens
  // (for example an image used as a link label) resolve fully; bounded by the
  // token count since each token only references lower indices.
  for (let pass = 0; pass <= tokens.length && working.includes("%%NUL%%"); pass += 1) {
    working = working.replace(/%%NUL%%T(\d+)%%NUL%%/g, (match, index) => tokens[Number(index)] || "");
  }

  return working;
}

// Escape and emphasize plain inline label text (used for link labels, where the
// URL has already been pulled out).
function escapeInlineText(text) {
  return applyEmphasis(escapeHtml(text));
}

// Apply bold/italic to already-escaped text. Bold is matched before italic so
// `**x**` is not mis-parsed as nested italics.
function applyEmphasis(escaped) {
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/(^|[^\w])_([^_]+)_(?=[^\w]|$)/g, "$1<em>$2</em>");
}

// --- Block rendering --------------------------------------------------------

function isHorizontalRule(line) {
  const trimmed = line.trim();
  return /^(-{3,}|\*{3,}|_{3,})$/.test(trimmed);
}

function listItemMatch(line) {
  const unordered = /^(\s*)([-*+])\s+(.*)$/.exec(line);
  if (unordered) {
    return { indent: unordered[1].length, ordered: false, content: unordered[3] };
  }
  const ordered = /^(\s*)(\d+)\.\s+(.*)$/.exec(line);
  if (ordered) {
    return { indent: ordered[1].length, ordered: true, content: ordered[3] };
  }
  return null;
}

// Render a contiguous run of list-item lines into nested <ul>/<ol> markup.
// Nesting is driven purely by leading indentation; the implementation is
// deliberately simple and tolerant rather than CommonMark-exact.
function renderList(lines) {
  let index = 0;

  function build(minIndent) {
    const first = listItemMatch(lines[index]);
    const ordered = first.ordered;
    const tag = ordered ? "ol" : "ul";
    let html = `<${tag}>`;

    while (index < lines.length) {
      const match = listItemMatch(lines[index]);
      if (!match || match.indent < minIndent) {
        break;
      }
      if (match.indent > minIndent) {
        // Deeper indentation belongs to a nested list inside the previous item.
        // Reopen the last <li> by trimming the closing tag we just emitted.
        html = html.replace(/<\/li>$/, "");
        html += build(match.indent);
        html += "</li>";
        continue;
      }
      index += 1;
      html += `<li>${renderInline(match.content)}</li>`;
    }

    html += `</${tag}>`;
    return html;
  }

  return build(listItemMatch(lines[0]).indent);
}

// Render a paragraph block, honoring hard line breaks: a line ending in two or
// more spaces or a trailing backslash becomes a <br>.
function renderParagraph(lines) {
  const parts = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const hardBreak = /(\s{2,}|\\)$/.test(line);
    const content = renderInline(line.replace(/(\s+|\\)$/, ""));
    if (hardBreak && i < lines.length - 1) {
      parts.push(`${content}<br>`);
    } else {
      parts.push(content);
    }
  }
  return `<p>${parts.join("\n")}</p>`;
}

function renderBlockquote(lines) {
  // Strip a single leading `>` (and optional space) from each line, then render
  // the inner content as markdown blocks.
  const inner = lines.map((line) => line.replace(/^\s*>\s?/, "")).join("\n");
  return `<blockquote>${renderMarkdownBody(inner)}</blockquote>`;
}

/**
 * Render markdown source into the inner HTML body (no document wrapper).
 * Never throws on malformed input — unrecognized lines degrade to paragraphs.
 */
export function renderMarkdownBody(markdown) {
  let source;
  try {
    source = String(markdown == null ? "" : markdown).replace(/\r\n?/g, "\n");
  } catch {
    return "";
  }

  const lines = source.split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Blank line: skip.
    if (line.trim() === "") {
      i += 1;
      continue;
    }

    // Fenced code block: ```lang ... ```
    const fenceMatch = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(line);
    if (fenceMatch) {
      const fence = fenceMatch[2][0];
      const fenceLen = fenceMatch[2].length;
      const lang = fenceMatch[3].trim().split(/\s+/)[0] || "";
      const codeLines = [];
      i += 1;
      let closed = false;
      while (i < lines.length) {
        const closeMatch = new RegExp(`^\\s*${fence}{${fenceLen},}\\s*$`).test(lines[i]);
        if (closeMatch) {
          closed = true;
          i += 1;
          break;
        }
        codeLines.push(lines[i]);
        i += 1;
      }
      // (closed unused beyond loop control; an unterminated fence still renders
      // everything collected, degrading gracefully.)
      void closed;
      const langAttr = lang ? ` class="language-${escapeAttribute(lang)}"` : "";
      out.push(`<pre><code${langAttr}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      continue;
    }

    // Horizontal rule.
    if (isHorizontalRule(line)) {
      out.push("<hr>");
      i += 1;
      continue;
    }

    // ATX heading.
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2].replace(/\s+#+\s*$/, "");
      out.push(`<h${level}>${renderInline(text)}</h${level}>`);
      i += 1;
      continue;
    }

    // Blockquote: consecutive `>` lines.
    if (/^\s*>/.test(line)) {
      const quoteLines = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quoteLines.push(lines[i]);
        i += 1;
      }
      out.push(renderBlockquote(quoteLines));
      continue;
    }

    // List: consecutive list-item lines (tolerating nested indentation).
    if (listItemMatch(line)) {
      const listLines = [];
      while (i < lines.length && (listItemMatch(lines[i]) || /^\s+\S/.test(lines[i]))) {
        // Stop the list if we hit a blank line followed by a non-list line.
        if (lines[i].trim() === "") {
          break;
        }
        if (!listItemMatch(lines[i]) && listLines.length > 0) {
          // A plain indented continuation line: stop simply to keep behavior
          // predictable rather than attempting loose-list paragraph merging.
          break;
        }
        listLines.push(lines[i]);
        i += 1;
      }
      out.push(renderList(listLines));
      continue;
    }

    // Paragraph: gather until a blank line or a block-starting line.
    const paraLines = [];
    while (i < lines.length) {
      const current = lines[i];
      if (
        current.trim() === "" ||
        /^(#{1,6})\s+/.test(current) ||
        /^(\s*)(`{3,}|~{3,})/.test(current) ||
        isHorizontalRule(current) ||
        /^\s*>/.test(current) ||
        listItemMatch(current)
      ) {
        break;
      }
      paraLines.push(current);
      i += 1;
    }
    if (paraLines.length > 0) {
      out.push(renderParagraph(paraLines));
    }
  }

  return out.join("\n");
}

// Light, readable article CSS consistent with a clean publishing product.
const DOCUMENT_STYLE = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: #1a1a1a;
  background: #ffffff;
  line-height: 1.65;
  margin: 0;
  padding: 2.5rem 1.25rem 4rem;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
main {
  max-width: 720px;
  margin: 0 auto;
}
h1, h2, h3, h4, h5, h6 {
  line-height: 1.25;
  font-weight: 650;
  margin: 2rem 0 0.75rem;
  color: #0a0a0a;
}
h1 { font-size: 2rem; margin-top: 0; }
h2 { font-size: 1.5rem; }
h3 { font-size: 1.25rem; }
h4 { font-size: 1.05rem; }
h5, h6 { font-size: 1rem; }
p { margin: 0 0 1.1rem; }
a { color: #c9530a; text-decoration: underline; text-underline-offset: 2px; }
a:hover { color: #a8430a; }
strong { font-weight: 650; }
ul, ol { margin: 0 0 1.1rem; padding-left: 1.5rem; }
li { margin: 0.25rem 0; }
li > ul, li > ol { margin: 0.25rem 0; }
blockquote {
  margin: 1.25rem 0;
  padding: 0.25rem 1.1rem;
  border-left: 3px solid #d4d4d8;
  color: #52525b;
}
blockquote p:last-child { margin-bottom: 0; }
code {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 0.9em;
  background: #f4f4f5;
  padding: 0.15em 0.4em;
  border-radius: 4px;
}
pre {
  background: #f4f4f5;
  border: 1px solid #e4e4e7;
  border-radius: 8px;
  padding: 1rem 1.1rem;
  overflow-x: auto;
  margin: 0 0 1.25rem;
}
pre code {
  background: none;
  padding: 0;
  font-size: 0.875rem;
  line-height: 1.55;
}
hr {
  border: 0;
  border-top: 1px solid #e4e4e7;
  margin: 2rem 0;
}
img { max-width: 100%; height: auto; border-radius: 6px; }
table {
  border-collapse: collapse;
  width: 100%;
  margin: 0 0 1.25rem;
  font-size: 0.95rem;
}
th, td {
  border: 1px solid #e4e4e7;
  padding: 0.5rem 0.75rem;
  text-align: left;
}
th { background: #f4f4f5; font-weight: 650; }
`.trim();

/**
 * Render markdown source into a complete, self-contained HTML document string.
 * The optional `title` sets the <title> (it is escaped). Never throws.
 */
export function markdownToHtml(markdown, { title } = {}) {
  const safeTitle = escapeHtml(title == null || String(title).trim() === "" ? "Document" : String(title));
  const body = renderMarkdownBody(markdown);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; img-src * data:; style-src 'unsafe-inline'; font-src * data:; base-uri 'none'; form-action 'none'">
<title>${safeTitle}</title>
<style>
${DOCUMENT_STYLE}
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}
