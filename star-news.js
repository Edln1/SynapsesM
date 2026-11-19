(function(root,factory){'use strict';var api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.SynapsesStarNews=api;})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';
  var HOSTS={nvidia:['blogs.nvidia.com'],meta:['about.fb.com'],youtube:['blog.youtube']};
  function desktopDeviceAllowed(win){
    if(!win||!win.document||typeof win.matchMedia!=='function')return false;
    var html=win.document.documentElement;
    if(html&&html.classList&&html.classList.contains('ava-app-mode'))return false;
    try{
      if(new URLSearchParams(win.location&&win.location.search||'').get('ava-app')==='1')return false;
      var nav=win.navigator||{},ua=String(nav.userAgent||'');
      if(nav.userAgentData&&nav.userAgentData.mobile===true||/Android|iPhone|iPad|iPod|IEMobile|Opera Mini|Mobile/i.test(ua)||/Macintosh/i.test(ua)&&Number(nav.maxTouchPoints)>1)return false;
      return win.matchMedia('(hover: hover) and (pointer: fine)').matches===true;
    }catch(_){return false;}
  }
  function desktopAllowed(win){return !!(win&&win.innerWidth>=700&&desktopDeviceAllowed(win));}
  function clearWake(win){var cleanup=win.__synapsesStarNewsWake;if(cleanup){delete win.__synapsesStarNewsWake;cleanup();}}
  function waitForDesktop(options,win){
    clearWake(win);if(!desktopDeviceAllowed(win))return;
    var media=win.matchMedia('(hover: hover) and (pointer: fine)'),observer=null;
    function resume(){if(!desktopDeviceAllowed(win)){clearWake(win);return;}if(desktopAllowed(win)){clearWake(win);init(options);}}
    function cleanup(){win.removeEventListener('resize',resume);win.removeEventListener('popstate',resume);if(media.removeEventListener)media.removeEventListener('change',resume);else if(media.removeListener)media.removeListener(resume);if(observer)observer.disconnect();}
    win.__synapsesStarNewsWake=cleanup;win.addEventListener('resize',resume,{passive:true});win.addEventListener('popstate',resume);
    if(media.addEventListener)media.addEventListener('change',resume);else if(media.addListener)media.addListener(resume);
    if(win.MutationObserver){observer=new win.MutationObserver(resume);observer.observe(win.document.documentElement,{attributes:true,attributeFilter:['class']});}
  }
  function safeItem(item){try{var u=new URL(item.url);return item&&HOSTS[item.topic]&&HOSTS[item.topic].indexOf(u.hostname)>=0&&u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&typeof item.title==='string'&&item.title.trim().length>0&&item.title.length<=240&&typeof item.source==='string'&&item.source.length<=40&&Number.isFinite(Date.parse(item.publishedAt));}catch(_){return false;}}
  function validSnapshot(value){if(!value||value.version!==1||!Number.isFinite(Date.parse(value.generatedAt))||!Array.isArray(value.items)||value.items.length>60)return null;return{version:1,generatedAt:value.generatedAt,sources:Array.isArray(value.sources)?value.sources.slice(0,6):[],items:value.items.filter(safeItem)};}
  function nearestPoint(points,x,y,radius,width,height){var found=null,best=radius*radius;(Array.isArray(points)?points:[]).slice(0,1200).forEach(function(p){if(!p||!Number.isFinite(p.x)||!Number.isFinite(p.y)||p.x<8||p.y<8||p.x>width-8||p.y>height-8)return;var d=(p.x-x)*(p.x-x)+(p.y-y)*(p.y-y);if(d<=best){best=d;found=p;}});return found;}
  function cardPosition(point,width,height,cardWidth,cardHeight){var left=point.x+17,top=point.y+15;if(left+cardWidth>width-12)left=point.x-cardWidth-17;if(top+cardHeight>height-12)top=point.y-cardHeight-15;return{left:Math.max(12,Math.min(left,width-cardWidth-12)),top:Math.max(12,Math.min(top,height-cardHeight-12))};}
  function particlePoints(canvas,container,particles,w,h){
    if(!canvas||!container||!Array.isArray(particles)||!(w>0)||!(h>0)||!container.classList.contains('active'))return[];
    var doc=canvas.ownerDocument,win=doc&&doc.defaultView;if(!win||doc.hidden||doc.body.classList.contains('cs-blur-open'))return[];
    var rect=canvas.getBoundingClientRect();if(!(rect.width>0)||!(rect.height>0))return[];
    for(var current=canvas;current;current=current.parentElement){var style=win.getComputedStyle(current);if(style.display==='none'||style.visibility==='hidden'||Number(style.opacity||1)<.06)return[];}
    return particles.map(function(p,i){var brightness=Number(p.alpha)*(p.fadeA==null?1:Number(p.fadeA));if(!Number.isFinite(p.x)||!Number.isFinite(p.y)||!Number.isFinite(brightness)||brightness<.12)return null;return{id:canvas.id+'-'+i,x:rect.left+p.x*rect.width/w,y:rect.top+p.y*rect.height/h,brightness:brightness};}).filter(function(p){return p&&p.x>=0&&p.y>=0&&p.x<=win.innerWidth&&p.y<=win.innerHeight;});
  }
  function hash(text){var h=2166136261;for(var i=0;i<text.length;i++){h^=text.charCodeAt(i);h=Math.imul(h,16777619);}return h>>>0;}
  function markedPoints(values,previous,width,height,limit,accept){
    var prior=new Set(previous||[]),seen=new Set(),selected=[];
    var candidates=(Array.isArray(values)?values:[]).slice(0,1200).filter(function(p){if(!p||p.id==null||!Number.isFinite(p.x)||!Number.isFinite(p.y)||p.x<32||p.y<48||p.x>width-32||p.y>height-48||seen.has(String(p.id)))return false;seen.add(String(p.id));return true;});
    candidates.sort(function(a,b){return Number(prior.has(String(b.id)))-Number(prior.has(String(a.id)))||hash(String(a.id))-hash(String(b.id));});
    var count=limit==null?Math.max(3,Math.min(7,Math.floor(width*height/220000))):Math.max(1,Math.min(7,limit));
    for(var i=0;i<Math.min(candidates.length,80)&&selected.length<count;i++){var p=candidates[i];if(selected.every(function(s){return Math.hypot(p.x-s.x,p.y-s.y)>=120;})&&(!accept||accept(p)))selected.push(p);}
    return selected;
  }
  function init(options){
    options=options||{};var win=options.window||window,doc=win.document;
    if(!desktopAllowed(win)){if(win.__synapsesStarNews&&typeof win.__synapsesStarNews.destroy==='function')win.__synapsesStarNews.destroy();if(desktopDeviceAllowed(win))waitForDesktop(options,win);else clearWake(win);return null;}
    clearWake(win);
    if(win.__synapsesStarNews)return win.__synapsesStarNews;
    var getPoints=options.getPoints||function(){return typeof win.synapsesStarNewsPoints==='function'?win.synapsesStarNewsPoints():[];};
    var snapshot=null,activePoint=null,activeIndex=0,keyboard=false,closed=false,hoverTimer=0,closeTimer=0,loadPromise=null,lastMove=-Infinity,focusedBefore=null,modeObserver=null,desktopMedia=win.matchMedia('(hover: hover) and (pointer: fine)'),marked=[],markers=new Map(),hoveredId='',frameId=0,lastFrame=-Infinity;
    var card=doc.createElement('section');card.className='syn-star-news-card';card.id='synStarNewsCard';card.hidden=true;card.setAttribute('aria-label','Company update');card.setAttribute('role','region');
    var access=doc.createElement('button');access.type='button';access.className='syn-star-news-access';access.textContent='Explore company updates from the stars';access.setAttribute('aria-controls',card.id);access.setAttribute('aria-expanded','false');
    var marks=doc.createElement('div');marks.className='syn-star-news-marks';marks.setAttribute('aria-hidden','true');doc.body.append(access,card,marks);
    function node(tag,className,text){var n=doc.createElement(tag);if(className)n.className=className;if(text!=null)n.textContent=text;return n;}
    function ensureDesktop(){if(closed)return false;if(desktopAllowed(win))return true;var recover=desktopDeviceAllowed(win),resumeOptions=snapshot?Object.assign({},options,{snapshot:snapshot}):options;if(api)api.destroy();if(recover)waitForDesktop(resumeOptions,win);return false;}
    function blocked(target){if(!target||target===doc.body||target===doc.documentElement)return false;if(card.contains(target)||target===access)return false;return !!(target.closest&&target.closest('button,a,input,textarea,select,form,label,header,nav,aside,table,dialog,[role="dialog"],[role="button"],[contenteditable="true"],[aria-modal="true"],#avaCompanionChat,.ac-shell,.widget,.panel,.modal,[data-no-star-news]'));}
    function points(){try{var value=getPoints();return Array.isArray(value)?value:[];}catch(_){return[];}}
    function updateMarks(){
      if(!ensureDesktop()||doc.hidden){marks.hidden=true;return;}
      marked=markedPoints(points(),marked.map(function(p){return String(p.id);}),win.innerWidth,win.innerHeight,null,function(p){return !doc.elementFromPoint||!blocked(doc.elementFromPoint(p.x,p.y));});
      var ids=new Set(marked.map(function(p){return String(p.id);}));
      markers.forEach(function(marker,id){if(!ids.has(id)){marker.remove();markers.delete(id);}});
      marked.forEach(function(p){var id=String(p.id),marker=markers.get(id);if(!marker){marker=node('span','syn-star-news-mark');marker.setAttribute('data-star-id',id);marks.append(marker);markers.set(id,marker);}marker.style.transform='translate3d('+p.x.toFixed(2)+'px,'+p.y.toFixed(2)+'px,0)';marker.className='syn-star-news-mark'+(id===hoveredId?' is-hovered':'');});
      marks.hidden=!marked.length;
    }
    function stopFrames(){if(frameId&&win.cancelAnimationFrame)win.cancelAnimationFrame(frameId);frameId=0;}
    function startFrames(){if(!frameId&&!closed&&!doc.hidden&&win.requestAnimationFrame)frameId=win.requestAnimationFrame(frame);}
    function frame(time){frameId=0;if(!ensureDesktop()||doc.hidden){marks.hidden=true;return;}if(time-lastFrame>=80){lastFrame=time;updateMarks();}startFrames();}
    function highlight(id){hoveredId=id||'';markers.forEach(function(marker,key){marker.className='syn-star-news-mark'+(key===hoveredId?' is-hovered':'');});}
    function available(){return ensureDesktop()&&!doc.hidden&&marked.length>0;}
    function cancelTimers(){win.clearTimeout(hoverTimer);win.clearTimeout(closeTimer);hoverTimer=closeTimer=0;}
    function hide(returnFocus){cancelTimers();card.hidden=true;activePoint=null;highlight('');access.setAttribute('aria-expanded','false');if(returnFocus&&focusedBefore&&focusedBefore.isConnected)focusedBefore.focus();keyboard=false;}
    function position(){if(!activePoint)return;var rect=card.getBoundingClientRect(),p=cardPosition(activePoint,win.innerWidth,win.innerHeight,rect.width,rect.height);card.style.left=p.left+'px';card.style.top=p.top+'px';}
    function draw(){
      card.replaceChildren();var header=node('header'),topic=node('span','syn-star-news-topic'),close=node('button','syn-star-news-close','\u00d7');close.type='button';close.setAttribute('aria-label','Close company update');close.addEventListener('click',function(){hide(keyboard);});header.append(topic,close);card.append(header);
      var item=snapshot&&snapshot.items[activeIndex];
      if(!item){topic.textContent='Company news';card.append(node('p','syn-star-news-empty',loadPromise?'Checking saved updates...':'Updates are not available right now.'));}
      else{
        topic.textContent=item.source;var title=node('a','syn-star-news-title',item.title);title.href=item.url;title.target='_blank';title.rel='noopener noreferrer';
        var date=node('time','syn-star-news-date',new Date(item.publishedAt).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}));date.dateTime=item.publishedAt;
        var footer=node('footer'),read=node('a','syn-star-news-read','Read update');read.href=item.url;read.target='_blank';read.rel='noopener noreferrer';footer.append(read);
        if(snapshot.items.length>1){var another=node('button','syn-star-news-next','Next update');another.type='button';another.addEventListener('click',function(){activeIndex=(activeIndex+1)%snapshot.items.length;draw();});footer.append(another);}
        var source=snapshot.sources.find(function(s){return s&&s.id===item.topic;}),checked=source&&source.checkedAt||snapshot.generatedAt,stale=Date.now()-Date.parse(checked)>86400000||source&&source.status==='cached';
        card.append(title,date,footer,node('p','syn-star-news-source','Checked '+new Date(checked).toLocaleDateString(undefined,{month:'short',day:'numeric'})+(stale?'. Saved update; may be out of date.':'.')));
      }
      position();
    }
    function load(){if(!ensureDesktop())return Promise.resolve();if(loadPromise)return loadPromise;var url=options.feedUrl||'/assets/star-news.json';loadPromise=win.fetch(url,{credentials:'same-origin',cache:'no-cache',signal:AbortSignal.timeout(8000)}).then(function(r){if(!r.ok)throw Error('Unavailable');var length=Number(r.headers.get('content-length'));if(length>65536)throw Error('Too large');return r.text();}).then(function(text){if(text.length>65536)throw Error('Too large');snapshot=validSnapshot(JSON.parse(text));if(!snapshot)throw Error('Invalid snapshot');}).catch(function(){snapshot=null;}).finally(function(){loadPromise=null;if(!card.hidden&&ensureDesktop())draw();});return loadPromise;}
    function show(point,fromKeyboard){if(!ensureDesktop())return;cancelTimers();activePoint={id:String(point.id||''),x:point.x,y:point.y};highlight(activePoint.id);keyboard=!!fromKeyboard;focusedBefore=keyboard?doc.activeElement:null;activeIndex=snapshot&&snapshot.items.length?hash(activePoint.id)%snapshot.items.length:0;card.hidden=false;access.setAttribute('aria-expanded','true');draw();if(!snapshot)load();if(keyboard)card.querySelector('button').focus();}
    function delayHide(){if(keyboard)return;win.clearTimeout(closeTimer);closeTimer=win.setTimeout(function(){hide(false);},650);}
    function move(e){if(!ensureDesktop()||(e.pointerType&&e.pointerType!=='mouse'))return;if(card.contains(e.target)){cancelTimers();return;}if(e.buttons||blocked(e.target)||!available()){win.clearTimeout(hoverTimer);highlight('');if(!card.hidden)delayHide();return;}var now=performance.now();if(now-lastMove<90)return;lastMove=now;var p=nearestPoint(marked,e.clientX,e.clientY,13,win.innerWidth,win.innerHeight);if(p){highlight(String(p.id));if(activePoint&&String(p.id)===activePoint.id){win.clearTimeout(closeTimer);return;}win.clearTimeout(hoverTimer);hoverTimer=win.setTimeout(function(){var current=marked.find(function(s){return String(s.id)===String(p.id);});if(current)show(current,false);},280);}else{highlight('');win.clearTimeout(hoverTimer);if(!card.hidden)delayHide();}}
    function mouseUp(e){if(!ensureDesktop()||e.pointerType!=='mouse'||e.button!==0||blocked(e.target)||!available()||card.contains(e.target)||e.target===access)return;var p=nearestPoint(marked,e.clientX,e.clientY,13,win.innerWidth,win.innerHeight);if(p)show(p,false);}
    function mouseDown(e){if(!ensureDesktop())return;if(!card.hidden&&!card.contains(e.target)&&e.target!==access)hide(false);}
    function key(e){if(!ensureDesktop()||card.hidden)return;if(e.key==='Escape'){hide(keyboard);return;}if(keyboard&&(e.key==='ArrowRight'||e.key==='ArrowLeft')&&snapshot&&snapshot.items.length){e.preventDefault();activeIndex=(activeIndex+(e.key==='ArrowLeft'?-1:1)+snapshot.items.length)%snapshot.items.length;draw();card.querySelector('button').focus();}}
    function resize(){if(!ensureDesktop())return;if(!card.hidden)hide(false);if(doc.hidden){stopFrames();marks.hidden=true;}else{updateMarks();startFrames();}}
    card.addEventListener('pointerenter',cancelTimers);card.addEventListener('pointerleave',delayHide);
    access.addEventListener('click',function(){if(!ensureDesktop())return;updateMarks();if(!marked.length)return;show(marked[0],true);});
    win.addEventListener('pointermove',move,{passive:true});win.addEventListener('pointerup',mouseUp,{passive:true});win.addEventListener('mousedown',mouseDown,{passive:true});win.addEventListener('keydown',key);win.addEventListener('resize',resize);win.addEventListener('popstate',resize);doc.addEventListener('visibilitychange',resize);
    var api={open:function(){if(ensureDesktop())access.click();},close:function(){hide(false);},refresh:load,destroy:function(){clearWake(win);if(closed)return;closed=true;hide(false);stopFrames();win.removeEventListener('pointermove',move);win.removeEventListener('pointerup',mouseUp);win.removeEventListener('mousedown',mouseDown);win.removeEventListener('keydown',key);win.removeEventListener('resize',resize);win.removeEventListener('popstate',resize);doc.removeEventListener('visibilitychange',resize);if(desktopMedia.removeEventListener)desktopMedia.removeEventListener('change',resize);else if(desktopMedia.removeListener)desktopMedia.removeListener(resize);if(modeObserver)modeObserver.disconnect();card.remove();access.remove();marks.remove();markers.clear();marked=[];delete win.__synapsesStarNews;}};win.__synapsesStarNews=api;
    if(desktopMedia.addEventListener)desktopMedia.addEventListener('change',resize);else if(desktopMedia.addListener)desktopMedia.addListener(resize);
    if(win.MutationObserver&&doc.documentElement){modeObserver=new win.MutationObserver(resize);modeObserver.observe(doc.documentElement,{attributes:true,attributeFilter:['class']});}
    // One small cached snapshot per page, never a network request for each star.
    if(options.snapshot){snapshot=validSnapshot(options.snapshot);}else load();
    updateMarks();startFrames();
    return api;
  }
  return{init:init,desktopAllowed:desktopAllowed,markedPoints:markedPoints,validSnapshot:validSnapshot,nearestPoint:nearestPoint,cardPosition:cardPosition,particlePoints:particlePoints,safeItem:safeItem};
});
