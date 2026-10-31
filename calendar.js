"use strict";

// Calendar page logic.  Mimics cal.py: Event and Update records are loaded
// from events.json, repeated events are instantiated for the listing window
// (one row per week, weeks start on Monday), then the Updates are applied.
//
// URL parameters:
//   ?start=YYYY-MM-DD  first row shows the week containing this day
//                      (default: today)
//   ?weeks=N           number of week rows shown (default: 4)

// ---------------------------------------------------------------------------
// parsing helpers
// ---------------------------------------------------------------------------


const MANDATORY_EVENT_FIELDS = ["Id", "Name", "Day", "Time", "Length", "Kind", "Location"];


// ---------------------------------------------------------------------------
// cron-style Repeat field ("dom mon dow") except that all conditions must be satisfied simultaneously
// ---------------------------------------------------------------------------

function cronField(spec, lo, hi) {
    const values = new Set();
    for (let item of spec.split(",")) {
        item = item.trim();
        if (!item) throw new Error("empty item in cron field");
        let first, last;
        if (item === "*") {
            [first, last] = [lo, hi];
        } else if (item.includes("-")) {
            const [a, b] = item.split("-", 2);
            [first, last] = [+a, +b];
        } else {
            first = last = +item;
        }
        // TODO: maybe support negative numbers so we can model "last monday of the month"
        if (!Number.isInteger(first) || !Number.isInteger(last) ||
            first < lo || last > hi || first > last)
            throw new Error(`cron item ${JSON.stringify(item)} out of range ${lo}-${hi}`);
        for (let v = first; v <= last; v++) values.add(v);
    }
    return values;
}

class Repeat {
    /** A parsed Repeat filter: day-of-month, month, day-of-week. */
    constructor(dom, mon, dow) {
        this.dom = dom; this.mon = mon; this.dow = dow;
    }

    // day is a Temporal.PlainDate representing the day to check against the repeat filter.
    matches(day) {
        if (!this.mon.has(day.month)) return false;
        if (!this.dom.has(day.day)) return false;
        return this.dow.has(day.dayOfWeek);
    }
}

function parseRepeat(text) {
    const components = String(text).trim().split(/\s+/);
    if (components.length !== 3)
        throw new Error(`invalid Repeat ${JSON.stringify(text)} (expected 3 cron ` +
            "fields: day-of-month, month, day-of-week)");
    const [domS, monS, dowS] = components;
    const dow = new Set([...cronField(dowS, 0, 7)].map(d => d % 7));  // 7 -> Sunday
    return new Repeat(cronField(domS, 1, 31), cronField(monS, 1, 12), dow);
}

// ---------------------------------------------------------------------------
// records
// ---------------------------------------------------------------------------

class Event {
    constructor(fields) {
        this.fields = { ...fields };
        this.day = Temporal.PlainDate.from(fields.Day);
        // Temporal.PlainTime representing the start time of the event.
        this.start = Temporal.PlainTime.from(fields.Time);
        // Temporal.Duration representing the length of the event.
        this.length = Temporal.Duration.from(fields.Length);
        this.repeat = "Repeat" in fields ? parseRepeat(fields.Repeat) : null;
        this.last = "Last" in fields ? Temporal.PlainDate.from(fields.Last) : null;
    }

    get id() { return this.fields.Id; }
}



function loadRecords(data) {
    if (!Array.isArray(data))
        throw new Error("events.json: top level must be a JSON array");
    const events = [], updates = [], byId = new Map();
    data.forEach((rec, i) => {
        const where = `record #${i + 1}`;
        if (typeof rec !== "object" || rec === null || Array.isArray(rec))
            throw new Error(`${where}: expected an object`);
        if ("Change" in rec) {  // an Update record
            if ("Id" in rec)
                throw new Error(`Update ${where} must not contain an Id field`);
            const target = rec.Change;
            if (!byId.has(target))
                throw new Error(`Update ${where} references event ` +
                    `${JSON.stringify(target)} which is not declared ` +
                    "earlier in the file");
            if ("Instance" in rec) {
                if (!byId.get(target).repeat)
                    throw new Error(`Update ${where} uses Instance but event ` +
                        `${JSON.stringify(target)} has no Repeat field`);
            }
            updates.push(rec);
        } else if ("Id" in rec) {  // an Event record
            for (const f of MANDATORY_EVENT_FIELDS)
                if (!(f in rec))
                    throw new Error(`Event ${where} is missing mandatory field ${f}`);
            if (byId.has(rec.Id))
                throw new Error(`Event ${where}: duplicate Id ${JSON.stringify(rec.Id)}`);
            const ev = new Event(rec);
            events.push(ev);
            byId.set(ev.id, ev);
        } else {
            throw new Error(`${where}: neither an Event (no Id) nor an Update ` +
                "(no Event) record");
        }
    });
    return { events, updates, byId };
}

