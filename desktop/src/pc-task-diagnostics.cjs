'use strict';
const fs=require('node:fs');
const phases=new Set(['idle','planning','transport','running-tool','observing','complete','failed','cancelled']);
const actions=new Set(['list_apps','list_windows','open_app','move_window','read_window','click_control','type_control','press_key','scroll_window','open_url','read_page','click','type','press','scroll','back','media_play','finish','chat','clarify']);
const reasons=new Set(['none','cancelled','inactive','timeout','invalid_plan','invalid_target','planner_unavailable','planner_failed','planner_format','planner_rate_limited','planner_guest_limit','planner_auth','planner_network','planner_server','planner_model_unavailable','partial','unverified','unsupported','context_limit','step_limit','unverified_step']);
const providerCodes=new Set(['none','unknown','output_parse_failed','tool_use_failed','json_validate_failed','invalid_action_arguments','limit_reached','rate_limit_exceeded','model_not_found','model_decommissioned','invalid_api_key','authentication_error','server_error','internal_server_error','network_error']);
const models=new Set(['openai/gpt-oss-20b','openai/gpt-oss-120b']);
function createTaskDiagnostics({file,version,write=(target,data)=>fs.writeFileSync(target,data,'utf8'),now=()=>new Date().toISOString()}){
  let state={phase:'idle',step:0,action:null,reasonCode:'none'},transport=null;
  function record(event){
    if(!event||!phases.has(event.phase))return;
    if(event.phase==='planning'&&event.step===1){state={phase:'idle',step:0,action:null,reasonCode:'none'};transport=null;}
    if(event.phase==='transport')transport={httpStatus:Number.isInteger(event.httpStatus)&&event.httpStatus>=100&&event.httpStatus<=599?event.httpStatus:null,
      providerCode:providerCodes.has(event.providerCode)?event.providerCode:'unknown',model:models.has(event.model)?event.model:'unknown',
      attempt:Number.isInteger(event.attempt)&&event.attempt>=1&&event.attempt<=3?event.attempt:null,accountReferencePresent:event.accountReferencePresent===true};
    state={phase:event.phase,step:Number.isInteger(event.step)&&event.step>0&&event.step<=20?event.step:state.step,
      action:actions.has(event.action)?event.action:state.action,reasonCode:reasons.has(event.reasonCode)?event.reasonCode:event.phase==='complete'?'none':state.reasonCode};
    try{write(file,JSON.stringify({version,time:now(),...state,...(transport?{transport}:{})},null,2)+'\n');}catch{}
  }
  return {record};
}
module.exports={createTaskDiagnostics};
