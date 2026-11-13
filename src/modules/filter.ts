/**
 * Temporary visibility filter for board nodes.
 *
 * A filter is pure view state: it hides nodes without touching their
 * positions, region membership, or the persisted layout. Clearing the
 * filter restores the board exactly as it was.
 *
 * Query syntax (case-insensitive, terms are AND-ed):
 * - bare words match title, subtitle (creator/year), and badge (item type)
 * - `title:word`, `author:word`, `type:journalArticle` restrict the field
 * - `kind:item|note|collection` restricts the node kind
 * - date terms: `added:>2024-01-01`, `read:<30d`, `modified:>=2023`,
 *   `added:never`, `read:any` (field aliases: created/modified/edited/read)
 * - quote multi-word values: `title:"deep learning"`
 *
 * This module is intentionally free of Zotero globals so it can be unit
 * tested and reused by a future 3D renderer.
 */

import type { NodeKind, SceneNode } from "./scene";

/** Filterable date fields, stored as epoch milliseconds on nodes. */
export type DateField = "added" | "modified" | "read";

interface DateTerm {
  type: "date";
  field: DateField;
  op: "<" | ">" | "<=" | ">=";
  /** Epoch ms; NaN for `never` / `any` terms. */
  value: number;
  mode: "compare" | "never" | "any";
}

interface TextTerm {
  type: "text";
  field: "title" | "author" | "type" | "any";
  text: string;
}

interface KindTerm {
  type: "kind";
  kind: NodeKind;
}

type Term = DateTerm | TextTerm | KindTerm;

export interface NodeFilter {
  /** Original query text, kept for the toolbar input. */
  raw: string;
  terms: Term[];
  /** True when the query hides at least the possibility of nodes. */
  active: boolean;
}

export const EMPTY_FILTER: NodeFilter = { raw: "", terms: [], active: false };

const DAY_MS = 24 * 60 * 60 * 1000;

const DATE_ALIASES: Record<string, DateField> = {
  added: "added",
  created: "added",
  dateadded: "added",
  modified: "modified",
  edited: "modified",
  updated: "modified",
  datemodified: "modified",
  read: "read",
  lastread: "read",
};

const TEXT_ALIASES: Record<string, TextTerm["field"]> = {
  title: "title",
  author: "author",
  creator: "author",
  type: "type",
};

const KIND_ALIASES: Record<string, NodeKind> = {
  item: "item",
  items: "item",
  paper: "item",
  papers: "item",
  note: "note",
  notes: "note",
  collection: "collection",
  collections: "collection",
  folder: "collection",
  folders: "collection",
};

/**
 * Parse a query into a filter. Unknown `field:value` terms fall back to a
 * substring match on the whole token so typing never dead-ends.
 */
export function parseFilter(query: string): NodeFilter {
  const raw = query.trim();
  if (!raw) {
    return EMPTY_FILTER;
  }
  const terms: Term[] = [];
  for (const token of tokenize(raw)) {
    const term = parseToken(token);
    if (term) {
      terms.push(term);
    }
  }
  return { raw, terms, active: terms.length > 0 };
}

