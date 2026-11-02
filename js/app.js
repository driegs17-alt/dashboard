/* ==========================================================
   Dylan's Dashboard: a daily operating system

   TODAY     One thing first (eat the frog), Today's 3 (Ivy Lee,
             trimmed to 3), a streak for consistency (don't break
             the chain), and quick capture so nothing lives in your head.
   WEEK      Two-week load strip, the Sunday weekly reset (GTD-style
             review) and every deadline, sorted by urgency.
   APPLY     Job and internship applications: a checklist per
             application (steps also show up in Today/Week), how to
             send it, and the master materials library.
   CLASSES   Reference: one card per course.
   BUSINESS  Product tests and Athens leads, for after Today's 3.
   AGENTS    Hand tasks to Claude. Jobs queue in data/agent.json; an
             hourly Claude run works them with subagents (see
             agent/RUNNER.md) and writes results to agent/results/.

   Data lives in the repo:
     data/deadlines.json  ← written by the eLC sync robot (don't edit)
     data/tasks.json      ← your own tasks
     data/done.json       ← what you've checked off (also weekly reset)
     data/plan.json       ← which items you pinned to Today's 3
     data/applications.json ← applications and the materials library
     data/agent.json      ← jobs handed to Claude (status, results)
     data/courses.json, leads.csv, products.json

   Without a key the page is read-only. With a key (Connect button),
   everything saves straight to GitHub.
   ========================================================== */

const OWNER = "driegs17-alt";
const REPO = "dashboard";
const BRANCH = "main";
const REFRESH_MS = 3 * 60 * 1000;
const TOKEN_KEY = "dashboard.githubKey";
const GRADES_KEY = "dashboard.gradesKey";
const PENDING_KEY = "dashboard.pendingDone";
const FOCUS_KEY = "dashboard.focusEnd";
const FOCUS_MINUTES = 50;
const MAX_TODAY = 3;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const IS_LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) || location.protocol === "file:";

const AGENT_TYPES = {
  prep: {
    label: "Study prep",
    hint: "A crash sheet: key ideas, formulas, worked examples and quick self-checks, so you get through it faster. You still do and submit the graded work.",
  },
  research: { label: "Research", hint: "Look things up and come back with a short, sourced answer or list." },
  draft: { label: "First draft", hint: "Write a first draft for you to edit: an email, a write-up, copy, an outline. Not for graded assignments." },
  plan: { label: "Break it down", hint: "Turn a big task into small dated steps you can check off, with time estimates." },
  custom: { label: "Something else", hint: "Describe exactly what you want below." },
};
const AGENT_LIVE = ["queued", "working", "needs-you"];

const RESET_STEPS = [
  "Skim eLC announcements for anything the robot can't see (in-class changes, new instructions).",
  "Look at next week's strip. Start early on the heaviest day's work.",
  "Give every “No date yet” item a date, or drop it.",
  "Pick one business move for the week: one lead to contact or one product to test.",
];

/* ---------- Storage (wrapped: private browsing can throw) ---------- */

const storage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch {} },
  remove(key) { try { localStorage.removeItem(key); } catch {} },
};

const state = {
  deadlines: [],
  synced: null,
  tasks: [],
  done: {},
  plan: {},
  apps: { library: [], applications: [] },
  courses: [],
  courseNames: {},
  agent: { jobs: [] },
  gradesKey: storage.get(GRADES_KEY) || "",
  grades: null,
  gradesError: "",
  gradeTab: "issues",
  handTarget: null,
  token: storage.get(TOKEN_KEY) || "",
};

/* ---------- Helpers ---------- */

const $ = (id) => document.getElementById(id);

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function today() {
  return startOfDay(new Date());
}

function dateKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ISO week, e.g. "2026-W43", so the weekly reset starts fresh each Monday.
function weekKey(d = new Date()) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function daysUntil(date) {
  return Math.round((startOfDay(date) - today()) / 86400000);
}

function dayLabel(date) {
  const days = daysUntil(date);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days > 1 && days < 7) return date.toLocaleDateString(undefined, { weekday: "long" });
  return `${date.toLocaleDateString(undefined, { weekday: "short" })} ${MONTHS[date.getMonth()]} ${date.getDate()}`;
}

function whenLabel(item) {
  if (!item.dueDate) return "No date";
  const time = item.hasTime ? item.dueDate.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "";
  return time ? `${dayLabel(item.dueDate)} · ${time}` : dayLabel(item.dueDate);
}

function whenSentence(item) {
  return whenLabel(item).replace(" · ", " at ");
}

function countdown(item) {
  if (!item.dueDate) return { cls: "none", text: "No date" };
  const days = daysUntil(item.dueDate);
  const hours = (item.dueDate - new Date()) / 3600000;
  let text;
  if (hours < 0) text = days < 0 ? `${-days}d late` : "Late";
  else if (days === 0) text = hours < 1 ? "< 1 hr" : `${Math.round(hours)} hrs`;
  else if (days === 1) text = "Tomorrow";
  else text = `${days} days`;
  const cls = hours < 0 ? "late" : days <= 2 ? "urgent" : days <= 7 ? "soon" : "later";
  return { cls, text };
}

function plural(n, word, many = word + "s") {
  return `${n} ${n === 1 ? word : many}`;
}

function toast(message, isError = false) {
  const el = $("toast");
  el.textContent = message;
  el.classList.toggle("error", isError);
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), isError ? 6000 : 2600);
}

/* ---------- Reading and writing the repo ---------- */

function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

function base64ToUtf8(b64) {
  const binary = atob(b64.replace(/\n/g, ""));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

function apiHeaders() {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${state.token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

// Uses the API when connected (always fresh), otherwise the public raw file.
async function readFile(path) {
  if (IS_LOCAL) {
    const r = await fetch(path, { cache: "no-store" });
    if (!r.ok) throw new Error(`Couldn't load ${path}`);
    return r.text();
  }
  if (state.token) {
    const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}?ref=${BRANCH}`, {
      headers: apiHeaders(),
      cache: "no-store",
    });
    if (r.ok) return base64ToUtf8((await r.json()).content);
    if (r.status === 401) markTokenBad();
  }
  const r = await fetch(`https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/${path}?v=${Date.now()}`, { cache: "no-store" });
  if (r.ok) return r.text();
  const fallback = await fetch(path, { cache: "no-store" });
  if (!fallback.ok) throw new Error(`Couldn't load ${path}`);
  return fallback.text();
}

// Read-modify-write a JSON file, retrying if another device saved first.
async function updateJson(path, change, message) {
  if (!state.token) throw new Error("not-connected");
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}?ref=${BRANCH}`, {
      headers: apiHeaders(),
      cache: "no-store",
    });
    if (r.status === 401) { markTokenBad(); throw new Error("bad-key"); }
    if (!r.ok) throw new Error(`GitHub said ${r.status}`);
    const current = await r.json();
    const data = change(JSON.parse(base64ToUtf8(current.content)));
    const put = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`, {
      method: "PUT",
      headers: { ...apiHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        content: utf8ToBase64(JSON.stringify(data, null, 2) + "\n"),
        sha: current.sha,
        branch: BRANCH,
      }),
    });
    if (put.ok) return data;
    if (put.status === 401 || put.status === 403) { markTokenBad(); throw new Error("bad-key"); }
    if (put.status !== 409 && put.status !== 422) throw new Error(`GitHub said ${put.status}`);
    await new Promise((res) => setTimeout(res, 600 * (attempt + 1)));
  }
  throw new Error("Couldn't save after a few tries");
}

function needsKey(message) {
  if (state.token) return false;
  openConnect(message);
  return true;
}

function saveError(error) {
  toast(error.message === "bad-key" ? "Your GitHub key stopped working. Reconnect to save." : `Didn't save: ${error.message}`, true);
}

/* Check-offs made on this device stay visible even if GitHub's public
   copy is a few minutes behind. */
function pending() {
  try { return JSON.parse(storage.get(PENDING_KEY) || "{}"); } catch { return {}; }
}
function setPending(map) {
  storage.set(PENDING_KEY, JSON.stringify(map));
}

function doneMap() {
  const done = { ...state.done };
  for (const [id, value] of Object.entries(pending())) {
    if (value === null) delete done[id];
    else done[id] = value;
  }
  return done;
}

/* ---------- Building the list ---------- */

function allItems() {
  const done = doneMap();
  const fromElc = state.deadlines.map((d) => ({ ...d, source: "elc", dueDate: new Date(d.due) }));
  const mine = state.tasks.map((t) => ({
    ...t,
    source: "me",
    hasTime: false,
    dueDate: t.due ? new Date(`${t.due}T23:59:00`) : null,
  }));
  const steps = (state.apps.applications || []).flatMap((app) =>
    (app.steps || []).map((s) => ({
      ...s,
      source: "app",
      org: app.org,
      course: "",
      note: app.role,
      hasTime: false,
      dueDate: s.due ? new Date(`${s.due}T23:59:00`) : null,
    }))
  );
  return [...fromElc, ...mine, ...steps].map((item) => ({ ...item, doneAt: done[item.id] || null }));
}

