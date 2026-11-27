import DOMPurify from 'dompurify';
import { Marked } from 'marked';

/** Removes a leading `---` front-matter block (and a BOM) from Markdown. */
export function stripFrontMatter(md: string): string {
  const BOM = String.fromCharCode(0xfeff);
  return (md.startsWith(BOM) ? md.slice(1) : md).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

// Own instance: the global `marked` (chat messages) keeps its defaults. GFM task items become a
// styled box: DOMPurify drops <input> elements.
const md = new Marked({
  gfm: true,
  renderer: {
    checkbox({ checked }) {
      return `<span class="oide-md-task${checked ? ' oide-md-task-done' : ''}" role="img" aria-label="${checked ? 'Done' : 'Not done'}"></span>`;
    },
  },
});

/**
 * Markdown documents (doc artifacts, Markdown files in the Files editor): GFM without front matter,
 * sanitised with DOMPurify. The result is safe for `innerHTML`; the CSP still blocks remote content.
 */
export function renderMarkdown(source: string): string {
  const html = md.parse(stripFrontMatter(source), { async: false }) as string;
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form', 'input', 'iframe'], FORBID_ATTR: ['style'] });
}
