# Dylan's Dashboard

My personal dashboard: deadlines, classes, design projects, Athens web leads and e-commerce product ideas. It's a plain static site (HTML, CSS, JavaScript) hosted free on GitHub Pages, so it works on any phone or computer.

## Editing in VS Code

Everything on the page comes from these files. Edit them, save, then commit and push.

| File | What it controls |
|------|------------------|
| `TASKS.md` | Deadlines and to-dos |
| `data/courses.json` | Class cards |
| `data/projects.json` | Design project cards |
| `data/leads.csv` | Athens web leads table |
| `data/products.json` | E-commerce product ideas |

You shouldn't need to touch `index.html`, `css/` or `js/` unless you're changing the design.

### Task format

```markdown
- [ ] **Task title** - Class (ARGD 3060), due Sun Oct 25, 11:59 PM
  - optional sub-step
```

- Put the course code in the line (like `ARGD 3060`) and it gets tagged with that class.
- Write the date as `due Mon Oct 26` (time is optional) and it gets sorted and counted down.
- To finish a task, change `[ ]` to `[x]` or move it under `## Done`.

### Leads

In `data/leads.csv`, set the `website` column to the site's address, or `no` if they don't have one. Leave it blank if you haven't checked yet. Use `status` for where you are (Not contacted, Emailed, Meeting, Client).

## Previewing on your Mac

Install the **Live Server** extension (VS Code will suggest it), then right-click `index.html` → **Open with Live Server**. Opening the file directly won't load the data.

## Publishing

1. Click the **Source Control** icon in VS Code's left sidebar.
2. Type a short message (e.g. "Update tasks") and click **Commit**.
3. Click **Sync Changes**.

GitHub Pages rebuilds the site in about a minute.

> This repo and site are public. Don't put passwords, grades, or anything private in these files.
