/* ==========================================================
   Dylan's Dashboard

   Data lives in the repo:
     data/deadlines.json  ← written by the eLC sync robot (don't edit)
     data/tasks.json      ← your own tasks
     data/done.json       ← what you've checked off
     data/courses.json, projects.json, leads.csv, products.json

   Without a key the page is read-only. With a key (Connect button),
   check-offs and new tasks save straight to GitHub.
   ========================================================== */

const OWNER = "driegs17-alt";
const REPO = "dashboard";
const BRANCH = "main";
const REFRESH_MS = 3 * 60 * 1000;
const TOKEN_KEY = "dashboard.githubKey";
const PENDING_KEY = "dashboard.pendingDone";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const IS_LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) || location.protocol === "file:";

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
  courses: [],
  courseNames: {},
  token: storage.get(TOKEN_KEY) || "",
  saving: false,
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

function timeLabel(item) {
  if (!item.hasTime) return "";
  return item.dueDate.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function whenLabel(item) {
  if (!item.dueDate) return "No date";
  const time = timeLabel(item);
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

// Returns { text, sha }. Uses the API when connected (always fresh),
// otherwise the public raw file (may lag a few minutes).
async function readFile(path) {
  if (IS_LOCAL) {
    const r = await fetch(path, { cache: "no-store" });
    if (!r.ok) throw new Error(`Couldn't load ${path}`);
    return { text: await r.text(), sha: null };
  }
  if (state.token) {
    const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}?ref=${BRANCH}`, {
      headers: apiHeaders(),
      cache: "no-store",
    });
    if (r.ok) {
      const json = await r.json();
      return { text: base64ToUtf8(json.content), sha: json.sha };
    }
    if (r.status === 401) markTokenBad();
  }
  const r = await fetch(`https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/${path}?v=${Date.now()}`, { cache: "no-store" });
  if (!r.ok) {
    const fallback = await fetch(path, { cache: "no-store" });
    if (!fallback.ok) throw new Error(`Couldn't load ${path}`);
    return { text: await fallback.text(), sha: null };
  }
  return { text: await r.text(), sha: null };
}

// Read-modify-write a JSON file with one retry if someone else saved first.
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

/* Check-offs made on this device stay visible even if GitHub's public
   copy is a few minutes behind. */
function pending() {
  try { return JSON.parse(storage.get(PENDING_KEY) || "{}"); } catch { return {}; }
}
function setPending(map) {
  storage.set(PENDING_KEY, JSON.stringify(map));
}

/* ---------- Building the list ---------- */

function allItems() {
  const local = pending();
  const done = { ...state.done };
  for (const [id, value] of Object.entries(local)) {
    if (value === null) delete done[id];
    else done[id] = value;
  }

  const fromElc = state.deadlines.map((d) => ({
    ...d,
    source: "elc",
    dueDate: new Date(d.due),
  }));
  const mine = state.tasks.map((t) => ({
    ...t,
    source: "me",
    hasTime: false,
    dueDate: t.due ? new Date(`${t.due}T23:59:00`) : null,
  }));
  return [...fromElc, ...mine].map((item) => ({ ...item, doneAt: done[item.id] || null }));
}

// Many small items due at the same moment for the same class (like a week
// of Macro modules) become one bundle so the list stays calm.
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
      firstSeen: list.some((i) => i.firstSeen) ? list.map((i) => i.firstSeen).filter(Boolean).sort().pop() : null,
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
  if (!item.firstSeen) return false;
  return Date.now() - new Date(item.firstSeen) < 48 * 3600000;
}

function classify() {
  const items = allItems();
  const open = items.filter((i) => !i.doneAt);
  const recentDone = items
    .filter((i) => i.doneAt && Date.now() - new Date(i.doneAt) < 7 * 86400000)
    .sort((a, b) => new Date(b.doneAt) - new Date(a.doneAt));

  const now = new Date();
  const overdue = open.filter((i) => i.dueDate && i.dueDate < now).sort(byDue);
  const upcoming = open.filter((i) => i.dueDate && i.dueDate >= now).sort(byDue);
  const week = upcoming.filter((i) => daysUntil(i.dueDate) <= 7);
  const later = upcoming.filter((i) => daysUntil(i.dueDate) > 7);
  const undated = open.filter((i) => !i.dueDate);
  return { items, open, overdue, week, later, undated, recentDone };
}

