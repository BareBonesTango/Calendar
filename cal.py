#!/usr/bin/env python3
"""Render a chronological listing of calendar events from a JSON file.

The JSON file holds an array of Event and Update records as described in
SPEC.md.  Evaluation happens in two steps:

1.  Collect all non-repeating Events overlapping the listing window and
    instantiate every repeated Event for each day matching its simplified
    cron-style ``Repeat`` filter (honouring the optional ``Last`` day).
2.  Apply the Update records to that list.

Usage:
    cal.py [FILE] [--start YYYY-MM-DD] [--days N]
"""

from __future__ import annotations

import argparse
import dataclasses
import datetime
import json
from os import path
import re
import sys
import collections

# ---------------------------------------------------------------------------
# parsing helpers
# ---------------------------------------------------------------------------

_LENGTH_RE = re.compile(r"^\s*PT(?:(\d+)\s*H)?(?:(\d+)\s*M)?\s*$")
_TIME_RE = re.compile(r"^(\d{1,2}):(\d{2})$")


#
EVENT_INDICATOR_FIELD = "Id"
EVENT_MANDATORY_FIELDS = set(["Name", "Day", "Time", "Length", "Kind"])
EVENT_REPEAT_FIELDS = set(["Repeat", "Last"])
EVENT_OPTIONAL_FIELDS = set(
    ["Status", "Location", "Price", "Class", "Region", "Extra", "Music", "Links"])
EVENT_ALL_FIELDS = set([EVENT_INDICATOR_FIELD]
                       ) | EVENT_MANDATORY_FIELDS | EVENT_OPTIONAL_FIELDS | EVENT_REPEAT_FIELDS
#
UPDATE_INDICATOR_FIELD = "Change"
UPDATE_OPTIONAL_FIELDS = set(
    ["Instance"]) | EVENT_MANDATORY_FIELDS | EVENT_OPTIONAL_FIELDS
UPDATE_ALL_FIELDS = set([UPDATE_INDICATOR_FIELD]) | UPDATE_OPTIONAL_FIELDS


def substitute(text: str, values: dict) -> str:
    """Return text with every ${key} replaced by values[key]."""
    return re.sub(r"\$\{([^}]*)\}", lambda m: str(values[m.group(1)]), text)


def parse_day(text: str) -> datetime.date:
    try:
        return datetime.date.fromisoformat(text.strip())
    except (ValueError, AttributeError):
        raise ValueError(f"invalid day {text!r} (expected YYYY-mm-dd)")


def parse_time(text: str) -> datetime.time:
    m = _TIME_RE.match(text.strip()) if isinstance(text, str) else None
    if not m or int(m.group(1)) > 23 or int(m.group(2)) > 59:
        raise ValueError(f"invalid time {text!r} (expected HH:MM)")
    return datetime.time(int(m.group(1)), int(m.group(2)))


def parse_length(text: str) -> datetime.timedelta:
    m = _LENGTH_RE.match(text) if isinstance(text, str) else None
    if not m or not (m.group(1) or m.group(2)):
        raise ValueError(
            f"invalid length {text!r} (expected XhYm, e.g. 3h30m)")
    return datetime.timedelta(hours=int(m.group(1) or 0),
                              minutes=int(m.group(2) or 0))


# ---------------------------------------------------------------------------
# cron-style Repeat field ("dom,mon,dow")
# ---------------------------------------------------------------------------


def _cron_field(spec: str, lo: int, hi: int) -> set[int]:
    """Parse one cron field (``*``, lists, ranges, steps) into a value set."""
    values: set[int] = set()
    for item in spec.split(","):
        item = item.strip()
        if not item:
            raise ValueError("empty item in cron field")
        if item == "*":
            first, last = lo, hi
        elif "-" in item:
            a, _, b = item.partition("-")
            first, last = int(a), int(b)
        else:
            first = int(item)
            last = first
        if first < lo or last > hi or first > last:
            raise ValueError(f"cron item {item!r} out of range {lo}-{hi}")
        values.update(range(first, last + 1, 1))
    return values


