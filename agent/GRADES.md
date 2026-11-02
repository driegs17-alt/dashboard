# Grades refresh: how Claude updates the Grades tab

The Grades tab reads `data/grades.enc.json`, which is **encrypted** to the public key in `data/grades-key.json`. Only devices holding Dylan's grades key (`gk1-…`) can read it. The key is created on his device (Grades tab → Create key); only its public half is in the repo. Claude never has the private key. The repo is public, so **plain grades never go in the repo**, not even for a moment.

Runs on the scheduled task "Grades refresh" (needs Dylan's computer for the built-in browser) or by hand ("refresh my grades").

## Steps

1. **Repo.** Clone `driegs17-alt/dashboard` (attach it with push access if the session doesn't have it).
2. **eLC tab.** In the built-in browser on Dylan's computer, open `https://uga.view.usg.edu/d2l/home`. If it lands on the UGA login page, stop: send Dylan one push notification ("eLC signed you out. Open the Claude app's browser and sign in, then say 'refresh my grades'"). Never type his password or approve Duo.
3. **Pull.** Run `scripts/elc_grades.js` in that tab with the browser's JavaScript tool, after replacing `__OUS__` with `{code: ou}` from `data/courses.json` (the number at the end of each `elc` link), and prefixing `window.__grades = await` so the result stays in the page. It only makes read-only GET calls to eLC's API.
4. **Compact it in the page** (same compaction used on Nov 2, 2026): for each course keep `code`, `sys` (GradingSystem), `nz` (IsNullGradeZero), `cats` as `[id, name, weight, dropLow, dropHigh, excluded]`, `items` as `[name, catId, max, weight, score|null, due (YYYY-MM-DDTHH:MM, UTC) |null, submitted (null = not a dropbox, 0 = empty dropbox, or time), eLCoverdue 0/1, flags (1 bonus, 2 excluded), hasFeedback 0/1]`, and `loose` dropboxes not tied to a grade item as `[name, due, submitted]`. Due dates come from the item's dropbox or quiz, else a calendar event or eLC overdue entry with the same normalized title. Store as `window.__compact`; then read `JSON.stringify(window.__compact)`.
5. **Copy out, verified.** Write that JSON to a file **outside the repo** (e.g. `/tmp/grades-raw.json`). Check the length and CRC-32 of the compact JSON match what the page reports (compute both in the page and in Python); if they don't, fetch it again in two halves.
6. **Build + encrypt.** `python3 scripts/build_grades.py /tmp/grades-raw.json` (pip install `cryptography` if needed). It prints one line per class. Delete the raw file afterwards.
7. **Save.** Commit only `data/grades.enc.json` ("Refresh grades"), pull --rebase, push.
8. **Tell Dylan** (one push notification) only if something changed that needs him: a new missing or flagged item, or a class moving a letter grade. Use the printed summary lines; never put scores in a public place.

## What the statuses mean

See the docstring at the top of `scripts/build_grades.py`. Short version: *missing* = past due and nothing turned in; *flagged* = turned in but eLC shows a 0 or still says overdue; *check* = done outside eLC with no grade yet; *cleared* = graded fine but eLC's overdue list hasn't caught up.

## Overall grade

Worked out from each class's gradebook setup in eLC: weighted classes use category weights and drop-lowest rules, points classes use earned / possible, and custom-formula classes (Type & Image) aren't estimated. Three numbers: **current** (graded work only), **floor** (if nothing else is turned in) and **ceiling** (if everything left is perfect), plus how much of the class has been graded so far.
