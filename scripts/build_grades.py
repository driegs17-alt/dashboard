"""Turn a raw eLC gradebook pull into the encrypted data/grades.enc.json.

    python3 scripts/build_grades.py /path/OUTSIDE/the/repo/raw.json

The raw file comes from scripts/elc_grades.js, run in a signed-in eLC tab
(see agent/GRADES.md). It must never go in the repo: the repo is public.
This script works out each item's status and each class's overall grade,
then encrypts everything to the public key in data/grades-key.json. Only
devices holding the private key (pasted into the Grades tab) can read it.

Raw item rows (compact):
  [name, categoryId, maxPoints, weight, score|null, due|null,
   submitted (null = not a dropbox, 0 = dropbox with nothing, or a time),
   elcOverdue (1 = eLC lists it as overdue), flags (1 bonus, 2 excluded),
   hasFeedback]

Item statuses:
  flagged    you submitted, but eLC shows a 0 or still lists it overdue
  missing    past due with a 0, an empty dropbox, or eLC's overdue flag
  check      past due, no grade, and eLC can't see the work (done in an
             outside tool like Achieve or InQuizitive)
  submitted  submitted, waiting on a grade
  cleared    graded fine, but eLC still lists it as overdue (ignore)
  graded     graded
  upcoming   not due yet
  info       no due date and no grade yet

Overall grade, three numbers per class:
  current    on graded work only (what you'd have if the semester ended
             with only what's been graded so far counting)
  floor      if nothing else gets turned in (ungraded counts as 0)
  ceiling    if everything left is a perfect score
  plus how much of the course (by weight) has been graded so far.
Drop-lowest rules are applied the way eLC does. Bonus items add on top.

Each class also carries a compact "calc" block so the Grades tab can redo
the same math in the browser when Dylan enters his own score for an item
(data/grade-overrides.enc.json, encrypted the same way; Claude never needs
to read it). Keep overall() here and gradeCalc() in js/app.js in step.
"""

import base64
import json
import math
import os
import sys
from datetime import datetime, timezone

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INFO = b"dashboard-grades-v1"

# UGA's plus/minus scale. Syllabi can differ, so the UI says "about".
LETTERS = [(93, "A"), (90, "A-"), (87, "B+"), (83, "B"), (80, "B-"), (77, "C+"), (73, "C"), (70, "C-"), (60, "D"), (0, "F")]


def letter(pct):
    if pct is None:
        return None
    return next(l for cut, l in LETTERS if pct >= cut - 1e-9)