class Repeat:
    """A parsed Repeat filter: day-of-month, month, day-of-week."""

    def __init__(self, dom: set[int], mon: set[int], dow: set[int]):
        self.dom, self.mon, self.dow = dom, mon, dow

    def matches(self, d: datetime.date) -> bool:
        if d.month not in self.mon:
            return False
        if d.day not in self.dom:
            return False
        return (d.weekday() + 1) % 7 in self.dow  # cron: Sunday = 0


def parse_repeat(text: str) -> Repeat:
    components = text.strip().split()
    if len(components) != 3:
        raise ValueError(f"invalid Repeat {text!r} (expected 3 cron fields: "
                         "day-of-month, month, day-of-week)")
    dom_s, mon_s, dow_s = components
    dom = _cron_field(dom_s, 1, 31)
    mon = _cron_field(mon_s, 1, 12)
    dow = {d % 7 for d in _cron_field(dow_s, 0, 7)}  # 7 -> Sunday
    return Repeat(dom, mon, dow)


# ---------------------------------------------------------------------------
# records
# ---------------------------------------------------------------------------

@dataclasses.dataclass
class Event:
    fields: dict
    day: datetime.date
    start: datetime.time
    length: datetime.timedelta
    repeat: Repeat | None
    last: datetime.date | None

    @property
    def id(self) -> str:
        return self.fields["Id"]


def load_records(data: list) -> tuple[list[Event], list[dict], dict[str, Event]]:
    events: list[Event] = []
    updates: list[dict] = []
    by_id: dict[str, Event] = {}
    for i, rec in enumerate(data):
        where = f"record #{i + 1}"
        if not isinstance(rec, dict):
            raise ValueError(f"{where}: expected an object")
        if UPDATE_INDICATOR_FIELD in rec:  # an Update record
            for f in rec:
                if f not in UPDATE_ALL_FIELDS:
                    raise ValueError(
                        f"Update {where} contains unknown field {f}")
            target = rec["Change"]
            if target not in by_id:
                raise ValueError(f"Update {where} references event {target!r} "
                                 "which is not declared earlier in the file")
            if "Instance" in rec:
                if by_id[target].repeat is None:
                    raise ValueError(f"Update {where} uses Instance but event "
                                     f"{target!r} has no Repeat field")
                parse_day(str(rec["Instance"]))
            updates.append(rec)
        elif EVENT_INDICATOR_FIELD in rec:  # an Event record
            for f in rec:
                if f not in EVENT_ALL_FIELDS:
                    raise ValueError(
                        f"Event {where} contains unknown field {f}")
            for f in EVENT_MANDATORY_FIELDS:
                if f not in rec:
                    raise ValueError(
                        f"Event {where} is missing mandatory field {f}")
            if rec["Id"] in by_id:
                raise ValueError(f"Event {where}: duplicate Id {rec['Id']!r}")
            ev = Event(
                fields=dict(rec),
                day=parse_day(str(rec["Day"])),
                start=parse_time(str(rec["Time"])),
                length=parse_length(str(rec["Length"])),
                repeat=(parse_repeat(str(rec["Repeat"]))
                        if "Repeat" in rec else None),
                last=(parse_day(str(rec["Last"]))
                      if "Last" in rec else None),
            )
            events.append(ev)
            by_id[ev.id] = ev
        else:
            raise ValueError(f"{where}: neither an Event (no Id) nor an "
                             "Update (no Event) record")
    return events, updates, by_id


# ---------------------------------------------------------------------------
# evaluation
# ---------------------------------------------------------------------------

def instantiate(events: list[Event], start_day: datetime.date,
                days: int) -> list[Event]:
    """Step 1: collect plain events and instantiate repeated ones."""
    end_day = start_day + datetime.timedelta(days=days-1)
    rows: list[Event] = []
    for ev in events:
        if ev.repeat is None:
            if start_day <= ev.day <= end_day:
                rows.append(ev)
            continue
        d = ev.day
        while d <= end_day:
            if ev.last is not None and d > ev.last:
                break
            if ev.repeat.matches(d):
                if start_day <= d <= end_day:
                    rows.append(Event(
                        fields={**ev.fields, "Day": d.isoformat()},
                        day=d,
                        start=ev.start,
                        length=ev.length,
                        repeat=None,
                        last=None
                    ))
            d += datetime.timedelta(days=1)
    return rows