// Many small items due at the same moment for one class (like a week of
// Macro modules) become one bundle so the list stays calm.
function bundle(items) {
  const out = [];
  const groups = new Map();
  for (const item of items) {
    if (item.source !== "elc") { out.push(item); continue; }
    const key = `${item.course}|${item.due}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  for (const list of groups.values()) {
    if (list.length < 3) { out.push(...list); continue; }
    const first = list[0];
    const short = state.courseNames[first.course] || first.course;
    out.push({
      ...first,
      id: `bundle:${list.map((i) => i.id).join(",")}`,
      title: `${short}: ${list.length} assignments`,
      parts: list,
      url: "",
      doneAt: list.every((i) => i.doneAt) ? list.map((i) => i.doneAt).sort().pop() : null,
      firstSeen: list.map((i) => i.firstSeen).filter(Boolean).sort().pop() || null,
    });
  }
  return out.sort(byDue);
}

function byDue(a, b) {
  if (!a.dueDate && !b.dueDate) return a.title.localeCompare(b.title);
  if (!a.dueDate) return 1;
  if (!b.dueDate) return -1;
  return a.dueDate - b.dueDate || a.title.localeCompare(b.title);
}

function isNew(item) {
  return Boolean(item.firstSeen) && Date.now() - new Date(item.firstSeen) < 48 * 3600000;
}

function classify() {
  const items = bundle(allItems());
  const open = items.filter((i) => !i.doneAt);
  const now = new Date();
  const overdue = open.filter((i) => i.dueDate && i.dueDate < now);
  const upcoming = open.filter((i) => i.dueDate && i.dueDate >= now);
  return {
    items,
    open,
    overdue,
    week: upcoming.filter((i) => daysUntil(i.dueDate) <= 7),
    later: upcoming.filter((i) => daysUntil(i.dueDate) > 7),
    undated: open.filter((i) => !i.dueDate),
    recentDone: items
      .filter((i) => i.doneAt && Date.now() - new Date(i.doneAt) < 7 * 86400000)
      .sort((a, b) => new Date(b.doneAt) - new Date(a.doneAt)),
    queue: [...overdue, ...upcoming, ...open.filter((i) => !i.dueDate)],
  };
}

/* ---------- Today's 3 ---------- */

function pinnedIds() {
  return state.plan[dateKey()] || [];
}

// Pinned items (in your order) if you've chosen; otherwise the 3 most
// urgent, so there's always a plan without having to think about it.
function todaysThree(c) {
  const byId = new Map(c.items.map((i) => [i.id, i]));
  const pinned = pinnedIds().map((id) => byId.get(id)).filter(Boolean);
  if (pinned.length) return { list: pinned.slice(0, MAX_TODAY), chosen: true };
  return { list: c.queue.slice(0, MAX_TODAY), chosen: false };
}

/* ---------- Rendering: Today ---------- */

function renderBrief(c, three) {
  const openToday = three.list.filter((i) => !i.doneAt);
  const doneToday = three.list.length - openToday.length;
  let title;
  let line;

  if (three.list.length && !openToday.length) {
    title = "Day won.";
    line = "Today's 3 are done. Anything else is a bonus. Business tab is open if you want a focused block.";
  } else if (c.overdue.length) {
    title = `${plural(c.overdue.length, "thing")} slipped.`;
    line = `Clear ${c.overdue[0].title} first, then back on plan.`;
  } else if (openToday.length) {
    const first = openToday[0];
    title = doneToday ? `${doneToday} down, ${openToday.length} to go.` : `${plural(c.week.length, "deadline")} this week.`;
    line = first.dueDate ? `Start with ${first.title}, due ${whenSentence(first)}.` : `Start with ${first.title}.`;
    if (c.later.length && !doneToday) line += " Everything further out is handled.";
  } else {
    title = "All clear.";
    line = "Nothing on the list. New eLC work shows up here on its own.";
  }
  $("brief-title").textContent = title;
  $("brief").textContent = line;
}

function partsList(item, light = false) {
  if (!item.parts) return "";
  return `<details class="parts${light ? " light" : ""}"><summary>${item.parts.length} parts</summary><ul>${item.parts
    .map((p) => `<li class="${p.doneAt ? "is-done" : ""}">${escapeHtml(p.title)}</li>`)
    .join("")}</ul></details>`;
}

function focusRemaining() {
  const end = Number(storage.get(FOCUS_KEY) || 0);
  return end > Date.now() ? end - Date.now() : 0;
}

function renderFrog(three) {
  const el = $("frog");
  const item = three.list.find((i) => !i.doneAt);
  if (!item) {
    el.innerHTML = `<div class="frog-empty"><p class="label">The one thing</p><h3>${three.list.length ? "Done for today." : "Nothing pressing."}</h3></div>`;
    return;
  }
  const cd = countdown(item);
  const course = state.courseNames[item.course] || item.org || item.course || "";
  const link = item.url ? `<a class="btn ghost-light" href="${escapeHtml(item.url)}" target="_blank" rel="noopener">Open in eLC ↗</a>` : "";
  const left = focusRemaining();
  const focus = left
    ? `<button type="button" class="btn ghost-light" data-focus="stop">Focus · <span id="focus-clock">${clock(left)}</span> · Stop</button>`
    : `<button type="button" class="btn ghost-light" data-focus="start">Start ${FOCUS_MINUTES}-min focus</button>`;

  el.innerHTML = `
    <div class="frog-count ${cd.cls}"><span>${escapeHtml(cd.text)}</span></div>
    <div class="frog-body">
      <p class="label">The one thing${course ? ` · ${escapeHtml(course)}` : ""}</p>
      <h3>${escapeHtml(item.title)}</h3>
      <p class="meta">${item.dueDate ? `Due ${escapeHtml(whenLabel(item))}` : escapeHtml(item.note || "No due date")}</p>
      ${partsList(item, true)}
      <div class="frog-actions">
        <button type="button" class="btn light" data-done="${escapeHtml(item.id)}">✓ Done</button>
        ${focus}
        ${link}
      </div>
    </div>`;
}

function clock(ms) {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function renderThree(three) {
  $("three-note").textContent = three.chosen
    ? "Your picks. Do them in order. When all 3 are done, the day is a win."
    : "Picked for you by urgency. Tap ☆ on any item in Week to choose your own.";
  $("three").innerHTML = three.list.length
    ? three.list
        .map((item) => {
          const course = state.courseNames[item.course] || item.org;
          const pin = three.chosen
            ? `<button type="button" class="pin is-pinned" data-unpin="${escapeHtml(item.id)}" aria-label="Remove from Today's 3">★</button>`
            : "";
          return `
            <li class="three-item${item.doneAt ? " done" : ""}">
              ${checkButton(item)}
              <div>
                <p class="three-title">${escapeHtml(item.title)}</p>
                <p class="three-meta">${course ? `${escapeHtml(course)} · ` : ""}${escapeHtml(whenLabel(item))}</p>
              </div>
              ${pin}
            </li>`;
        })
        .join("")
    : `<li class="muted">Nothing to do. Enjoy it.</li>`;
}

function streakDays() {
  const days = new Set(Object.values(doneMap()).filter(Boolean).map((t) => dateKey(new Date(t))));
  let streak = 0;
  const cursor = today();
  if (!days.has(dateKey(cursor))) cursor.setDate(cursor.getDate() - 1); // today isn't over yet
  while (days.has(dateKey(cursor))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return { streak, days, today: days.has(dateKey()) };
}

function renderStreak() {
  const { streak, days, today: hitToday } = streakDays();
  const cells = [];
  for (let i = 13; i >= 0; i--) {
    const d = today();
    d.setDate(d.getDate() - i);
    const hit = days.has(dateKey(d));
    cells.push(`<span class="link${hit ? " hit" : ""}${i === 0 ? " now" : ""}" title="${escapeHtml(dayLabel(d))}${hit ? ": checked something off" : ""}"></span>`);
  }
  const note = hitToday
    ? "Today counts. Keep going."
    : streak
      ? "Check one thing off today to keep it."
      : "Check one thing off to start a chain.";
  $("streak").innerHTML = `
    <p class="streak-num">${streak}<span> ${streak === 1 ? "day" : "days"}</span></p>
    <div class="chain" aria-label="Last 14 days">${cells.join("")}</div>
    <p class="streak-note">${note}</p>`;
}

function renderResetBanner() {
  const day = new Date().getDay(); // 0 = Sunday
  const left = RESET_STEPS.filter((_, i) => !doneMap()[resetId(i)]).length;
  const show = (day === 0 || day === 1) && left > 0;
  const el = $("reset-banner");
  el.hidden = !show;
  if (show) el.innerHTML = `<a href="#week">Weekly reset: ${RESET_STEPS.length - left}/${RESET_STEPS.length} done. 15 minutes sets up the whole week →</a>`;
}

/* ---------- Rendering: Week ---------- */

function renderWeekStrip(c) {
  const open = c.open.filter((i) => i.dueDate);
  const cells = [];
  for (let d = 0; d < 14; d++) {
    const day = today();
    day.setDate(day.getDate() + d);
    const count = open
      .filter((i) => daysUntil(i.dueDate) === d)
      .reduce((n, i) => n + (i.parts ? i.parts.length : 1), 0);
    const load = count >= 5 ? "heavy" : count >= 2 ? "some" : count === 1 ? "one" : "";
    cells.push(`
      <div class="day ${load}${d === 0 ? " is-today" : ""}" title="${escapeHtml(dayLabel(day))}: ${plural(count, "item")}">
        <span class="dow">${day.toLocaleDateString(undefined, { weekday: "narrow" })}</span>
        <span class="num">${day.getDate()}</span>
        <span class="load">${count || ""}</span>
      </div>`);
  }
  $("week-strip").innerHTML = `<p class="week-label">Load, next two weeks</p><div class="days">${cells.join("")}</div>`;
}

function resetId(i) {
  return `reset-${weekKey()}-${i + 1}`;
}

function renderReset() {
  const done = doneMap();
  $("reset-list").innerHTML = RESET_STEPS.map((step, i) => {
    const id = resetId(i);
    const isDone = Boolean(done[id]);
    const button = isDone
      ? `<button type="button" class="check small is-done" data-undo="${id}" aria-label="Undo: ${escapeHtml(step)}">✓</button>`
      : `<button type="button" class="check small" data-done="${id}" aria-label="Done: ${escapeHtml(step)}"></button>`;
    return `<li class="${isDone ? "done" : ""}">${button}<span>${escapeHtml(step)}</span></li>`;
  }).join("");
  const left = RESET_STEPS.filter((_, i) => !done[resetId(i)]).length;
  $("reset-count").textContent = `${RESET_STEPS.length - left}/${RESET_STEPS.length}`;
  const resetDay = [0, 1].includes(new Date().getDay());
  $("reset").classList.toggle("is-sunday", resetDay && left > 0);
  // Open by itself on Sunday/Monday until it's finished; otherwise stay folded.
  if (!renderReset.initialised) {
    $("reset").open = resetDay && left > 0;
    renderReset.initialised = true;
  }
}

function checkButton(item) {
  return item.doneAt
    ? `<button type="button" class="check is-done" data-undo="${escapeHtml(item.id)}" aria-label="Undo: ${escapeHtml(item.title)}">✓</button>`
    : `<button type="button" class="check" data-done="${escapeHtml(item.id)}" aria-label="Mark done: ${escapeHtml(item.title)}"></button>`;
}

function taskRow(item) {
  const cd = item.doneAt ? { cls: "done", text: "Done" } : countdown(item);
  const course = state.courseNames[item.course] || item.org;
  const tag = course ? `<span class="tag">${escapeHtml(course)}</span>` : "";
  const fresh = !item.doneAt && isNew(item) ? `<span class="new">New</span>` : "";
  const note = item.note ? `<p class="task-meta">${escapeHtml(item.note)}</p>` : "";
  const link = item.url ? `<a class="open" href="${escapeHtml(item.url)}" target="_blank" rel="noopener" aria-label="Open ${escapeHtml(item.title)} in eLC">↗</a>` : "";
  const pinned = pinnedIds().includes(item.id);
  const pin = item.doneAt
    ? ""
    : `<button type="button" class="pin${pinned ? " is-pinned" : ""}" data-${pinned ? "unpin" : "pin"}="${escapeHtml(item.id)}" aria-label="${pinned ? "Remove from" : "Add to"} Today's 3">${pinned ? "★" : "☆"}</button>`;

  const hand = item.doneAt ? "" : handButton(item);

  return `
    <article class="task${item.doneAt ? " done" : ""}">
      ${checkButton(item)}
      <div class="due ${cd.cls}"><strong>${escapeHtml(cd.text)}</strong><span>${escapeHtml(item.doneAt ? "" : whenLabel(item))}</span></div>
      <div class="task-body">
        <h3 class="task-title">${fresh}${tag}${escapeHtml(item.title)}</h3>
        ${note}
        ${partsList(item)}
      </div>
      <div class="row-actions">${hand}${pin}${link}</div>
    </article>`;
}

function group(title, items, { open = true, note = "" } = {}) {
  if (!items.length) return "";
  const rows = items.map(taskRow).join("");
  const head = `<span>${title}</span> <span class="count">${items.length}</span>${note ? `<span class="group-note">${note}</span>` : ""}`;
  return open
    ? `<div class="group"><h3 class="group-title">${head}</h3>${rows}</div>`
    : `<details class="group"><summary class="group-title">${head}</summary>${rows}</details>`;
}

function renderDeadlines(c) {
  $("task-groups").innerHTML =
    [
      group("Overdue", c.overdue),
      group("Next 7 days", c.week),
      group("Coming up", c.later, { open: false, note: "Handled. Not urgent yet." }),
      group("No date yet", c.undated, { open: false }),
      group("Done this week", c.recentDone, { open: false }),
    ].join("") || `<p class="muted">Nothing on the list.</p>`;
}

/* ---------- Rendering: Apply ---------- */

function copyButton(text, label = "Copy") {
  return `<button type="button" class="copy" data-copy="${escapeHtml(text)}">${label}</button>`;
}

function renderApps() {
  const done = doneMap();
  const apps = state.apps.applications || [];
  $("app-list").innerHTML = apps.length
    ? apps
        .map((app) => {
          const steps = app.steps || [];
          const finished = steps.filter((s) => done[s.id]).length;
          const pct = steps.length ? Math.round((finished / steps.length) * 100) : 0;
          const next = steps.find((s) => !done[s.id]);
          const target = app.target ? new Date(`${app.target}T12:00:00`) : null;
          const mailto = `mailto:${app.sendTo}?subject=${encodeURIComponent(app.subject)}`;
          const stepRows = steps
            .map((s) => {
              const isDone = Boolean(done[s.id]);
              const due = s.due ? new Date(`${s.due}T23:59:00`) : null;
              const cd = isDone ? { cls: "done", text: "Done" } : due ? countdown({ dueDate: due }) : { cls: "none", text: "" };
              const pinned = pinnedIds().includes(s.id);
              return `
                <li class="${isDone ? "done" : ""}">
                  ${isDone
                    ? `<button type="button" class="check small is-done" data-undo="${s.id}" aria-label="Undo: ${escapeHtml(s.title)}">✓</button>`
                    : `<button type="button" class="check small" data-done="${s.id}" aria-label="Done: ${escapeHtml(s.title)}"></button>`}
                  <span class="step-title">${escapeHtml(s.title)}</span>
                  <span class="step-due ${cd.cls}">${due ? escapeHtml(dayLabel(due)) : ""}</span>
                  ${isDone ? "" : `<button type="button" class="pin${pinned ? " is-pinned" : ""}" data-${pinned ? "unpin" : "pin"}="${s.id}" aria-label="${pinned ? "Remove from" : "Add to"} Today's 3">${pinned ? "★" : "☆"}</button>`}
                </li>`;
            })
            .join("");
          return `
            <article class="app">
              <header class="app-head">
                <div>
                  <p class="app-org">${escapeHtml(app.org)}<span class="status">${escapeHtml(app.status)}</span></p>
                  <h2 class="app-role">${escapeHtml(app.role)}</h2>
                  <p class="app-meta">${escapeHtml(app.location)} · ${escapeHtml(app.terms)}</p>
                </div>
                <div class="app-target">
                  <span class="label">${app.deadline ? "Deadline" : "Your target"}</span>
                  <strong>${target ? escapeHtml(dayLabel(target)) : "Not set"}</strong>
                </div>
              </header>

              <div class="progress" role="img" aria-label="${finished} of ${steps.length} steps done"><span style="width:${pct}%"></span></div>
              <p class="progress-note">${finished} of ${steps.length} done${next ? ` · Next: ${escapeHtml(next.title)}` : " · Sent. Nice."}</p>

              <div class="app-grid">
                <section>
                  <h3 class="mini">Checklist</h3>
                  <ul class="steps-list">${stepRows}</ul>
                </section>
                <section class="send">
                  <h3 class="mini">How to send</h3>
                  <dl class="send-list">
                    <div><dt>To</dt><dd>${escapeHtml(app.sendTo)} ${copyButton(app.sendTo)}</dd></div>
                    <div><dt>Subject</dt><dd>${escapeHtml(app.subject)} ${copyButton(app.subject)}</dd></div>
                    <div><dt>Attach</dt><dd><ul class="files">${(app.files || []).map((f) => `<li><code>${escapeHtml(f)}</code> ${copyButton(f.replace(/\.pdf$/, ""), "Copy name")}</li>`).join("")}</ul></dd></div>
                  </dl>
                  <h3 class="mini">Notes</h3>
                  <ul class="app-notes">${(app.notes || []).map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul>
                  <div class="app-links">
                    <a class="btn" href="${escapeHtml(app.posting)}" target="_blank" rel="noopener">Posting ↗</a>
                    <a class="btn" href="${escapeHtml(mailto)}">Start email</a>
                  </div>
                </section>
              </div>
            </article>`;
        })
        .join("")
    : `<p class="muted">No applications yet. Add one to data/applications.json.</p>`;

  const lib = state.apps.library || [];
  $("library").innerHTML = lib
    .map((l) => {
      const isDone = Boolean(done[l.id]);
      return `
        <li class="${isDone ? "done" : ""}">
          ${isDone
            ? `<button type="button" class="check small is-done" data-undo="${l.id}" aria-label="Mark not ready: ${escapeHtml(l.title)}">✓</button>`
            : `<button type="button" class="check small" data-done="${l.id}" aria-label="Mark ready: ${escapeHtml(l.title)}"></button>`}
          <div>
            <p class="lib-title">${escapeHtml(l.title)} <span class="lib-state">${isDone ? "Ready" : "To build"}</span></p>
            <p class="lib-note"><code>${escapeHtml(l.where)}</code> · ${escapeHtml(l.note)}</p>
          </div>
        </li>`;
    })
    .join("");
}

/* ---------- Rendering: Classes and Business ---------- */

function renderCourses(c) {
  $("course-grid").innerHTML = state.courses
    .map((course) => {
      const upcoming = c.open.filter((i) => i.course === course.code && i.dueDate && i.dueDate >= new Date());
      const next = upcoming[0];
      const nextHtml = next
        ? `<b>Next:</b> ${escapeHtml(next.title)} · ${escapeHtml(whenLabel(next))}${upcoming.length > 1 ? ` <span class="muted">(+${upcoming.length - 1} more)</span>` : ""}`
        : `<span class="muted">Nothing due</span>`;
      return `
        <article class="course">
          <div>
            <p class="course-code">${escapeHtml(course.code)}</p>
            <h3>${escapeHtml(course.short)}</h3>
            <p class="full">${escapeHtml(course.name)}</p>
          </div>
          <p class="notes">${escapeHtml(course.notes)}</p>
          <p class="course-next">${nextHtml}</p>
          <a class="btn" href="${escapeHtml(course.elc)}" target="_blank" rel="noopener">Open in eLC ↗</a>
        </article>`;
    })
    .join("");
}

function fillCourseSelect() {
  $("add-course").innerHTML =
    `<option value="">No class</option>` +
    state.courses.map((course) => `<option value="${escapeHtml(course.code)}">${escapeHtml(course.short)}</option>`).join("");
}

function renderProducts(products) {
  $("product-grid").innerHTML = products
    .map(
      (p, i) => `
      <article class="product">
        <p class="num">${String(i + 1).padStart(2, "0")}</p>
        <div>
          <p class="type">${escapeHtml(p.type)}</p>
          <h3>${escapeHtml(p.name)}<span class="status">${escapeHtml(p.status)}</span></h3>
        </div>
        <p>${escapeHtml(p.why)}</p>
        <p class="test"><b>First test:</b> ${escapeHtml(p.test)}</p>
      </article>`
    )
    .join("");
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((v) => v !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((v) => v !== "")) rows.push(row);
  const [header, ...body] = rows;
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] || "").trim()])));
}

function websiteCell(site) {
  if (!site) return `<span class="pill">To check</span>`;
  if (/^(no|none)$/i.test(site)) return `<span class="pill no-site">No site</span>`;
  const url = /^https?:\/\//.test(site) ? site : `https://${site}`;
  return `<a class="pill has-site" href="${escapeHtml(url)}" target="_blank" rel="noopener">Has site ↗</a>`;
}

function setupLeads(leads) {
  const rowsEl = $("lead-rows");
  const searchEl = $("lead-search");
  const filtersEl = $("lead-filters");
  const areas = ["All", ...new Set(leads.map((l) => l.neighborhood).filter(Boolean))];
  let area = "All";

  filtersEl.innerHTML = areas
    .map((a) => `<button type="button" class="chip" data-area="${escapeHtml(a)}" aria-pressed="${a === "All"}">${escapeHtml(a)}</button>`)
    .join("");

  function draw() {
    const q = searchEl.value.trim().toLowerCase();
    const shown = leads.filter((l) => (area === "All" || l.neighborhood === area) && (!q || Object.values(l).join(" ").toLowerCase().includes(q)));
    const noSite = leads.filter((l) => /^(no|none)$/i.test(l.website)).length;
    const unchecked = leads.filter((l) => !l.website).length;
    $("lead-count").textContent = `Showing ${shown.length} of ${leads.length} · ${noSite} without a site · ${unchecked} still to check`;
    rowsEl.innerHTML = shown
      .map(
        (l) => `
        <tr>
          <td>${escapeHtml(l.name)}${l.notes ? `<br><span class="muted">${escapeHtml(l.notes)}</span>` : ""}</td>
          <td>${escapeHtml(l.neighborhood)}</td>
          <td>${escapeHtml(l.category)}</td>
          <td>${websiteCell(l.website)}</td>
          <td>${escapeHtml(l.status || "")}</td>
        </tr>`
      )
      .join("");
  }

  filtersEl.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-area]");
    if (!btn) return;
    area = btn.dataset.area;
    filtersEl.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
    draw();
  });
  searchEl.addEventListener("input", draw);
  draw();
}

