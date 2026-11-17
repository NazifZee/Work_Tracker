const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
let state;
let current = "login";
const selected = new Map();
let attendanceRequest = 0;
let attendanceRows = [];


const TOKEN_KEY = "tracker_token";
async function api(action, data) {
  const config = window.TRACKER_CONFIG || {};
  if (!config.scriptUrl || config.scriptUrl.includes("YOUR-SCRIPT")) {
    throw new Error("Not connected yet: open config.js and paste your Google Apps Script web app URL (see README).");
  }
  let result;
  try {
    // No custom headers on purpose: a plain text/plain POST avoids a CORS preflight, which Apps Script cannot answer.
    const response = await fetch(config.scriptUrl, {
      method: "POST",
      body: JSON.stringify({action, token: localStorage.getItem(TOKEN_KEY) || "", data: data ?? {}}),
    });
    result = await response.json();
  } catch {
    throw new Error("Cannot reach the sheet. Check your internet, and that the web app is deployed with access set to Anyone.");
  }
  if (result.error) {
    if (result.status === 401 && action !== "login") {
      localStorage.removeItem(TOKEN_KEY);
      state = undefined;
      selected.clear();
      $$("dialog[open]").forEach(dialog => dialog.close());
      show("login");
    }
    throw new Error(result.error);
  }
  if (action === "login") localStorage.setItem(TOKEN_KEY, result.data.token);
  if (action === "logout") localStorage.removeItem(TOKEN_KEY);
  return result.data ?? {};
}
function show(view) {
  if (view === "attendance" && state?.user.role !== "admin") return;
  if (view !== "attendance") attendanceRequest++;
  current = view;
  for (const pane of ["login","tasks","projects","people","reports","attendance"]) $("#" + pane).hidden = view !== pane;
  $("#nav").hidden = $("#profile").hidden = $("#reload").hidden = view === "login";
  $("#today").textContent = state?.today ?? "";
  $("#location").textContent = {login:"Sign in",tasks:"Tasks",projects:"Projects",people:"Team access",reports:"Reports",attendance:"Attendance"}[view];
  for (const button of $$("[data-view]")) {
    if (button.dataset.view === view) button.setAttribute("aria-current","page");
    else button.removeAttribute("aria-current");
  }
}
function element(tag, value, className) {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = value;
  if (className) node.className = className;
  return node;
}
function table(container, headers, rows, empty) {
  container.replaceChildren();
  if (!rows.length) return container.append(element("p",empty,"empty"));
  const scroll = element("div",undefined,"scroll");
  const grid = element("table");
  const header = grid.createTHead().insertRow();
  for (const name of headers) {
    const cell = element("th",name);
    cell.scope = "col";
    header.append(cell);
  }
  const body = grid.createTBody();
  for (const row of rows) {
    const line = body.insertRow();
    for (const item of row) {
      const cell = line.insertCell();
      if (item instanceof Node) cell.append(item);
      else cell.textContent = item;
    }
  }
  scroll.append(grid);
  container.append(scroll);
}
function status(task) {
  return task.status === "Pending" && task.due && task.due < state.today ? "Delayed" : task.status;
}
function tag(label) {
  return element("span",label,"tag " + label.toLowerCase());
}
function button(label, action) {
  const control = element("button",label);
  control.type = "button";
  control.addEventListener("click",action);
  return control;
}
const taskHeaders = ["Task","Project","Assigned to","Assigned","Due date","Status","Started","Completed","Last update","Notes"];
function taskValues(task) {
  return [task.name,(task.project || "No project")+(task.round>1?" · Round "+task.round:""),task.employee+" ("+task.user_id.split("~")[0]+(task.user_id.includes("~")?", archived":"")+")",task.assigned || "—",task.due || "—",status(task),
    task.started || "—",task.completed || "—",task.updated || "—",task.note || "—"];
}
function taskRows(tasks, hideName = false, editable = false, report = false) {
  return tasks.map(task => {
    const row = taskValues(task);
    row[1] = (task.project || task.name)+(task.round>1?" · Round "+task.round:"");
    row[5] = tag(row[5]);
    if (editable) {
      const label = element("label",undefined,"task-choice");
      const input = element("input");
      input.type = "checkbox";
      input.checked = selected.has(task.id);
      input.addEventListener("change",()=>{
        if (input.checked) {
          const previous = state.updates?.find(entry=>entry.task_id===task.id);
          selected.set(task.id,{id:task.id,status:task.status,pending:task.status === "Done" ? "" : previous?.pending || "",note:"",activities:{[task.status]:""}});
        } else selected.delete(task.id);
        $$('input[data-task-id="'+task.id+'"]').forEach(box=>{box.checked=input.checked;});
        drawBatch();
      });
      input.dataset.taskId = task.id;
      label.append(input,element("span",row[1]));
      row[1] = label;
    }
    const steps = state.progress.filter(step=>step.task_id===task.id && (report || state.user.role !== "admin" || !$("#subtask-filter").value || String(step.id)===$("#subtask-filter").value));
    if (steps.length && !editable) {
      const group = element("div",undefined,"stack");
      group.append(row[1] instanceof Node ? row[1] : element("span",row[1]));
      const details = element("details");
      details.open = state.user.role === "admin";
      details.append(element("summary","Subtasks ("+steps.length+")"));
      const subtaskTable = element("div");
      table(subtaskTable,["Subtask","Status","Last update","Notes"],steps.map(step=>[
        step.name,tag(step.status),step.updated || "No update yet",step.note || "No notes",
      ]),"No subtasks.");
      details.append(subtaskTable);
      group.append(details);
      row[1] = group;
    }
    return hideName ? row.slice(1) : row;
  });
}
function matchesFilters(task) {
  return state.user.role !== "admin" || (
    (!$("#project-filter").value || (task.project || "(No project)") === $("#project-filter").value) &&
    (!$("#subtask-filter").value || state.progress.some(step=>step.task_id===task.id && String(step.id)===$("#subtask-filter").value)) &&
    (!$("#employee-filter").value || task.user_id === $("#employee-filter").value)
  );
}
function workDate(task) {
  return task.updated || task.started || task.assigned || task.due;
}
const adminOpen = new Set();
function userColor(id) {
  let hash = 0;
  for (const ch of String(id).split("~")[0]) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return "hsl(" + ((Math.abs(hash) * 137.508) % 360).toFixed(0) + " 60% 42%)";
}
function personName(id) {
  const user = state.users.find(entry => entry.id === id);
  if (user) return user.name;
  const task = state.tasks.find(entry => entry.user_id === id);
  return task ? task.employee + " (archived)" : String(id).split("~")[0];
}
function isLatestRound(task) {
  return !state.tasks.some(other => other.user_id === task.user_id && (other.project || "").toLowerCase() === (task.project || "").toLowerCase() && other.round > task.round);
}
function extraItems(entries) {
  const list = element("div",undefined,"extra-items");
  for (const entry of entries) {
    const item = element("div",undefined,"extra-item");
    item.append(element("b",entry.date),element("span",entry.note));
    list.append(item);
  }
  return list;
}
function adminCard(group) {
  const card = element("details",undefined,"user-card");
  card.style.setProperty("--user",userColor(group.id));
  card.open = adminOpen.has(group.id);
  card.addEventListener("toggle",()=>{ if (card.open) adminOpen.add(group.id); else adminOpen.delete(group.id); });
  const name = personName(group.id);
  const title = element("span",undefined,"user-name");
  title.append(name,element("small",group.id.split("~")[0]));
  const chips = element("span",undefined,"chips");
  for (const label of ["Pending","In progress","Done","Delayed"]) {
    const count = group.tasks.filter(task=>status(task)===label).length;
    if (count) chips.append(element("span",label+" "+count,"chip "+label.toLowerCase().replace(" ","-")));
  }
  if (group.extras.length) chips.append(element("span","Extra work "+group.extras.length,"chip extra"));
  const person = state.users.find(user=>user.id===group.id);
  if (person && !person.active) chips.append(element("span","Disabled","chip"));
  const initials = name.replace(/\(.*\)/,"").trim().split(/\s+/).map(part=>part[0]).join("").slice(0,2).toUpperCase();
  const summary = element("summary");
  summary.append(element("span",initials,"avatar"),title,chips);
  const body = element("div",undefined,"user-body");
  const rows = taskRows(group.tasks,true).map((row,index)=>{
    const task = group.tasks[index];
    const rework = task.status === "Done" && isLatestRound(task) && !task.user_id.includes("~")
      ? button("Rework",async()=>{
          if (!window.confirm("Start a new round of "+task.project+" for "+task.employee+"? The finished round stays in the history.")) return;
          try { await api("task/rework",{id:task.id,user_id:task.user_id}); await refresh(); $("#notice").textContent = "Rework started."; }
          catch (error) { $("#notice").textContent = error.message; }
        })
      : "";
    return [row[0],row[2],row[3],row[4],row[5],row[6],row[7],row[8],rework];
  });
  const holder = element("div");
  table(holder,["Project","Assigned","Due date","Status","Started","Completed","Last update","Notes",""],rows,"No project tasks in this view.");
  body.append(holder);
  if (group.extras.length) {
    const details = element("details");
    details.open = true;
    details.append(element("summary","Extra work ("+group.extras.length+")"),extraItems(group.extras));
    body.append(details);
  }
  card.append(summary,body);
  return card;
}
function drawAdminGroups(displayed, period, date) {
  const holder = $("#task-list");
  const showExtras = $("#filter").value === "All statuses" && !$("#project-filter").value && !$("#subtask-filter").value;
  const employee = $("#employee-filter").value;
  const extras = showExtras ? state.extras.filter(entry => (period === "all" || entry.date === date) && (!employee || entry.user_id === employee)) : [];
  const groups = new Map();
  const group = id => { if (!groups.has(id)) groups.set(id,{id,tasks:[],extras:[]}); return groups.get(id); };
  for (const task of displayed) group(task.user_id).tasks.push(task);
  for (const entry of extras) group(entry.user_id).extras.push(entry);
  const ordered = [...groups.values()].sort((a,b)=>personName(a.id).localeCompare(personName(b.id)));
  if (!ordered.length) return holder.replaceChildren(element("p","No tasks match this view.","empty"));
  const cards = ordered.map(adminCard);
  const setAll = open => cards.forEach((card,index)=>{ card.open = open; if (open) adminOpen.add(ordered[index].id); else adminOpen.delete(ordered[index].id); });
  const bar = element("div",undefined,"toolbar group-bar");
  bar.append(element("span",ordered.length+" employee"+(ordered.length===1?"":"s")),
    button("Expand all",()=>setAll(true)),button("Collapse all",()=>setAll(false)));
  holder.replaceChildren(bar,...cards);
}
function drawExtras() {
  const holder = $("#extra-list");
  holder.replaceChildren();
  const entries = state.extras || [];
  if (!entries.length) return holder.append(element("p","No extra work added yet.","empty"));
  holder.append(element("h3","Your extra work ("+entries.length+")"),extraItems(entries.slice(0,100)));
}
function reportExtras() {
  const date = $("#report-date").value;
  if (!date || !$("#report-date").checkValidity() || $("#report-project").value) return [];
  const employee = state.user.role === "admin" ? $("#report-employee").value : state.user.id;
  return (state.extras || []).filter(entry => entry.date.startsWith(date) && (!employee || entry.user_id === employee));
}
function drawTasks() {
  const filter = $("#filter").value;
  const period = $("#task-period").value;
  const admin = state.user.role === "admin";
  const date = period === "today" ? state.today : $("#task-date").value;
  const dayMatches = task => [task.assigned,task.due,task.started,task.completed,task.updated].includes(date) || state.progress.some(step=>step.task_id===task.id && step.updated===date);
  const visible = state.tasks.filter(task => matchesFilters(task) &&
    (admin || (task.assigned || task.due) <= state.today || [task.started,task.completed,task.updated].some(Boolean)));
  const timed = visible.filter(task => period === "all" || (date && dayMatches(task)));
  const displayed = timed.filter(task => filter === "All statuses" || status(task) === filter);
  $("#stats").replaceChildren(...["All tasks","In progress","Done","Delayed"].map(label => {
    const card = element("div",undefined,"stat");
    card.append(element("span",label),element("strong",label==="All tasks"?timed.length:timed.filter(task=>status(task)===label).length));
    return card;
  }));
  const headers = taskHeaders.slice(1);
  $("#task-suggestions").hidden = admin;
  if (admin) return drawAdminGroups(displayed,period,date);
  table($("#task-list"),headers,taskRows(displayed,true,!admin),"No tasks match this view.");
  const backlog = visible.filter(task => task.status !== "Done" && workDate(task) && workDate(task) < state.today);
  table($("#suggestion-list"),headers,taskRows(backlog,true,!admin),"No unfinished work from earlier dates.");
}
function subtaskUpdate(taskId, id, changes) {
  const status = ["Done","In progress","Delayed","Pending"].find(value=>Object.hasOwn(changes,value));
  if (!status) throw new Error("Select a subtask status before saving.");
  const note = status === "Done" ? "" : Object.entries(changes)
    .map(([key,value])=>key+(value.trim() ? ": "+value.trim() : "")).join("\n");
  return {id,task_id:taskId,status,note};
}
function subtaskEditor(task, draft, steps) {
  const group = element("div",undefined,"stack");
  group.append(element("strong","Subtasks"));
  const row = element("div",undefined,"work-status-options");
  const editor = element("div",undefined,"stack");
  draft.openSteps ??= new Set();
  draft.steps ??= {};
  for (const step of steps) {
    const control = button(step.name+" · "+step.status,()=>{
      if (draft.openSteps.has(step.id)) draft.openSteps.delete(step.id);
      else draft.openSteps.add(step.id);
      drawBatch();
      $("#step-"+task.id+"-"+step.id)?.focus();
    });
    control.id = "step-"+task.id+"-"+step.id;
    control.setAttribute("aria-expanded",String(draft.openSteps.has(step.id)));
    row.append(control);
    if (!draft.openSteps.has(step.id)) continue;

    const change = draft.steps[step.id] ??= {[step.status]:step.note || ""};
    const markEdited = ()=> (draft.editedSteps ??= new Set()).add(step.id);
    const card = element("fieldset",undefined,"task-editor stack");
    card.append(element("legend",step.name));
    const choices = element("div",undefined,"work-status-options");
    const inputs = element("div",undefined,"work-note-grid");
    const labels = {Pending:"Pending work","In progress":"Current work",Delayed:"Finish task notes"};
    for (const [status,noteLabel] of Object.entries(labels)) {
      const label = element("label",undefined,"task-choice");
      const checkbox = element("input");
      checkbox.type = "checkbox";
      checkbox.checked = Object.hasOwn(change,status);
      checkbox.id = control.id+"-"+status.replaceAll(" ","-");
      checkbox.addEventListener("change",()=>{
        markEdited();
        if (!checkbox.checked) delete change[status];
        else {
          delete change.Done;
          change[status] = "";
        }
        drawBatch();
        document.getElementById(checkbox.id)?.focus();
      });
      label.append(checkbox,element("span",status === "Delayed" ? "Finish task" : status));
      choices.append(label);
      if (!checkbox.checked || !noteLabel) continue;
      const notes = element("textarea");
      notes.rows = 2;
      notes.maxLength = 900;
      notes.value = change[status];
      notes.addEventListener("input",()=>{change[status]=notes.value; markEdited();});
      const field = element("label",noteLabel);
      field.append(notes);
      inputs.append(field);
    }
    card.append(choices,inputs);
    const saveStep = async (control, complete = false)=>{
      control.disabled = true;
      try {
        await api("subtask/progress",subtaskUpdate(task.id,step.id,complete ? {Done:""} : change));
        draft.openSteps.delete(step.id);
        draft.editedSteps?.delete(step.id);
        delete draft.steps[step.id];
        await refresh();
        $("#notice").textContent = complete ? "Subtask marked done." : "Subtask progress saved.";
      } catch (error) {
        $("#notice").textContent = error.message;
      } finally {
        control.disabled = false;
      }
    };
    const save = button("Save subtask progress",()=>saveStep(save));
    const actions = element("div",undefined,"editor-actions");
    actions.append(save);
    if (step.status !== "Done") {
      const complete = button("Mark subtask done",()=>saveStep(complete,true));
      actions.append(complete);
    }
    card.append(actions);
    editor.append(card);
  }
  group.append(row,editor);
  return group;
}
function drawBatch() {
  if (state.user.role === "admin") selected.clear();
  const fields = $("#batch-fields");
  fields.replaceChildren();
  for (const draft of selected.values()) {
    const task = state.tasks.find(task=>task.id===draft.id);
    if (!task) continue;
    const panel = element("fieldset",undefined,"task-editor stack");
    panel.id = "task-editor-"+task.id;
    panel.append(element("legend",(task.project || task.name)+" · "+task.employee),element("p","Saved status: "+status(task)));
    const steps = state.progress.filter(step=>step.task_id===task.id && (state.user.role !== "admin" || !$("#subtask-filter").value || String(step.id)===$("#subtask-filter").value));
    if (steps.length) {
      if (!Object.hasOwn(draft.activities,"Done")) panel.append(subtaskEditor(task,draft,steps));
      const choices = element("div",undefined,"editor-actions project-status");
      choices.setAttribute("role","group");
      choices.setAttribute("aria-label","Project status");
      const activeStatus = Object.keys(draft.activities)[0] || status(task);
      for (const value of ["Pending","In progress","Done"]) {
        const choice = button(value === "Done" ? "Mark project done" : value,()=>{
          draft.activities = {[value]:""};
          draft.projectStatusOnly = true;
          drawBatch();
          document.getElementById(choice.id)?.focus();
        });
        choice.id = "project-status-"+task.id+"-"+value.replaceAll(" ","-");
        choice.setAttribute("aria-pressed",String(activeStatus === value));
        choices.append(choice);
      }
      panel.append(element("strong","Project status"),choices,button("Remove selection",()=>{
        selected.delete(task.id);
        drawTasks();
        drawBatch();
      }));
      fields.append(panel);
      continue;
    }
    const statuses = ["Pending","In progress","Done","Delayed"];
    const choices = element("div",undefined,"work-status-options");
    choices.append(element("strong","Work statuses"));
    for (const status of statuses) {
      const label = element("label",undefined,"task-choice");
      const checkbox = element("input");
      checkbox.type = "checkbox";
      checkbox.checked = Object.hasOwn(draft.activities,status);
      checkbox.addEventListener("change",()=>{
        if (checkbox.checked) {
          if (status === "Done") draft.activities = {};
          else delete draft.activities.Done;
          draft.activities[status] = "";
        }
        else delete draft.activities[status];
        drawBatch();
      });
      label.append(checkbox,element("span",status));
      choices.append(label);
    }
    function noteField(labelText,value,save) {
      const label = element("label",labelText);
      const field = element("textarea");
      field.rows = 2;
      field.maxLength = 450;
      field.value = value;
      field.addEventListener("input",()=>save(field.value));
      label.append(field);
      return label;
    }
    panel.append(choices);
    const notes = element("div",undefined,"work-note-grid");
    const labels = {Pending:"Pending work","In progress":"Current work",Delayed:"Delayed work"};
    for (const status of statuses) {
      if (labels[status] && Object.hasOwn(draft.activities,status)) {
        notes.append(noteField(labels[status],draft.activities[status],value=>{draft.activities[status]=value;}));
      }
    }
    if (notes.childElementCount) panel.append(notes);
    const previous = state.updates?.find(entry=>entry.task_id===task.id);
    if (!Object.hasOwn(draft.activities,"Done") && task.status !== "Done" && previous && previous.status !== "Done") {
      const details = element("details");
      details.append(element("summary","Previous unfinished work"));
      const grid = element("div",undefined,"work-note-grid previous-work-grid");
      grid.append(element("p",previous.date+" · "+previous.status));
      const lines = previous.current_work.split("\n");
      const unfinished = lines.map((line,index)=>({line,index})).filter(({line})=>/^(Pending|In progress|Delayed)(:|$)/.test(line));
      if (previous.pending && !unfinished.some(({line})=>/^Pending:/.test(line))) {
        grid.append(element("p","Pending: "+previous.pending));
      }
      for (const {line,index} of unfinished) {
        let end = index + 1;
        while (end < lines.length && !/^(Pending|In progress|Delayed|Done)(:|$)|^Tomorrow/.test(lines[end])) end++;
        grid.append(element("p",[line,...lines.slice(index+1,end)].join("\n")));
      }
      if (!unfinished.length && previous.current_work && !/^(Done|Tomorrow)/.test(previous.current_work)) {
        grid.append(element("p",previous.current_work));
      }
      details.append(grid);
      panel.append(details);
    }
    panel.append(button("Remove selection",()=>{
      selected.delete(task.id);
      drawTasks();
      drawBatch();
    }));
    fields.append(panel);
  }
  $("#batch-form").hidden = !selected.size;
}
function reportEmployeeTasks() {
  const employee = state.user.role === "admin" ? $("#report-employee").value : state.user.id;
  return state.tasks.filter(task=>!employee || task.user_id===employee);
}
function reportProjectName(task) {
  return task.project || task.name;
}
function syncReportProjects() {
  const projects = [...new Set(reportEmployeeTasks().map(reportProjectName))].sort();
  setOptions("#report-project",projects.map(name=>[name,name]));
}
function reportTasks() {
  const date = $("#report-date").value;
  const project = $("#report-project").value;
  if (!date || !$("#report-date").checkValidity()) return [];
  return reportEmployeeTasks().filter(task=>
    (!project || reportProjectName(task)===project) &&
    ([task.assigned,task.due,task.started,task.completed,task.updated].some(value=>value?.startsWith(date)) ||
      state.progress.some(step=>step.task_id===task.id && step.updated?.startsWith(date))));
}
function drawReports() {
  const date = $("#report-date").value;
  const admin = state.user.role === "admin";
  const employee = $("#report-employee");
  const scope = [date,$("#report-project").value,admin && employee.value ? employee.selectedOptions[0].text : ""];
  $("#report-range").textContent = date ? scope.filter(Boolean).join(" · ") : "Choose a reporting date.";
  const extras = reportExtras();
  table($("#report-list"),admin ? taskHeaders.slice(1) : taskHeaders,taskRows(reportTasks(),admin,false,true),extras.length ? "No project tasks in this period." : "No tasks match these report filters.");
  const box = $("#report-extras");
  box.replaceChildren();
  if (extras.length) {
    const holder = element("div");
    table(holder,admin ? ["Employee","Date","Extra work"] : ["Date","Extra work"],extras.map(entry=>admin ? [personName(entry.user_id),entry.date,entry.note] : [entry.date,entry.note]),"");
    box.append(element("h3","Extra work"),holder);
  }
}
function syncSubtaskFilter() {
  const project = $("#project-filter").value;
  setOptions("#subtask-filter",state.subtasks.filter(step=>!project || step.project===project)
    .map(step=>[String(step.id),project ? step.name : step.project+" · "+step.name]));
}
function setOptions(selector, options) {
  const control = $(selector);
  const previous = control.value;
  control.replaceChildren(new Option("All",""),...options.map(([id,label])=>new Option(label,id)));
  if (options.some(([id])=>id===previous)) control.value = previous;
}
function collapsibleList(list, count, label, open = false) {
  if (count <= 10) return list;
  const details = element("details");
  details.open = open;
  details.append(element("summary",label+" ("+count+")"),list);
  return details;
}
function manageSubtasks(project) {
  const group = element("div",undefined,"stack");
  function edit(step) {
    const dialog = $("#subtask-name");
    const form = $("form",dialog);
    form.dataset.action = step ? "subtask/rename" : "subtask";
    form.elements.namedItem("project").value = project;
    form.elements.namedItem("id").value = step?.id ?? "";
    form.elements.namedItem("name").value = step?.name ?? "";
    $("h2",dialog).textContent = step ? "Rename subtask" : "Add subtask";
    dialog.showModal();
  }
  const steps = state.subtasks.filter(step=>step.project===project);
  const list = element("div",undefined,"horizontal-project-list");
  for (const step of steps) {
    const line = element("div",undefined,"subtask-line");
    line.append(element("span",step.name),button("Rename",()=>edit(step)),button("Delete",async()=>{
      if (!confirm("Delete "+step.name+" and its progress for every assigned employee?")) return;
      try {
        await api("subtask/delete",{id:step.id});
        await refresh();
      } catch (error) { $("#notice").textContent = error.message; }
    }));
    list.append(line);
  }
  group.append(collapsibleList(list,steps.length,"Subtasks"));
  group.append(button("Add subtask",()=>edit()));
  return group;
}
function renderCommonSubtasks() {
  const form = $('form[data-action="common-subtask/apply"]');
  for (const [selector, field, entries] of [
    ["#common-subtask-options","subtasks",state.commonSubtasks],
    ["#common-project-options","projects",state.projects],
  ]) {
    const container = $(selector);
    const open = $("details",container)?.open;
    const list = element("div",undefined,"horizontal-project-list");
    const previous = new Set(new FormData(form).getAll(field));
    for (const {name} of entries) {
      const label = element("label",undefined,"task-choice");
      const input = element("input");
      input.type = "checkbox";
      input.name = field;
      input.value = name;
      input.checked = previous.has(name);
      label.append(input,element("span",name));
      list.append(label);
    }
    if (!entries.length) list.append(element("p",field==="projects"?"Create a project first.":"Add a subtask to the library first."));
    container.replaceChildren(collapsibleList(list,entries.length,field==="projects"?"Projects":"Common subtasks",open ?? previous.size>0));
  }
  $("button",form).disabled = !state.projects.length || !state.commonSubtasks.length;
}
async function refresh() {
  const next = await api("state");
  if (!next.user || !Array.isArray(next.tasks)) throw new Error("Invalid server response. Deploy the updated Code.gs web app and refresh.");
  for (const key of ["progress","users","subtasks","commonSubtasks","projects","updates","extras"]) {
    if (!Array.isArray(next[key])) next[key] = [];
  }
  state = next;
  const admin = state.user.role === "admin";
  $$("[data-admin]").forEach(node => { node.hidden = !admin; });
  $("#identity").textContent = state.user.name;
  $("#password-button").hidden = !admin;
  $("#role").textContent = (admin?"Admin":"Employee") + " · " + state.user.id;
  $("#tasks-title").textContent = admin?"Team tasks":"My tasks";
  $$("[data-employee]").forEach(node => { node.hidden = admin; });
  const extraDate = $("#extra-date");
  extraDate.max = state.today;
  extraDate.defaultValue = state.today;
  if (!extraDate.value) extraDate.value = state.today;
  $("#task-date").value ||= state.today;
  $("#task-date").max = admin ? "" : state.today;
  $("#report-date").max = admin ? "" : state.today.slice(0,$("#period").value==="month"?7:10);
  $("#report-date").value ||= state.today;
  setOptions("#project-filter",[...new Set([...state.projects.map(project=>project.name),...state.tasks.map(task=>task.project || "(No project)")])].sort().map(name=>[name,name]));
  syncSubtaskFilter();
  const reportEmployees = new Map(state.users.map(user=>[user.id,user.name+" ("+user.id+")"]));
  if (admin) for (const task of state.tasks) if (!reportEmployees.has(task.user_id)) reportEmployees.set(task.user_id,taskValues(task)[2]);
  setOptions("#report-employee",[...reportEmployees]);
  syncReportProjects();
  setOptions("#employee-filter",state.users.map(user=>[user.id,user.name+" ("+user.id+")"]));
  for (const id of selected.keys()) if (!state.tasks.some(task=>task.id===id)) selected.delete(id);
  drawBatch();
  show(current === "login" || (!admin && ["people","projects","attendance"].includes(current)) ? "tasks" : current);
  drawTasks();
  drawReports();
  if (!admin) drawExtras();
  renderCommonSubtasks();
  table($("#project-list"),["Project","Subtasks","Manage"],state.projects.map(project=>[
    project.name,manageSubtasks(project.name),button("Delete",async()=>{
      if (!window.confirm("Delete "+project.name+"? Existing assignments will stay in the tracker.")) return;
      try {
        await api("project/delete",{name:project.name});
        await refresh();
        $("#notice").textContent = "Project deleted.";
      } catch(error) {
        $("#notice").textContent = error.message;
      }
    }),
  ]),"No projects yet.");
  table($("#member-list"),["Employee","User ID","Access","Manage"],state.users.map(user=>{
    const actions = element("div",undefined,"member-actions");
    actions.append(button("Edit assignments",()=>openAssignments(user)),button(user.active?"Disable":"Enable",async()=>{
      try { await api("access",{id:user.id,active:!user.active}); await refresh(); }
      catch(error) { $("#notice").textContent=error.message; }
    }),button("Delete",async()=>{
      if (!window.confirm("Delete access for "+user.name+" ("+user.id+")? Their task history will be kept.")) return;
      try {
        await api("member/delete",{id:user.id});
        await refresh();
        $("#notice").textContent = "Employee deleted.";
      } catch(error) { $("#notice").textContent=error.message; }
    }));
    return [user.name,user.id,user.active?"Active":"Disabled",actions];
  }),"Add an employee to start assigning tasks.");
}
for (const control of $$("[data-view]")) control.addEventListener("click",()=>{
  show(control.dataset.view);
  if (current === "attendance") {
    const employees = state.users.filter(user=>user.active).map(user=>[user.id,user.name+" ("+user.id+")"]);
    setOptions("#attendance-person",employees);
    $("#attendance-person").options[0].textContent = "Choose employee";
    setOptions("#attendance-filter",employees);
    $('#attendance-form input[name="date"]').value ||= state.today;
    $("#attendance-month").value ||= state.today.slice(0,7);
    syncAttendanceRange();
    loadAttendance();
  }
});
const attendanceLabels = {
  Off:"Off / Leave",
  "First half":"Half day · 1st half",
  "Second half":"Half day · 2nd half",
  Permission:"Permission",
  "Work from home":"Work from home"
};
function drawAttendance() {
  const employee = $("#attendance-filter").value;
  const rows = attendanceRows.filter(row=>!employee || row.user_id === employee)
    .sort((a,b)=>b.date.localeCompare(a.date) || a.name.localeCompare(b.name));
  const counts = {Off:0,"First half":0,"Second half":0,Permission:0,"Work from home":0};
  for (const row of rows) if (Object.hasOwn(counts,row.status)) counts[row.status]++;
  const summary = [
    ["Off / Leave",counts.Off],
    ["Half days",counts["First half"]+counts["Second half"]],
    ["Permissions",counts.Permission],
    ["Work from home",counts["Work from home"]]
  ];
  $("#attendance-counts").replaceChildren(...summary.map(([label,count])=>{
    const card = element("div",undefined,"stat");
    card.append(element("span",label),element("strong",count));
    if (label === "Half days") card.append(element("span",counts["First half"]+" first half · "+counts["Second half"]+" second half"));
    return card;
  }));
  table($("#attendance-records"),["Date","Day","Employee","Status","Manage"],rows.map(row=>[
    row.date,row.day,row.name,tag(attendanceLabels[row.status] || row.status),button("Edit",()=>{
      const form = $("#attendance-form");
      form.elements.user_id.value = row.user_id;
      form.elements.date.value = row.date;
      form.elements.status.value = row.status;
      form.elements.end_date.value = "";
      syncAttendanceRange();
      form.elements.status.focus();
    })
  ]),"No attendance records for this selection.");
}
async function loadAttendance() {
  const request = ++attendanceRequest;
  const month = $("#attendance-month").value;
  attendanceRows = [];
  $("#attendance-counts").replaceChildren();
  $("#attendance-records").textContent = month ? "Loading attendance…" : "Choose a month.";
  if (!month) return;
  try {
    const result = await api("attendance/list",{month});
    if (request !== attendanceRequest || current !== "attendance") return;
    attendanceRows = result.records;
    drawAttendance();
  } catch (error) {
    if (request === attendanceRequest) $("#attendance-records").textContent = error.message;
  }
}
$("#attendance-month").addEventListener("change",loadAttendance);
$("#attendance-filter").addEventListener("change",()=>{
  if ($("#attendance-counts").childElementCount) drawAttendance();
});
function syncAttendanceRange() {
  const form = $("#attendance-form");
  const leave = form.elements.status.value === "Off";
  $("#attendance-date-label").textContent = leave ? "From date" : "Date";
  $("#attendance-end").hidden = !leave;
  form.elements.end_date.disabled = !leave;
  form.elements.end_date.min = form.elements.date.value;
}
$("#attendance-form").addEventListener("change",syncAttendanceRange);
$("#attendance-form").addEventListener("submit",async event=>{
  event.preventDefault();
  const submit = event.submitter;
  const feedback = $("#attendance-feedback");
  const record = Object.fromEntries(new FormData(event.currentTarget));
  submit.disabled = true;
  feedback.textContent = "";
  try {
    const result = await api("attendance/save",record);
    if (current !== "attendance") return;
    feedback.textContent = result.days > 1 ? "Attendance saved for "+result.days+" days." : "Attendance saved.";
    $("#attendance-month").value = record.date.slice(0,7);
    $("#attendance-filter").value = record.user_id;
    await loadAttendance();
  } catch (error) {
    feedback.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});
for (const control of $$("[data-close]")) control.addEventListener("click",()=>control.closest("dialog").close());
$("#password-button").addEventListener("click",()=>$("#password-dialog").showModal());
$("#task-period").addEventListener("change",()=>{
  $("#task-date-label").hidden = $("#task-period").value !== "date";
  drawTasks();
});
$("#task-date").addEventListener("change",()=>{
  if (!$("#task-date").checkValidity()) $("#task-date").value = state.today;
  drawTasks();
});
for (const selector of ["#project-filter","#subtask-filter","#employee-filter"]) {
  $(selector).addEventListener("input",()=>{if (selector==="#project-filter") syncSubtaskFilter();drawTasks();drawReports();});
}
$("#batch-form").addEventListener("submit",async event=>{
  event.preventDefault();
  const submit = event.submitter;
  const feedback = $("#batch-feedback");
  feedback.textContent = "";
  submit.disabled = true;
  try {
    const drafts = [...selected.values()];
    const subtaskUpdates = drafts.flatMap(draft=>[...(draft.editedSteps || [])]
      .map(id=>({draft,id,data:subtaskUpdate(draft.id,id,draft.steps[id])})));
    const updates = drafts.filter(draft=>Object.keys(draft.activities).length).map(draft=>{
      const statuses = Object.keys(draft.activities);
      if (draft.projectStatusOnly) {
        const task = state.tasks.find(task=>task.id===draft.id);
        return {id:draft.id,status:statuses[0],note:task.note || ""};
      }
      const status = ["In progress","Delayed","Pending","Done"].find(value=>statuses.includes(value));
      const note = statuses.map(value=>value+(draft.activities[value].trim() ? ": "+draft.activities[value].trim() : ""));
      return {id:draft.id,status,note:note.join("\n"),pending:draft.activities.Pending ?? ""};
    });
    if (!updates.length && !subtaskUpdates.length) throw new Error("Change a subtask status or note, or select a project status before saving.");
    for (const {draft,id,data} of subtaskUpdates) {
      await api("subtask/progress",data);
      draft.editedSteps.delete(id);
    }
    if (updates.length) await api("batch",{updates});
    selected.clear();
    await refresh();
    $("#notice").textContent = "Task updates saved.";
  } catch(error) {
    feedback.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});
$("#csv").addEventListener("click",()=>{
  if (!$("#report-date").reportValidity()) return;
  const escape = value => {
    const safe = /^[\s]*[=+\-@]|^[\t\r\n]/.test(value) ? "'"+value : value;
    return '"'+safe.replaceAll('"','""')+'"';
  };
  const admin = state.user.role === "admin";
  const rows = [taskHeaders,...reportTasks().map(taskValues)].map(row=>admin ? row.slice(1) : row);
  const extras = reportExtras();
  if (extras.length) rows.push([],["Extra work"],admin ? ["Employee","Date","Work"] : ["Date","Work"],...extras.map(entry=>admin ? [personName(entry.user_id),entry.date,entry.note] : [entry.date,entry.note]));
  const csv = rows.map(row=>row.map(escape).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob(["\uFEFF",csv],{type:"text/csv;charset=utf-8"}));
  const link = element("a");
  link.href = url;
  link.download = "teamwork-"+$("#report-date").value+".csv";
  link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
});
$("#filter").addEventListener("change",drawTasks);
$("#report-employee").addEventListener("change",()=>{syncReportProjects();drawReports();});
$("#report-project").addEventListener("change",drawReports);
$("#report-date").addEventListener("change",drawReports);
$("#period").addEventListener("change",event=>{
  const input = $("#report-date");
  input.type = event.target.value;
  input.max = state.user.role === "admin" ? "" : state.today.slice(0,input.type==="month"?7:10);
  input.value = input.type === "month" ? state.today.slice(0,7) : state.today;
  drawReports();
});
$("#print").addEventListener("click",()=>{ if ($("#report-date").reportValidity()) window.print(); });
$("#new-member").addEventListener("click",()=>$("#member").showModal());
function openAssignments(user) {
  if (state.assignmentVersion !== 2) { $("#notice").textContent = "Deploy the latest Code.gs, then refresh to manage assignments."; return; }
  const dialog = $("#manage-assignments");
  $(".form-error",dialog)?.remove();
  $('input[name="user_id"]',dialog).value = user.id;
  $("#manage-assignments-title").textContent = "Assignments — "+user.name+" ("+user.id+")";
  const entries = state.assignmentTasks.filter(task=>task.user_id===user.id);
  const projects = new Set(entries.map(task=>task.project));
  const options = entries.concat(state.projects.filter(project=>!projects.has(project.name)).map(project=>({project:project.name,removed:true,subtasks:[]})));
  const container = $("#manage-assignment-options");
  container.replaceChildren();
  for (const entry of options) {
    const group = element("fieldset",undefined,"task-editor managed-assignment");
    group.dataset.id = entry.id || "";
    group.dataset.project = entry.project;
    const legend = element("legend");
    const label = element("label",undefined,"task-choice");
    const enabled = element("input");
    enabled.type = "checkbox";
    enabled.className = "project-enabled";
    enabled.checked = !entry.removed;
    label.append(enabled,element("span",entry.project+(entry.round ? " · Round "+entry.round+" · "+entry.status : " · New assignment")));
    legend.append(label); group.append(legend);
    const steps = state.subtasks.filter(step=>step.project===entry.project);
    for (const step of steps) {
      const label = element("label",undefined,"task-choice");
      const input = element("input");
      input.type = "checkbox"; input.value = String(step.id); input.className = "managed-subtask";
      input.checked = entry.subtasks.includes(String(step.id)); input.disabled = !enabled.checked;
      label.append(input,element("span",step.name)); group.append(label);
    }
    if (!steps.length) group.append(element("p","No subtasks defined for this project."));
    enabled.addEventListener("change",()=>$$('.managed-subtask',group).forEach(input=>input.disabled=!enabled.checked));
    group.dataset.original = JSON.stringify(readManagedAssignment(group));
    container.append(group);
  }
  if (!options.length) container.append(element("p","Create a project first in Projects."));
  dialog.showModal();
}
function readManagedAssignment(group) {
  const enabled = $(".project-enabled",group).checked;
  return {
    id:group.dataset.id || undefined,
    project:group.dataset.project,
    enabled,
    subtasks:enabled ? $$(".managed-subtask:checked",group).map(input=>input.value) : []
  };
}
function managedAssignmentData(fields) {
  const assignments = [];
  for (const group of $$("#manage-assignment-options fieldset")) {
    const entry = readManagedAssignment(group);
    if (JSON.stringify(entry) !== group.dataset.original) assignments.push(entry);
  }
  return {user_id:fields.get("user_id"),assignments};
}
const assignmentDrafts = new Map();
function drawAssignmentSubtasks() {
  const container = $("#assign-subtasks");
  container.replaceChildren();
  const projects = $$('#assign-projects input:checked').map(input=>input.value);
  const employees = $$('#assign-employees input:checked').map(input=>input.value);
  if (!projects.length || !employees.length) {
    container.append(element("p","Select projects and employees to choose their subtasks."));
    return;
  }
  for (const userId of employees) for (const project of projects) {
    const key = JSON.stringify([userId,project]);
    if (!assignmentDrafts.has(key)) assignmentDrafts.set(key,new Set());
    const chosen = assignmentDrafts.get(key);
    const group = element("fieldset",undefined,"task-editor assignment-subtasks");
    group.dataset.userId = userId;
    group.dataset.project = project;
    group.append(element("legend",state.users.find(user=>user.id===userId).name+" — "+project));
    const steps = state.subtasks.filter(step=>step.project===project);
    if (!steps.length) group.append(element("p","No subtasks defined. This will assign the project itself."));
    for (const step of steps) {
      const label = element("label",undefined,"task-choice");
      const input = element("input");
      input.type = "checkbox";
      input.value = String(step.id);
      input.checked = chosen.has(input.value);
      input.addEventListener("change",()=>input.checked ? chosen.add(input.value) : chosen.delete(input.value));
      label.append(input,element("span",step.name));
      group.append(label);
    }
    container.append(group);
  }
}
for (const selector of ["#assign-projects","#assign-employees"]) $(selector).addEventListener("change",drawAssignmentSubtasks);
function assignmentData(fields) {
  if (state.assignmentVersion < 1) throw new Error("Deploy the updated Code.gs as a new web app version, then refresh before assigning subtasks.");
  const projects = fields.getAll("projects"), employees = fields.getAll("employees");
  if (!projects.length || !employees.length) throw new Error("Select at least one project and one employee.");
  const assignments = $$("#assign-subtasks fieldset").map(group=>{
    const subtasks = $$("input:checked",group).map(input=>input.value);
    if ($$("input",group).length && !subtasks.length) throw new Error("Choose at least one subtask for "+$("legend",group).textContent+".");
    return {user_id:group.dataset.userId,project:group.dataset.project,subtasks};
  });
  return {projects,employees,assignments};
}
$("#new-task").addEventListener("click",()=>{
  if (!state.projects.length) return show("projects");
  const employees = state.users.filter(user=>user.active);
  if (!employees.length) return show("people");
  function choices(selector, field, entries) {
    $(selector).replaceChildren(...entries.map(([value,name])=>{
      const label = element("label",undefined,"task-choice");
      const input = element("input");
      input.type = "checkbox";
      input.name = field;
      input.value = value;
      label.append(input,element("span",name));
      return label;
    }));
  }
  choices("#assign-projects","projects",state.projects.map(project=>[project.name,project.name]));
  choices("#assign-employees","employees",employees.map(user=>[user.id,user.name+" ("+user.id+")"]));
  assignmentDrafts.clear();
  $("#assign .form-error")?.remove();
  drawAssignmentSubtasks();
  $("#assign").showModal();
});
$("#logout").addEventListener("click",async()=>{
  try { await api("logout",{}); }
  catch (error) { if (state) return $("#notice").textContent=error.message; }
  state = undefined;
  attendanceRows = [];
  for (const id of ["attendance-person","attendance-filter","attendance-counts","attendance-records","attendance-feedback"]) $("#"+id).replaceChildren();
  selected.clear();
  $("#batch-fields").replaceChildren();
  $("#suggestion-list").replaceChildren();
  $("#task-period").selectedIndex = 0;
  $("#task-date-label").hidden = true;
  $("#task-date").value = "";
  $("#project-filter").replaceChildren();
  $("#subtask-filter").replaceChildren();
  $("#employee-filter").replaceChildren();
  $("#filter").selectedIndex = 0;
  $("#period").selectedIndex = 0;
  $("#report-employee").replaceChildren();
  $("#report-project").replaceChildren();
  $("#report-date").type = "date";
  $("#report-date").value = "";
  $("#notice").textContent = "";
  for (const selector of ["#identity","#role","#stats","#task-list","#report-list","#member-list","#project-list","#assign-projects","#assign-employees","#common-subtask-options","#common-project-options","#extra-list","#report-extras"]) $(selector).replaceChildren();
  $$("form").forEach(form => form.reset());
  show("login");
});
for (const form of $$("form[data-action]")) {
  form.addEventListener("submit",async event=>{
    event.preventDefault();
    const submit = event.submitter;
    const errorBox = $(".form-error",form) ?? element("div",undefined,"form-error");
    errorBox.setAttribute("role","alert");
    errorBox.remove();
    submit.disabled = true;
    try {
      const fields = new FormData(form);
      const data = form.dataset.action === "task"
        ? assignmentData(fields)
        : form.dataset.action === "assignments/update"
          ? managedAssignmentData(fields)
        : form.dataset.action === "common-subtask/apply"
          ? {projects:fields.getAll("projects"),subtasks:fields.getAll("subtasks")}
          : Object.fromEntries(fields);
      const result = await api(form.dataset.action,data);
      if (form.dataset.action === "task") $("#notice").textContent = (result.added || result.updated) ? "New assignments: "+(result.added || 0)+". Open assignments given additional subtasks: "+(result.updated || 0)+"." : "No changes: the selected work is already assigned.";
      if (form.dataset.action === "assignments/update") $("#notice").textContent = "Assignments updated. This employee will see only their selected projects and subtasks after refreshing.";
      if (form.dataset.action === "extra/add") $("#notice").textContent = "Extra work added.";
      if (form.dataset.action === "common-subtask/apply") $("#notice").textContent = result.added ? "Subtasks added: "+result.added : "The selected projects already have these subtasks.";
      form.closest("dialog")?.close();
      form.reset();
      await refresh();
      if (form.dataset.action === "password") $("#notice").textContent = "Password changed.";
    } catch(error) {
      errorBox.textContent = error.message;
      form.append(errorBox);
    } finally { submit.disabled = false; }
  });
}
$("#reload").addEventListener("click",async()=>{
  try { await refresh(); $("#notice").textContent = "Updated."; }
  catch (error) { $("#notice").textContent = error.message; }
});
// The admin screen refreshes by itself every minute (employees use the Refresh button).
setInterval(()=>{
  if (!state || state.user.role !== "admin" || document.hidden || selected.size || $$("dialog[open]").length) return;
  if (document.activeElement && ["INPUT","TEXTAREA","SELECT"].includes(document.activeElement.tagName)) return;
  refresh().catch(()=>{});
}, 60000);
if (localStorage.getItem(TOKEN_KEY) || !window.TRACKER_CONFIG?.scriptUrl || window.TRACKER_CONFIG.scriptUrl.includes("YOUR-SCRIPT")) {
  refresh().catch(error=>{if (error.message!=="Sign in to continue.") $("#notice").textContent=error.message;});
}
