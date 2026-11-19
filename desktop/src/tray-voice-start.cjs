'use strict';
function showDialogPreservingWindowState(dialog,win,options) {
  return win.isVisible()&&!win.isMinimized()?dialog.showMessageBox(win,options):dialog.showMessageBox(options);
}
function createTrayVoiceStarter({beginIntent,ready,startClient,requestReload,failed,finishAttempt}) {
  let running=null;
  function start(){
    if(running)return running;
    beginIntent();
    running=(async()=>{
      if(!await ready()){await requestReload();return false;}
      const started=await startClient();
      if(!started)failed();
      return started===true;
    })().catch(()=>{failed();return false;}).finally(()=>{finishAttempt();running=null;});
    return running;
  }
  return {start};
}
module.exports={createTrayVoiceStarter,showDialogPreservingWindowState};