/* ---------- Actions ---------- */

function idsFor(id) {
  return id.startsWith("bundle:") ? id.slice(7).split(",") : [id];
}

async function setDone(id, isDone) {
  if (needsKey("Connect this device once and check-offs will save everywhere.")) return;
  const ids = idsFor(id);
  const stamp = new Date().toISOString();
  const local = pending();
  ids.forEach((i) => (local[i] = isDone ? stamp : null));
  setPending(local);
  renderAll();

  const item = allItems().find((i) => i.id === ids[0]);
  const libItem = (state.apps.library || []).find((l) => l.id === id);
  const label = libItem ? libItem.title : id.startsWith("reset-") ? "weekly reset step" : id.startsWith("bundle:") ? `${ids.length} items` : item ? item.title : "task";
  try {
    state.done = await updateJson(
      "data/done.json",
      (done) => {
        ids.forEach((i) => (isDone ? (done[i] = stamp) : delete done[i]));
        return done;
      },
      `${isDone ? "Done" : "Undo"}: ${label}`
    );
    if (isDone && !id.startsWith("reset-")) toast(`Done: ${label}`);
  } catch (error) {
    saveError(error);
  } finally {
    const after = pending();
    ids.forEach((i) => delete after[i]);
    setPending(after);
    renderAll();
  }
}

