import { visibleWidth } from "@earendil-works/pi-tui";

/** A soft-wrapped segment of the draft text. */
export interface WrappedLine {
  /** The segment text (at most `width` cells wide). */
  text: string;
  /** Which hard (newline-separated) line this segment belongs to. */
  hardLine: number;
  /** Absolute start offset of this segment in the draft string. */
  start: number;
  /** Absolute end offset (exclusive) of this segment in the draft string. */
  end: number;
  /** Whether this segment exactly filled the wrap width. */
  fullWidth: boolean;
}

/**
 * Soft-wrap each hard line of `text` to fit `width` visible cells.
 * Empty hard lines produce a single empty segment so visual line count
 * stays in sync with the newline-delimited source.
 */
export function wrapToWidth(text: string, width: number): WrappedLine[] {
  if (width <= 0) width = 1;
  const hardLines = text.split("\n");
  const result: WrappedLine[] = [];
  let hardOffset = 0;

  for (let hl = 0; hl < hardLines.length; hl++) {
    const line = hardLines[hl]!;
    if (line.length === 0) {
      result.push({ text: "", hardLine: hl, start: hardOffset, end: hardOffset, fullWidth: false });
    } else {
      let segment = "";
      let segmentWidth = 0;
      let segmentStart = 0;
      let i = 0;

      while (i < line.length) {
        const codePoint = line.codePointAt(i)!;
        const ch = String.fromCodePoint(codePoint);
        const step = ch.length;
        const chWidth = visibleWidth(ch);

        if (segment !== "" && segmentWidth + chWidth > width) {
          result.push({
            text: segment,
            hardLine: hl,
            start: hardOffset + segmentStart,
            end: hardOffset + i,
            fullWidth: segmentWidth >= width,
          });
          segment = "";
          segmentWidth = 0;
          segmentStart = i;
          continue;
        }

        segment += ch;
        segmentWidth += chWidth;
        i += step;
      }

      result.push({
        text: segment,
        hardLine: hl,
        start: hardOffset + segmentStart,
        end: hardOffset + line.length,
        fullWidth: segmentWidth >= width,
      });
    }

    hardOffset += line.length;
    if (hl < hardLines.length - 1) hardOffset += 1;
  }

  return result;
}
