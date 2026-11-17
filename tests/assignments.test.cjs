const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ctx = vm.createContext({console, CacheService:{getScriptCache:()=>({get:()=> 'admin'})}});
vm.runInContext(fs.readFileSync('apps-script/Code.gs','utf8'),ctx);
vm.runInContext(`
let testUser = {id:'admin',role:'admin',name:'Admin'};
let serial = 100;
const db = {
 Users:[{UserID:'a',Name:'Alice',Role:'employee',Active:'1',SheetName:'Alice'},{UserID:'b',Name:'Bob',Role:'employee',Active:'1',SheetName:'Bob'}],
 'Project List':[{Type:'Project',Project:'LATHE'},{Type:'Subtask',ID:'1',Project:'LATHE',Subtask:'Cut'},{Type:'Subtask',ID:'2',Project:'LATHE',Subtask:'Polish'},{Type:'Project',Project:'Other project'},{Type:'Subtask',ID:'3',Project:'Other project',Subtask:'Inspect'}],
 Alice:[], Bob:[], UpdateLog:[]
};
me_ = ()=>testUser;
today_ = ()=>'2026-11-17';
sheet_ = name=>name;
read_ = name=>db[name].map((r,i)=>({...r,_row:i+2}));
userSheet_ = u=>u.SheetName || (u.id==='a'?'Alice':'Bob');
append_ = (sh,h,r)=>db[sh].push({...r});
put_ = (sh,h,r)=>db[sh][r._row-2]={...r};
nextId_ = ()=>++serial;
ss_ = ()=>({getSheetByName:name=>db[name]?name:null});
`,ctx);
const run = code=>vm.runInContext(code,ctx);
const assign = (a,b)=>run(`handle_('task',{projects:['LATHE'],employees:['a','b'],assignments:[{user_id:'a',project:'LATHE',subtasks:${JSON.stringify(a)}},{user_id:'b',project:'LATHE',subtasks:${JSON.stringify(b)}}]},'token')`);
assert.equal(assign(['1'],['2']).data.added,2);
assert.equal(run("state_(testUser,today_()).progress.filter(s=>s.task_id===101).map(s=>s.id).join(',')"),'1');
assert.equal(run("state_(testUser,today_()).progress.filter(s=>s.task_id===102).map(s=>s.id).join(',')"),'2');
run("testUser={id:'a',role:'employee',name:'Alice'}");
assert.equal(run("handle_('subtask/progress',{id:2,task_id:101,status:'Done',note:''},'token')").status,404);
assert.ok(run("handle_('subtask/progress',{id:1,task_id:101,status:'Done',note:'saved'},'token')").data);
assert.equal(run("db.Alice[0].Status"),"In progress");
assert.equal(run("db.Alice[0].Started"),"2026-11-17");
assert.equal(run("db.Alice[0].Updated"),"2026-11-17");
run("testUser={id:'admin',role:'admin',name:'Admin'}");
assert.equal(assign(['1','2'],['2']).data.updated,1);
assert.equal(run("state_(testUser,today_()).progress.find(s=>s.task_id===101 && s.id===1).note"),'saved');
assert.equal(assign(['1','2'],['2']).data.added,0);
assert.equal(assign(['3'],['2']).status,400);
assert.equal(assign([],['2']).status,400);
assert.equal(run('db.Alice.length'),2);
run("db.Alice[0].Status='Done'");
assert.ok(run("handle_('task/rework',{id:101,user_id:'a'},'token')").data);
assert.equal(run("db.Alice[2].AssignedSubtasks"),'["1","2"]');
run("db.Bob[0].AssignedSubtasks=''");
assert.equal(run("state_(testUser,today_()).progress.filter(s=>s.task_id===102).length"),2);
assert.equal(assign(['1'],['1']).data.updated,0);
assert.equal(run("db.Bob[0].AssignedSubtasks"),'');
run("testUser={id:'a',role:'employee',name:'Alice'}");
assert.equal(assign(['1'],['2']).status,403);
assert.equal(run("state_(testUser,today_()).tasks.some(t=>t.user_id==='b')"),false);
assert.equal(fs.readFileSync('Code.gs','utf8'),fs.readFileSync('apps-script/Code.gs','utf8'));
console.log('Passed: per-person assignment, authorization, additive updates, progress preservation, validation, rework, legacy compatibility, employee isolation, synchronized backend copies.');
// Exact editing, removals/restoration, and cross-user protection.
const manage = (user,assignments)=>run(`handle_('assignments/update',${JSON.stringify({user_id:user,assignments})},'token')`);
assert.equal(manage('b',[]).status,403);
run("testUser={id:'admin',role:'admin',name:'Admin'}");
assert.ok(manage('a',[{id:101,enabled:true,subtasks:['2']}]).data);
assert.equal(run("state_(testUser,today_()).progress.filter(s=>s.task_id===101).map(s=>s.id).join(',')"),'2');
assert.equal(run("state_(testUser,today_()).progress.filter(s=>s.task_id===102).length"),2);
assert.ok(manage('a',[{id:101,enabled:true,subtasks:['1','2']}]).data);
assert.equal(run("state_(testUser,today_()).progress.find(s=>s.task_id===101 && s.id===1).note"),'saved');
assert.equal(run("db.Alice[0].Status"),'In progress');
assert.ok(manage('a',[{id:101,enabled:false,subtasks:[]},{id:103,enabled:false,subtasks:[]}]).data);
run("testUser={id:'a',role:'employee',name:'Alice'}");
assert.equal(run("state_(testUser,today_()).tasks.length"),0);
assert.equal(run("state_(testUser,today_()).progress.length"),0);
assert.equal(run("state_(testUser,today_()).assignmentTasks.length"),0);
assert.equal(run("handle_('subtask/progress',{id:1,task_id:101,status:'Done',note:''},'token')").status,404);
run("testUser={id:'admin',role:'admin',name:'Admin'}");
assert.equal(manage('b',[{id:101,enabled:true,subtasks:['1']}]).status,400);
assert.ok(manage('a',[{id:101,enabled:true,subtasks:['1']}]).data);
assert.equal(run("state_(testUser,today_()).progress.find(s=>s.task_id===101 && s.id===1).note"),'saved');
assert.ok(manage('a',[{project:'Other project',enabled:true,subtasks:['3']}]).data);
assert.equal(run("db.Alice.filter(t=>t.Type==='Task' && t.Project==='Other project').length"),1);
assert.equal(manage('a',[{project:'Other project',enabled:true,subtasks:['3']}]).status,409);
assert.equal(manage('a',[{id:101,enabled:false,subtasks:[]},{id:104,enabled:true,subtasks:['999']}]).status,400);
assert.equal(run("db.Alice[0].Removed"),'');
assert.ok(manage('a',[{id:101,enabled:true,subtasks:[]}]).data);
assert.equal(run("state_(testUser,today_()).progress.filter(s=>s.task_id===101).length"),0);
assert.ok(manage('b',[{id:102,enabled:true,subtasks:['2']}]).data);
assert.equal(run("state_(testUser,today_()).progress.filter(s=>s.task_id===102).map(s=>s.id).join(',')"),'2');
console.log('Passed: exact subtask edits, project removal/restoration, retained notes, reopening completed work, user isolation, authorization, new projects, duplicate protection, validation before writes, empty subtask selections, legacy narrowing.');