async function setPinned(id, pin) {
  if (needsKey("Connect this device to choose Today's 3.")) return;
  const key = dateKey();
  const current = pinnedIds();
  if (pin && current.length >= MAX_TODAY) {
    toast(`Today's 3 is full. Finish or unpin one first.`, true);
    return;
  }
  const next = pin ? [...current, id] : current.filter((x) => x !== id);
  state.plan = { ...state.plan, [key]: next };
  renderAll();
  try {
    state.plan = await updateJson(
      "data/plan.json",
      (plan) => {
        const kept = {};
        const cutoff = new Date(Date.now() - 14 * 86400000);
        for (const [k, v] of Object.entries(plan)) if (new Date(k) >= cutoff) kept[k] = v;
        const list = (kept[key] || []).filter((x) => x !== id);
        kept[key] = pin ? [...list, id].slice(0, MAX_TODAY) : list;
        return kept;
      },
      `${pin ? "Pin" : "Unpin"} for ${key}`
    );
    if (pin) toast("Added to Today's 3");
  } catch (error) {
    saveError(error);
    await refresh();
  }
  renderAll();
}

async function addTask(event) {
  event.preventDefault();
  if (needsKey("Connect this device to add tasks.")) return;
  const title = $("add-title").value.trim();
  if (!title) return;
  const task = {
    id: `t-${Date.now().toString(36)}`,
    title,
    course: $("add-course").value || "",
    due: $("add-due").value || null,
    note: "",
  };
  const button = event.target.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    state.tasks = await updateJson("data/tasks.json", (tasks) => [...tasks, task], `Add task: ${title}`);
    event.target.reset();
    toast(`Captured: ${title}`);
    renderAll();
  } catch (error) {
    saveError(error);
  } finally {
    button.disabled = false;
  }
}

function toggleFocus(action) {
  if (action === "start") {
    storage.set(FOCUS_KEY, String(Date.now() + FOCUS_MINUTES * 60000));
    toast(`${FOCUS_MINUTES} minutes. Phone face down.`);
  } else {
    storage.remove(FOCUS_KEY);
  }
  renderAll();
}

function tickFocus() {
  const left = focusRemaining();
  const el = $("focus-clock");
  if (el && left) {
    el.textContent = clock(left);
    document.title = `${clock(left)} · Focus`;
  } else if (storage.get(FOCUS_KEY) && !left) {
    storage.remove(FOCUS_KEY);
    document.title = "Dylan's Dashboard";
    toast("Focus block done. Take 10, then go again or check it off.");
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    renderAll();
  } else if (!left && document.title !== "Dylan's Dashboard") {
    document.title = "Dylan's Dashboard";
  }
}



/* ---------- Grades (encrypted; only devices with the key can read) ---------- */

const b64uBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));

async function decryptGrades(enc, pubJwk, deviceKey) {
  const d = deviceKey.trim().replace(/^gk1-/, "");
  const ecdh = { name: "ECDH", namedCurve: "P-256" };
  const priv = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: pubJwk.x, y: pubJwk.y, d, ext: true }, ecdh, false, ["deriveBits"]);
  const epk = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: enc.epk.x, y: enc.epk.y, ext: true }, ecdh, false, []);
  const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: epk }, priv, 256);
  const hk = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  const aes = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: new TextEncoder().encode("dashboard-grades-v1") },
    hk, { name: "AES-GCM", length: 256 }, false, ["decrypt"]
  );
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64uBytes(enc.iv) }, aes, b64uBytes(enc.ct));
  return JSON.parse(new TextDecoder().decode(plain));
}

const ECDH = { name: "ECDH", namedCurve: "P-256" };

// Does this private key belong to the public key in the repo? (ECDH both ways must agree.)
async function keyMatches(deviceKey, pub) {
  try {
    const d = deviceKey.trim().replace(/^gk1-/, "");
    const priv = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: pub.x, y: pub.y, d, ext: true }, ECDH, false, ["deriveBits"]);
    const pubKey = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: pub.x, y: pub.y, ext: true }, ECDH, false, []);
    const eph = await crypto.subtle.generateKey(ECDH, false, ["deriveBits"]);
    const a = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: eph.publicKey }, priv, 256));
    const b = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: pubKey }, eph.privateKey, 256));
    return a.every((v, i) => v === b[i]);
  } catch {
    return false;
  }
}

async function loadGrades() {
  state.gradesPending = false;
  const [enc, pub] = await Promise.all([loadJson("data/grades.enc.json", null), loadJson("data/grades-key.json", null)]);
  state.gradesPub = pub && pub.x ? pub : null;
  if (!state.gradesKey) { state.grades = null; renderGrades(); return; }
  try {
    if (!state.gradesPub || !enc || !enc.ct || (enc.kid && enc.kid !== state.gradesPub.x.slice(0, 12))) {
      // Key exists but the grades haven't been locked to it yet.
      state.grades = null;
      state.gradesPending = true;
      state.gradesError = "";
    } else {
      state.gradesRaw = await decryptGrades(enc, state.gradesPub, state.gradesKey);
      await loadOverrides();
      state.grades = state.gradesRaw;
      state.gradesError = "";
    }
  } catch (error) {
    console.warn(error);
    state.grades = null;
    state.gradesError = "That key doesn't open these grades. Check you copied all of it.";
  }
  renderGrades();
}

async function unlockGrades(event) {
  event.preventDefault();
  const value = $("grades-key-input").value.trim();
  if (!value) return;
  if (state.gradesPub && !(await keyMatches(value, state.gradesPub))) {
    state.gradesError = "That isn't your grades key. Check you copied all of it.";
    renderGrades();
    return;
  }
  state.gradesKey = value;
  await loadGrades();
  if (state.grades || state.gradesPending) {
    storage.set(GRADES_KEY, value);
    toast(state.grades ? "Grades unlocked on this device." : "Key saved. Grades show up after the next refresh.");
  } else {
    state.gradesKey = "";
  }
  renderGrades();
}

async function createGradesKey(button) {
  if (needsKey("Connect this device first so it can save your new key's public half.")) return;
  button.disabled = true;
  try {
    const pair = await crypto.subtle.generateKey(ECDH, true, ["deriveBits"]);
    const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    const deviceKey = `gk1-${jwk.d}`;
    await updateJson("data/grades-key.json", () => ({ kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, created: new Date().toISOString() }), "New grades key (public half)");
    storage.set(GRADES_KEY, deviceKey);
    state.gradesKey = deviceKey;
    state.gradesPub = { x: jwk.x, y: jwk.y };
    state.newGradesKey = deviceKey;
    $("gkey-confirm").hidden = true;
    await loadGrades();
  } catch (error) {
    saveError(error);
  } finally {
    button.disabled = false;
  }
}

