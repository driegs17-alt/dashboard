/* ==========================================================
   Dylan's Dashboard
   Reads TASKS.md and the files in data/ and builds the page.
   To change what shows up, edit those files — not this one.
   ========================================================== */

const TODAY = startOfDay(new Date());
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/* ---------- Small helpers ---------- */

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Turns **bold** and ~~strike~~ into HTML, after escaping everything else.
function inlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/~~(.+?)~~/g, "<s>$1</s>");
}

function plain(text) {
  return text.replace(/\*\*|~~/g, "");
}

async function load(path, type) {
  const response = await fetch(path, { cache: "no-cache" });
  if (!response.ok) throw new Error(`Couldn't load ${path} (${response.status})`);
  return type === "json" ? response.json() : response.text();
}

function showError(el, message) {
  el.innerHTML = `<p class="error">${escapeHtml(message)}</p>`;
}

/* ---------- Reading TASKS.md ---------- */

// Finds "due Sun Oct 25, 12:00 PM" (weekday and time are optional).
function parseDue(text) {
  const match = text.match(/due (?:[A-Z][a-z]{2} )?([A-Z][a-z]{2}) (\d{1,2})(?:,? (\d{1,2}):(\d{2}) ?(AM|PM))?/);
  if (!match) return null;
  const month = MONTHS.indexOf(match[1]);
  if (month < 0) return null;

  let year = TODAY.getFullYear();
  // A January date read in December belongs to next year.
  if (month < TODAY.getMonth() - 6) year += 1;

  const date = new Date(year, month, Number(match[2]));
  if (match[3]) {
    let hour = Number(match[3]) % 12;
    if (match[5] === "PM") hour += 12;
    date.setHours(hour, Number(match[4]));
  }
  return { date, hasTime: Boolean(match[3]), raw: match[0] };
}

