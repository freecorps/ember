// Text edits over one source file. Every rewrite of the codemod is expressed as small, non-overlapping edits on the
// gaps around the nodes it keeps (`await ` removed, `Promise.all(` and `)` removed...), so rewrites of nested
// expressions compose without re-printing code: comments and formatting of everything else stay as they were.

export interface Edit {
  start: number;
  end: number;
  text: string;
  /** Insertion order, to keep several insertions at one position in the order they were made. */
  seq: number;
}

export class Edits {
  readonly list: Edit[] = [];
  private seq = 0;
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }

  replace(start: number, end: number, text: string): void {
    if (start > end || start < 0 || end > this.text.length) throw new Error(`bad edit range ${start}..${end}`);
    if (start === end && text === "") return;
    // The same edit twice (two passes reaching one node) is a no-op.
    if (this.list.some((e) => e.start === start && e.end === end && e.text === text && start !== end)) return;
    this.list.push({ start, end, text, seq: this.seq++ });
  }
  delete(start: number, end: number): void {
    this.replace(start, end, "");
  }
  insert(at: number, text: string): void {
    this.replace(at, at, text);
  }
  /** Whether [start, end) lies inside a range some edit replaces (the code there is gone). */
  consumed(start: number, end: number): boolean {
    return this.list.some((e) => e.end > e.start && e.start <= start && end <= e.end);
  }
  get size(): number {
    return this.list.length;
  }

  apply(): string {
    const sorted = [...this.list].sort((a, b) => a.start - b.start || a.end - b.end || a.seq - b.seq);
    for (let i = 1; i < sorted.length; i++) {
      const p = sorted[i - 1]!;
      const c = sorted[i]!;
      if (c.start < p.end) throw new Error(`overlapping edits at ${p.start}..${p.end} and ${c.start}..${c.end}`);
    }
    let out = "";
    let at = 0;
    for (const e of sorted) {
      out += this.text.slice(at, e.start) + e.text;
      at = e.end;
    }
    return out + this.text.slice(at);
  }
}

/** End of the whitespace run starting at `i` (spaces and tabs only, or newlines too with `lines`). */
export function skipSpace(text: string, i: number, lines = false): number {
  const re = lines ? /[ \t\r\n]/ : /[ \t]/;
  while (i < text.length && re.test(text[i]!)) i++;
  return i;
}
