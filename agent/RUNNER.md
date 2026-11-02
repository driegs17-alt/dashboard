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
  "deliver": "auto | drive | adobe | both  (where Dylan wants the files; missing = auto)",
  "folder": { "drive": "https://drive.google.com/drive/folders/…", "driveId": "…" },
  "steer": [{ "at": "ISO", "text": "a note Dylan sent while the job was running", "seen": "ISO, set by Claude" }],
  "stop": true,
  "progress": "one line: what's happening right now",
  "log": [{ "at": "ISO", "msg": "short progress line" }],
  "status": "queued | working | needs-you | done | failed | cancelled | archived",
  "requested": "ISO", "started": "ISO", "asked": "ISO", "finished": "ISO",
  "question": "what Claude needs from Dylan (needs-you only)",
  "summary": "one or two lines shown on the card",
  "result": "agent/results/<id>.md  (or <id>.enc.json when private)",
  "outputs": [{ "title": "Oral history outline", "kind": "folder | doc | sheet | deck | adobe | pdf | image | file | draft | calendar | figma | link", "url": "https://… (Drive, Adobe Express, Gmail drafts, Calendar, Figma)", "path": "agent/outputs/<id>/… (only when Drive/Adobe refused; see Deliverables)", "note": "optional one line" }],
  "agents": 3
}
```

## Each run

1. **Get the repo.** Clone `driegs17-alt/dashboard` (shallow is fine). If the session doesn't have it, attach it with push access first.
2. **Pick jobs.** Take `status: "queued"` jobs, oldest `requested` first, up to 6. Nothing queued → stop quietly (no commit, no notification).
   - **Preflight the file homes** (once per run, before claiming): Google Drive `get_file_metadata` on the Claude Agents folder (`1P2SPYbanobiE66uEyoxCDvqHVUB4172C`), and Adobe `adobe_mandatory_init`. If Drive refuses (permission / access error), send one push notification right away: "Google Drive refused access to Claude. Re-approve it in claude.ai → Settings → Connectors so your job files can land in Drive." Keep working; see "If a home refuses" under Deliverables.
3. **Claim them.** Set `status: "working"`, `started: now`, `progress: "Starting"`, and a first `log` line. Commit `Claude: started N jobs` and push right away, so the dashboard shows they're moving. Two runs can overlap (an instant run and the hourly one): if after `pull --rebase` a job is no longer `queued`, another run owns it; drop it from yours.
   - **Open attachments.** For each claimed job with `files`, run `python3 scripts/agent_files.py open <id> /tmp/agent-files/<id>` with `AGENT_FILES_KEY` set (the key is in the scheduled task's instructions; never write it anywhere). Decrypted files must stay in `/tmp`, never in the repo, a commit, a log line or a notification. Read them with the fitting skill (`file-reading`, `pdf-reading`, `docx`, `xlsx`, `pptx`; images with Read). `links.txt` holds links to read: fetch public pages with WebFetch, Google Docs/Sheets/Drive links with the Google Drive/Sheets connectors, Figma links with Figma. Links behind a school login (eLC, Achieve) are off limits per the rules below; say so in the result.
4. **Fan out.** Start one subagent per job, all in parallel. A job with `parts` (a bundle, e.g. a chapter's worth of modules) may get one subagent per natural chunk (e.g. per chapter); the lead merges their output into one result. Give each subagent: the job JSON, the matching course from `data/courses.json`, today's date, the rules below, and the result file path. Record the number of subagents used in `agents`. Hand each subagent the paths of its job's decrypted files.
   - **Live updates.** The Agents tab polls every 20 s while a job is working. The lead (not the subagents) keeps it current: update `progress` and append a short `log` line (max ~12 kept per job) when a subagent starts, finishes a meaningful chunk, or hits a problem, then commit `Claude: progress` and push (pull --rebase first). At most one progress push every ~2 minutes; batch lines across jobs. Log lines are public: no private file contents, names from attachments, emails or calendar details.
   - **Steering and stop.** Before each new step and before writing a result, `git pull --rebase` and re-read the job. New `steer` entries (no `seen`) are Dylan redirecting the work mid-run: pass them to the job's subagent (SendMessage), set `seen: now`, and log "Got your note: …" in a few words. `stop: true` means wrap up now: stop that job's subagent, save what exists as the result, set `status: "cancelled"` with a summary of what got done.
   - **Urgent blocker.** If a subagent hits something only Dylan can fix (a login, a missing connector, a decision) and other work can continue, set that job to `needs-you` right away with its question, push, and send a push notification then; don't wait for the end of the run.
5. **Finish each job.**
   - **Deliver the files first** (see Deliverables below): every job that finishes or stops with work in hand puts its full work into Google Drive and/or Adobe Creative Cloud, in the format that fits the subject, before it's marked anything.
   - Success → write `agent/results/<id>.md` as the **cover note** (Bottom line → "Your files" with one line per file saying what's in it and how to use it → the one next step). The full work lives in the files, not the repo. Set `status: "done"`, `finished: now`, `result`, `outputs`, `folder`, and a 1–2 line `summary` (what's in the files, the one thing to do next).
   - **Private jobs** (`private: true`, i.e. Dylan attached files or links): the Drive/Adobe files can hold the full private work (they're private to Dylan). Write the cover note to `/tmp/agent-files/<id>/result.md`, then `python3 scripts/agent_files.py seal-result <id> /tmp/agent-files/<id>/result.md`, which writes `agent/results/<id>.enc.json`, encrypted to Dylan's key. Set `result` to that path. Never commit the plain Markdown. Keep the `summary`, `question`, `log`, output titles and Drive/Adobe file names free of anything from the attachments (titles are public in `agent.json`).
   - **Outputs.** List every file the job made in `outputs`, job folder first (the cover note is shown automatically; don't list it): Drive job folder → `kind: "folder"`; Google Doc → `doc`; Google Sheet → `sheet`; Google Slides → `deck`; Adobe Express design → `adobe` (the editor URL); PDF → `pdf`; PNG/JPG/SVG → `image`; Gmail drafts → `draft` with `https://mail.google.com/mail/u/0/#drafts`; calendar events → `calendar` with the event's `htmlLink`. Every `url` is the file's real link from the tool result (`viewUrl` for Drive), never a guess. `path` is only for the refused-home fallback below.
   - Blocked → `status: "needs-you"`, `asked: now`, a short, specific `question` (what's needed and why, with a yes/no or a choice where possible). Put the partial work in the job's Drive/Adobe files (marked DRAFT at the top), list them in `outputs`, and write the cover note to `result` too.
   - Broken → `status: "failed"` with a `summary` that says why in plain words.
6. **Save.** Validate `data/agent.json` parses. Commit `Claude: finished N jobs` (pull --rebase first; the site and the eLC robot also write to this repo; retry up to 3 times). Only touch `data/agent.json`, `agent/results/` and `agent/outputs/`. Delete `/tmp/agent-files/<id>` when a job is done, failed or cancelled.
7. **Tell Dylan.** One push notification if anything finished or needs him: e.g. "2 Claude jobs done (Macro Ch. 11 crash sheet, Athens leads). 1 needs you: approve Google Drive?" Link: https://driegs17-alt.github.io/dashboard/#agents

## Deliverables: full files in Google Drive or Adobe Creative Cloud

Every job hands back **real, finished files** in Dylan's own apps, not just a Markdown report. The dashboard links to them from the job card and the Outputs tab.

### Where they go

**Google Drive** (account dtr16854@uga.edu), folder **Claude Agents** (`1P2SPYbanobiE66uEyoxCDvqHVUB4172C`):

| Area | Folder id | Use for |
|---|---|---|
| Classes | `1q8LISjyhvI-DW016Pza92uUelrRG1EKE` | anything with a `course`; put it in a course subfolder named like `ARGD 4115 Pro Practices` (find it with `search_files` `parentId = '<Classes id>' and title = '…'`; create it if missing) |
| Portfolio & Design | `1XILBeuzzPDBjjudGAYczJZK9NpWuvww2` | portfolio, case studies, design feedback, design PDFs/PNGs |
| Applications | `1hp49SAkWbfftrbBfOH91QzVFEpVqC4HA` | jobs, internships, resumes, cover letters |
| Business | `1WzqJ1QqNB4Bll-27jtutl0n-aJO_WRBL` | Athens web leads, e-commerce, products, outreach |
| Plans & Advice | `1223KNoeSSjmD4Plh5VCl_lL5a3FV7Y8W` | plans, advice, anything else |

Each job gets its own folder inside its area: `YYYY-MM-DD <job title>` (ET date the job was requested; for private jobs a generic title like `2026-11-03 History outline`). If the job already has `folder.driveId` (a re-run after a reply), reuse it. Save `folder: {drive: viewUrl, driveId}` on the job.

**Adobe Creative Cloud** (folder **Claude Agents** with `Design`, `Portfolio`, `Classes`, `Business`): visual work. Express designs are created with `export_html_to_express` (`docName` = `<job title> – <what it is>`); they land in Dylan's Adobe Express files.

### Pick the format by what the work *is* (`deliver: "auto"`)

| The work | Main file | Also |
|---|---|---|
| Study prep: crash sheet, study guide, concept explainer, outline | Google Doc | Google Sheet of flashcards/practice Qs (Front · Back · Topic) when there are 15+ |
| Writing: drafts, outlines, essays-in-progress, case study copy, memos | Google Doc | — |
| Resume, cover letter, handout, anything to print or submit | Google Doc (editable) | PDF of it in the same folder |
| Research comparing things, lead lists, product research, prices | Google Sheet (one row per item, sources column) | Google Doc summary if there's a recommendation |
| Athens leads / existing trackers | append to the existing sheet named in the job or `data/` (never overwrite rows) | Doc summary of what was added |
| Budgets, models, trackers, schedules with math | Google Sheet with working formulas | — |
| Plans / break it down | Google Doc checklist (☐ steps with dates + time estimates) | calendar events only after Dylan says yes |
| Advice / decisions | Google Doc memo | — |
| Presentations: class talks, pitches | Google Slides | for design classes (ARGD) or a pitch where looks matter: Adobe Express deck instead |
| Visual design: poster, flyer, social graphic, infographic, brand/type board, portfolio page or layout, mockup, logo concept sheet | **Adobe Express design** | PDF or PNG export in the Drive job folder (so it opens anywhere) |
| Emails / outreach | Gmail draft (never sent) | copy of all drafts in one Google Doc when there are several |
| Photo, video or audio edits | Adobe (image/video tools) | needs the source in Creative Cloud; if Dylan didn't give one, `needs-you` asking him to put it in CC › Claude Agents |

`deliver: "drive"` → everything in Drive (visual designs as PDF + PNG). `deliver: "adobe"` → visual work and documents as Adobe Express designs (multi-page Express doc for writing); spreadsheets still go to Drive (Adobe has no spreadsheet), say so in the cover note. `deliver: "both"` → the main file in its best home plus a copy in the other (Doc ⇄ Express doc/PDF).

Make the files complete and good-looking: real headings, tables, page-ready formatting, Dylan's name/course where it belongs. A file is "full" when he could use it as-is without the dashboard.

### How to make each kind (cloud run)

- **Google Doc**: write clean HTML (h1/h2, p, ul/ol, table, b/i, links; ☐ for checkboxes) and `create_file` with `contentMimeType: "text/html"`, `textContent`, `parentId` = job folder. It converts to a native Google Doc with the formatting intact. For heavy layout, build a .docx with the `docx` skill and upload `base64Content` with the docx MIME type (converts to a Doc).
- **Google Sheet**: simple table → `text/csv` `textContent` (converts to a Sheet). Formulas, several tabs, formatting → build .xlsx with the `xlsx` skill, upload `base64Content` with `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`. Editing an existing sheet → Google Sheets connector (`append_values`, `update_values`).
- **Google Slides**: build .pptx with the `pptx` skill, upload `base64Content` with the pptx MIME type (converts to Slides).
- **PDF / PNG**: render locally (Chromium/Playwright is installed: print HTML to PDF, screenshot to PNG; or the `pdf` skill), then upload with `disableConversionToGoogleType: true` and the real MIME type. Keep uploads under ~10 MB (compress images).
- **Adobe Express design**: `adobe_mandatory_init` → `create_visual_design_express_skill` (follow it; the destination is already decided, don't ask) → fonts via `suggest_type_palettes`/`get_fontkit_embed_url` → HTML → `html_export_readiness_skill` → `export_html_to_express` → check the returned slides kept the text and fonts → output `kind: "adobe"` with the editor URL. Render the same HTML to PDF/PNG for the Drive copy.
- **Binary file into Creative Cloud** (PNG, PDF, SVG): `asset_initialize_file_upload` with `path: "Claude Agents/<Design|Portfolio|Classes|Business>/<file>"`, PUT the bytes to the transfer link, `asset_finalize_file_upload`. The upload host (`at.adobe.com`) is outside this workspace's network allowlist as of Nov 2, so the PUT is refused: try once, then keep the file in the Drive job folder and note "CC copy skipped (network)" in the log. Express designs are not affected.
- **Check before listing**: every `create_file` result must show the expected `mimeType` (e.g. `application/vnd.google-apps.document`) and the job folder as `parentId`; every Express export must return an editor URL. Only list what really exists.

### If a home refuses

If Drive or Adobe returns a permission / access / auth error: retry once. Still refused → don't drop the work. Save each finished file to `agent/outputs/<id>/` (private jobs: `python3 scripts/agent_files.py seal-output <id> <file>`), list them with `path`, set the job to `needs-you` with `question`: "Google Drive refused access, so your files are parked on the dashboard for now. Re-approve Google Drive for Claude (claude.ai → Settings → Connectors), then reply 'retry'." On the next run, a reply on such a job means: upload the parked files to their proper home (open sealed ones with `scripts/agent_files.py`), swap `path` for `url` in `outputs`, delete the parked copies, mark done.

## Rules for every job

- **Public repo.** Results are visible to anyone. Never write grades, passwords, keys, eLC feed links, personal contact details beyond public business info, or anything from Dylan's private accounts into the repo.
- **Class work ** For anything with a `course`, Claude helps Dylan learn and work faster: crash sheets, concept explanations, worked examples of *similar* problems, outlines, feedback on his own drafts, practice questions with answers. Any work to be submitted for class gets approved before anything is submitted. 
- **Connectors and logins.** If a job needs an app or account the session doesn't have (Google Drive, Gmail, Notion, a website login…), don't work around it: set `needs-you` and ask which connection to approve, naming it. Dylan has said he'll approve connectors when asked.
- **Anything outward-facing waits for approval.** Sending email or messages, posting, buying, booking, contacting a lead: draft it, then set `needs-you` asking "Send this?" Never send on the first pass.
- **Research gets sources.** End research results with a `Sources` list of links.
- **Replies.** If `replies` exist, the latest reply answers the previous `question`. Pick up where the partial result left off.

## Skills and connectors to use

Before starting a job, the subagent loads the skills that fit (Skill tool) and uses connected apps instead of rebuilding things by hand. If a connector below isn't connected yet, the job goes to `needs-you` naming it. Subagents make the files themselves (they have the same connectors) and hand the lead the list of `outputs`; give each subagent its job folder id and the Deliverables section.

| Job | Skills | Connectors |
|---|---|---|
| Advice ("Ask Claude" on Today, weekly business review) | `ease-os:sparring-partner` (pressure-test before recommending); `gia-chief-of-staff:ops-check` for "catch me up" questions | Google Calendar + Gmail (read) for context, Google Sheets for leads |
| Research (leads, products, competitors, jobs) | `deep-research`; `marketing:competitive-brief`; Small Business `lead-finder` / Sales `account-research` if installed | Google Sheets for the Athens leads / product trackers |
| Lead outreach, application emails, instructor emails | `marketing:content-creation`, `marketing:email-sequence`; Small Business `outreach-composer` / `proposal-builder` or Sales `draft-outreach` if installed | Gmail (drafts only, never sends) |
| Plan / break it down | `productivity:task-management` | Google Calendar (proposes focus blocks; adds them only after Dylan says yes) |
| Study prep | `docx`/`xlsx` for richer Docs/Sheets | Google Drive (Dylan's own notes in; the crash sheet Doc + flashcard Sheet out) |
| Portfolio, case studies, design feedback, any visual design | `design:design-critique`, `design:ux-copy`, `design-superpowers:design-review`; Adobe `create_visual_design_express_skill` | Figma (read), Adobe Express (designs out), Google Drive (copy + PDF/PNG) |
| E-commerce | `marketing:campaign-plan`, `liquid-dev:theme-dev` once a store exists | Shopify (once a store exists) |
| Every job (the deliverable) | `docx`, `xlsx`, `pptx`, `pdf` as needed | Google Drive and/or Adobe per **Deliverables** above |

## Approvals (needs-you → yes)

Some jobs stop to ask before doing something outside the dashboard. On a later run, when the job is back in the queue with a reply:
- **Calendar:** if the result proposed focus blocks and the latest reply clearly says yes (or "yes except …"), create exactly those events in Google Calendar (title prefixed "Focus: ", 10-minute popup reminder), then mark the job done with a summary like "Added 5 focus blocks". Anything unclear → ask again.
- **Gmail drafts:** Claude never sends. If Dylan replies "send it", answer: "Open Gmail → Drafts and hit send; I can't send for you." and mark done.
- **Sheets:** edits a job asked for are part of the job; no extra approval needed, but never delete or overwrite Dylan's rows.

## Private data

Results are in a public repo. Advice and plans can use what's in Dylan's calendar and inbox, but the result file must not quote emails, name private contacts, or list his calendar events. Summarize ("you have two evening commitments Tuesday") and keep specifics in Gmail drafts or the push notification instead.

## Result file format

Two layers. **The files** (Drive/Adobe) hold the full work, structured by the type guides below. **The cover note** (`agent/results/<id>.md`) is Markdown, readable on a phone: a one-paragraph "Bottom line", "Your files" (one line each), then the next step. Partial work on `needs-you` jobs still goes into the files. The dashboard renders headings, lists, checkboxes (`- [ ]`), tables, bold/italic, links, code and quotes. Keep it short; the reference material belongs in the files.

### Type guides

- **prep**: Bottom line → key terms (one line each) → formulas/models with when to use them → 2–4 worked examples of the kind of problem the course tests (made up, not copied from the graded set) → common traps → a 5-question self-check with answers at the bottom → a suggested order and time box for the actual assignments.
- **research**: Bottom line → findings (table if comparing) → recommended next step → Sources.
- **draft**: Bottom line → the draft, ready to edit → notes on choices made. Never sent.
- **plan**: Bottom line → steps as `- [ ]` checkboxes with dates and time estimates, working back from the due date → first 25-minute step. If Google Calendar is connected, read his calendar and propose focus blocks in free time (a table: day, start–end, what), then set `needs-you` with "Add these N focus blocks to your calendar?" Don't add them yet.
- **advise**: Executive-assistant tone, direct and warm, no hedging filler. Bottom line (the recommendation in one or two sentences) → why (3 bullets max, tied to his actual deadlines, grades counts he mentioned, calendar load, money) → what you might be missing (pressure-test it: risks, the strongest counter-argument, what would change the answer) → next step he can do in under 30 minutes → confidence (high / medium / low and why). If the question is really a decision only he can make (values, relationships), lay out the options and trade-offs instead of picking.
- **custom**: follow `ask`; if unclear, ask one question via `needs-you`.
