/** Notes de version en Markdown simple (celui de docs/release-notes), en blocs à afficher.
 * Rien n'est interprété comme du HTML. */

export type Inline = { text: string; strong?: boolean; code?: boolean };

export type NoteBlock =
  | { kind: "heading"; inlines: Inline[] }
  | { kind: "paragraph"; inlines: Inline[] }
  | { kind: "list"; items: Inline[][] };

const HEADING = /^#{1,6}\s+(.+)$/;
const ITEM = /^\s{0,3}[-*+]\s+(.+)$/;
/** Gras, code, puis lien dont seul le texte reste. */
const INLINE = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\([^)]*\)/g;

export function parseInline(text: string): Inline[] {
  const inlines: Inline[] = [];
  let last = 0;
  const push = (inline: Inline) => {
    // Deux morceaux simples qui se suivent n'en font qu'un
    const previous = inlines[inlines.length - 1];
    if (previous && !previous.strong && !previous.code && !inline.strong && !inline.code) {
      previous.text += inline.text;
    } else if (inline.text) {
      inlines.push(inline);
    }
  };
  for (const match of text.matchAll(INLINE)) {
    push({ text: text.slice(last, match.index) });
    const [, strong, code, link] = match;
    if (strong !== undefined) push({ text: strong, strong: true });
    else if (code !== undefined) push({ text: code, code: true });
    else push({ text: link });
    last = match.index + match[0].length;
  }
  push({ text: text.slice(last) });
  return inlines;
}

export function parseNotes(markdown: string): NoteBlock[] {
  const blocks: NoteBlock[] = [];
  let paragraph: string[] | null = null;
  let items: string[][] | null = null;

  const flush = () => {
    if (paragraph) blocks.push({ kind: "paragraph", inlines: parseInline(paragraph.join(" ")) });
    if (items) {
      const list = items.map((lines) => parseInline(lines.join(" ")));
      const previous = blocks[blocks.length - 1];
      // Une ligne vide entre deux points ne coupe pas la liste
      if (previous?.kind === "list") previous.items.push(...list);
      else blocks.push({ kind: "list", items: list });
    }
    paragraph = null;
    items = null;
  };

  for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const heading = HEADING.exec(raw);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", inlines: parseInline(heading[1].trim()) });
      continue;
    }
    const item = ITEM.exec(raw);
    if (item) {
      if (paragraph) flush();
      items ??= [];
      items.push([item[1].trim()]);
      continue;
    }
    // La suite d'un point de liste, en retrait ou non, ou d'un paragraphe
    if (items) items[items.length - 1].push(line);
    else (paragraph ??= []).push(line);
  }
  flush();
  return blocks;
}
