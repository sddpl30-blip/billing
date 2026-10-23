/**
 * A PDF writer, written out by hand.
 *
 * There is no PDF library here and no way to install one, so this emits the
 * file format directly: a catalog, a page tree, one content stream per page
 * and the three base-14 fonts a document like this needs. Every PDF reader has
 * those fonts built in, so nothing has to be embedded.
 *
 * It does what an invoice and a receipt need and no more — text at a position
 * in three faces and sizes, horizontal rules, filled boxes, right-aligned
 * figures and a table. It is not a layout engine.
 *
 * Two details that matter for the file being readable at all:
 *
 *  · The cross-reference table's offsets are byte offsets into the file, so
 *    everything is assembled as Buffers and measured in bytes. Measuring in
 *    JavaScript string length would be correct until the first non-ASCII
 *    character and then silently wrong.
 *  · Text is written in WinAnsiEncoding, so the rupee sign — which is not in
 *    it — would be a wrong glyph rather than an error. `money()` writes "INR"
 *    instead, which is what a tax invoice should carry anyway.
 */

const FONTS = {
  regular: { key: 'F1', base: 'Helvetica' },
  bold: { key: 'F2', base: 'Helvetica-Bold' },
  mono: { key: 'F3', base: 'Courier' },
} as const;

export type Face = keyof typeof FONTS;

/** Widths of the Helvetica glyphs, in thousandths of the font size. */
const HELVETICA_WIDTHS: Record<string, number> = {
  ' ': 278, '!': 278, '"': 355, '#': 556, '$': 556, '%': 889, '&': 667, "'": 191,
  '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
  '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556,
  '8': 556, '9': 556, ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556,
  '@': 1015, 'A': 667, 'B': 667, 'C': 722, 'D': 722, 'E': 667, 'F': 611, 'G': 778,
  'H': 722, 'I': 278, 'J': 500, 'K': 667, 'L': 556, 'M': 833, 'N': 722, 'O': 778,
  'P': 667, 'Q': 778, 'R': 722, 'S': 667, 'T': 611, 'U': 722, 'V': 667, 'W': 944,
  'X': 667, 'Y': 667, 'Z': 611, '[': 278, '\\': 278, ']': 278, '^': 469, '_': 556,
  '`': 333, 'a': 556, 'b': 556, 'c': 500, 'd': 556, 'e': 556, 'f': 278, 'g': 556,
  'h': 556, 'i': 222, 'j': 222, 'k': 500, 'l': 222, 'm': 833, 'n': 556, 'o': 556,
  'p': 556, 'q': 556, 'r': 333, 's': 500, 't': 278, 'u': 556, 'v': 500, 'w': 722,
  'x': 500, 'y': 500, 'z': 500, '{': 334, '|': 260, '}': 334, '~': 584,
};

/**
 * The width of a string at a size, in points.
 *
 * Approximate for bold (Helvetica-Bold is wider) and exact enough for right
 * alignment to look right. Courier is monospaced at 600/1000.
 */
export function textWidth(text: string, size: number, face: Face = 'regular'): number {
  if (face === 'mono') return (text.length * 600 * size) / 1000;
  const scale = face === 'bold' ? 1.06 : 1;
  let total = 0;
  for (const character of text) total += HELVETICA_WIDTHS[character] ?? 556;
  return (total * size * scale) / 1000;
}

/** Escapes a string for a PDF literal, and drops what WinAnsi cannot carry. */
function literal(text: string): string {
  let out = '';
  for (const character of text) {
    const code = character.codePointAt(0) ?? 63;
    if (character === '(' || character === ')' || character === '\\') out += `\\${character}`;
    else if (code < 32) out += ' ';
    else if (code < 127) out += character;
    // Beyond ASCII, only the few WinAnsi characters worth carrying.
    else if (character === ' ') out += ' ';
    else if (character === '’') out += "'";
    else if (character === '‘') out += "'";
    else if (character === '“' || character === '”') out += '"';
    else if (character === '—' || character === '–') out += '-';
    else if (character === '·') out += '-';
    else if (character === '₹') out += 'INR ';
    else out += '?';
  }
  return out;
}

export interface Page {
  readonly widthPt: number;
  readonly heightPt: number;
}

export const A4: Page = { widthPt: 595.28, heightPt: 841.89 };

/**
 * Builds one page of content.
 *
 * Coordinates are PDF points from the bottom left, which is the format's own
 * convention; `cursor` counts down from the top because that is how a document
 * is written.
 */
export class PdfPage {
  private readonly parts: string[] = [];
  private y: number;

  constructor(readonly size: Page = A4, readonly margin = 48) {
    this.y = size.heightPt - margin;
  }

  get cursor(): number { return this.y; }
  set cursor(value: number) { this.y = value; }

  down(points: number): this {
    this.y -= points;
    return this;
  }

  text(
    value: string,
    opts: { x?: number; y?: number; size?: number; face?: Face; grey?: number } = {},
  ): this {
    const size = opts.size ?? 10;
    const face = opts.face ?? 'regular';
    const x = opts.x ?? this.margin;
    const y = opts.y ?? this.y;
    const grey = opts.grey ?? 0;
    this.parts.push(
      `BT /${FONTS[face].key} ${size} Tf ${grey} g 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm ` +
      `(${literal(value)}) Tj ET`,
    );
    return this;
  }

