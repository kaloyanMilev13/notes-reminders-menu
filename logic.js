// Pure logic for the Notes & Reminders extension: parsing, repeating, formatting.
// No GNOME APIs are used here, so it can be tested with plain Node.
//
// Input syntax (everything is optional and goes at the START of the text):
//   +10m text / +2h / +3d / +1w         in 10 minutes / 2 hours / 3 days / 1 week
//   in 10 minutes text / in 2 days text same, in words
//   14:30 text / 2:30pm / 9am text      next time that clock time happens
//   today 18:00 / tomorrow 9am text     today or tomorrow (9:00 if no time is given)
//   mon 9:00 text / on friday text      next Monday / Friday (bare weekday needs a time)
//   2026-12-25 10:00 text               exact date (YYYY-MM-DD)
//   25/12 10:00 / 25/12/2026 text       day/month[/year]; without a year it needs a time
//   dec 25 10:00 / 25 december 2026     month names
//   daily 8:00 text / weekly / monthly / yearly / hourly / weekdays
//   every day / every 2 weeks / every 3h / every mon 9:00 / every other day
// Start with a backslash to force a plain note:  \tomorrow is a word here

const MINUTE_MS = 60 * 1000;
const DEFAULT_TIME = {h: 9, mi: 0};

const UNIT_ALIASES = new Map(Object.entries({
    m: 'minutes', min: 'minutes', mins: 'minutes', minute: 'minutes', minutes: 'minutes',
    h: 'hours', hr: 'hours', hrs: 'hours', hour: 'hours', hours: 'hours',
    d: 'days', day: 'days', days: 'days',
    w: 'weeks', wk: 'weeks', wks: 'weeks', week: 'weeks', weeks: 'weeks',
    mo: 'months', mos: 'months', month: 'months', months: 'months',
    y: 'years', yr: 'years', yrs: 'years', year: 'years', years: 'years',
}));
const SINGULAR = new Map(Object.entries({
    minutes: 'minute', hours: 'hour', days: 'day', weeks: 'week', months: 'month', years: 'year',
}));
const REPEAT_UNITS = new Set([...SINGULAR.keys(), 'weekdays']);

const MONTHS = new Map(Object.entries({
    jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
    may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
    sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10,
    dec: 11, december: 11,
}));
const WEEKDAYS = new Map(Object.entries({
    sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2,
    wed: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4,
    fri: 5, friday: 5, sat: 6, saturday: 6,
}));
const REPEAT_WORDS = new Map(Object.entries({
    hourly: {every: 1, unit: 'hours'},
    daily: {every: 1, unit: 'days'},
    weekly: {every: 1, unit: 'weeks'},
    monthly: {every: 1, unit: 'months'},
    yearly: {every: 1, unit: 'years'},
    annually: {every: 1, unit: 'years'},
    weekdays: {every: 1, unit: 'weekdays'},
}));

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ---------- small helpers ----------

function pad(n) {
    return String(n).padStart(2, '0');
}

function startOfDay(ts) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

function daysInMonth(year, month) {
    return new Date(year, month + 1, 0).getDate();
}

function atTime(ts, time) {
    const d = new Date(ts);
    d.setHours(time.h, time.mi, 0, 0);
    return d.getTime();
}

function isWeekend(ts) {
    const day = new Date(ts).getDay();
    return day === 0 || day === 6;
}

// Calendar-aware addition: days keep the wall-clock time across DST changes,
// months clamp to the end of the month (31 Jan + 1 month = 28/29 Feb).
function addUnits(ts, n, unit) {
    const d = new Date(ts);
    switch (unit) {
    case 'minutes':
        return ts + n * MINUTE_MS;
    case 'hours':
        return ts + n * 60 * MINUTE_MS;
    case 'days':
        d.setDate(d.getDate() + n);
        return d.getTime();
    case 'weeks':
        d.setDate(d.getDate() + 7 * n);
        return d.getTime();
    case 'months':
    case 'years': {
        const months = unit === 'years' ? 12 * n : n;
        const day = d.getDate();
        d.setDate(1);
        d.setMonth(d.getMonth() + months);
        d.setDate(Math.min(day, daysInMonth(d.getFullYear(), d.getMonth())));
        return d.getTime();
    }
    default:
        return ts;
    }
}