/** Split on whitespace, honoring double quotes. */
function tokenize(query: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quoted = false;
  for (const ch of query) {
    if (ch === '"') {
      quoted = !quoted;
    } else if (!quoted && /\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function parseToken(token: string): Term | null {
  const colon = token.indexOf(":");
  if (colon > 0) {
    const field = token.slice(0, colon).toLowerCase();
    const value = token.slice(colon + 1);
    if (value) {
      if (field === "kind" || field === "is") {
        const kind = KIND_ALIASES[value.toLowerCase()];
        if (kind) {
          return { type: "kind", kind };
        }
      }
      if (DATE_ALIASES[field]) {
        const dateTerm = parseDateTerm(DATE_ALIASES[field], value);
        if (dateTerm) {
          return dateTerm;
        }
      }
      if (TEXT_ALIASES[field]) {
        return {
          type: "text",
          field: TEXT_ALIASES[field],
          text: value.toLowerCase(),
        };
      }
    }
    // Unknown field or unparseable value: literal substring match.
  }
  return { type: "text", field: "any", text: token.toLowerCase() };
}

function parseDateTerm(field: DateField, value: string): DateTerm | null {
  const lower = value.toLowerCase();
  if (lower === "never" || lower === "none") {
    return { type: "date", field, op: ">=", value: NaN, mode: "never" };
  }
  if (lower === "any" || lower === "ever") {
    return { type: "date", field, op: ">=", value: NaN, mode: "any" };
  }
  const match = lower.match(/^(<=|>=|<|>|=)?(.+)$/);
  if (!match) {
    return null;
  }
  const op = (match[1] === "=" ? ">=" : match[1] || ">=") as DateTerm["op"];
  const bound = parseDateBound(match[2]);
  if (bound === null) {
    return null;
  }
  return { type: "date", field, op, value: bound, mode: "compare" };
}

/**
 * Parse a date bound to epoch ms: relative (`7d`, `2w`, `3m`, `1y`,
 * `today`, `now`), or absolute (`2024`, `2024-05`, `2024-05-01`).
 * Relative bounds mean "that long ago"; absolute bounds are local time.
 */
export function parseDateBound(text: string, now = Date.now()): number | null {
  if (text === "now") {
    return now;
  }
  if (text === "today") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  const rel = text.match(/^(\d+(?:\.\d+)?)(d|w|m|y)$/);
  if (rel) {
    const amount = parseFloat(rel[1]);
    const unitMs =
      rel[2] === "d"
        ? DAY_MS
        : rel[2] === "w"
          ? 7 * DAY_MS
          : rel[2] === "m"
            ? 30 * DAY_MS
            : 365 * DAY_MS;
    return now - amount * unitMs;
  }
  const abs = text.match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/);
  if (abs) {
    const year = parseInt(abs[1], 10);
    const month = abs[2] ? parseInt(abs[2], 10) - 1 : 0;
    const day = abs[3] ? parseInt(abs[3], 10) : 1;
    if (month > 11 || day > 31) {
      return null;
    }
    return new Date(year, month, day).getTime();
  }
  return null;
}

/** True when the node passes every term of the filter. */
export function nodeMatchesFilter(
  node: SceneNode,
  filter: NodeFilter,
): boolean {
  if (!filter.active) {
    return true;
  }
  for (const term of filter.terms) {
    if (!termMatches(node, term)) {
      return false;
    }
  }
  return true;
}

function termMatches(node: SceneNode, term: Term): boolean {
  switch (term.type) {
    case "kind":
      return node.kind === term.kind;
    case "text": {
      const title = node.title.toLowerCase();
      const subtitle = (node.subtitle ?? "").toLowerCase();
      const badge = (node.badge ?? "").toLowerCase();
      switch (term.field) {
        case "title":
          return title.includes(term.text);
        case "author":
          return subtitle.includes(term.text);
        case "type":
          return badge.includes(term.text);
        case "any":
          return (
            title.includes(term.text) ||
            subtitle.includes(term.text) ||
            badge.includes(term.text)
          );
      }
      return false;
    }
    case "date": {
      const value = nodeDate(node, term.field);
      if (term.mode === "never") {
        return value === undefined;
      }
      if (term.mode === "any") {
        return value !== undefined;
      }
      if (value === undefined) {
        return false;
      }
      switch (term.op) {
        case "<":
          return value < term.value;
        case ">":
          return value > term.value;
        case "<=":
          return value <= term.value;
        case ">=":
          return value >= term.value;
      }
      return false;
    }
  }
}

function nodeDate(node: SceneNode, field: DateField): number | undefined {
  switch (field) {
    case "added":
      return node.added;
    case "modified":
      return node.modified;
    case "read":
      return node.read;
  }
}

/**
 * Whether a region's own name matches the query. Regions carry no dates,
 * so date terms cannot match them directly.
 */
export function regionNameMatchesFilter(
  region: SceneNode,
  filter: NodeFilter,
): boolean {
  if (!filter.active) {
    return true;
  }
  const hasDateTerm = filter.terms.some((t) => t.type === "date");
  return !hasDateTerm && nodeMatchesFilter(region, filter);
}