// ---------------------------------------------------------------------------
// evaluation
// ---------------------------------------------------------------------------

function instantiate(events, startDay, days) {
    // Step 1: collect plain events and instantiate repeated ones.
    const endDay = startDay.add({ days: days - 1 });
    const rows = [];

    for (const ev of events) {
        if (!ev.repeat) {
            if (Temporal.PlainDate.compare(startDay, ev.day) <= 0 && Temporal.PlainDate.compare(ev.day, endDay) <= 0)
                rows.push(ev);
            continue;
        }
        for (let d = ev.day; Temporal.PlainDate.compare(d, endDay) <= 0; d = d.add({ days: 1 })) {
            if (ev.last && Temporal.PlainDate.compare(d, ev.last) > 0) break;
            if (ev.repeat.matches(d) && Temporal.PlainDate.compare(startDay, d) <= 0)
                rows.push(new Event({ ...ev.fields, Day: d.toString() }));
        }
    }
    return rows;
}

function applyUpdates(events, updates) {
    // Step 2: override fields of the matching list entries.
    for (const upd of updates) {
        const target = upd.Change;
        const instDay = "Instance" in upd ? Temporal.PlainDate.from(upd.Instance) : null;
        const changes = Object.fromEntries(Object.entries(upd)
            .filter(([k]) => k !== "Change" && k !== "Instance"));
        for (const ev of events) {
            if (ev.id !== target) continue;
            if (instDay && Temporal.PlainDate.compare(ev.day, instDay) !== 0) continue;
            Object.assign(ev.fields, changes);
            if ("Time" in changes) ev.start = Temporal.PlainTime.from(changes.Time);
            if ("Length" in changes) ev.length = Temporal.Duration.from(changes.Length);
            if ("Day" in changes) ev.day = Temporal.PlainDate.from(changes.Day);
        }
    }
}


// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

const RENDER_ORDER = ["Music", "Price", "Class", "Extra", "Location", "Region", "Links"];

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function el(tag) { return document.createElement(tag); }


function renderChip(ev) {
    const chip = el("div");
    chip.className = `Event Kind${ev.fields.Kind[0]}`;
    const start = ev.start.toString({ smallestUnit: 'minute' });
    const end = (ev.start.add(ev.length)).toString({ smallestUnit: 'minute' });
    let s = `<div class=EvTitle>${start}–${end} ${ev.fields.Name}</div>`;
    for (const key of RENDER_ORDER) {
        if (key in ev.fields) s += `<div class=Ev${key}>${ev.fields[key]}</div>`;
    }
    chip.innerHTML = s;
    // chip.title = `${row.fields.Name}\n${isoOf(parseDay(row.fields.Day))} ${row.fields.Time}` +
    //    `  (${row.fields.Length}, ${row.fields.Kind})`;
    return chip;
}

// day and today are Temporal.PlainDate objects
function dayCell(day, events, today) {
    const cell = el("div");
    cell.className = "CellDate";
    if (Temporal.PlainDate.compare(day, today) === 0) cell.classList.add("today");

    //
    const num = el("span");
    num.className = "CellDay";
    num.textContent = `${day.day}. ${MONTHS[day.month - 1]}`;
    //
    // day of week (WEEKDAYS is Monday-first, cronDow is Sunday-first)
    const dow = el("span");
    dow.className = "CellDow";
    dow.textContent = WEEKDAYS[(day.dayOfWeek + 6) % 7];
    cell.appendChild(num);
    cell.appendChild(dow);
    for (const ev of events) {
        cell.appendChild(renderChip(ev));
    }
    return cell;
}

