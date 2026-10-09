/** Turns a stream of chunks into whole lines. Call flush() when the stream ends. */
export class LineSplitter {
  private rest = "";

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: string): void {
    const parts = (this.rest + chunk).split("\n");
    this.rest = parts.pop() ?? "";
    for (const p of parts) this.onLine(p.endsWith("\r") ? p.slice(0, -1) : p);
  }

  flush(): void {
    if (this.rest) this.onLine(this.rest);
    this.rest = "";
  }
}

/** Keeps roughly the last maxBytes of text, whole lines only. */
export class TailBuffer {
  private lines: string[] = [];
  private bytes = 0;
  private truncated = false;

  constructor(private readonly maxBytes: number) {}

  push(line: string): void {
    this.lines.push(line);
    this.bytes += Buffer.byteLength(line) + 1;
    // ponytail: Array.shift is O(n); swap for a ring buffer if logs ever reach millions of lines
    while (this.bytes > this.maxBytes && this.lines.length > 0) {
      this.bytes -= Buffer.byteLength(this.lines.shift() ?? "") + 1;
      this.truncated = true;
    }
  }

  toString(): string {
    const body = this.lines.join("\n");
    return this.truncated ? `[truncated]\n${body}` : body;
  }
}