const GRADE_STATUS = {
  flagged: { label: "Submitted, shows 0 / overdue", cls: "warn" },
  missing: { label: "Missing", cls: "bad" },
  check: { label: "No grade yet · check", cls: "warn" },
  submitted: { label: "Submitted · awaiting grade", cls: "wait" },
  upcoming: { label: "Not due yet", cls: "none" },
  cleared: { label: "Done · eLC still says overdue", cls: "good" },
  graded: { label: "Graded", cls: "good" },
  yours: { label: "Your entry", cls: "mine" },
  info: { label: "Not graded yet", cls: "none" },
};
const ISSUE = ["flagged", "missing", "check"];

function pctText(n) {
  return n == null ? "–" : `${Number(n).toFixed(1)}%`;
}

function gradeRow(item, course, code) {
  const s = GRADE_STATUS[item.status] || GRADE_STATUS.info;
  const due = item.due ? new Date(item.due) : null;
  const meta = [
    course ? course.short : "",
    item.category,
    due ? `Due ${dayLabel(due)}` : "",
    item.submittedAt ? `Submitted ${new Date(item.submittedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : "",
    item.feedback ? "Has feedback" : "",
  ].filter(Boolean).join(" · ");
  const hint =
    item.status === "flagged" ? "You submitted this, but eLC shows a zero or still lists it as overdue. It may just need grading. If it stays like this, email your instructor." :
    item.status === "check" ? "Done outside eLC (like Achieve or InQuizitive). eLC can't see whether you did it, so check there." :
    item.status === "missing" ? "Past due and nothing turned in. Check whether late work is accepted." :
    item.status === "yours" ? `You entered this${item.mine.note ? ` (${item.mine.note})` : ""}. eLC still shows ${item.elcScore || "no grade"}; it switches back once eLC has a real grade.` :
    item.overrideStale != null ? `eLC has a grade now, so your entry (${item.overrideStale}) is ignored.` : "";
  const editCode = code || (course && course.code);
  const edit = editCode ? `<button type="button" class="gedit" data-gedit="${escapeHtml(editCode)}" data-gname="${escapeHtml(item.name)}" aria-label="Enter your own score for ${escapeHtml(item.name)}" title="Enter your own score">✎</button>` : "";
  return `
    <article class="grade-row is-${escapeHtml(item.status)}">
      <span class="gstatus ${s.cls}">${escapeHtml(s.label)}</span>
      <div>
        <h3 class="task-title">${escapeHtml(item.name)}</h3>
        ${meta ? `<p class="task-meta">${escapeHtml(meta)}</p>` : ""}
        ${hint ? `<p class="grade-hint">${escapeHtml(hint)}</p>` : ""}
      </div>
      <span class="gscore">${escapeHtml(item.score || "–")}${item.pct != null ? `<small>${escapeHtml(Math.round(item.pct))}%</small>` : ""}</span>
      ${edit}
    </article>`;
}

function rangeBar(g) {
  if (g.floor == null || g.ceiling == null) return "";
  const pos = (n) => Math.max(0, Math.min(100, n));
  return `
    <div class="grade-range" role="img" aria-label="Final grade range ${pctText(g.floor)} to ${pctText(g.ceiling)}${g.current != null ? `, now ${pctText(g.current)}` : ""}">
      <div class="track">
        ${[60, 70, 80, 90].map((m) => `<span class="tick" style="left:${m}%"><i>${m}</i></span>`).join("")}
        <span class="span" style="left:${pos(g.floor)}%;width:${pos(g.ceiling) - pos(g.floor)}%"></span>
        ${g.current != null ? `<span class="now" style="left:${pos(g.current)}%"></span>` : ""}
      </div>
      <p class="range-note"><span>If nothing else is turned in: <b>${pctText(g.floor)}</b></span><span>If everything left is perfect: <b>${pctText(g.ceiling)}</b></span></p>
    </div>`;
}

function gradeCardHtml(c) {
  const g = c.grade || {};
  const k = c.counts || {};
  const issues = [k.missing ? `<b class="bad">${k.missing} missing</b>` : "", k.flagged ? `<b class="warn">${k.flagged} flagged</b>` : "", k.check ? `<b class="warn">${k.check} to check</b>` : "", k.submitted ? `${k.submitted} awaiting grade` : ""].filter(Boolean).join(" · ");
  return `<button type="button" class="grade-card" data-gtab="${escapeHtml(c.code)}">
    <span class="course-code">${escapeHtml(c.code)}</span>
    <strong>${escapeHtml(c.short)}</strong>
    <span class="grade-final">${g.current != null ? `${pctText(g.current)} <em>${escapeHtml(g.letter)}</em>` : "See eLC"}</span>
    ${g.gradedShare != null ? `<span class="grade-share"><span style="width:${Math.min(100, g.gradedShare)}%"></span></span><span class="grade-counts">${Math.round(g.gradedShare)}% of the class graded so far</span>` : `<span class="grade-counts">Custom formula</span>`}
    <span class="grade-counts">${issues || "Nothing missing"}</span>
  </button>`;
}

function renderGrades() {
  const locked = !state.gradesKey || !state.grades;
  $("grades-lock").hidden = !locked || state.gradesPending || Boolean(state.newGradesKey);
  $("gkey-show").hidden = !state.newGradesKey;
  if (state.newGradesKey) $("gkey-value").textContent = state.newGradesKey;
  $("gkey-wait").hidden = !state.gradesPending || Boolean(state.newGradesKey);
  $("grades-msg").textContent = state.gradesError;
  $("grades-msg").className = `form-msg${state.gradesError ? " error-text" : ""}`;
  const badge = $("grades-badge");
  if (locked) {
    $("grade-tabs").innerHTML = "";
    $("grades-body").innerHTML = "";
    badge.hidden = true;
    return;
  }
  const courses = applyOverrides(state.gradesRaw || state.grades).courses || [];
  $("grades-note").textContent = state.grades.scraped
    ? `From eLC, checked ${ago(state.grades.scraped)}. Encrypted, so only your devices can read this.`
    : "No grades pulled yet. The first eLC check fills this in.";
  const issues = courses.flatMap((c) => c.items.filter((i) => ISSUE.includes(i.status)).map((i) => ({ i, c })));
  badge.hidden = !issues.length;
  badge.textContent = issues.length ? String(issues.length) : "";

  const tabs = [{ id: "issues", label: "Overview" }, ...courses.map((c) => ({ id: c.code, label: c.short }))];
  if (!tabs.some((t) => t.id === state.gradeTab)) state.gradeTab = "issues";
  $("grade-tabs").innerHTML = tabs
    .map((t) => `<button type="button" class="chip" role="tab" data-gtab="${escapeHtml(t.id)}" aria-selected="${t.id === state.gradeTab}" aria-pressed="${t.id === state.gradeTab}">${escapeHtml(t.label)}</button>`)
    .join("");

  if (state.gradeTab === "issues") {
    $("grades-body").innerHTML = `
      <div class="grade-cards">${courses.map(gradeCardHtml).join("")}</div>
      <div class="group"><h3 class="group-title"><span>Needs attention</span> <span class="count">${issues.length}</span><span class="group-note">Missing, or submitted but eLC shows a zero or overdue.</span></h3>
      ${issues.length ? issues.map(({ i, c }) => gradeRow(i, c)).join("") : `<p class="muted">Nothing missing. Nice.</p>`}</div>
      <p class="block-note">Grades are worked out from each class's gradebook categories and weights in eLC, counting only what's been graded. Letters use UGA's standard plus/minus scale; your syllabus has the final say.</p>`;
    return;
  }
  const c = courses.find((x) => x.code === state.gradeTab);
  const g = c.grade || {};
  const cats = (g.categories || []).length
    ? `<div class="cat-table-wrap"><table class="cat-table">
        <thead><tr><th scope="col">Category</th><th scope="col">Weight</th><th scope="col">Your score</th><th scope="col">Graded</th><th scope="col">Points toward final</th></tr></thead>
        <tbody>${g.categories.map((k) => `
          <tr>
            <th scope="row">${escapeHtml(k.name)}${k.dropLow ? `<small>Lowest ${k.dropLow} dropped</small>` : ""}</th>
            <td>${escapeHtml(k.weight)}%</td>
            <td><span class="cat-bar"><span style="width:${k.pct ?? 0}%"></span></span>${pctText(k.pct)}</td>
            <td>${k.graded} of ${k.total}</td>
            <td>${k.earned != null ? `${Number(k.earned).toFixed(1)} / ${escapeHtml(k.weight)}` : "–"}</td>
          </tr>`).join("")}</tbody></table></div>`
    : "";
  const groups = [
    ["Needs attention", c.items.filter((i) => ISSUE.includes(i.status)), true],
    ["Submitted, waiting on a grade", c.items.filter((i) => i.status === "submitted"), true],
    ["Coming up", c.items.filter((i) => i.status === "upcoming"), true],
    ["Your entries", c.items.filter((i) => i.status === "yours"), true],
    ["Graded", c.items.filter((i) => i.status === "graded"), false],
    ["eLC says overdue, but it's done", c.items.filter((i) => i.status === "cleared"), false],
    ["Not graded yet", c.items.filter((i) => i.status === "info"), false],
  ];
  $("grades-body").innerHTML = `
    <div class="grade-head">
      <div>
        <p class="course-code">${escapeHtml(c.code)}</p>
        <h2 class="grade-course">${escapeHtml(c.short)}</h2>
        <p class="task-meta">${escapeHtml(g.note || "")}</p>
      </div>
      <div class="grade-final big">${g.current != null ? `${pctText(g.current)}<em>${escapeHtml(g.letter)}</em>` : "See eLC"}<small>${g.current != null ? `On graded work${g.withYours ? " + your entries" : ""} · ${Math.round(g.gradedShare)}% of class graded` : "Custom formula"}</small></div>
    </div>
    ${rangeBar(g)}
    ${cats}
    ${groups.map(([title, list, open]) => {
      if (!list.length) return "";
      const head = `<span>${title}</span> <span class="count">${list.length}</span>`;
      const rows = list.map((i) => gradeRow(i, null, c.code)).join("");
      return open ? `<div class="group"><h3 class="group-title">${head}</h3>${rows}</div>` : `<details class="group"><summary class="group-title">${head}</summary>${rows}</details>`;
    }).join("")}
    ${c.url ? `<p class="block-note"><a href="${escapeHtml(c.url)}" target="_blank" rel="noopener">Open grades in eLC ↗</a></p>` : ""}`;
}


