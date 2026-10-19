"""Pull deadlines from the eLC calendar feed into data/deadlines.json.

Runs on GitHub Actions every 15 minutes. The private feed address lives in
the ELC_FEED_URL repository secret, so it never appears in this public repo.

Only titles, course codes, due times and eLC links are saved — no assignment
descriptions.
"""

import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "deadlines.json"

KEEP_PAST_DAYS = 2      # yesterday's unfinished work still shows; older items drop off
KEEP_FUTURE_DAYS = 180  # rest of the semester and then some
SKIP_SUFFIXES = ("Available", "Availability Starts", "Availability Ends", "Start Date", "Starts", "End Date", "Ends")


def fetch(url):
    request = urllib.request.Request(url, headers={"User-Agent": "dashboard-sync/1.0"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read().decode("utf-8", errors="replace")


def unfold(text):
    # iCal wraps long lines onto continuation lines that start with a space or tab.
    return re.sub(r"\r?\n[ \t]", "", text).replace("\r\n", "\n")


def unescape(value):
    return (
        value.replace("\\n", "\n").replace("\\N", "\n")
        .replace("\\,", ",").replace("\\;", ";").replace("\\\\", "\\")
    )


def parse_date(raw, params):
    raw = raw.strip()
    if "VALUE=DATE" in params or re.fullmatch(r"\d{8}", raw):
        d = datetime.strptime(raw[:8], "%Y%m%d")
        # All-day item: treat as due at the end of that day, Eastern time.
        return d.replace(hour=23, minute=59, tzinfo=timezone(timedelta(hours=-5))), False
    if raw.endswith("Z"):
        return datetime.strptime(raw, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc), True
    # Local time with TZID; eLC is Eastern. Good enough for deadlines.
    d = datetime.strptime(raw[:15], "%Y%m%dT%H%M%S")
    return d.replace(tzinfo=timezone(timedelta(hours=-4))), True


def parse_events(ics):
    events = []
    current = None
    for line in unfold(ics).split("\n"):
        if line == "BEGIN:VEVENT":
            current = {}
        elif line == "END:VEVENT":
            if current is not None:
                events.append(current)
            current = None
        elif current is not None and ":" in line:
            key, value = line.split(":", 1)
            name, _, params = key.partition(";")
            current[name] = (value, params)
    return events


def course_code(location):
    match = re.search(r"(?<![A-Z])([A-Z]{3,4})\s?(\d{4})(?!\d)", location or "")
    return f"{match.group(1)} {match.group(2)}" if match else ""


def event_link(description):
    match = re.search(r"View event - (https://\S+)", description)
    if match:
        return match.group(1)
    match = re.search(r"(https://uga\.view\.usg\.edu/\S+)", description)
    return match.group(1) if match else ""


def main():
    feed_url = os.environ.get("ELC_FEED_URL", "").strip()
    if not feed_url:
        print("ELC_FEED_URL secret is not set; nothing to sync.")
        return 0

    try:
        ics = fetch(feed_url)
    except Exception as error:  # network hiccups shouldn't wipe the list
        print(f"Couldn't reach eLC: {error}")
        return 1
    if "BEGIN:VCALENDAR" not in ics:
        print("Feed didn't return a calendar (link reset or eLC down?). Keeping the current list.")
        return 1

    previous = {}
    if OUT.exists():
        try:
            previous = {d["id"]: d for d in json.loads(OUT.read_text())["items"]}
        except Exception:
            previous = {}
    first_run = not previous

    now = datetime.now(timezone.utc)
    earliest = now - timedelta(days=KEEP_PAST_DAYS)
    latest = now + timedelta(days=KEEP_FUTURE_DAYS)
    items = {}

    for event in parse_events(ics):
        summary = unescape(event.get("SUMMARY", ("", ""))[0]).strip()
        location = unescape(event.get("LOCATION", ("", ""))[0]).strip()
        code = course_code(location)
        if not summary or not code:
            continue  # campus-wide notices like maintenance windows

        parts = re.split(r"\s+-\s+", summary)
        suffix = parts[-1] if len(parts) > 1 else ""
        if suffix in SKIP_SUFFIXES:
            continue
        title = " - ".join(parts[:-1]) if suffix == "Due" else summary
        kind = "due" if suffix == "Due" else "event"

        when = event.get("DTSTART")
        if not when:
            continue
        due, has_time = parse_date(*when)
        if not (earliest <= due <= latest):
            continue

        uid = event.get("UID", (summary + due.isoformat(), ""))[0].split("@")[0]
        item = {
            "id": f"elc-{uid}",
            "title": re.sub(r"\s{2,}", " ", title).strip(),
            "course": code,
            "due": due.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "hasTime": has_time,
            "kind": kind,
            "url": event_link(unescape(event.get("DESCRIPTION", ("", ""))[0])),
            "firstSeen": None if first_run else now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
        if item["id"] in previous:
            item["firstSeen"] = previous[item["id"]].get("firstSeen")
        items[item["id"]] = item

    ordered = sorted(items.values(), key=lambda d: (d["due"], d["course"], d["title"]))

    # Only rewrite the file when the deadlines themselves changed, so the repo
    # doesn't get a commit every 15 minutes.
    old_items = sorted(previous.values(), key=lambda d: (d["due"], d["course"], d["title"]))
    if ordered == old_items and OUT.exists():
        print(f"No changes ({len(ordered)} deadlines).")
        return 0

    added = [d["title"] for d in ordered if d["id"] not in previous]
    OUT.write_text(json.dumps({
        "source": "eLC calendar feed",
        "synced": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "items": ordered,
    }, indent=2) + "\n")
    print(f"Saved {len(ordered)} deadlines. New: {added if not first_run else 'first sync'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