def b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def unb64u(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def when(value):
    if not value:
        return None
    text = value if value.endswith("Z") or "+" in value[10:] else value + "Z"
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ") if dt else None


# ---------- statuses ----------

def item_status(it, now):
    got, due, sub, od = it["got"], it["due"], it["sub"], it["od"]
    submitted = bool(sub)
    zero = got is not None and got == 0
    if submitted and (zero or od):
        return "flagged"
    if got is not None and not zero:
        return "cleared" if od else "graded"
    if submitted:
        return "submitted"
    if due and due < now:
        if zero or sub == 0 or od:
            return "missing"
        return "check"
    if due:
        return "upcoming"
    return "graded" if zero else "info"


# ---------- grade math ----------

def category_pct(items, drop_low, drop_high, fill=None):
    """Weighted % for one category. fill=None: graded items only;
    fill=0 or 1: ungraded items count as 0% or 100%."""
    rows = []
    for it in items:
        if it["max"] <= 0:
            continue
        if it["got"] is None:
            if fill is None:
                continue
            pct = float(fill)
        else:
            pct = it["got"] / it["max"]
        rows.append((pct, it["weight"] or it["max"]))
    if not rows:
        return None
    rows.sort(key=lambda r: r[0])
    keep_from = min(drop_low, max(len(rows) - 1, 0))
    rows = rows[keep_from:]
    if drop_high:
        rows = rows[: max(len(rows) - drop_high, 1)]
    total_w = sum(w for _, w in rows)
    return 100 * sum(p * w for p, w in rows) / total_w if total_w else None


def overall(course, items):
    system = course["sys"]
    counted = [i for i in items if not i["excluded"] and not i["bonus"]]
    bonus = [i for i in items if i["bonus"] and i["got"] is not None]

    if system == "Formula":
        return {
            "method": "formula",
            "note": "Your instructor grades this class with a custom formula in eLC, so the points below don't add up to a real grade. Go by eLC's own final grade and the feedback on each project.",
            "current": None, "floor": None, "ceiling": None, "gradedShare": None, "letter": None, "categories": [],
        }

    if system == "Points" or not course["cats"] and system != "Weighted":
        got = sum(i["got"] for i in counted if i["got"] is not None)
        graded_max = sum(i["max"] for i in counted if i["got"] is not None)
        all_max = sum(i["max"] for i in counted)
        extra = sum(i["got"] for i in bonus)
        cur = 100 * (got + extra) / graded_max if graded_max else None
        flo = 100 * (got + extra) / all_max if all_max else None
        cei = 100 * (got + extra + all_max - graded_max) / all_max if all_max else None
        return {
            "method": "points",
            "note": "Points: everything you've earned divided by everything that's been graded.",
            "current": cur, "floor": flo, "ceiling": min(cei, 100) if cei is not None else None,
            "gradedShare": 100 * graded_max / all_max if all_max else None,
            "letter": letter(cur), "categories": [],
        }

    # Weighted. Items with no category behave like their own category.
    groups = []
    for cid, name, weight, drop_low, drop_high, excluded in course["cats"]:
        if excluded:
            continue
        members = [i for i in counted if i["cat"] == cid]
        if members:
            groups.append({"name": name, "weight": weight, "dropLow": drop_low, "dropHigh": drop_high, "items": members})
    loose = [i for i in counted if i["cat"] is None or i["cat"] not in {c[0] for c in course["cats"]}]
    if loose:
        even = all(abs((i["weight"] or 0) - (loose[0]["weight"] or 0)) < 1e-6 for i in loose)
        for i in loose:
            groups.append({"name": i["name"], "weight": (1 if even else i["weight"]) or 0, "dropLow": 0, "dropHigh": 0, "items": [i], "single": True})

    total_w = sum(g["weight"] for g in groups) or 1
    cats = []
    cur_num = cur_den = flo_num = cei_num = graded_share = 0.0
    for g in groups:
        cur = category_pct(g["items"], g["dropLow"], g["dropHigh"])
        flo = category_pct(g["items"], g["dropLow"], g["dropHigh"], fill=0)
        cei = category_pct(g["items"], g["dropLow"], g["dropHigh"], fill=1)
        n_graded = sum(1 for i in g["items"] if i["got"] is not None)
        share = g["weight"] * n_graded / len(g["items"])
        graded_share += share
        if cur is not None:
            cur_num += g["weight"] * cur
            cur_den += g["weight"]
        flo_num += g["weight"] * (flo or 0)
        cei_num += g["weight"] * (cei if cei is not None else 100)
        if not g.get("single"):
            cats.append({
                "name": g["name"],
                "weight": rnd(100 * g["weight"] / total_w),
                "pct": rnd(cur),
                "graded": n_graded,
                "total": len(g["items"]),
                "dropLow": g["dropLow"],
                "earned": rnd(g["weight"] * cur / total_w, 2) if cur is not None else None,
            })
    cur = cur_num / cur_den if cur_den else None
    single_items = len([g for g in groups if g.get("single")])
    note = (
        "Weighted by category, using the weights in eLC. Drop-lowest rules applied."
        if cats else
        "Every assignment counts the same here, so this is the average of your graded assignments."
    )
    if cats and single_items:
        note += " Uncategorized items each count on their own."
    return {
        "method": "weighted",
        "note": note,
        "current": cur,
        "floor": flo_num / total_w,
        "ceiling": cei_num / total_w,
        "gradedShare": 100 * graded_share / total_w,
        "letter": letter(cur),
        "categories": cats,
    }


def rnd(x, places=1):
    # Half-up, same as Math.round in js/app.js, so both sides agree exactly.
    if x is None:
        return None
    f = 10 ** places
    return math.floor(x * f + 0.5) / f


def r1(x):
    return rnd(x, 1)


def build(raw, courses_meta):
    now = datetime.now(timezone.utc)
    meta = {c["code"]: c for c in courses_meta}
    out = []
    for course in raw["courses"]:
        cat_names = {c[0]: c[1] for c in course["cats"]}
        items = []
        for row in course["items"]:
            name, cat, mx, weight, got, due, sub, od, flags, fb = row
            items.append({
                "name": name, "cat": cat, "max": mx or 0, "weight": weight, "got": got,
                "due": when(due), "sub": sub, "od": bool(od),
                "bonus": bool(flags & 1), "excluded": bool(flags & 2), "feedback": bool(fb),
            })
        calc = overall(course, items)
        shown = []
        for it in items:
            if it["excluded"] and it["got"] is None:
                continue
            status = item_status(it, now)
            score = None
            if it["got"] is not None:
                score = f'{it["got"]:g} / {it["max"]:g}'
            shown.append({
                "name": it["name"],
                "category": cat_names.get(it["cat"], ""),
                "score": score,
                "pct": round(100 * it["got"] / it["max"], 1) if it["got"] is not None and it["max"] else None,
                "due": iso(it["due"]),
                "submittedAt": it["sub"] + "Z" if isinstance(it["sub"], str) else None,
                "status": status,
                "feedback": it["feedback"],
                "bonus": it["bonus"],
            })
        for name, due, sub in course.get("loose", []):
            d = when(due)
            status = "submitted" if sub else ("missing" if d and d < now else ("upcoming" if d else "info"))
            shown.append({"name": name, "category": "Dropbox (not in gradebook)", "score": None, "pct": None,
                          "due": iso(d), "submittedAt": sub + "Z" if sub else None, "status": status, "feedback": False, "bonus": False})
        order = ["flagged", "missing", "check", "submitted", "upcoming", "cleared", "graded", "info"]
        shown.sort(key=lambda i: (order.index(i["status"]), i["due"] or "9999", i["name"]))
        m = meta.get(course["code"], {})
        calc_items = [[i["name"], i["cat"], i["max"], i["weight"], i["got"], (1 if i["bonus"] else 0) + (2 if i["excluded"] else 0)] for i in items]
        out.append({
            "calc": {"sys": course["sys"], "cats": course["cats"], "items": calc_items},
            "code": course["code"],
            "short": m.get("short", course["code"]),
            "url": f'https://uga.view.usg.edu/d2l/lms/grades/my_grades/main.d2l?ou={m.get("elc", "").rstrip("/").split("/")[-1]}' if m.get("elc") else "",
            "system": course["sys"],
            "grade": {
                "current": r1(calc["current"]), "floor": r1(calc["floor"]), "ceiling": r1(calc["ceiling"]),
                "gradedShare": r1(calc["gradedShare"]), "letter": calc["letter"],
                "floorLetter": letter(calc["floor"]), "ceilingLetter": letter(calc["ceiling"]),
                "method": calc["method"], "note": calc["note"], "categories": calc["categories"],
            },
            "counts": {s: sum(1 for i in shown if i["status"] == s) for s in order},
            "items": shown,
        })
    return {"scraped": raw.get("scraped") or iso(now), "courses": out}


def encrypt(payload: dict, jwk: dict) -> dict:
    pub = ec.EllipticCurvePublicNumbers(
        int.from_bytes(unb64u(jwk["x"]), "big"), int.from_bytes(unb64u(jwk["y"]), "big"), ec.SECP256R1()
    ).public_key()
    eph = ec.generate_private_key(ec.SECP256R1())
    shared = eph.exchange(ec.ECDH(), pub)
    key = HKDF(algorithm=hashes.SHA256(), length=32, salt=bytes(32), info=INFO).derive(shared)
    iv = os.urandom(12)
    ct = AESGCM(key).encrypt(iv, json.dumps(payload, separators=(",", ":")).encode(), None)
    nums = eph.public_key().public_numbers()
    return {
        "v": 1,
        "kid": jwk["x"][:12],
        "updated": payload["scraped"],
        "epk": {"kty": "EC", "crv": "P-256", "x": b64u(nums.x.to_bytes(32, "big")), "y": b64u(nums.y.to_bytes(32, "big"))},
        "iv": b64u(iv),
        "ct": b64u(ct),
    }


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) != 1:
        sys.exit("usage: build_grades.py RAW_JSON [--print]  (keep RAW_JSON outside the repo)")
    raw_path = os.path.abspath(args[0])
    if raw_path.startswith(ROOT + os.sep):
        sys.exit("The raw pull must live outside the repo: the repo is public.")
    raw = json.load(open(raw_path))
    courses = json.load(open(os.path.join(ROOT, "data/courses.json")))
    jwk = json.load(open(os.path.join(ROOT, "data/grades-key.json")))
    if not jwk.get("x"):
        sys.exit("No grades key yet: Dylan needs to tap 'Create key' in the Grades tab first.")
    built = build(raw, courses)
    if "--print" in sys.argv:
        print(json.dumps(built, indent=1))
        return
    with open(os.path.join(ROOT, "data/grades.enc.json"), "w") as f:
        json.dump(encrypt(built, jwk), f, indent=2)
        f.write("\n")
    for c in built["courses"]:
        g, k = c["grade"], c["counts"]
        cur = f'{g["current"]}% ({g["letter"]})' if g["current"] is not None else "n/a"
        print(f'{c["code"]}: {cur}, range {g["floor"]}–{g["ceiling"]}, {g["gradedShare"]}% graded · '
              f'{k["missing"]} missing · {k["flagged"]} flagged · {k["check"]} to check · {k["submitted"]} awaiting')


if __name__ == "__main__":
    main()