/* ---------- Grade math (mirror of overall() in scripts/build_grades.py) ----------
   Only used when you've entered your own score for an item, so the class
   grade can be redone in the browser. Keep the two in step. */

const LETTERS = [[93, "A"], [90, "A-"], [87, "B+"], [83, "B"], [80, "B-"], [77, "C+"], [73, "C"], [70, "C-"], [60, "D"], [0, "F"]];
const letterFor = (p) => (p == null ? null : LETTERS.find(([cut]) => p >= cut - 1e-9)[1]);
const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

function categoryPct(items, dropLow, dropHigh, fill = null) {
  let rows = [];
  for (const it of items) {
    if (it.max <= 0) continue;
    if (it.got == null) { if (fill == null) continue; rows.push([fill, it.weight || it.max]); }
    else rows.push([it.got / it.max, it.weight || it.max]);
  }
  if (!rows.length) return null;
  rows.sort((a, b) => a[0] - b[0]);
  rows = rows.slice(Math.min(dropLow, Math.max(rows.length - 1, 0)));
  if (dropHigh) rows = rows.slice(0, Math.max(rows.length - dropHigh, 1));
  const tw = rows.reduce((n, r) => n + r[1], 0);
  return tw ? (100 * rows.reduce((n, r) => n + r[0] * r[1], 0)) / tw : null;
}

function gradeCalc(calc) {
  const items = calc.items.map(([name, cat, max, weight, got, flags]) => ({ name, cat, max: max || 0, weight, got, bonus: Boolean(flags & 1), excluded: Boolean(flags & 2) }));
  const counted = items.filter((i) => !i.excluded && !i.bonus);
  const bonus = items.filter((i) => i.bonus && i.got != null);
  if (calc.sys === "Formula") return null;
  if (calc.sys === "Points" || (!calc.cats.length && calc.sys !== "Weighted")) {
    const got = counted.filter((i) => i.got != null).reduce((n, i) => n + i.got, 0);
    const gradedMax = counted.filter((i) => i.got != null).reduce((n, i) => n + i.max, 0);
    const allMax = counted.reduce((n, i) => n + i.max, 0);
    const extra = bonus.reduce((n, i) => n + i.got, 0);
    const cur = gradedMax ? (100 * (got + extra)) / gradedMax : null;
    return {
      current: round1(cur), floor: round1(allMax ? (100 * (got + extra)) / allMax : null),
      ceiling: round1(allMax ? Math.min((100 * (got + extra + allMax - gradedMax)) / allMax, 100) : null),
      gradedShare: round1(allMax ? (100 * gradedMax) / allMax : null), letter: letterFor(cur), categories: [],
    };
  }
  const groups = [];
  const catIds = new Set(calc.cats.map((c) => c[0]));
  for (const [cid, name, weight, dropLow, dropHigh, excluded] of calc.cats) {
    if (excluded) continue;
    const members = counted.filter((i) => i.cat === cid);
    if (members.length) groups.push({ name, weight, dropLow, dropHigh, items: members });
  }
  const loose = counted.filter((i) => i.cat == null || !catIds.has(i.cat));
  if (loose.length) {
    const even = loose.every((i) => Math.abs((i.weight || 0) - (loose[0].weight || 0)) < 1e-6);
    for (const i of loose) groups.push({ name: i.name, weight: (even ? 1 : i.weight) || 0, dropLow: 0, dropHigh: 0, items: [i], single: true });
  }
  const totalW = groups.reduce((n, g) => n + g.weight, 0) || 1;
  let curNum = 0, curDen = 0, floNum = 0, ceiNum = 0, share = 0;
  const cats = [];
  for (const g of groups) {
    const cur = categoryPct(g.items, g.dropLow, g.dropHigh);
    const flo = categoryPct(g.items, g.dropLow, g.dropHigh, 0);
    const cei = categoryPct(g.items, g.dropLow, g.dropHigh, 1);
    const nGraded = g.items.filter((i) => i.got != null).length;
    share += (g.weight * nGraded) / g.items.length;
    if (cur != null) { curNum += g.weight * cur; curDen += g.weight; }
    floNum += g.weight * (flo || 0);
    ceiNum += g.weight * (cei != null ? cei : 100);
    if (!g.single) cats.push({ name: g.name, weight: round1((100 * g.weight) / totalW), pct: round1(cur), graded: nGraded, total: g.items.length, dropLow: g.dropLow, earned: cur != null ? Math.round((g.weight * cur / totalW) * 100) / 100 : null });
  }
  const cur = curDen ? curNum / curDen : null;
  return { current: round1(cur), floor: round1(floNum / totalW), ceiling: round1(ceiNum / totalW), gradedShare: round1((100 * share) / totalW), letter: letterFor(cur), categories: cats };
}

/* ---------- Your own scores (encrypted overrides) ---------- */

async function encryptForGrades(payload, pub) {
  const eph = await crypto.subtle.generateKey(ECDH, true, ["deriveBits"]);
  const pubKey = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: pub.x, y: pub.y, ext: true }, ECDH, false, []);
  const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: pubKey }, eph.privateKey, 256);
  const hk = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  const aes = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: new TextEncoder().encode("dashboard-grades-v1") },
    hk, { name: "AES-GCM", length: 256 }, false, ["encrypt"]
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes, new TextEncoder().encode(JSON.stringify(payload))));
  const epk = await crypto.subtle.exportKey("jwk", eph.publicKey);
  const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { v: 1, kid: pub.x.slice(0, 12), epk: { kty: "EC", crv: "P-256", x: epk.x, y: epk.y }, iv: b64u(iv), ct: b64u(ct) };
}

const overrideKey = (code, name) => `${code}|${name}`;

function applyOverrides(grades) {
  const list = state.gradeOverrides || [];
  if (!list.length) return grades;
  const by = new Map(list.map((o) => [overrideKey(o.code, o.name), o]));
  const courses = grades.courses.map((c) => {
    const mine = c.items.filter((i) => by.has(overrideKey(c.code, i.name)));
    if (!mine.length) return c;
    let changed = false;
    const items = c.items.map((i) => {
      const o = by.get(overrideKey(c.code, i.name));
      if (!o) return i;
      const elcGot = i.score ? Number(i.score.split(" / ")[0]) : null;
      if (elcGot) return { ...i, overrideStale: o.got }; // eLC has a real grade now; it wins
      changed = true;
      const max = i.score ? Number(i.score.split(" / ")[1]) : o.max;
      return { ...i, status: "yours", elcScore: i.score, score: `${o.got} / ${max}`, pct: max ? Math.round((1000 * o.got) / max) / 10 : null, mine: o };
    });
    if (!changed || !c.calc) return { ...c, items };
    const calc = {
      ...c.calc,
      items: c.calc.items.map((row) => {
        const o = by.get(overrideKey(c.code, row[0]));
        return o && !row[4] ? [row[0], row[1], row[2], row[3], o.got, row[5]] : row;
      }),
    };
    const g = gradeCalc(calc);
    const counts = { ...c.counts };
    items.forEach((i, n) => { if (i.status === "yours") { counts[c.items[n].status] = Math.max(0, (counts[c.items[n].status] || 0) - 1); } });
    return g ? { ...c, items, counts, grade: { ...c.grade, ...g, floorLetter: letterFor(g.floor), ceilingLetter: letterFor(g.ceiling), withYours: true } } : { ...c, items, counts };
  });
  return { ...grades, courses };
}

async function loadOverrides() {
  state.gradeOverrides = [];
  if (!state.gradesKey || !state.gradesPub) return;
  const enc = await loadJson("data/grade-overrides.enc.json", null);
  if (!enc || !enc.ct || (enc.kid && enc.kid !== state.gradesPub.x.slice(0, 12))) return;
  try {
    const data = await decryptGrades(enc, state.gradesPub, state.gradesKey);
    state.gradeOverrides = Array.isArray(data.overrides) ? data.overrides : [];
  } catch (error) {
    console.warn("overrides", error);
  }
}

function openOverride(code, name) {
  const c = (state.gradesRaw?.courses || []).find((x) => x.code === code);
  const item = c && c.items.find((i) => i.name === name);
  if (!item) return;
  const current = (state.gradeOverrides || []).find((o) => o.code === code && o.name === name);
  const max = item.score ? Number(item.score.split(" / ")[1]) : (c.calc?.items.find((r) => r[0] === name) || [])[2] || 100;
  state.overrideTarget = { code, name, max };
  $("ov-title").textContent = name;
  $("ov-meta").textContent = `${c.short} · eLC shows ${item.score || "no grade"}`;
  $("ov-max").textContent = `/ ${max}`;
  $("ov-got").value = current ? current.got : "";
  $("ov-note").value = current ? current.note || "" : "";
  $("ov-clear").hidden = !current;
  $("ov-msg").textContent = "";
  $("override-modal").showModal();
}

async function saveOverride(clear = false) {
  if (needsKey("Connect this device to save your own scores.")) return;
  const t = state.overrideTarget;
  const got = Number($("ov-got").value);
  if (!clear && (!Number.isFinite(got) || $("ov-got").value === "" || got < 0)) {
    $("ov-msg").textContent = "Enter the points you got.";
    $("ov-msg").className = "form-msg error-text";
    return;
  }
  const list = (state.gradeOverrides || []).filter((o) => !(o.code === t.code && o.name === t.name));
  if (!clear) list.push({ code: t.code, name: t.name, got, max: t.max, note: $("ov-note").value.trim(), at: new Date().toISOString() });
  try {
    const enc = await encryptForGrades({ overrides: list }, state.gradesPub);
    await updateJson("data/grade-overrides.enc.json", () => enc, clear ? "Clear a grade entry" : "Update a grade entry");
    state.gradeOverrides = list;
    $("override-modal").close();
    toast(clear ? "Back to eLC's score." : "Saved. Your grade is updated.");
    renderGrades();
  } catch (error) {
    $("ov-msg").textContent = error.message === "bad-key" ? "Your GitHub key stopped working. Reconnect to save." : `Didn't save: ${error.message}`;
    $("ov-msg").className = "form-msg error-text";
  }
}

