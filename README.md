# Dylan's Dashboard

A daily operating system for school and side business. Live at https://driegs17-alt.github.io/dashboard/

## How it's organized

| Tab | What it's for | Borrowed from |
|-----|---------------|---------------|
| **Today** | The one thing to do first, Today's 3, your streak, and quick capture | "Eat the frog" (do the hardest, most urgent thing first), the Ivy Lee method (a short ordered list, done top to bottom), "don't break the chain" (a daily streak for consistency), and GTD-style capture (get it out of your head) |
| **Week** | Two-week load strip, the Sunday weekly reset, and every deadline | GTD weekly review, plus Eisenhower-style triage: what's urgent now vs. what's handled for later |
| **Apply** | One card per job/internship application: checklist with dates, how to send, notes, plus the master materials library | Treat applications like projects: one owner, dated steps, a clear finish line |
| **Classes** | One card per course with its next deadline and an eLC link | Reference only |
| **Grades** | Overall grade per class (from eLC's categories and weights), the best/worst-case range, and every missing, flagged or awaiting-grade item | Know where you stand before it's a surprise |
| **Business** | Product tests and Athens web leads | Protect focus: school first, then one focused business block |
| **Agents** | Hand any task to Claude (⇢ button). An hourly Claude run splits it across subagents and posts the result here | Delegate what doesn't need you |

## How it stays up to date

- **eLC deadlines** sync automatically every 15 minutes (`.github/workflows/sync-elc.yml` → `data/deadlines.json`). Don't edit that file by hand.
- **Check-offs, Today's 3 picks and new tasks** save from the site once a device is connected (Connect button, one-time GitHub key).
- **Morning brief** arrives as a push notification each morning.
- **Agents**: jobs queue in `data/agent.json`; a scheduled Claude run follows `agent/RUNNER.md` and writes results to `agent/results/`.
- **Grades**: a Claude run reads your gradebook in eLC (`agent/GRADES.md`) and saves it **encrypted** in `data/grades.enc.json`. Unlock it once per device with your grades key (`gk1-…`). The math is in `scripts/build_grades.py`.

## Files you can edit (in VS Code or on GitHub)

| File | What it controls |
|------|------------------|
| `data/tasks.json` | Your own tasks (`due` is `YYYY-MM-DD` or `null`) |
| `data/courses.json` | Class cards |
| `data/leads.csv` | Athens web leads (`website`: an address, `no`, or blank if unchecked) |
| `data/products.json` | Product ideas |
| `data/applications.json` | Applications (steps with dates show up in Today and Week) and the materials library |

`data/done.json` and `data/plan.json` are written by the site. `index.html`, `css/` and `js/` are the design and logic.

## Previewing on your Mac

Install the **Live Server** extension in VS Code, then right-click `index.html` → **Open with Live Server**.

> This repo and site are public. Don't put passwords, grades, or anything private in these files. (Grades only ever go in encrypted.)