const attendance = (action,data)=>run(`handle_('attendance/${action}',${JSON.stringify(data)},'token')`);
const record = {user_id:'a',date:'2026-11-17',status:'First half'};
run("testUser={id:'a',role:'employee',name:'Alice'}");
assert.equal(attendance('save',record).status,403);
assert.equal(attendance('list',{month:'2026-11'}).status,403);
run(`
testUser={id:'admin',role:'admin',name:'Admin'};
db.Attendance=[];
const attendanceSheet = {
  getLastRow:()=>db.Attendance.length+1,
  getMaxRows:()=>1000,
  deleteRow:index=>db.Attendance.splice(index-2,1),
  getRange:first=>({setValues:values=>first>1 && values.forEach(row=>{
    db.Attendance.push(Object.fromEntries(H.Attendance.map((column,index)=>[column,row[index]])));
  })})
};
sheet_ = name=>name==='Attendance'?attendanceSheet:name;
read_ = sheet=>db[sheet===attendanceSheet?'Attendance':sheet].map((r,i)=>({...r,_row:i+2}));
put_ = (sheet,headers,row)=>db[sheet===attendanceSheet?'Attendance':sheet][row._row-2]={...row};
`);
assert.equal(attendance('save',{...record,date:'2026-02-30'}).status,400);
assert.ok(attendance('save',record).data);
assert.equal(attendance('list',{month:'2026-11'}).data.records[0].day,'Tuesday');
assert.ok(attendance('save',{...record,status:'Permission'}).data);
const records = attendance('list',{month:'2026-11'}).data.records;
assert.equal(records.length,1);
assert.equal(records[0].status,'Permission');
assert.equal(attendance('list',{month:'2026-10'}).data.records.length,0);
run("db.Users[0].Active='0'");
assert.equal(attendance('save',record).status,404);
assert.equal(attendance('list',{month:'2026-11'}).data.records.length,0);
console.log('Passed: attendance permissions, date validation, monthly filtering and updates.');