/* ---------- Agents: hand tasks to Claude ---------- */

function jobsFor(itemId) {
  return (state.agent.jobs || []).filter((j) => j.item && j.item.id === itemId && j.status !== "archived");
}

function liveJob(itemId) {
  const jobs = jobsFor(itemId);
  return jobs.find((j) => AGENT_LIVE.includes(j.status)) || jobs.find((j) => j.status === "done") || null;
}

const STATUS_TEXT = { queued: "Queued", working: "Working", "needs-you": "Needs you", done: "Done", failed: "Didn't finish", cancelled: "Cancelled" };

function handButton(item) {
  const job = liveJob(item.id);
  if (job) {
    return `<a class="hand is-${job.status}" href="#agents" title="Claude: ${escapeHtml(STATUS_TEXT[job.status] || job.status)}" aria-label="Claude job: ${escapeHtml(STATUS_TEXT[job.status] || job.status)}">${job.status === "done" ? "✓" : job.status === "needs-you" ? "!" : "…"}</a>`;
  }
  return `<button type="button" class="hand" data-hand="${escapeHtml(item.id)}" aria-label="Hand off to Claude: ${escapeHtml(item.title)}" title="Hand off to Claude">⇢</button>`;
}

function itemSnapshot(item) {
  return {
    id: item.id,
    title: item.title,
    course: item.course || "",
    due: item.dueDate ? item.dueDate.toISOString() : null,
    url: item.url || "",
    note: item.note || "",
    parts: item.parts ? item.parts.map((p) => ({ id: p.id, title: p.title, url: p.url || "" })) : undefined,
  };
}

function openHandoff(itemOrTitle) {
  if (needsKey("Connect this device to hand tasks to Claude.")) return;
  const isItem = typeof itemOrTitle === "object";
  const item = isItem ? itemOrTitle : { id: `free-${Date.now().toString(36)}`, title: itemOrTitle, course: "" };
  state.handTarget = isItem ? itemSnapshot(item) : { id: item.id, title: item.title, course: "", due: null, url: "", note: "" };
  const course = state.courseNames[item.course] || item.org || "";
  $("hand-title").textContent = item.title;
  $("hand-meta").textContent = [course, isItem && item.dueDate ? `Due ${whenSentence(item)}` : "", item.parts ? `${item.parts.length} parts` : ""].filter(Boolean).join(" · ");
  const isClass = Boolean(item.course);
  $("hand-type").innerHTML = Object.entries(AGENT_TYPES)
    .filter(([key]) => !(isClass && key === "draft"))
    .map(([key, t]) => `<option value="${key}">${escapeHtml(t.label)}</option>`)
    .join("");
  $("hand-type").value = isClass ? "prep" : "research";
  $("hand-hint").textContent = AGENT_TYPES[$("hand-type").value].hint;
  $("hand-ask").value = "";
  $("hand-msg").textContent = "";
  const modal = $("hand-modal");
  if (typeof modal.showModal === "function") modal.showModal();
  else modal.setAttribute("open", "");
}

async function queueJob(event) {
  event.preventDefault();
  const target = state.handTarget;
  if (!target) return;
  const job = {
    id: `job-${Date.now().toString(36)}`,
    type: $("hand-type").value,
    item: target,
    ask: $("hand-ask").value.trim(),
    status: "queued",
    requested: new Date().toISOString(),
  };
  const button = $("hand-save");
  button.disabled = true;
  try {
    state.agent = await updateJson(
      "data/agent.json",
      (data) => ({ ...data, jobs: [...(data.jobs || []), job] }),
      `Hand off to Claude: ${target.title}`
    );
    $("hand-modal").close();
    toast("Queued. Claude picks it up within the hour.");
    renderAll();
  } catch (error) {
    $("hand-msg").textContent = error.message === "bad-key" ? "Your GitHub key stopped working. Reconnect to save." : `Didn't save: ${error.message}`;
    $("hand-msg").className = "form-msg error-text";
  } finally {
    button.disabled = false;
  }
}

async function changeJob(id, change, message, done) {
  if (needsKey("Connect this device to manage Claude jobs.")) return;
  try {
    state.agent = await updateJson(
      "data/agent.json",
      (data) => ({ ...data, jobs: (data.jobs || []).map((j) => (j.id === id ? change({ ...j }) : j)) }),
      message
    );
    if (done) toast(done);
  } catch (error) {
    saveError(error);
  }
  renderAll();
}

function answerJob(id, form) {
  const text = form.querySelector("textarea").value.trim();
  if (!text) return;
  changeJob(
    id,
    (j) => ({ ...j, status: "queued", replies: [...(j.replies || []), { at: new Date().toISOString(), text }] }),
    "Answer Claude's question",
    "Sent. It's back in the queue."
  );
}

/* Small, safe Markdown → HTML for results. Escapes first, then formats. */
function inlineMd(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

function renderMd(md) {
  const lines = md.replace(/\r/g, "").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i++;
      out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) { out.push(`<h${h[1].length + 1}>${inlineMd(h[2])}</h${h[1].length + 1}>`); i++; continue; }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) { out.push("<hr>"); i++; continue; }
    if (/^\s*\|/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const body = rows.filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r));
      const [head, ...rest] = body;
      out.push(`<div class="md-table"><table><thead><tr>${cells(head).map((c) => `<th>${inlineMd(c)}</th>`).join("")}</tr></thead><tbody>${rest
        .map((r) => `<tr>${cells(r).map((c) => `<td>${inlineMd(c)}</td>`).join("")}</tr>`)
        .join("")}</tbody></table></div>`);
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        const check = lines[i].match(/^\s*[-*]\s+\[( |x)\]\s+(.*)/i);
        items.push(check ? `<li class="md-check">${check[1].trim() ? "☑" : "☐"} ${inlineMd(check[2])}</li>` : `<li>${inlineMd(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ""))}</li>`);
        i++;
      }
      out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, ""));
      out.push(`<blockquote>${inlineMd(quote.join(" "))}</blockquote>`);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*([-*]|\d+\.)\s|\s*\||>)/.test(lines[i])) para.push(lines[i++]);
    if (!para.length) para.push(lines[i++]);
    out.push(`<p>${inlineMd(para.join(" "))}</p>`);
  }
  return out.join("");
}

async function openResult(id) {
  const job = (state.agent.jobs || []).find((j) => j.id === id);
  if (!job || !job.result) return;
  $("result-kind").textContent = `${AGENT_TYPES[job.type]?.label || "Result"} · ${STATUS_TEXT[job.status] || ""}`;
  $("result-title").textContent = job.item.title;
  $("result-body").innerHTML = `<p class="muted">Loading…</p>`;
  $("result-raw").href = `https://github.com/${OWNER}/${REPO}/blob/${BRANCH}/${job.result}`;
  const modal = $("result-modal");
  if (typeof modal.showModal === "function") modal.showModal();
  else modal.setAttribute("open", "");
  try {
    $("result-body").innerHTML = renderMd(await readFile(job.result));
  } catch {
    $("result-body").innerHTML = `<p class="error-text">Couldn't load the result yet. GitHub's copy can lag a minute; try again shortly.</p>`;
  }
}

