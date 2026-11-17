/**
 * Teamwork Work Tracker - Google Sheets backend (Google Apps Script web app)
 *
 * Every user, project and task lives in this Google Sheet:
 *   Users           one row per employee (User ID, Name, Active, name of their own tab)
 *   <employee tabs> one tab per employee, named after the employee - their tasks and progress
 *   Project List    ONE tab for projects, subtasks and common subtasks (Type column says which)
 *   UpdateLog       history of every progress update
 *   Config          the admin password (type it in the Value cell; it is scrambled after first login)
 *
 * Only the admin has a password. Employees sign in with their User ID only.
 */
const SHEET_ID = "";            // empty = use the sheet this script was opened from. Or paste another sheet's ID here (the long code in its link between /d/ and /edit)
const TZ = "Asia/Kolkata";
const STATUSES = ["Pending", "In progress", "Done", "Delayed"];
const ATTENDANCE_TYPES = ["Off", "First half", "Second half", "Permission"];
const H = {
  Attendance: ["Date", "Day", "UserID", "Name", "Status"],
  Users: ["UserID", "Name", "Role", "Active", "SheetName", "Created"],
  Config: ["Setting", "Value"],
  "Project List": ["Type", "ID", "Project", "Subtask"],   // Type = Project | Subtask | Common
  UpdateLog: ["Date", "UserID", "TaskID", "Status", "Pending", "CurrentWork"],
};
const PL = "Project List";
const TASK_H = ["Type", "ID", "Project", "Subtask", "Assigned", "Due", "Status", "Started", "Completed", "Updated", "Notes", "TaskID", "AssignedSubtasks", "Removed"];
const SESSION_SECONDS = 21600; // 6 hours (Apps Script cache maximum)

/* ------------------------------------------------------------------ */
/* Run this ONCE from the editor (select "setup" > Run) to authorize and create the tabs. */
function setup() {
  Object.keys(H).forEach(function (n) { sheet_(n, H[n]); });
  const cfg = sheet_("Config", H.Config);
  const rows = read_(cfg);
  if (!rows.some(function (r) { return r.Setting === "AdminPassword"; })) cfg.appendRow(["AdminPassword", ""]);
  if (!rows.some(function (r) { return r.Setting === "Help"; })) {
    cfg.appendRow(["Help", "Type your admin password (10+ characters) in the Value cell next to AdminPassword. It is scrambled automatically the first time you sign in. To change it later, type a new one here."]);
  }
  migrateOld_();
  return "Setup complete. Now type the admin password in Config > AdminPassword > Value.";
}

/** Copies data from the old separate tabs (Projects / Subtasks / CommonSubtasks) into "Project List" once. */
function migrateOld_() {
  const ss = ss_(), pl = sheet_(PL, H[PL]);
  if (read_(pl).length) return;
  const old = function (name, firstHeader) {
    const sh = ss.getSheetByName(name);
    return sh && sh.getLastRow() > 1 && String(sh.getRange(1, 1).getValue()) === firstHeader ? read_(sh) : [];
  };
  old("Projects", "Project").forEach(function (r) { append_(pl, H[PL], { Type: "Project", Project: r.Project }); });
  old("Subtasks", "SubtaskID").forEach(function (r) { append_(pl, H[PL], { Type: "Subtask", ID: r.SubtaskID, Project: r.Project, Subtask: r.Name }); });
  old("CommonSubtasks", "Name").forEach(function (r) { append_(pl, H[PL], { Type: "Common", Subtask: r.Name }); });
}

function doGet() {
  return out_({ ok: true, service: "Teamwork Work Tracker", note: "Use the website to sign in." });
}

function doPost(e) {
  let result;
  const lock = LockService.getScriptLock();
  let locked = false;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    const action = String(req.action || "");
    if (action !== "state") { lock.waitLock(25000); locked = true; }
    const data = req.data && typeof req.data === "object" && !Array.isArray(req.data) ? req.data : {};
    result = handle_(action, data, String(req.token || ""));
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    result = fail_(String(err && err.message).indexOf("lock") >= 0 ? "Server is busy. Try again." : "Something went wrong. Try again.", 500);
  } finally {
    if (locked) { try { lock.releaseLock(); } catch (x) { /* ignore */ } }
  }
  return out_(result);
}