function normalizeRepeat(repeat) {
    if (!repeat || typeof repeat !== 'object')
        return null;
    const unit = repeat.unit;
    const every = Number(repeat.every);
    if (typeof unit !== 'string' || !REPEAT_UNITS.has(unit))
        return null;
    if (!Number.isInteger(every) || every < 1 || every > 9999)
        return null;
    return {every: unit === 'weekdays' ? 1 : every, unit};
}

function sameRepeat(a, b) {
    return !!a && !!b && a.every === b.every && a.unit === b.unit;
}

// ---------- token recognisers ----------
// Each one looks at tokens[i...] and returns null (not mine) or a description with `len`
// (how many tokens it used). `invalid: true` means "looks like a time but isn't a valid one".

function isAmPm(token) {
    return !!token && (token.lower === 'am' || token.lower === 'pm');
}

function tryTime(tokens, i) {
    const t = tokens[i];
    if (!t)
        return null;
    let h;
    let mi = 0;
    let ap = null;
    let len = 1;
    let m = t.lower.match(/^(\d{1,2}):(\d{2})(am|pm)?$/);
    if (m) {
        h = Number(m[1]);
        mi = Number(m[2]);
        ap = m[3] ?? null;
        if (!ap && isAmPm(tokens[i + 1])) {
            ap = tokens[i + 1].lower;
            len = 2;
        }
    } else if ((m = t.lower.match(/^(\d{1,2})(am|pm)$/))) {
        h = Number(m[1]);
        ap = m[2];
    } else if ((m = t.lower.match(/^(\d{1,2})$/)) && isAmPm(tokens[i + 1])) {
        h = Number(m[1]);
        ap = tokens[i + 1].lower;
        len = 2;
    } else {
        return null;
    }

    if (mi > 59)
        return {invalid: true, word: t.word};
    if (ap) {
        if (h < 1 || h > 12)
            return {invalid: true, word: t.word};
        h = (h % 12) + (ap === 'pm' ? 12 : 0);
    } else if (h > 23) {
        return {invalid: true, word: t.word};
    }
    return {len, h, mi};
}

function tryYearToken(token) {
    if (token && /^\d{4}$/.test(token.lower)) {
        const y = Number(token.lower);
        if (y >= 2000 && y <= 2199)
            return y;
    }
    return null;
}

function tryDate(tokens, i, explicit) {
    const t = tokens[i];
    if (!t)
        return null;
    const w = t.lower;

    if (w === 'today')
        return {len: 1, kind: 'today'};
    if (w === 'tomorrow' || w === 'tmrw')
        return {len: 1, kind: 'tomorrow'};
    if (WEEKDAYS.has(w))
        return {len: 1, kind: 'weekday', weekday: WEEKDAYS.get(w), bare: !explicit};

    let m = w.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) {
        return {
            len: 1, kind: 'ymd', y: Number(m[1]), month: Number(m[2]) - 1, day: Number(m[3]),
            hasYear: true, ambiguous: false,
        };
    }

    // day first: 25/12, 25-12-2026, 25.12.26. Without a year it is ambiguous (could be "1/2 cup").
    m = w.match(/^(\d{1,2})([/.-])(\d{1,2})(?:\2(\d{2}|\d{4}))?$/);
    if (m) {
        const hasYear = m[4] !== undefined;
        let y = null;
        if (hasYear)
            y = m[4].length === 2 ? 2000 + Number(m[4]) : Number(m[4]);
        return {
            len: 1, kind: 'ymd', y, month: Number(m[3]) - 1, day: Number(m[1]),
            hasYear, ambiguous: !hasYear,
        };
    }

    // "dec 25 [2026]"
    if (MONTHS.has(w) && tokens[i + 1]) {
        const dm = tokens[i + 1].lower.match(/^(\d{1,2})(?:st|nd|rd|th)?$/);
        if (dm) {
            const y = tryYearToken(tokens[i + 2]);
            return {
                len: y !== null ? 3 : 2, kind: 'ymd', y, month: MONTHS.get(w), day: Number(dm[1]),
                hasYear: y !== null, ambiguous: false,
            };
        }
    }

    // "25 dec [2026]"
    m = w.match(/^(\d{1,2})(?:st|nd|rd|th)?$/);
    if (m && tokens[i + 1] && MONTHS.has(tokens[i + 1].lower)) {
        const y = tryYearToken(tokens[i + 2]);
        return {
            len: y !== null ? 3 : 2, kind: 'ymd', y, month: MONTHS.get(tokens[i + 1].lower),
            day: Number(m[1]), hasYear: y !== null, ambiguous: false,
        };
    }

    return null;
}