function ago(iso) {
  if (!iso) return "";
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function jobCard(job) {
  const course = state.courseNames[job.item.course] || "";
  const type = AGENT_TYPES[job.type]?.label || job.type;
  const when =
    job.status === "done" ? `Finished ${ago(job.finished)}` :
    job.status === "working" ? `Started ${ago(job.started)}` :
    job.status === "needs-you" ? `Asked ${ago(job.asked || job.started)}` :
    `Queued ${ago(job.requested)}`;
  const replies = (job.replies || []).map((r) => `<p class="job-reply"><b>You:</b> ${escapeHtml(r.text)}</p>`).join("");
  const question = job.status === "needs-you" && job.question
    ? `<div class="job-question"><p><b>Claude asks:</b> ${inlineMd(job.question)}</p>
         <form class="job-answer" data-answer="${escapeHtml(job.id)}">
           <label class="sr-only" for="ans-${escapeHtml(job.id)}">Your answer</label>
           <textarea id="ans-${escapeHtml(job.id)}" rows="2" placeholder="Answer, or say “approved”…" required></textarea>
           <button type="submit" class="btn solid">Send</button>
         </form></div>`
    : "";
  const actions = [
    job.result ? `<button type="button" class="btn ${job.status === "done" ? "solid" : ""}" data-result="${escapeHtml(job.id)}">Read</button>` : "",
    job.status === "queued" ? `<button type="button" class="btn" data-cancel-job="${escapeHtml(job.id)}">Cancel</button>` : "",
    ["done", "failed", "cancelled"].includes(job.status) ? `<button type="button" class="btn" data-requeue="${escapeHtml(job.id)}">Run again</button>` : "",
    ["done", "failed", "cancelled"].includes(job.status) ? `<button type="button" class="btn" data-archive="${escapeHtml(job.id)}">Clear</button>` : "",
  ].join("");
  return `
    <article class="job is-${escapeHtml(job.status)}">
      <span class="job-status">${escapeHtml(STATUS_TEXT[job.status] || job.status)}</span>
      <div class="job-body">
        <h3 class="task-title">${course ? `<span class="tag">${escapeHtml(course)}</span>` : ""}${escapeHtml(job.item.title)}</h3>
        <p class="task-meta">${escapeHtml(type)} · ${escapeHtml(when)}${job.agents ? ` · ${plural(job.agents, "subagent")}` : ""}</p>
        ${job.ask ? `<p class="job-ask">“${escapeHtml(job.ask)}”</p>` : ""}
        ${replies}
        ${job.summary ? `<p class="job-summary">${inlineMd(job.summary)}</p>` : ""}
        ${question}
        ${actions ? `<div class="job-actions">${actions}</div>` : ""}
      </div>
    </article>`;
}

function renderAgents() {
  const jobs = (state.agent.jobs || []).filter((j) => j.status !== "archived");
  const by = (s) => jobs.filter((j) => s.includes(j.status)).sort((a, b) => new Date(b.finished || b.requested) - new Date(a.finished || a.requested));
  const needs = by(["needs-you"]);
  const live = by(["working", "queued"]);
  const finished = by(["done", "failed", "cancelled"]);
  const section = (title, list, note = "") =>
    list.length ? `<div class="group"><h3 class="group-title"><span>${title}</span> <span class="count">${list.length}</span>${note ? `<span class="group-note">${note}</span>` : ""}</h3>${list.map(jobCard).join("")}</div>` : "";
  $("agent-list").innerHTML =
    [section("Needs you", needs), section("In progress", live, "Runs hourly, 8 AM to midnight."), section("Done", finished)].join("") ||
    `<p class="muted">Nothing handed off yet. Tap ⇢ on any task in Week.</p>`;

  const badge = $("agent-badge");
  badge.hidden = !needs.length;
  badge.textContent = needs.length ? String(needs.length) : "";

  const strip = $("agent-strip");
  const freshDone = finished.filter((j) => j.status === "done" && Date.now() - new Date(j.finished) < 24 * 3600000);
  const bits = [
    needs.length ? `${plural(needs.length, "job")} need${needs.length === 1 ? "s" : ""} you` : "",
    live.length ? `${live.length} working` : "",
    freshDone.length ? `${freshDone.length} ready to read` : "",
  ].filter(Boolean);
  strip.hidden = !bits.length;
  strip.classList.toggle("is-needs", Boolean(needs.length));
  strip.textContent = bits.length ? `Claude: ${bits.join(" · ")} →` : "";
}

/* ---------- Connect (GitHub key) ---------- */

function tokenPageUrl() {
  const params = new URLSearchParams({
    name: "Dashboard",
    description: "Check off tasks from my dashboard",
    target_name: OWNER,
    expires_in: "366",
    contents: "write",
  });
  return `https://github.com/settings/personal-access-tokens/new?${params}`;
}

function updateConnectButton() {
  const connected = Boolean(state.token);
  $("connect-label").textContent = connected ? "Connected" : "Connect";
  $("connect-dot").className = `dot ${connected ? "on" : ""}`;
  $("disconnect-btn").hidden = !connected;
}

function markTokenBad() {
  state.token = "";
  storage.remove(TOKEN_KEY);
  updateConnectButton();
}

function openConnect(message = "") {
  $("connect-msg").textContent = message;
  $("connect-msg").className = "form-msg";
  $("token-input").value = "";
  const modal = $("connect-modal");
  if (typeof modal.showModal === "function") modal.showModal();
  else modal.setAttribute("open", "");
}

async function saveToken(event) {
  event.preventDefault();
  const value = $("token-input").value.trim();
  const msg = $("connect-msg");
  if (!value) return;
  msg.textContent = "Checking…";
  msg.className = "form-msg";
  try {
    const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}`, {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${value}` },
    });
    if (!r.ok) throw new Error(r.status === 401 ? "GitHub didn't accept that key." : `GitHub said ${r.status}. Make sure the key includes the ${REPO} repo.`);
    const repo = await r.json();
    if (repo.permissions && !repo.permissions.push) throw new Error("That key can only read. Set Contents to Read and write.");
    state.token = value;
    storage.set(TOKEN_KEY, value);
    updateConnectButton();
    $("connect-modal").close();
    toast("Connected. Everything now saves from this device.");
    refresh();
  } catch (error) {
    msg.textContent = error.message;
    msg.className = "form-msg error-text";
  }
}

/* ---------- Tabs ---------- */

const TABS = ["today", "week", "apply", "classes", "grades", "business", "agents"];

function showTab() {
  const tab = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "today";
  document.querySelectorAll("[data-view]").forEach((v) => (v.hidden = v.dataset.view !== tab));
  document.querySelectorAll("[data-tab]").forEach((a) => {
    if (a.dataset.tab === tab) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  window.scrollTo(0, 0);
}

/* ---------- Load and refresh ---------- */

function renderAll() {
  const c = classify();
  const three = todaysThree(c);
  renderBrief(c, three);
  renderResetBanner();
  renderFrog(three);
  renderThree(three);
  renderStreak();
  renderWeekStrip(c);
  renderReset();
  renderDeadlines(c);
  renderApps();
  renderAgents();
  if (state.courses.length) renderCourses(c);
}

async function loadJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path));
  } catch (error) {
    console.warn(error);
    return fallback;
  }
}

async function refresh() {
  const [deadlines, tasks, done, plan, apps, agent] = await Promise.all([
    loadJson("data/deadlines.json", { items: [] }),
    loadJson("data/tasks.json", []),
    loadJson("data/done.json", {}),
    loadJson("data/plan.json", {}),
    loadJson("data/applications.json", { library: [], applications: [] }),
    loadJson("data/agent.json", { jobs: [] }),
  ]);
  state.agent = agent && Array.isArray(agent.jobs) ? agent : { jobs: [] };
  state.apps = apps && typeof apps === "object" ? apps : { library: [], applications: [] };
  state.deadlines = deadlines.items || [];
  state.synced = deadlines.synced || null;
  state.tasks = Array.isArray(tasks) ? tasks : [];
  state.done = done && typeof done === "object" ? done : {};
  state.plan = plan && typeof plan === "object" ? plan : {};
  renderAll();
  $("updated").textContent = `Updated ${new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })} · deadlines sync from eLC every 15 min`;
}

async function start() {
  $("today-date").textContent = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  $("token-link").href = tokenPageUrl();
  $("repo-name").textContent = REPO;
  updateConnectButton();
  showTab();
  window.addEventListener("hashchange", showTab);

  document.addEventListener("click", async (e) => {
    const copy = e.target.closest("[data-copy]");
    if (copy) {
      try {
        await navigator.clipboard.writeText(copy.dataset.copy);
        toast("Copied");
      } catch {
        toast("Couldn't copy. Long-press to select instead.", true);
      }
      return;
    }
    const ge = e.target.closest("[data-gedit]");
    if (ge) { openOverride(ge.dataset.gedit, ge.dataset.gname); return; }
    const gk = e.target.closest("[data-gkey]");
    if (gk) {
      if (gk.dataset.gkey === "ask") $("gkey-confirm").hidden = false;
      else createGradesKey(gk);
      return;
    }
    const g = e.target.closest("[data-gtab]");
    if (g) { state.gradeTab = g.dataset.gtab; renderGrades(); return; }
    const a = e.target.closest("[data-hand],[data-result],[data-cancel-job],[data-requeue],[data-archive]");
    if (a) {
      if (a.dataset.hand) {
        const item = classify().items.find((i) => i.id === a.dataset.hand);
        if (item) openHandoff(item);
      } else if (a.dataset.result) openResult(a.dataset.result);
      else if (a.dataset.cancelJob) changeJob(a.dataset.cancelJob, (j) => ({ ...j, status: "cancelled" }), "Cancel Claude job", "Cancelled");
      else if (a.dataset.requeue) changeJob(a.dataset.requeue, (j) => ({ ...j, status: "queued", requested: new Date().toISOString(), question: null }), "Run Claude job again", "Queued again");
      else if (a.dataset.archive) changeJob(a.dataset.archive, (j) => ({ ...j, status: "archived" }), "Clear Claude job");
      return;
    }
    const t = e.target.closest("[data-done],[data-undo],[data-pin],[data-unpin],[data-focus]");
    if (!t) return;
    if (t.dataset.focus) return toggleFocus(t.dataset.focus);
    t.disabled = true;
    if (t.dataset.done) setDone(t.dataset.done, true);
    else if (t.dataset.undo) setDone(t.dataset.undo, false);
    else if (t.dataset.pin) setPinned(t.dataset.pin, true);
    else if (t.dataset.unpin) setPinned(t.dataset.unpin, false);
  });
  $("add-task").addEventListener("submit", addTask);
  $("hand-form").addEventListener("submit", queueJob);
  $("grades-lock").addEventListener("submit", unlockGrades);
  $("ov-form").addEventListener("submit", (e) => { e.preventDefault(); saveOverride(false); });
  $("ov-clear").addEventListener("click", () => saveOverride(true));
  $("ov-cancel").addEventListener("click", () => $("override-modal").close());
  $("gkey-copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(state.newGradesKey); toast("Key copied"); }
    catch { toast("Couldn't copy. Select the key and copy it by hand.", true); }
  });
  $("gkey-done").addEventListener("click", () => { state.newGradesKey = ""; renderGrades(); });
  $("hand-cancel").addEventListener("click", () => $("hand-modal").close());
  $("hand-type").addEventListener("change", () => ($("hand-hint").textContent = AGENT_TYPES[$("hand-type").value].hint));
  $("result-close").addEventListener("click", () => $("result-modal").close());
  $("agent-new").addEventListener("submit", (e) => {
    e.preventDefault();
    const title = $("agent-new-title").value.trim();
    if (!title) return;
    openHandoff(title);
    if (state.token) $("agent-new-title").value = "";
  });
  document.addEventListener("submit", (e) => {
    const form = e.target.closest("[data-answer]");
    if (!form) return;
    e.preventDefault();
    answerJob(form.dataset.answer, form);
  });
  $("connect-btn").addEventListener("click", () => openConnect());
  $("connect-form").addEventListener("submit", saveToken);
  $("connect-cancel").addEventListener("click", () => $("connect-modal").close());
  $("disconnect-btn").addEventListener("click", () => {
    markTokenBad();
    $("connect-modal").close();
    toast("This device is disconnected.");
  });

  const [courses, leadsText, products] = await Promise.all([
    loadJson("data/courses.json", []),
    readFile("data/leads.csv").catch(() => ""),
    loadJson("data/products.json", []),
  ]);
  state.courses = courses;
  state.courseNames = Object.fromEntries(courses.map((c) => [c.code, c.short]));
  fillCourseSelect();
  renderProducts(products);
  if (leadsText) setupLeads(parseCsv(leadsText));

  await refresh();
  loadGrades();
  setInterval(() => { if (!document.hidden) { refresh(); loadGrades(); } }, REFRESH_MS);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  setInterval(tickFocus, 1000);
  setInterval(renderAll, 60 * 1000); // keep countdowns honest
}

start();