/* ---------- Rendering: brief, focus, week strip ---------- */

function renderBrief(c) {
  const weekBundled = bundle(c.week);
  const lateBundled = bundle(c.overdue);
  const todayItems = bundle(c.week.filter((i) => daysUntil(i.dueDate) === 0));
  let title;
  let line;

  if (lateBundled.length) {
    title = `${plural(lateBundled.length, "thing")} slipped.`;
    line = `Knock out ${lateBundled[0].title} first, then back on plan.`;
  } else if (todayItems.length) {
    title = `${plural(todayItems.length, "thing")} due today.`;
    line = `Start with ${todayItems[0].title}. Everything else can wait.`;
  } else if (weekBundled.length) {
    title = `${plural(weekBundled.length, "thing")} this week.`;
    line = `Start with ${weekBundled[0].title}, due ${whenSentence(weekBundled[0])}.`;
    if (bundle(c.later).length) line += ` The rest is handled and not urgent.`;
  } else if (c.later.length) {
    const next = bundle(c.later)[0];
    title = "Clear week.";
    line = `Nothing due for 7 days. Next up: ${next.title}, ${whenSentence(next)}.`;
  } else {
    title = "All clear.";
    line = "Nothing with a deadline. New eLC work will show up here on its own.";
  }

  $("brief-title").textContent = title;
  $("brief").textContent = line;
}

function partsList(item) {
  if (!item.parts) return "";
  return `<details class="parts"><summary>${item.parts.length} parts</summary><ul>${item.parts
    .map((p) => `<li>${escapeHtml(p.title)}</li>`)
    .join("")}</ul></details>`;
}

function renderFocus(c) {
  const el = $("focus");
  const queue = [...bundle(c.overdue), ...bundle(c.week), ...bundle(c.later)];
  const item = queue[0];
  if (!item) {
    el.innerHTML = `<div class="focus-empty"><p class="label">Do this now</p><h3>Nothing. Go make something.</h3></div>`;
    return;
  }
  const cd = countdown(item);
  const course = state.courseNames[item.course] || item.course || "";
  const then = queue[1];
  const link = item.url ? `<a class="btn ghost-light" href="${escapeHtml(item.url)}" target="_blank" rel="noopener">Open in eLC ↗</a>` : "";

  el.innerHTML = `
    <div class="focus-count ${cd.cls}">
      <span>${escapeHtml(cd.text)}</span>
    </div>
    <div class="focus-body">
      <p class="label">Do this now${course ? ` · ${escapeHtml(course)}` : ""}</p>
      <h3>${escapeHtml(item.title)}</h3>
      <p class="meta">Due ${escapeHtml(whenLabel(item))}</p>
      ${partsList(item)}
      <div class="focus-actions">
        <button type="button" class="btn light" data-done="${escapeHtml(item.id)}">✓ Done</button>
        ${link}
      </div>
      ${then ? `<p class="then">After that: ${escapeHtml(then.title)} · ${escapeHtml(whenLabel(then))}</p>` : ""}
    </div>`;
}

function renderWeek(c) {
  const el = $("week");
  const open = c.open.filter((i) => i.dueDate);
  const cells = [];
  for (let d = 0; d < 14; d++) {
    const day = new Date(today());
    day.setDate(day.getDate() + d);
    const count = open.filter((i) => daysUntil(i.dueDate) === d).length;
    const label = day.toLocaleDateString(undefined, { weekday: "narrow" });
    const heavy = count >= 5 ? "heavy" : count >= 2 ? "some" : count === 1 ? "one" : "";
    cells.push(`
      <div class="day ${heavy}${d === 0 ? " is-today" : ""}" title="${escapeHtml(dayLabel(day))}: ${plural(count, "item")}">
        <span class="dow">${label}</span>
        <span class="num">${day.getDate()}</span>
        <span class="load" aria-label="${plural(count, "item")} due">${count ? count : ""}</span>
      </div>`);
  }
  el.innerHTML = `<p class="week-label">Next two weeks</p><div class="days">${cells.join("")}</div>`;
}

/* ---------- Rendering: deadline list ---------- */

