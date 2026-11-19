'use strict';
const fs=require('node:fs');
const phases=new Set(['idle','planning','running-tool','observing','complete','failed','cancelled']);
const actions=new Set(['list_apps','list_windows','open_app','move_window','read_window','click_control','type_control','press_key','scroll_window','open_url','read_page','click','type','press','scroll','back','media_play','finish','chat','clarify']);
const reasons=new Set(['none','cancelled','inactive','timeout','invalid_plan','invalid_target','planner_unavailable','planner_failed','partial','unverified','unsupported','context_limit','step_limit','unverified_step']);
function createTaskDiagnostics({file,version,write=(target,data)=>fs.writeFileSync(target,data,'utf8'),now=()=>new Date().toISOString()}){
  let state={phase:'idle',step:0,action:null,reasonCode:'none'};
  function record(event){
    if(!event||!phases.has(event.phase))return;
    if(event.phase==='planning'&&event.step===1)state={phase:'idle',step:0,action:null,reasonCode:'none'};
    state={phase:event.phase,step:Number.isInteger(event.step)&&event.step>0&&event.step<=20?event.step:state.step,
      action:actions.has(event.action)?event.action:state.action,reasonCode:reasons.has(event.reasonCode)?event.reasonCode:event.phase==='complete'?'none':state.reasonCode};
    try{write(file,JSON.stringify({version,time:now(),...state},null,2)+'\n');}catch{}
  }
  return {record};
}
module.exports={createTaskDiagnostics};