run("db.Users[0].Active='1'");
assert.equal(attendance('save',{...record,status:'Off',date:'2026-11-30',end_date:'2026-12-02'}).data.days,3);
const december = attendance('list',{month:'2026-12'}).data.records;
assert.equal(december.length,1);
assert.equal(december[0].count,2);
assert.equal(december[0].date,'2026-11-30');
assert.equal(december[0].end_date,'2026-12-02');
assert.equal(attendance('list',{month:'2026-11',end_month:'2026-12'}).data.records.find(row=>row.id===december[0].id).count,3);
assert.equal(attendance('save',{...record,status:'Off',end_date:'2026-11-16'}).status,400);
assert.equal(attendance('save',{...record,status:'Work from home',date:'2026-12-01'}).status,409);
assert.equal(attendance('save',{...record,id:december[0].id,status:'Work from home',date:'2026-12-04',end_date:'2026-12-05',notes:'Remote setup'}).data.days,2);
const edited = attendance('list',{month:'2026-12'}).data.records;
assert.equal(edited.length,1);
assert.equal(edited[0].notes,'Remote setup');
assert.equal(edited[0].date,'2026-12-04');
assert.equal(edited[0].status,'Work from home');
assert.ok(attendance('delete',{id:edited[0].id}).data);
assert.equal(attendance('list',{month:'2026-12'}).data.records.length,0);
run("db.Attendance.push({UserID:'a',Date:'2026-12-10',Day:'Thursday',Status:'Second half'})");
assert.equal(attendance('list',{month:'2026-12'}).data.records[0].status,'Half day');
run("testUser={id:'a',role:'employee',name:'Alice'}");
assert.equal(attendance('delete',{id:edited[0].id}).status,403);
console.log('Passed: ranges and period counts, edits, notes, deletion, overlap checks, and legacy half days.');

run("testUser={id:'admin',role:'admin',name:'Admin'}");
assert.equal(attendance('save',{...record,status:'Off',date:'2026-11-14',end_date:'2026-11-16'}).data.days,2);
const weekendLeave = attendance('list',{month:'2026-11'}).data.records.find(row=>row.date==='2026-11-14');
assert.equal(weekendLeave.count,2);
assert.equal(weekendLeave.end_date,'2026-11-16');
assert.equal(weekendLeave.weekdays.join(','),'Saturday,Monday');
assert.equal(attendance('save',{...record,status:'Work from home',date:'2026-11-22'}).data.days,1);
console.log('Passed: leave excludes Sunday while other attendance statuses still count it.');