function tryRelative(tokens, i) {
    const t = tokens[i];
    if (!t)
        return null;
    let m;

    if (t.lower === 'in' && tokens[i + 1]) {
        if ((m = tokens[i + 1].lower.match(/^(\d+)([a-z]+)$/)) && UNIT_ALIASES.has(m[2]))
            return makeRel(2, m[1], UNIT_ALIASES.get(m[2]));
        if (/^\d+$/.test(tokens[i + 1].lower) && tokens[i + 2] && UNIT_ALIASES.has(tokens[i + 2].lower))
            return makeRel(3, tokens[i + 1].lower, UNIT_ALIASES.get(tokens[i + 2].lower));
        return null;
    }

    if ((m = t.lower.match(/^\+(\d+)([a-z]+)$/)) && UNIT_ALIASES.has(m[2]))
        return makeRel(1, m[1], UNIT_ALIASES.get(m[2]));
    if ((m = t.lower.match(/^\+(\d+)$/)) && tokens[i + 1] && UNIT_ALIASES.has(tokens[i + 1].lower))
        return makeRel(2, m[1], UNIT_ALIASES.get(tokens[i + 1].lower));
    return null;
}

function makeRel(len, digits, unit) {
    const n = Number(digits);
    if (!Number.isInteger(n) || n < 1 || n > 100000)
        return null;
    return {len, n, unit};
}

function makeRepeat(every, unit) {
    const n = Number(every);
    if (!Number.isInteger(n) || n < 1 || n > 9999)
        return null;
    return {every: n, unit};
}

// Returns {len, repeat, weekday?} or null.
function tryRepeat(tokens, i, dateAlreadySet) {
    const t = tokens[i];
    if (!t)
        return null;

    if (REPEAT_WORDS.has(t.lower))
        return {len: 1, repeat: {...REPEAT_WORDS.get(t.lower)}};

    if (t.lower !== 'every')
        return null;
    const a = tokens[i + 1];
    const b = tokens[i + 2];
    if (!a)
        return null;

    if (a.lower === 'other' && b && UNIT_ALIASES.has(b.lower)) {
        const r = makeRepeat(2, UNIT_ALIASES.get(b.lower));
        return r ? {len: 3, repeat: r} : null;
    }
    if (WEEKDAYS.has(a.lower)) {
        if (dateAlreadySet)
            return null;
        return {len: 2, repeat: {every: 1, unit: 'weeks'}, weekday: WEEKDAYS.get(a.lower)};
    }
    if (a.lower === 'weekday' || a.lower === 'weekdays')
        return {len: 2, repeat: {every: 1, unit: 'weekdays'}};
    if (/^\d+$/.test(a.lower) && b && UNIT_ALIASES.has(b.lower)) {
        const r = makeRepeat(a.lower, UNIT_ALIASES.get(b.lower));
        return r ? {len: 3, repeat: r} : null;
    }
    const m = a.lower.match(/^(\d+)([a-z]+)$/);
    if (m && UNIT_ALIASES.has(m[2])) {
        const r = makeRepeat(m[1], UNIT_ALIASES.get(m[2]));
        return r ? {len: 2, repeat: r} : null;
    }
    if (UNIT_ALIASES.has(a.lower))
        return {len: 2, repeat: {every: 1, unit: UNIT_ALIASES.get(a.lower)}};
    return null;
}

