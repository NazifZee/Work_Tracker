# Teamwork Work Tracker - Google Sheet version

Website = plain files on **GitHub Pages** (free). Data = **your Google Sheet**, through a **Google Apps Script** web app.

* Admin has a password. Employees sign in with their **User ID only**.
* Adding an employee creates a **new tab in the sheet named after them**.
* Everything is stored in the sheet: `Users`, one tab per employee, **`Project List`** (projects + subtasks + common subtasks in ONE tab), `UpdateLog`, `Config`.

## Setup (about 10 minutes)

### 1. Put the backend code in your sheet
1. Open your Google Sheet > **Extensions > Apps Script**.
2. Delete everything in the editor, paste all of `apps-script/Code.gs`, click **Save**.
3. In the function dropdown choose **setup** and click **Run**. Google asks for permission: **Review permissions > choose your account > Advanced > Go to project (unsafe) > Allow**. (It is your own script.)
   This creates the tabs `Users`, `Config`, `Project List`, `UpdateLog`.
   If you used an older version, run **setup** again: it copies your old `Projects` / `Subtasks` / `CommonSubtasks` tabs into `Project List` (once). Then you can delete those 3 old tabs.

### 2. Set the admin password
Open the **Config** tab. Next to `AdminPassword`, type your password (10+ characters) in the **Value** cell.
After your first sign in it is scrambled automatically, so it is no longer readable in the sheet. To change it later, type a new one in that cell (or use *Change password* in the app).

### 3. Deploy the web app
**Deploy > Manage deployments** > pencil icon > Version: **New version** > **Deploy**.
(First time ever: **Deploy > New deployment > Web app**.) Settings:
* Execute as: **Me**
* Who has access: **Anyone**

Keep the same deployment so the URL stays the same. Every time you change `Code.gs` you must deploy a **New version**.
Your URL is already in `config.js`. If it ever changes, paste the new one there.

### 4. Publish the website
Upload `index.html`, `tracker.css`, `tracker.js`, `config.js` (and the `.gitignore`) to your GitHub repo `NazifZee/Work_Tracker`.
If you uploaded the earlier Supabase version, delete its `supabase` folder and `.github` folder.
Then: **Settings > Pages > Deploy from a branch > main / (root) > Save**. Site: `https://nazifzee.github.io/Work_Tracker/`

### 5. Use it
* Sign in as `admin` + your password.
* **Projects** > create projects (and subtasks). **Team access > Add employee** (name + user ID). A new tab appears in the sheet.
* **Tasks > Assign projects**. Employees open the site, type their user ID, tick their task, add notes, **Save**.
* The admin screen refreshes every minute (or press **Refresh**). Reports export to CSV/PDF.

## How the screens work
* **Admin > Tasks:** one colour-coded card per employee (click to open). Each card shows that person's projects, status counts and extra work. *Expand all / Collapse all* at the top.
* **Extra work ("Others"):** employees use the *Add extra work* box on their Tasks screen for anything outside their projects. It is saved as a dated work update, never shows as Pending, and appears on the admin card and in Reports.
* **Rework:** when a project is Done, the admin sees a **Rework** button on it (or can assign the project again). A new Round starts (shown as "Round 2"), the old finished round stays in the history, and the subtasks start fresh.

## Changing the HTML later
Open `index.html` on GitHub > pencil > edit > Commit. Live in about a minute. The data stays in the sheet.

## Good to know
* **Employees have no password.** Anyone who knows an employee's user ID can open that person's tasks. Use IDs that are not easy to guess (for example `bob.k7`) and do not share the site link publicly. The admin side is always password protected.
* You can also edit cells directly in an employee's tab (for example the Due column) and the app shows it.
* Do not rename an employee tab by hand. If you do, update the `SheetName` column in the `Users` tab.
* Deleting an employee in the app keeps their tab (renamed "... (archived)") and their history.
* Each click takes about 1-3 seconds (Google Sheets is slower than a real database). Fine for small teams.
* Sign-ins last 6 hours.

## Update: employee-specific subtasks

1. Copy the entire `apps-script/Code.gs` into your existing Google Apps Script project's Code.gs. The root `Code.gs` is an identical convenience copy; use ONE copy, not both as separate script files.
2. Save, then Deploy > Manage deployments > edit the existing web app > New version > Deploy. Keep the existing URL and access settings. No setup rerun is needed for this update.
3. Upload `index.html`, `tracker.css`, `tracker.js`, and `config.js` together to your website. The configured backend URL is unchanged.
4. Hard-refresh the page (Ctrl+Shift+R), sign in, and open Assign projects. Select projects and employees, then choose subtasks in each employee/project section. Projects with subtasks require at least one selection per person.

New assignments show only the selected subtasks to that employee. Reassigning an open project adds selected subtasks and preserves saved progress. Rework carries forward the previous round's selection.

Existing assignments with a blank AssignedSubtasks column retain their previous all-subtasks behavior. They are not narrowed automatically. The backend adds the AssignedSubtasks header to employee tabs when needed; do not delete existing rows or rebuild the sheet. Existing project definitions, employee accounts, and history remain in place.

The new frontend blocks assignment against an older backend and displays deployment instructions instead of silently assigning every subtask. Deploy the backend before uploading the frontend.

Local regression checks: `node tests/assignments.test.cjs` and `node --check tracker.js`. These use simulated Sheets data; live Google Apps Script deployment and live save behavior must be verified after deployment.
