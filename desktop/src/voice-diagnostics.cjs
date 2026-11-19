'use strict';
const fs=require('node:fs');
const PHASES=new Set(['idle','tray_start','starting','capture_requested','capture_approved','capture_denied','listening','stopped','command-received','command-complete','command-failed','command-unrecognized']);
const REASONS=new Set(['none','user_stop','setup_timeout','tray_start_failed','hook_missing','native_start_denied','native_start_canceled','permission_wrong_request','permission_window_not_allowed','permission_pending','permission_declined','permission_expired','permission_error','capture_not_approved','page_changed','renderer_gone','window_closed','account_missing','account_unverified','account_changed','hook_unavailable','voice_unavailable','start_error','capture_timeout','capture_lost','capture_confirmation_failed','connection_lost','pagehide','destroyed','asr_error','asr_closed','asr_timeout','capture_denied','capture_missing','capture_unreadable','capture_security','capture_error','capture_unsupported','voice_init_error']);
const COMMAND_REASONS=new Set(['command_missing_target','command_target_invalid','command_parse_invalid','command_dns_empty','command_dns_nonpublic','command_dns_failed','command_dns_timeout','command_open_rejected','command_lease_revoked']);
for(const reason of COMMAND_REASONS)REASONS.add(reason);
function safeReason(value,fallback='user_stop'){return REASONS.has(value)?value:fallback;}
function createVoiceDiagnostics({file,version,readState,writeFile=(target,data)=>fs.writeFileSync(target,data,'utf8'),now=()=>new Date().toISOString()}){
  let phase='idle',stopReasonCode='none';
  function record(nextPhase,reason='none'){
    if(!PHASES.has(nextPhase))return snapshot();
    if(nextPhase==='tray_start'||nextPhase==='starting'||nextPhase==='listening')stopReasonCode='none';
    if(COMMAND_REASONS.has(stopReasonCode)&&['command-received','command-complete','stopped'].includes(nextPhase))stopReasonCode='none';
    phase=nextPhase;
    if(stopReasonCode==='none'&&REASONS.has(reason)&&reason!=='none')stopReasonCode=reason;
    const data=snapshot();
    try{writeFile(file,JSON.stringify(data,null,2)+'\n');}catch{}
    return data;
  }
  function snapshot(){const state=readState()||{};return {version,time:now(),enabled:state.enabled===true,listening:state.listening===true,phase,stopReasonCode};}
  return {record,snapshot};
}
module.exports={createVoiceDiagnostics,safeReason};
