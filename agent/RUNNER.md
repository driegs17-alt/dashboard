# Agent runner: how Claude works the dashboard queue

The dashboard's **Agents** tab writes jobs to `data/agent.json`. A scheduled Claude task ("Dashboard agents") runs this file every hour, 8 AM to midnight ET. Any Claude session can also run it by hand ("work my dashboard queue").

## Job shape (`data/agent.json`)

```json
{
  "id": "job-…",
  "type": "prep | research | draft | plan | custom",
  "item": { "id": "…", "title": "…", "course": "ECON 2105", "due": "ISO date or null", "url": "eLC link", "note": "…", "parts": [{ "id": "…", "title": "…" }] },
  "ask": "Dylan's instructions (may be empty)",
  "replies": [{ "at": "ISO", "text": "Dylan's answer to an earlier question" }],
  "status": "queued | working | needs-you | done | failed | cancelled | archived",
  "requested": "ISO", "started": "ISO", "asked": "ISO", "finished": "ISO",
  "question": "what Claude needs from Dylan (needs-you only)",
  "summary": "one or two lines shown on the card",
  "result": "agent/results/<id>.md",
  "agents": 3
}
```

## Each run

1. **Get the repo.** Clone `driegs17-alt/dashboard` (shallow is fine). If the session doesn't have it, attach it with push access first.
2. **Pick jobs.** Take `status: "queued"` jobs, oldest `requested` first, up to 6. Nothing queued → stop quietly (no commit, no notification).
3. **Claim them.** Set `status: "working"`, `started: now`. Commit `Claude: started N jobs` and push right away, so the dashboard shows they're moving.
4. **Fan out.** Start one subagent per job, all in parallel. A job with `parts` (a bundle, e.g. a chapter's worth of modules) may get one subagent per natural chunk (e.g. per chapter); the lead merges their output into one result. Give each subagent: the job JSON, the matching course from `data/courses.json`, today's date, the rules below, and the result file path. Record the number of subagents used in `agents`.
5. **Finish each job.**
   - Success → write `agent/results/<id>.md`, set `status: "done"`, `finished: now`, `result`, and a 1–2 line `summary` (what's in it, the one thing to do next).
   - Blocked → `status: "needs-you"`, `asked: now`, a short, specific `question` (what's needed and why, with a yes/no or a choice where possible). Write any partial work to the result file and set `result` too.
   - Broken → `status: "failed"` with a `summary` that says why in plain words.
6. **Save.** Validate `data/agent.json` parses. Commit `Claude: finished N jobs` (pull --rebase first; the site and the eLC robot also write to this repo; retry up to 3 times). Only touch `data/agent.json` and `agent/results/`.
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
| Research (leads, products, competitors, jobs) | `deep-research`; `marketing:competitive-brief` for product/market questions | Google Sheets for the Athens leads / product trackers |
| Lead outreach, application emails, instructor emails | `marketing:content-creation`, `marketing:email-sequence` | Gmail (drafts only, never sends) |
| Plan / break it down | `productivity:task-management` | Google Calendar (proposes focus blocks; adds them only after Dylan says yes) |
| Study prep | `xlsx`/`docx`/`pdf` only if a file helps | Google Drive for Dylan's own notes |
| Portfolio, case studies, design feedback | `design:design-critique`, `design:ux-copy`, `design-superpowers:design-review` | Figma, Adobe |
| E-commerce | `marketing:campaign-plan`, `liquid-dev:theme-dev` once a store exists | Shopify (once a store exists) |
| Anything producing a spreadsheet, doc or deck | `xlsx`, `docx`, `pptx`, `pdf` | Google Drive to save it where Dylan asked |

## Result file format

Markdown, readable on a phone. Start with a one-paragraph "Bottom line", then the work. The dashboard renders headings, lists, checkboxes (`- [ ]`), tables, bold/italic, links, code and quotes. Keep it scannable; long is fine only when it's reference material (like a crash sheet).

### Type guides

- **prep**: Bottom line → key terms (one line each) → formulas/models with when to use them → 2–4 worked examples of the kind of problem the course tests (made up, not copied from the graded set) → common traps → a 5-question self-check with answers at the bottom → a suggested order and time box for the actual assignments.
- **research**: Bottom line → findings (table if comparing) → recommended next step → Sources.
- **draft**: Bottom line → the draft, ready to edit → notes on choices made. Never sent.
- **plan**: Bottom line → steps as `- [ ]` checkboxes with dates and time estimates, working back from the due date → first 25-minute step.
- **custom**: follow `ask`; if unclear, ask one question via `needs-you`.