// ---------- parsing ----------

// Returns one of:
//   {type: 'empty'}
//   {type: 'error', message}
//   {type: 'note', text}
//   {type: 'reminder', text, due, repeat}   (repeat is null or {every, unit})
export function parseInput(raw, now = Date.now(), options = {}) {
    const allowPast = !!options.allowPast;
    const input = String(raw ?? '').trim();
    if (!input)
        return {type: 'empty'};

    const tokens = [];
    const re = /\S+/g;
    let match;
    while ((match = re.exec(input)) !== null)
        tokens.push({word: match[0], lower: match[0].toLowerCase(), index: match.index});

    const spec = {date: null, time: null, rel: null, repeat: null, exclusive: false};
    let i = 0;
    let consumed = false;
    let escaped = false;

    while (i < tokens.length) {
        if (tokens[i].word.startsWith('\\')) {
            escaped = true;
            break;
        }

        // "at 9:00"
        if (tokens[i].lower === 'at' && !spec.time && !spec.exclusive) {
            const peek = tryTime(tokens, i + 1);
            if (peek && !peek.invalid) {
                i += 1;
                consumed = true;
                continue;
            }
        }

        // "on friday", "next friday", "on 25 dec"
        if ((tokens[i].lower === 'on' || tokens[i].lower === 'next') && !spec.date && !spec.exclusive && !spec.rel) {
            const peek = tryDate(tokens, i + 1, true);
            if (peek) {
                const d = peek;
                i += 1 + d.len;
                spec.date = d;
                consumed = true;
                continue;
            }
        }

        if (!spec.repeat) {
            const r = tryRepeat(tokens, i, !!spec.date);
            if (r) {
                spec.repeat = r.repeat;
                if (r.weekday !== undefined)
                    spec.date = {kind: 'weekday', weekday: r.weekday, bare: false};
                i += r.len;
                consumed = true;
                continue;
            }
        }

        if (!spec.time && !spec.exclusive) {
            const tm = tryTime(tokens, i);
            if (tm) {
                if (tm.invalid) {
                    return {
                        type: 'error',
                        message: `"${tm.word}" is not a valid time. Use 14:30 or 2:30pm.`,
                    };
                }
                spec.time = {h: tm.h, mi: tm.mi};
                i += tm.len;
                consumed = true;
                continue;
            }
        }

        if (!spec.date && !spec.rel && !spec.exclusive) {
            const d = tryDate(tokens, i, false);
            if (d) {
                spec.date = d;
                i += d.len;
                consumed = true;
                continue;
            }
        }

        if (!spec.rel && !spec.date && !spec.exclusive) {
            const r = tryRelative(tokens, i);
            if (r) {
                const short = r.unit === 'minutes' || r.unit === 'hours';
                // "+10m" cannot be combined with a clock time that was already given.
                if (!(short && spec.time)) {
                    spec.rel = r;
                    if (short)
                        spec.exclusive = true;
                    i += r.len;
                    consumed = true;
                    continue;
                }
            }
        }

        break;
    }

    let rest;
    if (escaped)
        rest = input.slice(tokens[i].index + 1).trim();
    else
        rest = i < tokens.length ? input.slice(tokens[i].index).trim() : '';

    if (!consumed)
        return rest ? {type: 'note', text: rest} : {type: 'empty'};

    // Things that look like a date/weekday by accident ("1/2 cup flour", "mon something")
    // are only treated as reminders when a clock time is also given.
    const d = spec.date;
    if (d && !spec.time && ((d.kind === 'ymd' && d.ambiguous) || (d.kind === 'weekday' && d.bare)))
        return {type: 'note', text: input};

    if (!rest) {
        return {
            type: 'error',
            message: 'Add some text after the time, e.g. "tomorrow 9:00 call Anna". ' +
                     'Start with \\ to save it as a plain note.',
        };
    }

    const result = computeDue(spec, now, allowPast);
    if (result.error)
        return {type: 'error', message: result.error};
    return {type: 'reminder', text: rest, due: result.due, repeat: spec.repeat ? normalizeRepeat(spec.repeat) : null};
}

