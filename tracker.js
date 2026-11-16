const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
let state;
let current = "login";
const selected = new Map();


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
  current = view;
  for (const pane of ["login","tasks","projects","people","reports"]) $("#" + pane).hidden = view !== pane;
  $("#nav").hidden = $("#profile").hidden = $("#reload").hidden = view === "login";
  $("#today").textContent = state?.today ?? "";
  $("#location").textContent = {login:"Sign in",tasks:"Tasks",projects:"Projects",people:"Team access",reports:"Reports"}[view];
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
  return task.status !== "Done" && task.due && task.due < state.today ? "Delayed" : task.status;
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
  return [task.name,task.project || "No project",task.employee+" ("+task.user_id.split("~")[0]+(task.user_id.includes("~")?", archived":"")+")",task.assigned || "—",task.due || "—",status(task),
    task.started || "—",task.completed || "—",task.updated || "—",task.note || "—"];
}
function taskRows(tasks, hideName = false, editable = false, report = false) {
  return tasks.map(task => {
    const row = taskValues(task);
    row[1] = task.project || task.name;
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
  table($("#task-list"),headers,taskRows(displayed,true,!admin),"No tasks match this view.");
  const backlog = visible.filter(task => task.status !== "Done" && workDate(task) && workDate(task) < state.today);
  table($("#suggestion-list"),headers,taskRows(backlog,true,!admin),"No unfinished work from earlier dates.");
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
    const card = element("fieldset",undefined,"task-editor stack");
    card.append(element("legend",step.name));
    const choices = element("div",undefined,"work-status-options");
    const inputs = element("div",undefined,"work-note-grid");
    const labels = {Pending:"Pending work","In progress":"Current work",Delayed:"Delayed work",Done:null};
    for (const [status,noteLabel] of Object.entries(labels)) {
      const label = element("label",undefined,"task-choice");
      const checkbox = element("input");
      checkbox.type = "checkbox";
      checkbox.checked = Object.hasOwn(change,status);
      checkbox.id = control.id+"-"+status.replaceAll(" ","-");
      checkbox.addEventListener("change",()=>{
        if (!checkbox.checked) delete change[status];
        else {
          if (status === "Done") Object.keys(change).forEach(key=>delete change[key]);
          else delete change.Done;
          change[status] = "";
        }
        drawBatch();
        document.getElementById(checkbox.id)?.focus();
      });
      label.append(checkbox,element("span",status));
      choices.append(label);
      if (!checkbox.checked || !noteLabel) continue;
      const notes = element("textarea");
      notes.rows = 2;
      notes.maxLength = 900;
      notes.value = change[status];
      notes.addEventListener("input",()=>{change[status]=notes.value;});
      const field = element("label",noteLabel);
      field.append(notes);
      inputs.append(field);
    }
    card.append(choices,inputs);
    const save = button("Save subtask progress",async()=>{
      save.disabled = true;
      try {
        const status = ["Done","In progress","Delayed","Pending"].find(value=>Object.hasOwn(change,value));
        if (!status) throw new Error("Select at least one work status.");
        const note = status === "Done" ? "" : Object.entries(change).map(([key,value])=>key+": "+value.trim()).join("\n");
        await api("subtask/progress",{id:step.id,task_id:task.id,status,note});
        draft.openSteps.delete(step.id);
        delete draft.steps[step.id];
        await refresh();
        $("#notice").textContent = "Subtask progress saved.";
      } catch (error) {
        $("#notice").textContent = error.message;
      } finally {
        save.disabled = false;
      }
    });
    card.append(save);
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
      panel.append(subtaskEditor(task,draft,steps));
      const label = element("label",undefined,"task-choice");
      const done = element("input");
      done.type = "checkbox";
      done.checked = draft.activities.Done !== undefined;
      done.addEventListener("change",()=>{draft.activities = done.checked ? {Done:""} : {};});
      label.append(done,element("span","Mark project Done"));
      panel.append(label,button("Remove selection",()=>{
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
  table($("#report-list"),admin ? taskHeaders.slice(1) : taskHeaders,taskRows(reportTasks(),admin,false,true),"No tasks match these report filters.");
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
  state = await api("state");
  const admin = state.user.role === "admin";
  $$("[data-admin]").forEach(node => { node.hidden = !admin; });
  $("#identity").textContent = state.user.name;
  $("#password-button").hidden = !admin;
  $("#role").textContent = (admin?"Admin":"Employee") + " · " + state.user.id;
  $("#tasks-title").textContent = admin?"Team tasks":"My tasks";
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
  show(current === "login" || (!admin && ["people","projects"].includes(current)) ? "tasks" : current);
  drawTasks();
  drawReports();
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
    actions.append(button(user.active?"Disable":"Enable",async()=>{
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
for (const control of $$("[data-view]")) control.addEventListener("click",()=>show(control.dataset.view));
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
  submit.disabled = true;
  try {
    const updates = [...selected.values()].filter(draft=>!state.progress.some(step=>step.task_id===draft.id) || Object.hasOwn(draft.activities,"Done")).map(draft=>{
      const statuses = Object.keys(draft.activities);
      if (!statuses.length) throw new Error("Select at least one work status for each project.");
      const status = ["In progress","Delayed","Pending","Done"].find(value=>statuses.includes(value));
      const note = statuses.map(value=>value+(draft.activities[value].trim() ? ": "+draft.activities[value].trim() : ""));
      return {id:draft.id,status,note:note.join("\n"),pending:draft.activities.Pending ?? ""};
    });
    if (!updates.length) throw new Error("Mark a project Done or use Save subtask progress.");
    await api("batch",{updates});
    selected.clear();
    await refresh();
    $("#notice").textContent = "Task updates saved.";
  } catch(error) {
    $("#notice").textContent = error.message;
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
  const rows = [taskHeaders,...reportTasks().map(taskValues)];
  const csv = rows.map(row=>state.user.role === "admin" ? row.slice(1) : row).map(row=>row.map(escape).join(",")).join("\r\n");
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
  $("#assign").showModal();
});
$("#logout").addEventListener("click",async()=>{
  try { await api("logout",{}); }
  catch (error) { if (state) return $("#notice").textContent=error.message; }
  state = undefined;
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
  for (const selector of ["#identity","#role","#stats","#task-list","#report-list","#member-list","#project-list","#assign-projects","#assign-employees","#common-subtask-options","#common-project-options"]) $(selector).replaceChildren();
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
        ? {projects:fields.getAll("projects"),employees:fields.getAll("employees")}
        : form.dataset.action === "common-subtask/apply"
          ? {projects:fields.getAll("projects"),subtasks:fields.getAll("subtasks")}
          : Object.fromEntries(fields);
      const result = await api(form.dataset.action,data);
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
