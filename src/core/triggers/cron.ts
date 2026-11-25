// src/core/triggers/cron.ts
//
// A small five-field cron parser and next-run calculator.
//
//   minute hour day-of-month month day-of-week
//   0-59   0-23 1-31         1-12  0-7 (0 and 7 are Sunday)
//
// Each field accepts `*`, a number, a range `a-b`, a step `*/n` or `a-b/n`, and
// comma lists of those. Month and weekday names are accepted (jan..dec,
// sun..sat). The macros @hourly, @daily (@midnight), @weekly, @monthly and
// @yearly (@annually) are expanded. As in Vixie cron, when both day-of-month
// and day-of-week are restricted a day matches if EITHER matches.
//
// Times are evaluated in UTC or in the daemon's local time zone. In local time
// a wall-clock minute skipped by a DST change never fires, and one repeated by
// a DST change fires once (the next run is always strictly later).

export type CronZone = "UTC" | "local";

export interface CronSchedule {
  readonly source: string;
  readonly minute: ReadonlySet<number>;
  readonly hour: ReadonlySet<number>;
  readonly dom: ReadonlySet<number>;
  readonly month: ReadonlySet<number>;
  readonly dow: ReadonlySet<number>;
  /** True when the field was `*` (or `*` with a step covering every value). */
  readonly domAny: boolean;
  readonly dowAny: boolean;
}

export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronError";
  }
}

const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  names?: string[];
  /** Value the names start at (months: 1, days: 0). */
  nameBase?: number;
}

const FIELDS: FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS, nameBase: 1 },
  { name: "day of week", min: 0, max: 7, names: DAYS, nameBase: 0 },
];

function value(text: string, spec: FieldSpec): number {
  const lower = text.toLowerCase();
  if (spec.names) {
    const i = spec.names.indexOf(lower);
    if (i >= 0) return i + (spec.nameBase ?? 0);
  }
  if (!/^\d{1,2}$/.test(text)) throw new CronError(`${spec.name}: "${text}" is not a number`);
  const n = Number(text);
  if (n < spec.min || n > spec.max) {
    throw new CronError(`${spec.name}: ${n} is outside ${spec.min}-${spec.max}`);
  }
  return n;
}

function parseField(text: string, spec: FieldSpec): { values: Set<number>; any: boolean } {
  const values = new Set<number>();
  let any = false;
  for (const part of text.split(",")) {
    if (part === "") throw new CronError(`${spec.name}: empty list item`);
    const [range, stepText, extra] = part.split("/");
    if (extra !== undefined || range === undefined || range === "") {
      throw new CronError(`${spec.name}: "${part}" is not valid`);
    }
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d{1,2}$/.test(stepText) || Number(stepText) < 1) {
        throw new CronError(`${spec.name}: step "${stepText}" is not valid`);
      }
      step = Number(stepText);
    }
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = spec.min;
      hi = spec.max;
      if (step === 1) any = true;
    } else if (range.includes("-")) {
      const [a, b, more] = range.split("-");
      if (a === undefined || b === undefined || more !== undefined) {
        throw new CronError(`${spec.name}: range "${range}" is not valid`);
      }
      lo = value(a, spec);
      hi = value(b, spec);
      if (lo > hi) throw new CronError(`${spec.name}: range "${range}" runs backwards`);
    } else {
      lo = value(range, spec);
      // `5/15` means from 5 to the end in steps of 15.
      hi = stepText !== undefined ? spec.max : lo;
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return { values, any };
}

/** Parse a cron expression. Throws CronError with a message that names the bad field. */
export function parseCron(expr: string): CronSchedule {
  const trimmed = expr.trim();
  if (trimmed.length === 0 || trimmed.length > 200) throw new CronError("empty or too long");
  const expanded = MACROS[trimmed.toLowerCase()] ?? trimmed;
  if (expanded.startsWith("@")) throw new CronError(`unknown macro "${trimmed}"`);
  const parts = expanded.split(/\s+/);
  if (parts.length !== 5) {
    throw new CronError(`expected 5 fields (minute hour day month weekday), got ${parts.length}`);
  }
  const [minute, hour, dom, month, dow] = parts.map((p, i) =>
    parseField(p, FIELDS[i] as FieldSpec),
  );
  if (!minute || !hour || !dom || !month || !dow) throw new CronError("expected 5 fields");
  // 7 is Sunday too.
  if (dow.values.has(7)) {
    dow.values.delete(7);
    dow.values.add(0);
  }
  return {
    source: trimmed,
    minute: minute.values,
    hour: hour.values,
    dom: dom.values,
    month: month.values,
    dow: dow.values,
    domAny: dom.any,
    dowAny: dow.any,
  };
}

/** Wall-clock accessors in the chosen zone. */
function clock(zone: CronZone) {
  const utc = zone === "UTC";
  return {
    get: (d: Date) => ({
      year: utc ? d.getUTCFullYear() : d.getFullYear(),
      month: (utc ? d.getUTCMonth() : d.getMonth()) + 1,
      day: utc ? d.getUTCDate() : d.getDate(),
      dow: utc ? d.getUTCDay() : d.getDay(),
      hour: utc ? d.getUTCHours() : d.getHours(),
      minute: utc ? d.getUTCMinutes() : d.getMinutes(),
    }),
    make: (year: number, month: number, day: number, hour: number, minute: number) =>
      utc
        ? new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0))
        : new Date(year, month - 1, day, hour, minute, 0, 0),
  };
}

function dayMatches(s: CronSchedule, day: number, dow: number): boolean {
  const domOk = s.dom.has(day);
  const dowOk = s.dow.has(dow);
  if (s.domAny && s.dowAny) return true;
  if (s.domAny) return dowOk;
  if (s.dowAny) return domOk;
  return domOk || dowOk;
}

/** Nine years of days: Feb 29 recurs within 8 years, so any satisfiable expression is found. */
const MAX_DAYS = 366 * 9;

/**
 * The first time strictly after `after` that matches, at a whole minute, or
 * null when nothing matches within the search horizon (e.g. "0 0 31 2 *").
 */
export function nextRun(s: CronSchedule, after: Date, zone: CronZone = "UTC"): Date | null {
  const c = clock(zone);
  // Start at the next whole minute.
  const start = new Date(Math.floor(after.getTime() / 60_000) * 60_000 + 60_000);
  const t0 = c.get(start);
  const hours = [...s.hour].sort((a, b) => a - b);
  const minutes = [...s.minute].sort((a, b) => a - b);
  // Walk day by day from the start date; within a matching day pick the first
  // matching hour:minute that is not before `start`.
  for (let i = 0; i < MAX_DAYS; i++) {
    const dayStart = c.make(t0.year, t0.month, t0.day + i, 12, 0); // noon: safe from DST edges
    const d = c.get(dayStart);
    if (!s.month.has(d.month) || !dayMatches(s, d.day, d.dow)) continue;
    for (const h of hours) {
      for (const m of minutes) {
        const at = c.make(d.year, d.month, d.day, h, m);
        const got = c.get(at);
        // A local time that does not exist (DST gap) is normalised by Date to
        // another hour: skip it rather than fire at the wrong wall time.
        if (got.hour !== h || got.minute !== m || got.day !== d.day) continue;
        if (at.getTime() >= start.getTime()) return at;
      }
    }
  }
  return null;
}

/** Throws CronError when the expression is invalid or never fires. */
export function assertSchedulable(expr: string, zone: CronZone = "UTC"): CronSchedule {
  const s = parseCron(expr);
  if (!nextRun(s, new Date(), zone)) throw new CronError("the schedule never fires");
  return s;
}