/* ---------------------------- helpers ---------------------------- */
function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function fail_(msg, status) { return { error: msg, status: status || 400 }; }
function ok_(data) { return { data: data || {} }; }
function ss_() {
  if (SHEET_ID) return SpreadsheetApp.openById(SHEET_ID);   // a sheet ID here wins (use it to point at ANOTHER sheet)
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  throw new Error("Set SHEET_ID at the top of Code.gs (or create the script from the sheet).");
}
function today_() { return Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd"); }
function str_(v) { return v instanceof Date ? Utilities.formatDate(v, TZ, "yyyy-MM-dd") : (v === null || v === undefined ? "" : String(v)); }
function clean_(v, max) { return typeof v === "string" ? v.trim().slice(0, max) : ""; }
function lc_(v) { return String(v || "").toLowerCase(); }

function sheet_(name, headers) {
  const ss = ss_();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold");
    sh.setFrozenRows(1);
    sh.getRange(1, 1, sh.getMaxRows(), headers.length).setNumberFormat("@"); // keep everything as plain text
  }
  return sh;
}
function read_(sh) {
  const last = sh.getLastRow(), cols = sh.getLastColumn();
  if (last < 2 || cols < 1) return [];
  const vals = sh.getRange(1, 1, last, cols).getValues();
  const head = vals[0].map(str_);
  return vals.slice(1).map(function (r, i) {
    const o = { _row: i + 2 };
    head.forEach(function (h, j) { o[h] = str_(r[j]); });
    return o;
  }).filter(function (o) { return head.some(function (h) { return o[h] !== ""; }); });
}
function put_(sh, headers, o) { sh.getRange(o._row, 1, 1, headers.length).setValues([headers.map(function (h) { return o[h] === undefined ? "" : o[h]; })]); }
function append_(sh, headers, o) { sh.appendRow(headers.map(function (h) { return o[h] === undefined ? "" : o[h]; })); }
function deleteRows_(sh, rows) { rows.map(function (r) { return r._row; }).sort(function (a, b) { return b - a; }).forEach(function (n) { sh.deleteRow(n); }); }
function nextId_() {
  const p = PropertiesService.getScriptProperties();
  const n = Number(p.getProperty("nextId") || "0") + 1;
  p.setProperty("nextId", String(n));
  return n;
}
function tabName_(base, id) {
  const taken = ss_().getSheets().map(function (s) { return lc_(s.getName()); });
  const reserved = Object.keys(H).map(lc_).concat(["projects", "subtasks", "commonsubtasks"]);
  let tab = String(base || "").replace(/[\[\]\*\?:\/\\]/g, "-").trim().slice(0, 60) || id;
  if (taken.indexOf(lc_(tab)) >= 0 || reserved.indexOf(lc_(tab)) >= 0) tab = (tab + " (" + id + ")").slice(0, 95);
  let n = 2, candidate = tab;
  while (taken.indexOf(lc_(candidate)) >= 0) candidate = tab + " " + (n++);
  return candidate;
}
function throttle_(key, max) {
  const c = CacheService.getScriptCache();
  const n = Number(c.get(key) || 0);
  if (n >= max) return false;
  c.put(key, String(n + 1), 60);
  return true;
}
function hex_(bytes) { return bytes.map(function (b) { return ("0" + (b & 255).toString(16)).slice(-2); }).join(""); }
function hash_(pw, salt) {
  salt = salt || Utilities.getUuid().replace(/-/g, "");
  return "sha256:" + salt + ":" + hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + pw, Utilities.Charset.UTF_8));
}
function adminRow_() {
  const cfg = sheet_("Config", H.Config);
  let row = read_(cfg).filter(function (r) { return r.Setting === "AdminPassword"; })[0];
  if (!row) { cfg.appendRow(["AdminPassword", ""]); row = read_(cfg).filter(function (r) { return r.Setting === "AdminPassword"; })[0]; }
  return { cfg: cfg, row: row };
}
/** returns true / false / "unset" */
function checkAdmin_(pw) {
  const a = adminRow_(), stored = a.row.Value;
  if (!stored) return "unset";
  if (stored.indexOf("sha256:") === 0) return hash_(pw, stored.split(":")[1]) === stored;
  if (pw === stored) { a.cfg.getRange(a.row._row, 2).setValue(hash_(pw)); return true; } // scramble the typed password
  return false;
}
function userSheet_(u) {
  let sh = ss_().getSheetByName(u.SheetName);
  if (!sh) sh = sheet_(u.SheetName, TASK_H);
  const last = sh.getRange(1, 12);
  if (String(last.getValue()) !== "TaskID") last.setValue("TaskID");
  if (String(sh.getRange(1, 13).getValue()) !== "AssignedSubtasks") sh.getRange(1, 13).setValue("AssignedSubtasks");   // older tabs get the new column header
  if (String(sh.getRange(1, 14).getValue()) !== "Removed") sh.getRange(1, 14).setValue("Removed");
  return sh;
}
// Blank means a legacy assignment: retain its original all-subtasks behavior.
function assignedSubtask_(task, id) {
  return !task.AssignedSubtasks || JSON.parse(task.AssignedSubtasks).map(String).indexOf(String(id)) >= 0;
}
/** id of the first (oldest) round of a project in one employee tab */
function firstTaskId_(rows, project) {
  const ids = rows.filter(function (r) { return r.Type === "Task" && lc_(r.Project) === lc_(project); }).map(function (r) { return Number(r.ID); });
  return ids.length ? String(Math.min.apply(null, ids)) : "";
}
/** key that ties a subtask progress row to one subtask AND one round of the project */
function subKey_(rows, r) { return r.ID + "|" + (r.TaskID || firstTaskId_(rows, r.Project)); }

