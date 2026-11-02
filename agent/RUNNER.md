# Agent runner: how Claude works the dashboard queue

The dashboard's **Agents** tab writes jobs to `data/agent.json`. A scheduled Claude task ("Dashboard agents") runs this file as soon as a job is queued (the GitHub Action `.github/workflows/run-agents.yml` starts it whenever `data/agent.json` gains a queued job) and also every hour, 8 AM to midnight ET, as a backup. Any Claude session can also run it by hand ("work my dashboard queue").

## Job shape (`data/agent.json`)

```json
{
  "id": "job-…",
  "type": "prep | research | draft | plan | advise | custom",
  "item": { "id": "…", "title": "…", "course": "ECON 2105", "due": "ISO date or null", "url": "eLC link", "note": "…", "parts": [{ "id": "…", "title": "…" }] },
  "ask": "Dylan's instructions (may be empty)",
  "replies": [{ "at": "ISO", "text": "Dylan's answer to an earlier question", "files": 2 }],
  "files": [{ "path": "data/uploads/<id>/01.enc.json", "kind": "file | links", "size": 12345 }],
  "private": true,
  "steer": [{ "at": "ISO", "text": "a note Dylan sent while the job was running", "seen": "ISO, set by Claude" }],
  "stop": true,
  "progress": "one line: what's happening right now",
  "log": [{ "at": "ISO", "msg": "short progress line" }],
  "status": "queued | working | needs-you | done | failed | cancelled | archived",
  "requested": "ISO", "started": "ISO", "asked": "ISO", "finished": "ISO",
  "question": "what Claude needs from Dylan (needs-you only)",
  "summary": "one or two lines shown on the card",
  "result": "agent/results/<id>.md  (or <id>.enc.json when private)",
  "agents": 3
}
```

## Each run