function computeDue(spec, now, allowPast) {
    const nowDate = new Date(now);
    const todayStart = startOfDay(now);
    const repeat = spec.repeat;
    const PAST = 'That time is already in the past.';
    let due;

    if (spec.rel && (spec.rel.unit === 'minutes' || spec.rel.unit === 'hours')) {
        due = addUnits(now, spec.rel.n, spec.rel.unit);
    } else if (!spec.date && !spec.rel && !spec.time) {
        // Only a repeat was given ("every 2 hours stretch", "daily pills").
        if (repeat.unit === 'minutes' || repeat.unit === 'hours') {
            due = addUnits(now, repeat.every, repeat.unit);
        } else if (repeat.unit === 'days' || repeat.unit === 'weekdays') {
            due = atTime(now, DEFAULT_TIME);
            if (due <= now)
                due = atTime(addUnits(now, 1, 'days'), DEFAULT_TIME);
        } else {
            due = atTime(addUnits(now, repeat.every, repeat.unit), DEFAULT_TIME);
        }
    } else if (spec.rel && !spec.time) {
        due = addUnits(now, spec.rel.n, spec.rel.unit);
    } else {
        const time = spec.time ?? DEFAULT_TIME;
        const date = spec.date;

        if (spec.rel) {
            due = atTime(addUnits(now, spec.rel.n, spec.rel.unit), time);
        } else if (!date) {
            // Only a clock time: the next time it happens.
            due = atTime(now, time);
            if (due <= now)
                due = atTime(addUnits(now, 1, 'days'), time);
        } else if (date.kind === 'today') {
            due = atTime(now, time);
        } else if (date.kind === 'tomorrow') {
            due = atTime(addUnits(now, 1, 'days'), time);
        } else if (date.kind === 'weekday') {
            const delta = (date.weekday - nowDate.getDay() + 7) % 7;
            due = atTime(addUnits(now, delta, 'days'), time);
            if (due <= now)
                due = atTime(addUnits(now, delta + 7, 'days'), time);
        } else {
            // Explicit calendar date.
            if (date.month < 0 || date.month > 11 || date.day < 1 || date.day > 31)
                return {error: 'That date does not exist.'};
            if (date.hasYear) {
                if (date.day > daysInMonth(date.y, date.month))
                    return {error: 'That date does not exist.'};
                due = new Date(date.y, date.month, date.day, time.h, time.mi, 0, 0).getTime();
            } else {
                due = null;
                const firstYear = nowDate.getFullYear();
                let sawValid = false;
                for (let y = firstYear; y <= firstYear + 8; y++) {
                    if (date.day > daysInMonth(y, date.month))
                        continue;
                    sawValid = true;
                    const candidate = new Date(y, date.month, date.day, time.h, time.mi, 0, 0).getTime();
                    if (startOfDay(candidate) >= todayStart) {
                        due = candidate;
                        break;
                    }
                }
                if (due === null) {
                    return {error: sawValid ? PAST : 'That date does not exist.'};
                }
            }
        }
    }

    if (due <= now && !allowPast)
        return {error: PAST};

    // "weekdays" never lands on a weekend.
    if (repeat && repeat.unit === 'weekdays') {
        let guard = 0;
        while (isWeekend(due) && guard++ < 3)
            due = addUnits(due, 1, 'days');
    }
    return {due};
}

// ---------- repeating ----------