/* ------------------------------ api ------------------------------ */
function login_(d) {
  const id = lc_(clean_(d.id, 40));
  const pw = typeof d.password === "string" && d.password.length <= 200 ? d.password : "";
  if (!id) return fail_("Enter your user ID.", 400);
  if (!throttle_("a_all", 60) || !throttle_("a_" + id.replace(/[^a-z0-9._-]/g, "_"), 12)) return fail_("Too many attempts. Try again in one minute.", 429);
  let sid;
  if (id === "admin") {
    const good = checkAdmin_(pw);
    if (good === "unset") return fail_("Admin password is not set. Open the Config tab in your sheet and type it next to AdminPassword.", 401);
    if (!good) return fail_("Invalid user ID or password.", 401);
    sid = "admin";
  } else {
    const u = read_(sheet_("Users", H.Users)).filter(function (r) { return r.UserID === id && r.Role === "employee" && r.Active === "1"; })[0];
    if (!u) return fail_("Invalid user ID.", 401);
    sid = u.UserID;
  }
  const token = Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, "");
  const cache = CacheService.getScriptCache();
  cache.put("s_" + token, sid, SESSION_SECONDS);
  cache.remove("a_" + id.replace(/[^a-z0-9._-]/g, "_"));
  return ok_({ token: token });
}

function me_(sid) {
  if (sid === "admin") return { id: "admin", name: "Administrator", role: "admin" };
  const u = read_(sheet_("Users", H.Users)).filter(function (r) { return r.UserID === sid && r.Role === "employee" && r.Active === "1"; })[0];
  return u ? { id: u.UserID, name: u.Name, role: "employee", SheetName: u.SheetName } : null;
}

