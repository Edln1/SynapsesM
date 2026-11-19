(function(root,factory){'use strict';var api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.SynapsesStarNews=api;})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';
  var HOSTS={nvidia:['blogs.nvidia.com'],meta:['about.fb.com'],youtube:['blog.youtube']};
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
  function init(options){
    options=options||{};var win=options.window||window,doc=win.document;
    if(win.__synapsesStarNews)return win.__synapsesStarNews;
    var getPoints=options.getPoints||function(){return typeof win.synapsesStarNewsPoints==='function'?win.synapsesStarNewsPoints():[];};
    var snapshot=null,activePoint=null,activeIndex=0,keyboard=false,closed=false,hoverTimer=0,closeTimer=0,loadPromise=null,lastMove=0,down=null,focusedBefore=null;
    var card=doc.createElement('section');card.className='syn-star-news-card';card.id='synStarNewsCard';card.hidden=true;card.setAttribute('aria-label','Company update');card.setAttribute('role','region');
    var access=doc.createElement('button');access.type='button';access.className='syn-star-news-access';access.textContent='Explore company updates from the stars';access.setAttribute('aria-controls',card.id);access.setAttribute('aria-expanded','false');doc.body.append(access,card);
    function node(tag,className,text){var n=doc.createElement(tag);if(className)n.className=className;if(text!=null)n.textContent=text;return n;}
    function blocked(target){if(!target||target===doc.body||target===doc.documentElement)return false;if(card.contains(target)||target===access)return false;return !!(target.closest&&target.closest('button,a,input,textarea,select,form,label,header,nav,aside,table,dialog,[role="dialog"],[role="button"],[contenteditable="true"],[aria-modal="true"],#avaCompanionChat,.ac-shell,.widget,.panel,.modal,[data-no-star-news]'));}
    function points(){try{return getPoints()||[];}catch(_){return[];}}
    function available(){return !closed&&!doc.hidden&&points().length>0;}
    function cancelTimers(){win.clearTimeout(hoverTimer);win.clearTimeout(closeTimer);hoverTimer=closeTimer=0;}
    function hide(returnFocus){cancelTimers();card.hidden=true;activePoint=null;access.setAttribute('aria-expanded','false');if(returnFocus&&focusedBefore&&focusedBefore.isConnected)focusedBefore.focus();keyboard=false;}
    function position(){if(!activePoint)return;var rect=card.getBoundingClientRect(),p=cardPosition(activePoint,win.innerWidth,win.innerHeight,rect.width,rect.height);card.style.left=p.left+'px';card.style.top=p.top+'px';}
    function draw(){
      card.replaceChildren();var header=node('header'),topic=node('span','syn-star-news-topic'),close=node('button','syn-star-news-close','×');close.type='button';close.setAttribute('aria-label','Close company update');close.addEventListener('click',function(){hide(keyboard);});header.append(topic,close);card.append(header);
      var item=snapshot&&snapshot.items[activeIndex];
      if(!item){topic.textContent='Company updates';card.append(node('p','syn-star-news-empty',loadPromise?'Checking saved updates…':'Updates are not available right now.'));}
      else{
        topic.textContent=item.source+' · official news';var title=node('a','syn-star-news-title',item.title);title.href=item.url;title.target='_blank';title.rel='noopener noreferrer';
        var date=node('time','syn-star-news-date',new Date(item.publishedAt).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}));date.dateTime=item.publishedAt;
        var footer=node('footer'),read=node('a','syn-star-news-read','Read the update ↗');read.href=item.url;read.target='_blank';read.rel='noopener noreferrer';footer.append(read);
        if(snapshot.items.length>1){var another=node('button','syn-star-news-next','Another update →');another.type='button';another.addEventListener('click',function(){activeIndex=(activeIndex+1)%snapshot.items.length;draw();});footer.append(another);}
        var source=snapshot.sources.find(function(s){return s.id===item.topic;}),checked=source&&source.checkedAt||snapshot.generatedAt,stale=Date.now()-Date.parse(checked)>86400000||source&&source.status==='cached';
        card.append(title,date,footer,node('p','syn-star-news-source',(stale?'Saved update · last checked ':'Checked ')+new Date(checked).toLocaleDateString(undefined,{month:'short',day:'numeric'})+'. '+(stale?'May be out of date.':'Headlines update periodically.')));
      }
      position();
    }
    function load(){if(loadPromise)return loadPromise;var url=options.feedUrl||'/assets/star-news.json';loadPromise=win.fetch(url,{credentials:'same-origin',cache:'no-cache',signal:AbortSignal.timeout(8000)}).then(function(r){if(!r.ok)throw Error('Unavailable');var length=Number(r.headers.get('content-length'));if(length>65536)throw Error('Too large');return r.text();}).then(function(text){if(text.length>65536)throw Error('Too large');snapshot=validSnapshot(JSON.parse(text));if(!snapshot)throw Error('Invalid snapshot');}).catch(function(){snapshot=null;}).finally(function(){loadPromise=null;if(!card.hidden)draw();});return loadPromise;}
    function show(point,fromKeyboard){cancelTimers();activePoint={id:String(point.id||''),x:point.x,y:point.y};keyboard=!!fromKeyboard;focusedBefore=keyboard?doc.activeElement:null;activeIndex=snapshot&&snapshot.items.length?hash(activePoint.id)%snapshot.items.length:0;card.hidden=false;access.setAttribute('aria-expanded','true');draw();if(!snapshot)load();if(keyboard)card.querySelector('button').focus();}
    function delayHide(){if(keyboard)return;win.clearTimeout(closeTimer);closeTimer=win.setTimeout(function(){hide(false);},650);}
    function move(e){if(e.pointerType==='touch'||e.pointerType==='pen')return;if(card.contains(e.target)){cancelTimers();return;}if(e.buttons||blocked(e.target)||!available()){if(!card.hidden)delayHide();return;}var now=performance.now();if(now-lastMove<90)return;lastMove=now;var p=nearestPoint(points(),e.clientX,e.clientY,12,win.innerWidth,win.innerHeight);if(p){if(activePoint&&String(p.id)===activePoint.id){win.clearTimeout(closeTimer);return;}win.clearTimeout(hoverTimer);hoverTimer=win.setTimeout(function(){show(p,false);},280);}else{win.clearTimeout(hoverTimer);if(!card.hidden)delayHide();}}
    function pointerDown(e){if(!card.hidden&&!card.contains(e.target)&&e.target!==access)hide(false);down={x:e.clientX,y:e.clientY,t:Date.now(),pointerType:e.pointerType};}
    function pointerUp(e){if(!down)return;var start=down;down=null;if(!['touch','pen'].includes(start.pointerType)||Date.now()-start.t>550||Math.hypot(e.clientX-start.x,e.clientY-start.y)>8||blocked(e.target)||!available())return;var p=nearestPoint(points(),e.clientX,e.clientY,24,win.innerWidth,win.innerHeight);if(p)show(p,false);}
    function key(e){if(card.hidden)return;if(e.key==='Escape'){hide(keyboard);return;}if(keyboard&&(e.key==='ArrowRight'||e.key==='ArrowLeft')&&snapshot&&snapshot.items.length){e.preventDefault();activeIndex=(activeIndex+(e.key==='ArrowLeft'?-1:1)+snapshot.items.length)%snapshot.items.length;draw();card.querySelector('button').focus();}}
    function resize(){if(!card.hidden)hide(false);}
    card.addEventListener('pointerenter',cancelTimers);card.addEventListener('pointerleave',delayHide);
    access.addEventListener('click',function(){var ps=points();if(!ps.length)return;var p=ps.find(function(s){return s.x>40&&s.y>60&&s.x<win.innerWidth-40&&s.y<win.innerHeight-80;})||ps[0];show(p,true);});
    win.addEventListener('pointermove',move,{passive:true});win.addEventListener('pointerdown',pointerDown,{passive:true});win.addEventListener('pointerup',pointerUp,{passive:true});win.addEventListener('keydown',key);win.addEventListener('resize',resize);doc.addEventListener('visibilitychange',resize);
    var api={open:function(){access.click();},close:function(){hide(false);},refresh:load,destroy:function(){closed=true;hide(false);win.removeEventListener('pointermove',move);win.removeEventListener('pointerdown',pointerDown);win.removeEventListener('pointerup',pointerUp);win.removeEventListener('keydown',key);win.removeEventListener('resize',resize);doc.removeEventListener('visibilitychange',resize);card.remove();access.remove();delete win.__synapsesStarNews;}};win.__synapsesStarNews=api;
    // One small cached snapshot per page, never a network request for each star.
    if(options.snapshot){snapshot=validSnapshot(options.snapshot);}else load();
    return api;
  }
  return{init:init,validSnapshot:validSnapshot,nearestPoint:nearestPoint,cardPosition:cardPosition,particlePoints:particlePoints,safeItem:safeItem};
});
