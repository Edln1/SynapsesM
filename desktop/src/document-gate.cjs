'use strict';
function createDocumentGate({showSurface,hideSurface,onOptionalError=()=>{}}) {
  let generation=0,requiredReady=Promise.resolve(false);
  function reset(){generation++;requiredReady=Promise.resolve(false);hideSurface();}
  function prepare(required,optional){
    const ticket=generation;
    requiredReady=Promise.resolve(required).then(()=>true,()=>false);
    requiredReady.then(ready=>{if(ready&&ticket===generation&&optional)Promise.resolve().then(optional).catch(onOptionalError);});
  }
  async function finish(){
    const ticket=generation,required=requiredReady;
    if(await required&&ticket===generation){showSurface();return true;}
    return false;
  }
  return {reset,prepare,finish};
}
module.exports={createDocumentGate};