1. **Get the repo.** Clone `driegs17-alt/dashboard` (shallow is fine). If the session doesn't have it, attach it with push access first.
2. **Pick jobs.** Take `status: "queued"` jobs, oldest `requested` first, up to 6. Nothing queued → stop quietly (no commit, no notification).
3. **Claim them.** Set `status: "working"`, `started: now`, `progress: "Starting"`, and a first `log` line. Commit `Claude: started N jobs` and push right away, so the dashboard shows they're moving. Two runs can overlap (an instant run and the hourly one): if after `pull --rebase` a job is no longer `queued`, another run owns it; drop it from yours.
   - **Open attachments.** For each claimed job with `files`, run `python3 scripts/agent_files.py open <id> /tmp/agent-files/<id>` with `AGENT_FILES_KEY` set (the key is in the scheduled task's instructions; never write it anywhere). Decrypted files must stay in `/tmp`, never in the repo, a commit, a log line or a notification. Read them with the fitting skill (`file-reading`, `pdf-reading`, `docx`, `xlsx`, `pptx`; images with Read). `links.txt` holds links to read: fetch public pages with WebFetch, Google Docs/Sheets/Drive links with the Google Drive/Sheets connectors, Figma links with Figma. Links behind a school login (eLC, Achieve) are off limits per the rules below; say so in the result.
4. **Fan out.** Start one subagent per job, all in parallel. A job with `parts` (a bundle, e.g. a chapter's worth of modules) may get one subagent per natural chunk (e.g. per chapter); the lead merges their output into one result. Give each subagent: the job JSON, the matching course from `data/courses.json`, today's date, the rules below, and the result file path. Record the number of subagents used in `agents`. Hand each subagent the paths of its job's decrypted files.
   - **Live updates.** The Agents tab polls every 20 s while a job is working. The lead (not the subagents) keeps it current: update `progress` and append a short `log` line (max ~12 kept per job) when a subagent starts, finishes a meaningful chunk, or hits a problem, then commit `Claude: progress` and push (pull --rebase first). At most one progress push every ~2 minutes; batch lines across jobs. Log lines are public: no private file contents, names from attachments, emails or calendar details.
   - **Steering and stop.** Before each new step and before writing a result, `git pull --rebase` and re-read the job. New `steer` entries (no `seen`) are Dylan redirecting the work mid-run: pass them to the job's subagent (SendMessage), set `seen: now`, and log "Got your note: …" in a few words. `stop: true` means wrap up now: stop that job's subagent, save what exists as the result, set `status: "cancelled"` with a summary of what got done.
   - **Urgent blocker.** If a subagent hits something only Dylan can fix (a login, a missing connector, a decision) and other work can continue, set that job to `needs-you` right away with its question, push, and send a push notification then; don't wait for the end of the run.
5. **Finish each job.**
   - Success → write `agent/results/<id>.md`, set `status: "done"`, `finished: now`, `result`, and a 1–2 line `summary` (what's in it, the one thing to do next).
   - **Private jobs** (`private: true`, i.e. Dylan attached files or links): write the Markdown to `/tmp/agent-files/<id>/result.md`, then `python3 scripts/agent_files.py seal-result <id> /tmp/agent-files/<id>/result.md`, which writes `agent/results/<id>.enc.json`, encrypted to Dylan's key. Set `result` to that path. Never commit the plain Markdown. Keep the `summary`, `question` and `log` free of anything from the attachments (they're public).
   - Blocked → `status: "needs-you"`, `asked: now`, a short, specific `question` (what's needed and why, with a yes/no or a choice where possible). Write any partial work to the result file and set `result` too.
   - Broken → `status: "failed"` with a `summary` that says why in plain words.
6. **Save.** Validate `data/agent.json` parses. Commit `Claude: finished N jobs` (pull --rebase first; the site and the eLC robot also write to this repo; retry up to 3 times). Only touch `data/agent.json` and `agent/results/`. Delete `/tmp/agent-files/<id>` when a job is done, failed or cancelled.
7. **Tell Dylan.** One push notification if anything finished or needs him: e.g. "2 Claude jobs done (Macro Ch. 11 crash sheet, Athens leads). 1 needs you: approve Google Drive?" Link: https://driegs17-alt.github.io/dashboard/#agents

## Rules for every job

- **Public repo.** Results are visible to anyone. Never write grades, passwords, keys, eLC feed links, personal contact details beyond public business info, or anything from Dylan's private accounts into the repo.
- **Class work is prep, not doing.** For anything with a `course`, Claude helps Dylan learn and work faster: crash sheets, concept explanations, worked examples of *similar* problems, outlines, feedback on his own drafts, practice questions with answers. Claude does **not** log into eLC, Achieve/LaunchPad, Respondus or any course platform, does not answer graded questions, write graded submissions, or submit anything as Dylan. If a job asks for that, do the prep version and say so in the `summary`.
- **Connectors and logins.** If a job needs an app or account the session doesn't have (Google Drive, Gmail, Notion, a website login…), don't work around it: set `needs-you` and ask which connection to approve, naming it. Dylan has said he'll approve connectors when asked.
- **Anything outward-facing waits for approval.** Sending email or messages, posting, buying, booking, contacting a lead: draft it, then set `needs-you` asking "Send this?" Never send on the first pass.
- **Research gets sources.** End research results with a `Sources` list of links.
- **Replies.** If `replies` exist, the latest reply answers the previous `question`. Pick up where the partial result left off.

## Skills and connectors to use

Before starting a job, the subagent loads the skills that fit (Skill tool) and uses connected apps instead of rebuilding things by hand. If a connector below isn't connected yet, the job goes to `needs-you` naming it.

| Job | Skills | Connectors |
|---|---|---|
| Advice ("Ask Claude" on Today, weekly business review) | `ease-os:sparring-partner` (pressure-test before recommending); `gia-chief-of-staff:ops-check` for "catch me up" questions | Google Calendar + Gmail (read) for context, Google Sheets for leads |
| Research (leads, products, competitors, jobs) | `deep-research`; `marketing:competitive-brief`; Small Business `lead-finder` / Sales `account-research` if installed | Google Sheets for the Athens leads / product trackers |
| Lead outreach, application emails, instructor emails | `marketing:content-creation`, `marketing:email-sequence`; Small Business `outreach-composer` / `proposal-builder` or Sales `draft-outreach` if installed | Gmail (drafts only, never sends) |
| Plan / break it down | `productivity:task-management` | Google Calendar (proposes focus blocks; adds them only after Dylan says yes) |
| Study prep | `xlsx`/`docx`/`pdf` only if a file helps | Google Drive for Dylan's own notes |
| Portfolio, case studies, design feedback | `design:design-critique`, `design:ux-copy`, `design-superpowers:design-review` | Figma, Adobe |
| E-commerce | `marketing:campaign-plan`, `liquid-dev:theme-dev` once a store exists | Shopify (once a store exists) |
| Anything producing a spreadsheet, doc or deck | `xlsx`, `docx`, `pptx`, `pdf` | Google Drive to save it where Dylan asked |

## Approvals (needs-you → yes)

Some jobs stop to ask before doing something outside the dashboard. On a later run, when the job is back in the queue with a reply:
- **Calendar:** if the result proposed focus blocks and the latest reply clearly says yes (or "yes except …"), create exactly those events in Google Calendar (title prefixed "Focus: ", 10-minute popup reminder), then mark the job done with a summary like "Added 5 focus blocks". Anything unclear → ask again.
- **Gmail drafts:** Claude never sends. If Dylan replies "send it", answer: "Open Gmail → Drafts and hit send; I can't send for you." and mark done.
- **Sheets:** edits a job asked for are part of the job; no extra approval needed, but never delete or overwrite Dylan's rows.

## Private data

Results are in a public repo. Advice and plans can use what's in Dylan's calendar and inbox, but the result file must not quote emails, name private contacts, or list his calendar events. Summarize ("you have two evening commitments Tuesday") and keep specifics in Gmail drafts or the push notification instead.

## Result file format

Markdown, readable on a phone. Start with a one-paragraph "Bottom line", then the work. The dashboard renders headings, lists, checkboxes (`- [ ]`), tables, bold/italic, links, code and quotes. Keep it scannable; long is fine only when it's reference material (like a crash sheet).

### Type guides

- **prep**: Bottom line → key terms (one line each) → formulas/models with when to use them → 2–4 worked examples of the kind of problem the course tests (made up, not copied from the graded set) → common traps → a 5-question self-check with answers at the bottom → a suggested order and time box for the actual assignments.
- **research**: Bottom line → findings (table if comparing) → recommended next step → Sources.
- **draft**: Bottom line → the draft, ready to edit → notes on choices made. Never sent.
- **plan**: Bottom line → steps as `- [ ]` checkboxes with dates and time estimates, working back from the due date → first 25-minute step. If Google Calendar is connected, read his calendar and propose focus blocks in free time (a table: day, start–end, what), then set `needs-you` with "Add these N focus blocks to your calendar?" Don't add them yet.
- **advise**: Executive-assistant tone, direct and warm, no hedging filler. Bottom line (the recommendation in one or two sentences) → why (3 bullets max, tied to his actual deadlines, grades counts he mentioned, calendar load, money) → what you might be missing (pressure-test it: risks, the strongest counter-argument, what would change the answer) → next step he can do in under 30 minutes → confidence (high / medium / low and why). If the question is really a decision only he can make (values, relationships), lay out the options and trade-offs instead of picking.
- **custom**: follow `ask`; if unclear, ask one question via `needs-you`.