// First occurrence of a repeating reminder that is strictly after `now`,
// following the schedule that starts at `dueAt`.
export function nextAfter(repeat, dueAt, now) {
    const r = normalizeRepeat(repeat);
    const base = Number.isFinite(dueAt) ? dueAt : now;
    if (!r)
        return Math.max(base, now) + 24 * 60 * MINUTE_MS;

    const ref = Math.max(now, base);

    if (r.unit === 'weekdays') {
        const bd = new Date(base);
        const cand = new Date(ref);
        cand.setHours(bd.getHours(), bd.getMinutes(), 0, 0);
        let guard = 0;
        while ((cand.getTime() <= ref || isWeekend(cand.getTime())) && guard++ < 20)
            cand.setDate(cand.getDate() + 1);
        return cand.getTime();
    }

    if (r.unit === 'minutes' || r.unit === 'hours') {
        const step = r.every * (r.unit === 'hours' ? 60 : 1) * MINUTE_MS;
        const n = Math.max(1, Math.floor((now - base) / step) + 1);
        return base + n * step;
    }

    let n = 1;
    if (r.unit === 'days' || r.unit === 'weeks') {
        const step = r.every * (r.unit === 'weeks' ? 7 : 1) * 24 * 60 * MINUTE_MS;
        n = Math.max(1, Math.floor((now - base) / step) - 1);
    }
    let t = addUnits(base, n * r.every, r.unit);
    for (let guard = 0; t <= now && guard < 200000; guard++) {
        n++;
        t = addUnits(base, n * r.every, r.unit);
    }
    if (t <= now)
        t = now + 24 * 60 * MINUTE_MS;
    return t;
}

// ---------- formatting ----------

export function sameMinute(a, b) {
    if (!Number.isFinite(a) || !Number.isFinite(b))
        return false;
    return Math.floor(a / MINUTE_MS) === Math.floor(b / MINUTE_MS);
}

export function formatDue(due, now = Date.now()) {
    const d = new Date(due);
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const diff = Math.round((startOfDay(due) - startOfDay(now)) / (24 * 60 * 60 * 1000));

    if (diff === 0)
        return `today ${time}`;
    if (diff === 1)
        return `tomorrow ${time}`;
    if (diff === -1)
        return `yesterday ${time}`;
    if (diff >= 2 && diff <= 6)
        return `${DAY_NAMES[d.getDay()]} ${time}`;

    const sameYear = d.getFullYear() === new Date(now).getFullYear();
    const date = `${d.getDate()} ${MONTH_NAMES[d.getMonth()]}${sameYear ? '' : ` ${d.getFullYear()}`}`;
    return `${date} ${time}`;
}

export function formatRepeat(repeat) {
    const r = normalizeRepeat(repeat);
    if (!r)
        return '';
    if (r.unit === 'weekdays')
        return 'weekdays';
    if (r.every === 1)
        return `every ${SINGULAR.get(r.unit)}`;
    return `every ${r.every} ${r.unit}`;
}

// The text that goes back into the entry box when editing. Parsing it again gives the
// same reminder (same repeat, same exact date and time, same text).
export function toEditString(item) {
    let text = item.text;
    // If the text itself starts with something that looks like a time/date/repeat
    // (or a backslash), protect it with a backslash so it is not re-interpreted.
    if (text.startsWith('\\') || parseInput(text, Date.now(), {allowPast: true}).type !== 'note')
        text = `\\${text}`;

    if (item.due === null || item.due === undefined)
        return text;

    const d = new Date(item.due);
    const parts = [];
    const r = normalizeRepeat(item.repeat);
    if (r) {
        if (r.unit === 'weekdays')
            parts.push('weekdays');
        else if (r.every === 1)
            parts.push(`every ${SINGULAR.get(r.unit)}`);
        else
            parts.push(`every ${r.every} ${r.unit}`);
    }
    parts.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
    parts.push(`${pad(d.getHours())}:${pad(d.getMinutes())}`);
    parts.push(text);
    return parts.join(' ');
}

// ---------- storage ----------

// Cleans one item loaded from disk (old files have only text/done/due/fired).
// Returns null for anything unusable.
export function normalizeItem(raw, newId) {
    if (!raw || typeof raw !== 'object' || typeof raw.text !== 'string')
        return null;
    const text = raw.text.trim();
    if (!text)
        return null;

    const due = typeof raw.due === 'number' && Number.isFinite(raw.due) ? raw.due : null;
    const repeat = due !== null ? normalizeRepeat(raw.repeat) : null;
    return {
        id: typeof raw.id === 'string' && raw.id ? raw.id : newId(),
        text,
        done: !!raw.done,
        due,
        fired: due !== null ? !!raw.fired : false,
        repeat,
    };
}