function handle_(action, d, token) {
  if (action === "login") return login_(d);
  const cache = CacheService.getScriptCache();
  const sid = token ? cache.get("s_" + token) : null;
  const me = sid ? me_(sid) : null;
  if (!me) return fail_("Sign in to continue.", 401);
  const admin = me.role === "admin";
  const today = today_();

  if (action === "state") return ok_(state_(me, today));
  if (action === "logout") { cache.remove("s_" + token); return ok_(); }
  if (action === "password") {
    if (!admin) return fail_("Employees sign in with their user ID only. There is no password to change.", 403);
    const current = typeof d.current === "string" ? d.current : "";
    if (checkAdmin_(current) !== true) return fail_("Current password is incorrect.", 400);
    const pw = typeof d.password === "string" ? d.password : "";
    if (pw.length < 10 || pw.length > 200) return fail_("Enter a new password of 10 to 200 characters.", 400);
    const a = adminRow_();
    a.cfg.getRange(a.row._row, 2).setValue(hash_(pw));
    return ok_();
  }

  /* ---------- employee actions ---------- */
  if (action === "update" || action === "batch") {
    if (admin) return fail_("Only employees can update their task progress.", 403);
    const list = action === "batch" ? d.updates : [d];
    if (!Array.isArray(list) || !list.length || list.length > 200) return fail_("Check the selected task updates.", 400);
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      if (!it || typeof it !== "object" || !/^\d{1,9}$/.test(String(it.id)) || STATUSES.indexOf(it.status) < 0 ||
          typeof it.note !== "string" || it.note.length > 3000 ||
          (it.pending !== undefined && (typeof it.pending !== "string" || it.pending.length > 3000))) return fail_("Check the selected task updates.", 400);
      if (it.project !== undefined) return fail_("Project changes are unavailable in task updates.", 403);
    }
    const sh = userSheet_(me), rows = read_(sh);
    const targets = list.map(function (it) {
      return rows.filter(function (r) { return r.Type === "Task" && r.ID === String(Number(it.id)); })[0];
    });
    if (targets.some(function (t) { return !t || t.Removed === "1"; })) return fail_("One or more tasks are unavailable.", 404);
    const log = sheet_("UpdateLog", H.UpdateLog);
    list.forEach(function (it, i) {
      const t = targets[i], pending = (it.pending || "").trim(), note = it.note.trim();
      t.Status = it.status;
      t.Notes = [pending ? "Pending: " + pending : "", note].filter(Boolean).join("\n");
      t.Updated = today;
      if (it.status === "In progress" || it.status === "Done") t.Started = t.Started || today;
      t.Completed = it.status === "Done" ? (t.Completed || today) : "";
      put_(sh, TASK_H, t);
      append_(log, H.UpdateLog, { Date: today, UserID: me.id, TaskID: t.ID, Status: it.status, Pending: pending, CurrentWork: note });
    });
    return ok_();
  }

  if (action === "subtask/progress") {
    if (admin) return fail_("Only employees can update subtask progress.", 403);
    const status = clean_(d.status, 20);
    if (STATUSES.indexOf(status) < 0) return fail_("Choose a status.", 400);
    if (!/^\d{1,9}$/.test(String(d.id)) || !/^\d{1,9}$/.test(String(d.task_id))) return fail_("Subtask unavailable.", 404);
    const sub0 = read_(sheet_(PL, H[PL])).filter(function (r) { return r.Type === "Subtask" && r.ID === String(Number(d.id)); })[0];
    const sub = sub0 && { SubtaskID: sub0.ID, Project: sub0.Project, Name: sub0.Subtask };
    const sh = userSheet_(me), rows = read_(sh);
    const task = rows.filter(function (r) { return r.Type === "Task" && r.ID === String(Number(d.task_id)); })[0];
    if (!sub || !task || task.Removed === "1" || lc_(task.Project) !== lc_(sub.Project) || !assignedSubtask_(task, sub.SubtaskID)) return fail_("Subtask unavailable.", 404);
    const prev = rows.filter(function (r) { return r.Type === "Subtask" && subKey_(rows, r) === sub.SubtaskID + "|" + task.ID; })[0];
    const rec = { Type: "Subtask", ID: sub.SubtaskID, Project: sub.Project, Subtask: sub.Name, Status: status, Updated: today, Notes: clean_(d.note, 3000), TaskID: task.ID };
    if (prev) { rec._row = prev._row; put_(sh, TASK_H, rec); } else append_(sh, TASK_H, rec);
    task.Updated = today;
    if (status !== "Pending" && task.Status === "Pending") {
      task.Status = "In progress";
      task.Started = task.Started || today;
    }
    put_(sh, TASK_H, task);
    return ok_();
  }

  if (action === "extra/add") {
    if (admin) return fail_("Only employees can add extra work.", 403);
    const note = clean_(d.note, 3000);
    if (!note) return fail_("Describe the extra work you did.", 400);
    const date = typeof d.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.date) && d.date <= today ? d.date : today;
    append_(sheet_("UpdateLog", H.UpdateLog), H.UpdateLog, { Date: date, UserID: me.id, TaskID: "", Status: "Extra", Pending: "", CurrentWork: note });
    return ok_();
  }

  /* ---------- admin only ---------- */
  if (!admin) return fail_("Administrator access required.", 403);
  const plSh = sheet_(PL, H[PL]);
  const usersSh = sheet_("Users", H.Users);
  const rowsOf_ = function (type) { return read_(plSh).filter(function (r) { return r.Type === type; }); };
  const findProject = function (name) { return rowsOf_("Project").filter(function (r) { return lc_(r.Project) === lc_(name); })[0]; };

  switch (action) {
    case "attendance/list": {
      const month = clean_(d.month, 7);
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return fail_("Choose a valid month.", 400);
      const members = new Set(read_(usersSh).filter(function (r) {
        return r.Role === "employee" && r.Active === "1";
      }).map(function (r) { return r.UserID; }));
      const records = read_(sheet_("Attendance", H.Attendance)).filter(function (r) {
        return members.has(r.UserID) && r.Date.startsWith(month + "-");
      }).map(function (r) {
        return {date:r.Date, day:r.Day, user_id:r.UserID, name:r.Name, status:r.Status};
      });
      return ok_({records:records});
    }
    case "attendance/save": {
      const date = d.date;
      if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail_("Choose a valid date.", 400);
      const parsed = new Date(date + "T00:00:00Z");
      if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return fail_("Choose a valid date.", 400);
      if (!ATTENDANCE_TYPES.includes(d.status)) return fail_("Choose an attendance status.", 400);
      const user = read_(usersSh).find(function (r) {
        return r.UserID === d.user_id && r.Role === "employee" && r.Active === "1";
      });
      if (!user) return fail_("Choose an active employee.", 404);
      const sh = sheet_("Attendance", H.Attendance);
      const existing = read_(sh).find(function (r) { return r.Date === date && r.UserID === user.UserID; });
      const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      const record = {Date:date, Day:days[parsed.getUTCDay()], UserID:user.UserID, Name:user.Name, Status:d.status};
      if (existing) {
        record._row = existing._row;
        put_(sh, H.Attendance, record);
      } else {
        append_(sh, H.Attendance, record);
      }
      return ok_();
    }

    case "project": {
      const name = clean_(d.name, 100);
      if (!name) return fail_("Enter a project name.", 400);
      if (lc_(name) === "others") return fail_("\"Others\" is built in: employees add extra work from their own screen.", 400);
      if (findProject(name)) return fail_("That project already exists.", 409);
      append_(plSh, H[PL], { Type: "Project", Project: name });
      return ok_();
    }
    case "project/delete": {
      const p = findProject(clean_(d.name, 100));
      if (!p) return fail_("Project unavailable.", 404);
      deleteRows_(plSh, [p].concat(rowsOf_("Subtask").filter(function (r) { return lc_(r.Project) === lc_(p.Project); })));
      return ok_();
    }
    case "common-subtask": {
      const name = clean_(d.name, 100);
      if (!name) return fail_("Enter a common subtask name.", 400);
      if (rowsOf_("Common").some(function (r) { return lc_(r.Subtask) === lc_(name); })) return fail_("That common subtask already exists.", 409);
      append_(plSh, H[PL], { Type: "Common", Subtask: name });
      return ok_();
    }
    case "common-subtask/apply": {
      const okList = function (l) { return Array.isArray(l) && l.length > 0 && l.length <= 200 && l.every(function (x) { return typeof x === "string"; }); };
      if (!okList(d.projects) || !okList(d.subtasks)) return fail_("Select at least one project and one common subtask.", 400);
      const projects = d.projects.map(function (n) { const p = findProject(n); return p && p.Project; });
      const commons = rowsOf_("Common");
      const names = d.subtasks.map(function (n) { const c = commons.filter(function (r) { return lc_(r.Subtask) === lc_(n); })[0]; return c && c.Subtask; });
      if (projects.some(function (p) { return !p; }) || names.some(function (n) { return !n; })) return fail_("A selected project or common subtask is unavailable.", 400);
      const existing = rowsOf_("Subtask");
      let added = 0;
      projects.filter(function (p, i) { return projects.indexOf(p) === i; }).forEach(function (p) {
        names.filter(function (n, i) { return names.indexOf(n) === i; }).forEach(function (n) {
          if (existing.some(function (r) { return lc_(r.Project) === lc_(p) && lc_(r.Subtask) === lc_(n); })) return;
          const rec = { Type: "Subtask", ID: String(nextId_()), Project: p, Subtask: n };
          append_(plSh, H[PL], rec); existing.push(rec); added++;
        });
      });
      return ok_({ added: added });
    }
    case "subtask": case "subtask/rename": case "subtask/delete": {
      const id = /^\d{1,9}$/.test(String(d.id)) ? String(Number(d.id)) : "";
      const all = rowsOf_("Subtask");
      if (action === "subtask/delete") {
        const s = all.filter(function (r) { return r.ID === id; })[0];
        if (!s) return fail_("Subtask unavailable.", 404);
        deleteRows_(plSh, [s]);
        return ok_();
      }
      const name = clean_(d.name, 100);
      if (!name) return fail_("Enter a subtask name.", 400);
      let project, current;
      if (action === "subtask/rename") {
        current = all.filter(function (r) { return r.ID === id; })[0];
        project = current && current.Project;
      } else {
        const p = findProject(clean_(d.project, 100));
        project = p && p.Project;
      }
      if (!project) return fail_("Project or subtask unavailable.", 404);
      if (all.some(function (r) { return lc_(r.Project) === lc_(project) && lc_(r.Subtask) === lc_(name) && r.ID !== id; })) return fail_("That subtask already exists.", 409);
      if (current) { current.Subtask = name; put_(plSh, H[PL], current); }
      else append_(plSh, H[PL], { Type: "Subtask", ID: String(nextId_()), Project: project, Subtask: name });
      return ok_();
    }
    case "member": {
      const id = lc_(clean_(d.id, 40)), name = clean_(d.name, 100);
      if (!/^[a-z0-9._-]{3,40}$/.test(id) || id === "admin" || !name) return fail_("Enter a valid user ID (3-40 letters, numbers . _ -) and a name.", 400);
      if (read_(usersSh).some(function (r) { return lc_(r.UserID) === id; })) return fail_("That user ID already exists.", 409);
      const tab = tabName_(name, id);
      sheet_(tab, TASK_H);                       // <- the employee's own sheet tab
      append_(usersSh, H.Users, { UserID: id, Name: name, Role: "employee", Active: "1", SheetName: tab, Created: today });
      return ok_();
    }
    case "member/delete": case "access": {
      const id = clean_(d.id, 80);
      const u = read_(usersSh).filter(function (r) { return r.UserID === id && r.Role === "employee" && Number(r.Active) >= 0; })[0];
      if (!u) return fail_("Employee unavailable.", 404);
      if (action === "access") { u.Active = d.active === true ? "1" : "0"; put_(usersSh, H.Users, u); return ok_(); }
      const stamp = String(Date.now());
      const tab = ss_().getSheetByName(u.SheetName);
      if (tab) { u.SheetName = tabName_(u.SheetName.slice(0, 50) + " (archived)", stamp); tab.setName(u.SheetName); }
      const logSh = sheet_("UpdateLog", H.UpdateLog), oldId = u.UserID;
      read_(logSh).filter(function (r) { return r.UserID === oldId; }).forEach(function (r) { r.UserID = oldId + "~" + stamp; put_(logSh, H.UpdateLog, r); });
      const attendance = ss_().getSheetByName("Attendance");
      if (attendance) read_(attendance).filter(function (r) {
        return r.UserID === oldId;
      }).forEach(function (r) {
        r.UserID = oldId + "~" + stamp;
        put_(attendance, H.Attendance, r);
      });
      u.UserID = u.UserID + "~" + stamp; u.Active = "-1";
      put_(usersSh, H.Users, u);
      return ok_();
    }
    case "task": {
      const okList = function (l) { return Array.isArray(l) && l.length > 0 && l.length <= 100 && l.every(function (x) { return typeof x === "string"; }); };
      if (!okList(d.projects) || !okList(d.employees)) return fail_("Select at least one project and one employee.", 400);
      const projects = d.projects.map(function (n) { const p = findProject(n); return p && p.Project; });
      const users = read_(usersSh), subs = rowsOf_("Subtask");
      const emps = d.employees.map(function (id) { return users.filter(function (r) { return r.UserID === id && r.Role === "employee" && r.Active === "1"; })[0]; });
      if (projects.some(function (p) { return !p || lc_(p) === "others"; }) || emps.some(function (u) { return !u; })) return fail_("Choose existing projects and active employees.", 400);
      const explicit = d.assignments !== undefined;
      if (explicit && (!Array.isArray(d.assignments) || d.assignments.length !== projects.length * emps.length)) return fail_("Choose subtasks for every employee and project.", 400);
      const plans = [];
      for (const u of emps) for (const p of projects) {
        const available = subs.filter(function (s) { return lc_(s.Project) === lc_(p); }).map(function (s) { return String(s.ID); });
        let ids = available;
        if (explicit) {
          const matches = d.assignments.filter(function (a) { return a && a.user_id === u.UserID && a.project === p; });
          if (matches.length !== 1 || !Array.isArray(matches[0].subtasks)) return fail_("Choose subtasks for every employee and project.", 400);
          ids = matches[0].subtasks.map(String);
          if ((available.length && !ids.length) || ids.some(function (id) { return available.indexOf(id) < 0; })) return fail_("Select at least one valid subtask for " + u.Name + " / " + p + ".", 400);
        }
        plans.push({user: u, project: p, ids: Array.from(new Set(ids))});
      }
      let added = 0, updated = 0;
      plans.forEach(function (plan) {
        const sh = userSheet_(plan.user), rows = read_(sh);
        const open = rows.find(function (r) { return r.Type === "Task" && lc_(r.Project) === lc_(plan.project) && r.Status !== "Done" && r.Removed !== "1"; });
        if (open) {
          // Keep legacy assignments and saved progress; new selections only add work.
          if (explicit && open.AssignedSubtasks) {
            const previous = JSON.parse(open.AssignedSubtasks).map(String);
            const merged = Array.from(new Set(previous.concat(plan.ids)));
            if (merged.length !== previous.length) {
              open.AssignedSubtasks = JSON.stringify(merged);
              put_(sh, TASK_H, open);
              updated++;
            }
          }
          return;
        }
        append_(sh, TASK_H, {Type: "Task", ID: String(nextId_()), Project: plan.project, Assigned: today, Due: "", Status: "Pending", AssignedSubtasks: explicit ? JSON.stringify(plan.ids) : ""});
        added++;
      });
      return ok_({added: added, updated: updated});
    }

    case "assignments/update": {
      const u = read_(usersSh).find(function (r) { return r.UserID === d.user_id && r.Role === "employee" && Number(r.Active) >= 0; });
      if (!u) return fail_("Employee unavailable.", 404);
      if (!Array.isArray(d.assignments) || d.assignments.length > 500) return fail_("Invalid assignments.", 400);
      const sh = userSheet_(u), rows = read_(sh), subs = rowsOf_("Subtask"), seen = {};
      const plans = [];
      for (const a of d.assignments) {
        if (!a || typeof a.enabled !== "boolean" || !Array.isArray(a.subtasks)) return fail_("Invalid assignment selection.", 400);
        const task = a.id ? rows.find(function (r) { return r.Type === "Task" && r.ID === String(a.id); }) : null;
        const project = task ? task.Project : (findProject(a.project) || {}).Project;
        const key = task ? "task:" + task.ID : "project:" + lc_(project);
        if ((a.id && !task) || !project || lc_(project) === "others" || seen[key]) return fail_("Project or assignment unavailable.", 400);
        seen[key] = true;
        const ids = Array.from(new Set(a.subtasks.map(String)));
        const available = subs.filter(function (r) { return lc_(r.Project) === lc_(project); }).map(function (r) { return String(r.ID); });
        if (a.enabled && ids.some(function (id) { return available.indexOf(id) < 0; })) return fail_("A selected subtask is unavailable. Refresh and try again.", 400);
        if (!task && a.enabled && rows.some(function (r) { return r.Type === "Task" && lc_(r.Project) === lc_(project); })) return fail_("This project is already listed. Update its existing assignment.", 409);
        plans.push({task:task,project:project,ids:ids,enabled:a.enabled});
      }
      // All selections are validated before changing any assignment. Progress rows are never deleted.
      plans.forEach(function (plan) {
        if (plan.task) {
          const t = plan.task;
          if (plan.enabled) {
            const added = plan.ids.some(function (id) { return !assignedSubtask_(t,id); });
            t.AssignedSubtasks = JSON.stringify(plan.ids);
            if (added && t.Status === "Done") { t.Status = "In progress"; t.Completed = ""; }
          }
          t.Removed = plan.enabled ? "" : "1";
          put_(sh,TASK_H,t);
        } else if (plan.enabled) {
          append_(sh,TASK_H,{Type:"Task",ID:String(nextId_()),Project:plan.project,Assigned:today,Status:"Pending",AssignedSubtasks:JSON.stringify(plan.ids)});
        }
      });
      return ok_();
    }
    case "task/rework": {
      const u = read_(usersSh).filter(function (r) { return r.UserID === clean_(d.user_id, 80) && r.Role === "employee" && r.Active === "1"; })[0];
      if (!u) return fail_("Employee unavailable (disabled or archived).", 404);
      const sh = userSheet_(u), rows = read_(sh);
      const t = rows.filter(function (r) { return r.Type === "Task" && r.ID === String(Number(d.id)); })[0];
      if (!t || t.Removed === "1") return fail_("Task unavailable.", 404);
      if (t.Status !== "Done") return fail_("Only a finished (Done) project can be reworked.", 400);
      if (rows.some(function (r) { return r.Type === "Task" && lc_(r.Project) === lc_(t.Project) && r.Status !== "Done" && r.Removed !== "1"; })) return fail_("A rework round is already open for this project.", 409);
      append_(sh, TASK_H, { Type: "Task", ID: String(nextId_()), Project: t.Project, Assigned: today, Due: "", Status: "Pending", AssignedSubtasks: t.AssignedSubtasks || "" });
      return ok_();
    }
  }
  return fail_("Page unavailable.", 404);
}