def apply_updates(events: list[Event], updates: list[dict]) -> None:
    """Step 2: override fields of the matching list entries."""
    by_id = collections.defaultdict(list)
    for ev in events:
        by_id[ev.id].append(ev)
    for upd in updates:
        target = upd["Change"]
        inst_day = (parse_day(str(upd["Instance"]))
                    if "Instance" in upd else None)
        for ev in by_id[target]:
            if inst_day is not None and ev.day != inst_day:
                continue
            for k, v in upd.items():
                if k in ("Instance", "Change"):
                    continue
                ev.fields[k] = v
                if k == "Day":
                    ev.day = parse_day(v)
                if k == "Time":
                    ev.start = parse_time(v)
                if k == "Length":
                    ev.length = parse_length(v)


MAX_RECURSE = 10


def merge_multiline(d: dict[str, str | list[str]]) -> dict[str, str]:
    for key, val in d.items():
        if isinstance(val, list):
            d[key] = "\n".join(val)
    return d


def apply_abbrevs(events: list[dict[str, str]],
                  abbrevs: dict[str, str]) -> None:
    """Step 1: apply abbreviations to the events."""
    # apply abbreviations to all fields
    for key, val in abbrevs.items():
        for _ in range(MAX_RECURSE):
            new_val = substitute(val, abbrevs)
            if new_val == val:
                break
            val = new_val
        else:
            raise ValueError(
                f"Abbreviation {key} could not be fully resolved.")
        abbrevs[key] = val
    for ev in events:
        for k, val in ev.items():
            ev[k] = substitute(val, abbrevs)


# ---------------------------------------------------------------------------
# rendering
# ---------------------------------------------------------------------------
def render(rows: list[Event]) -> None:
    rows.sort(key=lambda r: (r.day, r.fields["Kind"], r.fields["Name"]))
    if not rows:
        print("No events.")
        return
    last_day = None
    for r in rows:
        if last_day != r.day:
            last_day = r.day
            if last_day is not None:
                print()
            print(f"{last_day:%Y-%m-%d}")
        s = datetime.datetime.combine(r.day, r.start)
        e = s + r.length
        end = f"{e:%H:%M}" if e.date() == s.date() else f"{e:%Y-%m-%d %H:%M}"
        print(f"  {s:%H:%M} - {end}  [{r.fields['Kind']}] {r.fields['Name']}")
        for k, v in r.fields.items():
            if k not in ("Kind", "Name", "Repeat", "Length", "Day", "Id", "Time"):
                print(f"    {k}: {v}")


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="cal.py",
        description="Render a chronological listing of calendar events "
                    "from a JSON file with Event and Update records.")
    ap.add_argument("events", nargs="?", default="events.json",
                    help="JSON file with Event/Update records "
                         "(default: events.json)")
    ap.add_argument("abbrevs", nargs="?", default="abbrevs.json",
                    help="JSON file with Abbreviation records "
                         "(default: abbrevs.json)")
    ap.add_argument("-s", "--start", metavar="YYYY-MM-DD", default=None,
                    help="start day of the listing window (default: today)")
    ap.add_argument("-n", "--days", metavar="N", type=int, default=28,
                    help="length of the listing window in days (default: 28)")
    args = ap.parse_args(argv)

    try:
        start = parse_day(args.start) if args.start else datetime.date.today()
        if args.days < 1:
            raise ValueError("days must be at least 1")
        try:
            abbrevs = json.load(open(args.abbrevs,  encoding="utf-8"))
            if not isinstance(abbrevs, dict):
                raise ValueError(
                    f"{args.abbrevs}: top level must be a JSON dict")
            abbrevs = merge_multiline(abbrevs)
        except OSError as e:
            raise ValueError(f"cannot read {args.abbrevs}: {e.strerror or e}")
        try:
            data = json.load(open(args.events, encoding="utf-8"))
            if not isinstance(data, list):
                raise ValueError(
                    f"{args.events}: top level must be a JSON array")
            data = [merge_multiline(d) for d in data]
        except OSError as e:
            raise ValueError(f"cannot read {args.events}: {e.strerror or e}")

        apply_abbrevs(data, abbrevs)
        events, updates, _ = load_records(data)
        rows = instantiate(events, start, args.days)
        apply_updates(rows, updates)
        render(rows)
    except ValueError as e:
        print(f"cal.py: error: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