function taskRow(item) {
  const cd = item.doneAt ? { cls: "done", text: "Done" } : countdown(item);
  const course = state.courseNames[item.course];
  const tag = course ? `<span class="tag">${escapeHtml(course)}</span>` : "";
  const fresh = !item.doneAt && isNew(item) ? `<span class="new">New</span>` : "";
  const note = item.note ? `<p class="task-meta">${escapeHtml(item.note)}</p>` : "";
  const link = item.url ? `<a class="open" href="${escapeHtml(item.url)}" target="_blank" rel="noopener" aria-label="Open ${escapeHtml(item.title)} in eLC">↗</a>` : "";
  const check = item.doneAt
    ? `<button type="button" class="check is-done" data-undo="${escapeHtml(item.id)}" aria-label="Undo: ${escapeHtml(item.title)}">✓</button>`
    : `<button type="button" class="check" data-done="${escapeHtml(item.id)}" aria-label="Mark done: ${escapeHtml(item.title)}"></button>`;

  return `
    <article class="task${item.doneAt ? " done" : ""}">
      ${check}
      <div class="due ${cd.cls}"><strong>${escapeHtml(cd.text)}</strong><span>${escapeHtml(item.doneAt ? "" : whenLabel(item))}</span></div>
      <div class="task-body">
        <h3 class="task-title">${fresh}${tag}${escapeHtml(item.title)}</h3>
        ${note}
        ${partsList(item)}
      </div>
      ${link}
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
  const recentDone = c.recentDone.filter((i) => !i.parts);
  $("task-groups").innerHTML =
    [
      group("Overdue", bundle(c.overdue)),
      group("Next 7 days", bundle(c.week)),
      group("Coming up", bundle(c.later), { open: false, note: "Handled. Not urgent yet." }),
      group("No date yet", c.undated.sort(byDue), { open: false }),
      group("Done this week", bundle(c.recentDone), { open: false }),
    ].join("") || `<p class="muted">Nothing on the list.</p>`;

  const synced = state.synced ? new Date(state.synced) : null;
  $("sync-note").textContent = synced
    ? `Synced from eLC automatically. Last new deadline arrived ${synced.toLocaleDateString(undefined, { month: "short", day: "numeric" })}.`
    : "Synced from eLC automatically.";
}

/* ---------- Actions ---------- */

function idsFor(id) {
  return id.startsWith("bundle:") ? id.slice(7).split(",") : [id];
}

async function setDone(id, isDone) {
  const ids = idsFor(id);
  if (!state.token) {
    openConnect("Connect this device once and check-offs will save everywhere.");
    return;
  }
  const stamp = new Date().toISOString();
  const local = pending();
  ids.forEach((i) => (local[i] = isDone ? stamp : null));
  setPending(local);
  renderAll();

  const item = allItems().find((i) => i.id === ids[0]);
  const label = id.startsWith("bundle:") ? `${ids.length} items` : item ? item.title : "task";
  try {
    const saved = await updateJson(
      "data/done.json",
      (done) => {
        ids.forEach((i) => (isDone ? (done[i] = stamp) : delete done[i]));
        return done;
      },
      `${isDone ? "Done" : "Undo"}: ${label}`
    );
    state.done = saved;
    const after = pending();
    ids.forEach((i) => delete after[i]);
    setPending(after);
    toast(isDone ? `Done: ${label}` : `Back on the list: ${label}`);
  } catch (error) {
    const after = pending();
    ids.forEach((i) => delete after[i]);
    setPending(after);
    renderAll();
    toast(error.message === "bad-key" ? "Your GitHub key stopped working. Reconnect to save." : `Didn't save: ${error.message}`, true);
  }
  renderAll();
}

async function addTask(event) {
  event.preventDefault();
  if (!state.token) {
    openConnect("Connect this device to add tasks.");
    return;
  }
  const title = $("add-title").value.trim();
  if (!title) return;
  const task = {
    id: `t-${Date.now().toString(36)}`,
    title,
    course: $("add-course").value || "",
    due: $("add-due").value || null,
    note: "",
  };
  const button = event.submitter || event.target.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    state.tasks = await updateJson("data/tasks.json", (tasks) => [...tasks, task], `Add task: ${title}`);
    event.target.reset();
    toast(`Added: ${title}`);
    renderAll();
  } catch (error) {
    toast(`Didn't save: ${error.message}`, true);
  } finally {
    button.disabled = false;
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
    toast("Connected. Check-offs now save from this device.");
    refresh();
  } catch (error) {
    msg.textContent = error.message;
    msg.className = "form-msg error-text";
  }
}

