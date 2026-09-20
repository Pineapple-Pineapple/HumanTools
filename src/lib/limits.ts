/**
 * What a scan could not see.
 *
 * Each limit carries two forms of the same admission: a short `label` the panel can show as a chip
 * without spending a paragraph on it, and the full `detail` sentence, which is the honest version
 * and is never dropped — it is what the chip says on hover. The label exists to get the disclosure
 * onto the screen at all; a list of five-line bullets at the bottom of a panel is a disclosure
 * nobody reads.
 */
export interface Limit {
  label: string;
  detail: string;
}

export function limit(label: string, detail: string): Limit {
  return { label, detail };
}