  /** Right-aligned at `right`, which is what a column of money needs. */
  textRight(
    value: string,
    right: number,
    opts: { y?: number; size?: number; face?: Face; grey?: number } = {},
  ): this {
    const size = opts.size ?? 10;
    const face = opts.face ?? 'regular';
    return this.text(value, { ...opts, size, face, x: right - textWidth(value, size, face) });
  }

  line(x1: number, y1: number, x2: number, y2: number, grey = 0.75, width = 0.5): this {
    this.parts.push(
      `${grey} G ${width} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ` +
      `${x2.toFixed(2)} ${y2.toFixed(2)} l S`,
    );
    return this;
  }

  rule(grey = 0.8): this {
    return this.line(this.margin, this.y, this.size.widthPt - this.margin, this.y, grey);
  }

  box(x: number, y: number, width: number, height: number, grey = 0.94): this {
    this.parts.push(
      `${grey} g ${x.toFixed(2)} ${y.toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)} re f`,
    );
    return this;
  }

  content(): string {
    return this.parts.join('\n');
  }
}

/**
 * Assembles pages into a PDF file.
 *
 * Object numbering: 1 catalog, 2 pages, 3–5 fonts, then a content stream and a
 * page object per page.
 */
export function buildPdf(
  pages: readonly PdfPage[],
  meta: { title: string; author: string; subject?: string },
): Buffer {
  if (pages.length === 0) throw new Error('a PDF needs at least one page');

  const objects: string[] = [];
  const add = (body: string): number => {
    objects.push(body);
    return objects.length;
  };

  const catalogNumber = add('<< /Type /Catalog /Pages 2 0 R >>');
  const pagesNumber = add('');          // filled in once the page objects exist
  const fontNumbers: Record<Face, number> = {
    regular: add(`<< /Type /Font /Subtype /Type1 /BaseFont /${FONTS.regular.base} /Encoding /WinAnsiEncoding >>`),
    bold: add(`<< /Type /Font /Subtype /Type1 /BaseFont /${FONTS.bold.base} /Encoding /WinAnsiEncoding >>`),
    mono: add(`<< /Type /Font /Subtype /Type1 /BaseFont /${FONTS.mono.base} /Encoding /WinAnsiEncoding >>`),
  };

  const resources =
    `<< /Font << /${FONTS.regular.key} ${fontNumbers.regular} 0 R ` +
    `/${FONTS.bold.key} ${fontNumbers.bold} 0 R ` +
    `/${FONTS.mono.key} ${fontNumbers.mono} 0 R >> >>`;

  const pageNumbers: number[] = [];
  for (const page of pages) {
    const stream = page.content();
    const streamNumber = add(
      `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    );
    pageNumbers.push(add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.size.widthPt.toFixed(2)} ` +
      `${page.size.heightPt.toFixed(2)}] /Resources ${resources} /Contents ${streamNumber} 0 R >>`,
    ));
  }

  objects[pagesNumber - 1] =
    `<< /Type /Pages /Count ${pageNumbers.length} /Kids [` +
    `${pageNumbers.map(n => `${n} 0 R`).join(' ')}] >>`;

  const infoNumber = add(
    `<< /Title (${literal(meta.title)}) /Author (${literal(meta.author)})` +
    (meta.subject === undefined ? '' : ` /Subject (${literal(meta.subject)})`) +
    ` /Producer (SocietyBooks) >>`,
  );

  // Assembly, measuring byte offsets as it goes.
  const chunks: Buffer[] = [];
  let offset = 0;
  const push = (text: string): void => {
    const buffer = Buffer.from(text, 'latin1');
    chunks.push(buffer);
    offset += buffer.length;
  };

  push('%PDF-1.4\n');
  // A comment with high bytes, which tells tools the file is binary.
  push('%âãÏÓ\n');

  const offsets: number[] = [];
  for (const [index, body] of objects.entries()) {
    offsets.push(offset);
    push(`${index + 1} 0 obj\n${body}\nendobj\n`);
  }

  const xrefOffset = offset;
  push(`xref\n0 ${objects.length + 1}\n`);
  push('0000000000 65535 f \n');
  for (const entry of offsets) {
    push(`${String(entry).padStart(10, '0')} 00000 n \n`);
  }
  push(
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalogNumber} 0 R ` +
    `/Info ${infoNumber} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  );

  return Buffer.concat(chunks);
}

/** Paise as a figure with two decimals and thousands separators. */
export function money(paise: number): string {
  const negative = paise < 0;
  const absolute = Math.abs(paise);
  const rupees = Math.floor(absolute / 100);
  const fraction = String(absolute % 100).padStart(2, '0');
  // Indian grouping: the last three digits, then pairs.
  const digits = String(rupees);
  const head = digits.length > 3 ? digits.slice(0, digits.length - 3) : '';
  const tail = digits.slice(-3);
  const grouped = head === ''
    ? tail
    : `${head.replace(/\B(?=(\d\d)+(?!\d))/g, ',')},${tail}`;
  return `${negative ? '-' : ''}${grouped}.${fraction}`;
}