function render(events, firstDay, rows, today, days_per_row) {
    // group instances by their effective day (Updates applied)
    const byDay = new Map();
    for (const ev of events) {
        const key = ev.day.toString();
        if (!byDay.has(key)) byDay.set(key, []);
        byDay.get(key).push(ev);
    }
    for (const list of byDay.values())
        list.sort((a, b) =>
            String(a.fields.Kind).localeCompare(String(b.fields.Kind)) ||
            Temporal.PlainTime.compare(a.start, b.start) ||
            String(a.fields.Name).localeCompare(String(b.fields.Name)));

    const cal = el("div");
    cal.id = "calendar";
    document.getElementById("calendar").replaceWith(cal);
    let d = firstDay;
    for (let w = 0; w < rows; w++) {
        const weekEl = el("div");
        weekEl.className = "week";
        for (let i = 0; i < days_per_row; i++, d = d.add({ days: 1 }))
            weekEl.appendChild(dayCell(d, byDay.get(d.toString()) || [], today));
        cal.appendChild(weekEl);
    }
}
// ---------------------------------------------------------------------------
// data cleanup
// ---------------------------------------------------------------------------
function applyAbbrevs(events, abbrevs) {
    for (const k in abbrevs) {
        let n = 10;
        let val = abbrevs[k];
        while (n-- > 0) {
            let new_val = substitute(val, abbrevs);
            if (new_val === val) break;
            val = new_val;
        }
        if (n == 0)
            throw new Error(`abbreviations: still contain unexpanded ${k} after 10 passes`);
        abbrevs[k] = val;
    }

    for (const ev of events) {
        for (const k in ev) {
            ev[k] = substitute(ev[k], abbrevs);
        }
    }
}

function substitute(text, values) {
    return text.replace(/\$\{([^}]*)\}/g, (m, key) => String(values[key]));
}

// Cleanup step: join values that are lists into a single string,
//  using newline as the separator.  Applies to one record object.
function joinLists(obj) {
    for (const key of Object.keys(obj))
        if (Array.isArray(obj[key]))
            obj[key] = obj[key].join("\n");
}
// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
    const params = new URLSearchParams(location.search);
    const today = Temporal.Now.plainDateISO();
    const start = params.has("start") ? Temporal.PlainDate.from(params.get("start")) : today;
    const weeks = params.has("weeks") ? +params.get("weeks") : 5;
    if (!Number.isInteger(weeks) || weeks < 1)
        throw new Error("weeks must be a positive integer");


    // mobile browsers get a single-column layout filling the entire width
    const runsOnMobile = navigator.userAgentData?.mobile ||
        /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
    if (runsOnMobile)
        document.body.classList.add("mobile");

    // the first row shows the week containing `start`, starting on Monday
    const monday = start.subtract({ days: ((start.dayOfWeek + 6) % 7) });

    console.log(`Rendered calendar starting from ${monday.toString()} for ${weeks} weeks`);

    const response_abbrevs = await fetch("abbrevs.json");
    if (!response_abbrevs.ok)
        throw new Error(`cannot load abbrevs.json (HTTP ${response_abbrevs.status})`);

    const response_events = await fetch("events.json");
    if (!response_events.ok)
        throw new Error(`cannot load events.json (HTTP ${response_events.status})`);

    const data = await response_events.json();
    if (!Array.isArray(data))
        throw new Error("events.json: top level must be a JSON array");
    const abbrevs = await response_abbrevs.json();

    // cleanup: join values that are lists into newline-separated strings
    data.forEach(joinLists);
    joinLists(abbrevs);

    applyAbbrevs(data, abbrevs);
    const { events, updates } = loadRecords(data);
    console.log(`Loaded ${events.length} events and ${updates.length} updates`);
    const instantiated_events = instantiate(events, monday, weeks * 7);
    console.log(`Instantiated ${instantiated_events.length} events`);
    applyUpdates(instantiated_events, updates);
    render(instantiated_events, monday, weeks, today, 7);
    //render(instantiated_events, monday, 28, today, 1);

    //
}

main().catch(err => {
    console.error(err);
    document.getElementById("error").textContent = `error: ${err}`;
});
