/**
 * Five-field cron ("minute hour day-of-month month day-of-week") in the
 * server's local time. Supports `*`, lists, ranges, steps (`*\/15`, `1-5/2`)
 * and the usual aliases (@hourly, @daily, @weekly, @monthly). When both
 * day fields are restricted, a day matches either one (as classic cron).
 */

interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  daysRestricted: boolean;
  weekdaysRestricted: boolean;
}

const ALIASES: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
};

const MONTH_NAMES = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
];
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export class CronError extends Error {}

function parseField(
  text: string,
  min: number,
  max: number,
  names: string[] = [],
  nameOffset = 0,
): { values: Set<number>; restricted: boolean } {
  const values = new Set<number>();
  const value = (token: string): number => {
    const lower = token.toLowerCase();
    const named = names.indexOf(lower);
    if (named >= 0) return named + nameOffset;
    if (!/^\d+$/.test(token)) throw new CronError(`"${token}" is not a number`);
    return Number(token);
  };
  for (const part of text.split(',')) {
    const [range, stepText] = part.split('/');
    if (range === undefined || range === '') throw new CronError(`empty part in "${text}"`);
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new CronError(`bad step in "${part}"`);
    let from: number;
    let to: number;
    if (range === '*') {
      from = min;
      to = max;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-');
      from = value(a ?? '');
      to = value(b ?? '');
    } else {
      from = value(range);
      to = stepText === undefined ? from : max;
    }
    if (from < min || to > max || from > to) {
      throw new CronError(`"${part}" is outside ${min}-${max}`);
    }
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return { values, restricted: text !== '*' };
}

export function parseCron(expression: string): CronFields {
  const text = (ALIASES[expression.trim().toLowerCase()] ?? expression).trim();
  const parts = text.split(/\s+/);
  if (parts.length !== 5) {
    throw new CronError('a schedule has 5 fields: minute hour day month weekday ("0 3 * * *")');
  }
  const [mi, ho, dom, mo, dow] = parts as [string, string, string, string, string];
  const weekdays = parseField(dow, 0, 7, DAY_NAMES);
  // 7 is Sunday too.
  if (weekdays.values.has(7)) {
    weekdays.values.delete(7);
    weekdays.values.add(0);
  }
  const days = parseField(dom, 1, 31);
  return {
    minutes: parseField(mi, 0, 59).values,
    hours: parseField(ho, 0, 23).values,
    days: days.values,
    months: parseField(mo, 1, 12, MONTH_NAMES, 1).values,
    weekdays: weekdays.values,
    daysRestricted: days.restricted,
    weekdaysRestricted: weekdays.restricted,
  };
}

export function validateCron(expression: string): string | null {
  try {
    parseCron(expression);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

function dayMatches(fields: CronFields, date: Date): boolean {
  const dom = fields.days.has(date.getDate());
  const dow = fields.weekdays.has(date.getDay());
  if (fields.daysRestricted && fields.weekdaysRestricted) return dom || dow;
  if (fields.daysRestricted) return dom;
  if (fields.weekdaysRestricted) return dow;
  return true;
}

/** The first matching minute strictly after `after` (epoch ms), or null within ~5 years. */
export function nextCronTime(expression: string, after: number): number | null {
  const fields = parseCron(expression);
  const date = new Date(after);
  date.setSeconds(0, 0);
  date.setMinutes(date.getMinutes() + 1);
  const limit = after + 5 * 366 * 86_400_000;
  while (date.getTime() <= limit) {
    if (!fields.months.has(date.getMonth() + 1)) {
      date.setMonth(date.getMonth() + 1, 1);
      date.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(fields, date)) {
      date.setDate(date.getDate() + 1);
      date.setHours(0, 0, 0, 0);
      continue;
    }
    if (!fields.hours.has(date.getHours())) {
      date.setHours(date.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!fields.minutes.has(date.getMinutes())) {
      date.setMinutes(date.getMinutes() + 1, 0, 0);
      continue;
    }
    return date.getTime();
  }
  return null;
}

/** "Every day at 03:00" for the common shapes; the expression otherwise. */
export function describeCron(expression: string): string {
  const text = (ALIASES[expression.trim().toLowerCase()] ?? expression).trim();
  const [mi, ho, dom, mo, dow] = text.split(/\s+/);
  const pad = (v: string | undefined) => (v ?? '0').padStart(2, '0');
  if (/^\d+$/.test(mi ?? '') && /^\d+$/.test(ho ?? '') && mo === '*') {
    const at = `${pad(ho)}:${pad(mi)}`;
    if (dom === '*' && dow === '*') return `Every day at ${at}`;
    if (dom === '*' && /^\d$/.test(dow ?? '')) {
      const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      return `Every ${names[Number(dow) % 7]} at ${at}`;
    }
    if (/^\d+$/.test(dom ?? '') && dow === '*') return `Monthly on day ${dom} at ${at}`;
  }
  if (/^\d+$/.test(mi ?? '') && ho === '*' && dom === '*' && mo === '*' && dow === '*') {
    return `Every hour at :${pad(mi)}`;
  }
  return expression;
}