function state_(me, today) {
  const admin = me.role === "admin";
  const users = read_(sheet_("Users", H.Users));
  const pl = read_(sheet_(PL, H[PL]));
  const subtasks = pl.filter(function (r) { return r.Type === "Subtask"; })
    .map(function (r) { return { SubtaskID: r.ID, Project: r.Project, Name: r.Subtask }; })
    .sort(function (a, b) { return Number(a.SubtaskID) - Number(b.SubtaskID); });
  const targets = admin ? users.filter(function (u) { return u.Role === "employee"; }) : users.filter(function (u) { return u.UserID === me.id; });
  const tasks = [], progress = [], assignmentTasks = [], ss = ss_();
  targets.forEach(function (u) {
    const sh = ss.getSheetByName(u.SheetName);
    if (!sh) return;
    const rows = read_(sh), saved = {}, counts = {};
    rows.forEach(function (r) { if (r.Type === "Subtask") saved[subKey_(rows, r)] = r; });
    rows.filter(function (r) { return r.Type === "Task" && lc_(r.Project) !== "others"; })   // "Others" is not a project: extra work is logged separately
      .sort(function (a, b) { return Number(a.ID) - Number(b.ID); })
      .forEach(function (r) {
      const id = Number(r.ID), k = lc_(r.Project);
      counts[k] = (counts[k] || 0) + 1;
      if (admin) assignmentTasks.push({id:id,user_id:u.UserID,project:r.Project,round:counts[k],removed:r.Removed === "1",status:r.Status,
        subtasks:subtasks.filter(function (s) { return lc_(s.Project) === k && assignedSubtask_(r,s.SubtaskID); }).map(function (s) { return String(s.SubtaskID); })});
      if (r.Removed === "1") return;
      tasks.push({ id: id, name: r.Project, user_id: u.UserID, due: r.Due, status: STATUSES.indexOf(r.Status) >= 0 ? r.Status : "Pending", note: r.Notes,
        project: r.Project, started: r.Started, completed: r.Completed, updated: r.Updated, assigned: r.Assigned, employee: u.Name, round: counts[k] });
      subtasks.forEach(function (s) {
        if (lc_(s.Project) !== lc_(r.Project) || !assignedSubtask_(r, s.SubtaskID)) return;
        const p = saved[s.SubtaskID + "|" + id];
        progress.push({ id: Number(s.SubtaskID), name: s.Name, task_id: id, status: p && p.Status ? p.Status : "Pending", note: p ? p.Notes : "", updated: p ? p.Updated : "" });
      });
    });
  });
  tasks.sort(function (a, b) { return (a.due || "").localeCompare(b.due || "") || b.id - a.id; });
  const byName = function (k) { return function (a, b) { return lc_(a[k]).localeCompare(lc_(b[k])); }; };
  const out = {
    assignmentVersion: 2, assignmentTasks: assignmentTasks, user: { id: me.id, name: me.name, role: me.role }, today: today, tasks: tasks, progress: progress,
    users: [], subtasks: [], commonSubtasks: [], projects: [], updates: [], extras: [],
  };
  const log = read_(sheet_("UpdateLog", H.UpdateLog));
  out.extras = log.filter(function (r) { return r.Status === "Extra" && (admin || r.UserID === me.id); }).reverse()
    .map(function (r) { return { user_id: r.UserID, date: r.Date, note: r.CurrentWork }; })
    .sort(function (a, b) { return b.date.localeCompare(a.date); });
  if (admin) {
    out.users = users.filter(function (u) { return u.Role === "employee" && Number(u.Active) >= 0; })
      .map(function (u) { return { id: u.UserID, name: u.Name, active: Number(u.Active) }; }).sort(byName("name"));
    out.subtasks = subtasks.map(function (s) { return { id: Number(s.SubtaskID), project: s.Project, name: s.Name }; });
    out.commonSubtasks = pl.filter(function (r) { return r.Type === "Common"; }).map(function (r) { return { name: r.Subtask }; }).sort(byName("name"));
    out.projects = pl.filter(function (r) { return r.Type === "Project" && lc_(r.Project) !== "others"; }).map(function (r) { return { name: r.Project }; }).sort(byName("name"));
  } else {
    out.updates = log.filter(function (r) { return r.UserID === me.id && r.Status !== "Extra" && tasks.some(function (t) { return String(t.id) === String(r.TaskID); }); }).reverse()
      .map(function (r) { return { task_id: Number(r.TaskID), date: r.Date, status: r.Status, pending: r.Pending, current_work: r.CurrentWork }; });
  }
  return out;
}