/* ---------- Classes, projects, leads, shop ---------- */

function renderCourses(c) {
  $("course-grid").innerHTML = state.courses
    .map((course) => {
      const upcoming = bundle(c.open.filter((i) => i.course === course.code && i.dueDate && i.dueDate >= new Date()));
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

  $("add-course").innerHTML =
    `<option value="">No class</option>` +
    state.courses.map((course) => `<option value="${escapeHtml(course.code)}">${escapeHtml(course.short)}</option>`).join("");
}

function renderProjects(projects) {
  $("project-grid").innerHTML = projects
    .map((p) => {
      const media = p.image
        ? `<div class="project-media"><img src="${escapeHtml(p.image)}" alt="${escapeHtml(p.title)}" loading="lazy"></div>`
        : `<div class="project-media placeholder" aria-hidden="true"><p><span>[</span>${escapeHtml(p.title)}<span>]</span></p></div>`;
      const thumbs = p.gallery && p.gallery.length
        ? `<div class="thumbs">${p.gallery.map((src, i) => `<img src="${escapeHtml(src)}" alt="${escapeHtml(p.title)}, option ${i + 1}" loading="lazy">`).join("")}</div>`
        : "";
      const links = (p.links || []).map((l) => `<a class="btn" href="${escapeHtml(l.url)}">${escapeHtml(l.label)}</a>`).join("");
      return `
        <article class="project">
          ${media}
          ${thumbs}
          <div>
            <p class="kind">${escapeHtml(p.kind)}</p>
            <h3>${escapeHtml(p.title)}<span class="status">${escapeHtml(p.status)}</span></h3>
          </div>
          <p>${escapeHtml(p.summary)}</p>
          ${p.next ? `<p class="next-step"><b>Next →</b> ${escapeHtml(p.next)}</p>` : ""}
          ${links}
        </article>`;
    })
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
  const countEl = $("lead-count");
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
    countEl.textContent = `Showing ${shown.length} of ${leads.length} · ${noSite} without a site · ${unchecked} still to check`;
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

/* ---------- Load and refresh ---------- */

function renderAll() {
  const c = classify();
  renderBrief(c);
  renderFocus(c);
  renderWeek(c);
  renderDeadlines(c);
  if (state.courses.length) renderCourses(c);
}

async function loadJson(path, fallback) {
  try {
    return JSON.parse((await readFile(path)).text);
  } catch (error) {
    console.warn(error);
    return fallback;
  }
}

async function refresh() {
  const [deadlines, tasks, done] = await Promise.all([
    loadJson("data/deadlines.json", { items: [] }),
    loadJson("data/tasks.json", []),
    loadJson("data/done.json", {}),
  ]);
  state.deadlines = deadlines.items || [];
  state.synced = deadlines.synced || null;
  state.tasks = Array.isArray(tasks) ? tasks : [];
  state.done = done && typeof done === "object" ? done : {};

  // Drop local check-offs once GitHub's copy has caught up.
  const local = pending();
  let changed = false;
  for (const [id, value] of Object.entries(local)) {
    if ((value && state.done[id]) || (value === null && !state.done[id])) { delete local[id]; changed = true; }
  }
  if (changed) setPending(local);

  renderAll();
  $("updated").textContent = `Checked ${new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

async function start() {
  $("today").textContent = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  $("token-link").href = tokenPageUrl();
  $("repo-name").textContent = REPO;
  updateConnectButton();

  document.addEventListener("click", (e) => {
    const done = e.target.closest("[data-done]");
    if (done) { done.disabled = true; setDone(done.dataset.done, true); return; }
    const undo = e.target.closest("[data-undo]");
    if (undo) { undo.disabled = true; setDone(undo.dataset.undo, false); }
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

  const [courses, projects, leadsText, products] = await Promise.all([
    loadJson("data/courses.json", []),
    loadJson("data/projects.json", []),
    readFile("data/leads.csv").then((f) => f.text).catch(() => ""),
    loadJson("data/products.json", []),
  ]);
  state.courses = courses;
  state.courseNames = Object.fromEntries(courses.map((c) => [c.code, c.short]));
  renderProjects(projects);
  if (leadsText) setupLeads(parseCsv(leadsText));
  renderProducts(products);

  await refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  // Re-render each minute so countdowns stay honest.
  setInterval(renderAll, 60 * 1000);
}

start();
