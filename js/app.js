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

   Data lives in the repo:
     data/deadlines.json  ← written by the eLC sync robot (don't edit)
     data/tasks.json      ← your own tasks
     data/done.json       ← what you've checked off (also weekly reset)
     data/plan.json       ← which items you pinned to Today's 3
     data/applications.json ← applications and the materials library
     data/courses.json, leads.csv, products.json

   Without a key the page is read-only. With a key (Connect button),
   everything saves straight to GitHub.
   ========================================================== */

const OWNER = "driegs17-alt";
const REPO = "dashboard";
const BRANCH = "main";
const REFRESH_MS = 3 * 60 * 1000;
const TOKEN_KEY = "dashboard.githubKey";
const PENDING_KEY = "dashboard.pendingDone";
const FOCUS_KEY = "dashboard.focusEnd";
const FOCUS_MINUTES = 50;
const MAX_TODAY = 3;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const IS_LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) || location.protocol === "file:";

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

  return `
    <article class="task${item.doneAt ? " done" : ""}">
      ${checkButton(item)}
      <div class="due ${cd.cls}"><strong>${escapeHtml(cd.text)}</strong><span>${escapeHtml(item.doneAt ? "" : whenLabel(item))}</span></div>
      <div class="task-body">
        <h3 class="task-title">${fresh}${tag}${escapeHtml(item.title)}</h3>
        ${note}
        ${partsList(item)}
      </div>
      <div class="row-actions">${pin}${link}</div>
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

const TABS = ["today", "week", "apply", "classes", "business"];

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
  const [deadlines, tasks, done, plan, apps] = await Promise.all([
    loadJson("data/deadlines.json", { items: [] }),
    loadJson("data/tasks.json", []),
    loadJson("data/done.json", {}),
    loadJson("data/plan.json", {}),
    loadJson("data/applications.json", { library: [], applications: [] }),
  ]);
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
  setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  setInterval(tickFocus, 1000);
  setInterval(renderAll, 60 * 1000); // keep countdowns honest
}

start();
