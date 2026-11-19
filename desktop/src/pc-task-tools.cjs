'use strict';

function createPcTaskTools({windows,browser,assertActive,authorizeAction=async()=>false}) {
  async function current() { if (await assertActive() === false) throw Error('PC task is stopped.'); }
  async function invoke(action,operation,context) {
    await current();
    if(context?.signal?.aborted)throw Error('PC task is stopped.');
    const nativeAction=['list_apps','list_windows','open_app','move_window','read_window','click_control','type_control','press_key','scroll_window'].includes(action);
    const abort=()=>{if(nativeAction)windows.cancel?.();else browser.cancel({keepIdleWindow:true});};
    context?.signal?.addEventListener('abort',abort,{once:true});
    try{
    let result=await operation(false);
    await current();
    if(context?.signal?.aborted)throw Error('PC task is stopped.');
    if(result?.confirmationRequired===true||result?.needsConfirmation===true){
      // Approval is obtained by native code; it is never an argument from a model.
      const approved=await authorizeAction({action,description:String(result.message||'Confirm this action on your PC.').slice(0,500)});
      await current();
      if(context?.signal?.aborted)throw Error('PC task is stopped.');
      if(approved!==true)return {ok:false,confirmationRequired:true,message:'That action was not approved. I have not performed it.'};
      result=await operation(true);
      await current();
      if(context?.signal?.aborted)throw Error('PC task is stopped.');
    }
    return result;
    }finally{context?.signal?.removeEventListener('abort',abort);}
  }
  const simple=(name,operation)=>(args,context)=>invoke(name,()=>operation(args),context);
  const native=(name,operation)=>(args,context)=>invoke(name,confirmed=>operation(args,{confirmed}),context);
  const web=(name,tool,convert)=>(args,context)=>invoke(name,confirmed=>browser.perform(tool,convert(args),{confirmed}),context);
  return {
    list_apps:simple('list_apps',args=>windows.catalog({query:args.value||''})),
    list_windows:simple('list_windows',()=>windows.windows()),
    open_app:simple('open_app',args=>windows.launch({appId:args.target})),
    move_window:simple('move_window',args=>windows.moveWindow({windowId:args.target,displayId:args.secondary})),
    read_window:simple('read_window',args=>windows.readWindow({windowId:args.target})),
    click_control:native('click_control',(args,approval)=>windows.clickControl({windowId:args.target,ref:args.secondary},approval)),
    type_control:native('type_control',(args,approval)=>windows.typeControl({windowId:args.target,ref:args.secondary,text:args.value},approval)),
    press_key:native('press_key',(args,approval)=>windows.pressKey({windowId:args.target,key:args.value},approval)),
    scroll_window:native('scroll_window',(args,approval)=>windows.scrollWindow({windowId:args.target,direction:args.direction,amount:args.amount},approval)),
    open_url:web('open_url','open_url',args=>({url:args.target})),
    read_page:web('read_page','read_page',()=>({})),
    click:web('click','click',args=>({ref:args.target})),
    type:web('type','type',args=>({ref:args.target,text:args.value})),
    press:web('press','press',args=>({key:args.value,...(args.target?{ref:args.target}:{})})),
    scroll:web('scroll','scroll',args=>({direction:args.direction,amount:args.amount})),
    back:web('back','back',()=>({})),
    media_play:web('media_play','media_play',args=>args.target?{ref:args.target}:{})
  };
}
module.exports={createPcTaskTools};