function parseTasks(markdown) {
  const tasks = [];
  let section = "";
  let current = null;

  for (const line of markdown.split("\n")) {
    const heading = line.match(/^##\s+(.+)/);
    if (heading) {
      section = heading[1].trim();
      current = null;
      continue;
    }

    const item = line.match(/^- \[( |x|X)\]\s+(.*)$/);
    if (item) {
      const body = item[2];
      const titleMatch = body.match(/^(?:~~)?\*\*(.+?)\*\*(?:~~)?\s*(?:-\s*)?(.*)$/);
      const title = titleMatch ? titleMatch[1] : plain(body);
      const details = titleMatch ? titleMatch[2] : "";
      const code = (details.match(/\b([A-Z]{3,4}) ?(\d{4})\b/) || []).slice(1).join(" ");
      current = {
        section,
        done: item[1] !== " " || /done/i.test(section),
        title,
        details,
        due: parseDue(details),
        course: code,
        sub: [],
      };
      tasks.push(current);
      continue;
    }

    const sub = line.match(/^\s{2,}- (.+)$/);
    if (sub && current) current.sub.push(sub[1]);
  }
  return tasks;
}

function daysUntil(date) {
  return Math.round((startOfDay(date) - TODAY) / 86400000);
}

function dueInfo(task) {
  if (!task.due) return { cls: "none", big: "No date", small: "" };
  const days = daysUntil(task.due.date);
  const d = task.due.date;
  const dateLabel = `${d.toLocaleDateString(undefined, { weekday: "short" })} ${MONTHS[d.getMonth()]} ${d.getDate()}`;
  const time = task.due.hasTime ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "";
  let big;
  if (days < 0) big = `${-days}d late`;
  else if (days === 0) big = "Today";
  else if (days === 1) big = "Tomorrow";
  else big = `${days} days`;
  const cls = days <= 2 ? "urgent" : days <= 7 ? "soon" : "later";
  return { cls, big, small: `${dateLabel}${time ? " · " + time : ""}`, days };
}

// The context after the title, minus the "due …" part (already shown on the left).
function cleanDetails(task) {
  let text = task.details;
  if (task.due) text = text.replace(task.due.raw, "");
  // Drop the "Class (CODE)" label; the tag already shows the class.
  text = text.replace(/^[^,]*\([A-Z]{3,4} ?\d{4}\),?\s*/, "");
  return text.replace(/,\s*$/, "").replace(/,\s*,/g, ",").replace(/\s+-\s*$/, "").trim();
}

function renderTask(task, courseNames) {
  const info = dueInfo(task);
  const short = courseNames[task.course];
  const tag = short ? `<span class="tag">${escapeHtml(short)}</span>` : "";
  let subs = "";
  if (task.sub.length === 1) {
    subs = `<p class="task-meta">${inlineMarkdown(task.sub[0])}</p>`;
  } else if (task.sub.length > 1) {
    subs = `<details class="subtasks"><summary>${task.sub.length} parts</summary><ul>${task.sub
      .map((s) => `<li>${inlineMarkdown(s)}</li>`)
      .join("")}</ul></details>`;
  }
  return `
    <article class="task${task.done ? " done" : ""}">
      <div class="due ${info.cls}"><strong>${escapeHtml(info.big)}</strong>${escapeHtml(info.small)}</div>
      <div>
        <h3 class="task-title">${tag}${escapeHtml(task.title)}</h3>
        <p class="task-meta">${inlineMarkdown(cleanDetails(task))}</p>
        ${subs}
      </div>
    </article>`;
}

function renderTasks(tasks, courseNames) {
  const el = document.getElementById("task-groups");
  const open = tasks.filter((t) => !t.done && /active/i.test(t.section));
  const dated = open.filter((t) => t.due && daysUntil(t.due.date) >= 0).sort((a, b) => a.due.date - b.due.date);
  const overdue = open.filter((t) => t.due && daysUntil(t.due.date) < 0);
  const thisWeek = dated.filter((t) => daysUntil(t.due.date) <= 7);
  const later = dated.filter((t) => daysUntil(t.due.date) > 7);
  const undated = open.filter((t) => !t.due);
  const waiting = tasks.filter((t) => !t.done && /waiting/i.test(t.section));
  const someday = tasks.filter((t) => !t.done && /someday/i.test(t.section));

  const groups = [
    ["Overdue", overdue],
    ["Next 7 days", thisWeek],
    ["Later", later],
    ["No date yet", undated],
    ["Waiting on", waiting],
    ["Someday", someday],
  ].filter(([, list]) => list.length);

  el.innerHTML = groups.length
    ? groups
        .map(
          ([name, list]) => `
      <div class="group">
        <h3 class="group-title">${name} <span class="count">${list.length}</span></h3>
        ${list.map((t) => renderTask(t, courseNames)).join("")}
      </div>`
        )
        .join("")
    : `<p class="muted">Nothing on the list. Add tasks to TASKS.md.</p>`;

  return { open, dated, thisWeek, overdue };
}

function renderNext(groups, courseNames) {
  const el = document.getElementById("next-up");
  const [first, ...rest] = [...groups.overdue, ...groups.dated];
  if (!first) {
    el.innerHTML = `<p>No dated deadlines coming up.</p>`;
    return;
  }
  const info = dueInfo(first);
  const days = info.days;
  const number = days <= 0 ? "!" : days;
  const unit = days < 0 ? "late" : days === 0 ? "due today" : days === 1 ? "day left" : "days left";
  const sameDay = rest.filter((t) => t.due && daysUntil(t.due.date) === daysUntil(first.due.date));
  const after = rest.find((t) => daysUntil(t.due.date) !== daysUntil(first.due.date));
  const course = courseNames[first.course] ? `${courseNames[first.course]} · ` : "";

  el.innerHTML = `
    <div class="countdown">${number}<small>${unit}</small></div>
    <div>
      <p class="label">Next deadline</p>
      <h3>${escapeHtml(first.title)}</h3>
      <p class="meta">${escapeHtml(course)}${escapeHtml(info.small)}</p>
      ${sameDay.length ? `<p class="also">Same day: ${sameDay.map((t) => escapeHtml(t.title)).join(", ")}</p>` : ""}
      ${after ? `<p class="also">Then: ${escapeHtml(after.title)} · ${escapeHtml(dueInfo(after).small)}</p>` : ""}
    </div>`;
}

function renderStats(groups, leads, products) {
  const stats = [
    ["Due in 7 days", groups.thisWeek.length],
    ["Open tasks", groups.open.length],
    ["Web leads", leads],
    ["Shop ideas", products],
  ];
  document.getElementById("stats").innerHTML = stats
    .map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`)
    .join("");
}

/* ---------- Classes ---------- */

function renderCourses(courses, tasks) {
  const el = document.getElementById("course-grid");
  el.innerHTML = courses
    .map((c) => {
      const upcoming = tasks
        .filter((t) => !t.done && t.course === c.code && t.due && daysUntil(t.due.date) >= 0)
        .sort((a, b) => a.due.date - b.due.date);
      const next = upcoming[0];
      const nextHtml = next
        ? `<b>Next:</b> ${escapeHtml(next.title)} · ${escapeHtml(dueInfo(next).small)}${
            upcoming.length > 1 ? ` <span class="muted">(+${upcoming.length - 1} more)</span>` : ""
          }`
        : `<span class="muted">No upcoming deadlines</span>`;
      return `
        <article class="course">
          <div>
            <p class="course-code">${escapeHtml(c.code)}</p>
            <h3>${escapeHtml(c.short)}</h3>
            <p class="full">${escapeHtml(c.name)}</p>
          </div>
          <p class="notes">${escapeHtml(c.notes)}</p>
          <p class="course-next">${nextHtml}</p>
          <a class="btn" href="${escapeHtml(c.elc)}">Open in eLC ↗</a>
        </article>`;
    })
    .join("");
}

/* ---------- Projects ---------- */

function renderProjects(projects) {
  const el = document.getElementById("project-grid");
  el.innerHTML = projects
    .map((p) => {
      const media = p.image
        ? `<div class="project-media"><img src="${escapeHtml(p.image)}" alt="${escapeHtml(p.title)}" loading="lazy"></div>`
        : `<div class="project-media placeholder" aria-hidden="true"><p><span>[</span>${escapeHtml(p.title)}<span>]</span></p></div>`;
      const thumbs = p.gallery && p.gallery.length
        ? `<div class="thumbs">${p.gallery
            .map((src, i) => `<img src="${escapeHtml(src)}" alt="${escapeHtml(p.title)}, option ${i + 1}" loading="lazy">`)
            .join("")}</div>`
        : "";
      const links = (p.links || [])
        .map((l) => `<a class="btn" href="${escapeHtml(l.url)}">${escapeHtml(l.label)}</a>`)
        .join("");
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

/* ---------- Leads (CSV) ---------- */

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
  return `<a class="pill has-site" href="${escapeHtml(url)}">Has site ↗</a>`;
}

function setupLeads(leads) {
  const rowsEl = document.getElementById("lead-rows");
  const countEl = document.getElementById("lead-count");
  const searchEl = document.getElementById("lead-search");
  const filtersEl = document.getElementById("lead-filters");
  const areas = ["All", ...new Set(leads.map((l) => l.neighborhood).filter(Boolean))];
  let area = "All";

  filtersEl.innerHTML = areas
    .map((a) => `<button type="button" class="chip" data-area="${escapeHtml(a)}" aria-pressed="${a === "All"}">${escapeHtml(a)}</button>`)
    .join("");

  function draw() {
    const q = searchEl.value.trim().toLowerCase();
    const shown = leads.filter(
      (l) =>
        (area === "All" || l.neighborhood === area) &&
        (!q || Object.values(l).join(" ").toLowerCase().includes(q))
    );
    const noSite = leads.filter((l) => /^(no|none)$/i.test(l.website)).length;
    const unchecked = leads.filter((l) => !l.website).length;
    countEl.textContent = `Showing ${shown.length} of ${leads.length} · ${noSite} without a site · ${unchecked} still to check`;
    rowsEl.innerHTML = shown
      .map(
        (l) => `
        <tr>
          <td>${escapeHtml(l.name)}${l.notes ? `<br><span class="muted">${escapeHtml(l.notes)}</span>` : ""}</td>
          <td data-label="Area">${escapeHtml(l.neighborhood)}</td>
          <td data-label="Type">${escapeHtml(l.category)}</td>
          <td data-label="Website">${websiteCell(l.website)}</td>
          <td data-label="Status">${escapeHtml(l.status || "")}</td>
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

/* ---------- Shop ideas ---------- */

function renderProducts(products) {
  document.getElementById("product-grid").innerHTML = products
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

/* ---------- Start ---------- */

async function start() {
  document.getElementById("today").textContent = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const [tasksMd, courses, projects, leadsCsv, products] = await Promise.allSettled([
    load("TASKS.md", "text"),
    load("data/courses.json", "json"),
    load("data/projects.json", "json"),
    load("data/leads.csv", "text"),
    load("data/products.json", "json"),
  ]);

  const courseList = courses.status === "fulfilled" ? courses.value : [];
  const courseNames = Object.fromEntries(courseList.map((c) => [c.code, c.short]));
  const tasks = tasksMd.status === "fulfilled" ? parseTasks(tasksMd.value) : [];
  const leads = leadsCsv.status === "fulfilled" ? parseCsv(leadsCsv.value) : [];
  const productList = products.status === "fulfilled" ? products.value : [];

  if (tasksMd.status === "fulfilled") {
    const groups = renderTasks(tasks, courseNames);
    renderNext(groups, courseNames);
    renderStats(groups, leads.length, productList.length);
  } else {
    showError(document.getElementById("task-groups"), tasksMd.reason.message);
    showError(document.getElementById("next-up"), tasksMd.reason.message);
  }

  if (courses.status === "fulfilled") renderCourses(courseList, tasks);
  else showError(document.getElementById("course-grid"), courses.reason.message);

  if (projects.status === "fulfilled") renderProjects(projects.value);
  else showError(document.getElementById("project-grid"), projects.reason.message);

  if (leadsCsv.status === "fulfilled") setupLeads(leads);
  else showError(document.getElementById("lead-count"), leadsCsv.reason.message);

  if (products.status === "fulfilled") renderProducts(productList);
  else showError(document.getElementById("product-grid"), products.reason.message);

  document.getElementById("updated").textContent = `Page updated ${new Date(document.lastModified).toLocaleDateString()}`;
}

start();
