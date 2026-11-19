'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {doorDashSearchUrl,selectDoorDashRestaurant,verifyDoorDashRestaurant,doorDashBlocked}=require('../src/doordash-restaurant.cjs');

test('search URLs encode the restaurant query inside the DoorDash store route',()=>{
  assert.equal(doorDashSearchUrl(' McDonalds '),'https://www.doordash.com/search/store/McDonalds/');
  assert.equal(doorDashSearchUrl("McDonald's"),'https://www.doordash.com/search/store/McDonald%27s/');
  assert.equal(doorDashSearchUrl('Game of Wings'),'https://www.doordash.com/search/store/Game%20of%20Wings/');
  for(const query of ['',null,'x'.repeat(161),'name\nother'])assert.equal(doorDashSearchUrl(query),null);
});
test('selection uses an observed same-site link and matches apostrophe and slug variants',()=>{
  const page={url:'https://www.doordash.com/search/store/McDonalds/',controls:[{ref:'a',href:'/en-CA/store/mcdonalds-vancouver-123/',label:'McDonald’s'},{ref:'b',href:'/store/wendys-456/',label:'Wendy’s'}]};
  assert.equal(selectDoorDashRestaurant(page,'McDonalds'),'https://www.doordash.com/en-CA/store/mcdonalds-vancouver-123/');
  assert.equal(selectDoorDashRestaurant(page,"McDonald's"),'https://www.doordash.com/en-CA/store/mcdonalds-vancouver-123/');
  assert.equal(selectDoorDashRestaurant({url:page.url,links:[{href:'/store/mcdonald-s-123/',text:'View menu'}]},'McDonalds'),'https://www.doordash.com/store/mcdonald-s-123/');
  assert.equal(selectDoorDashRestaurant(page,'Game of Wings'),null);
  const numeric={url:page.url,controls:[{href:'/store/23594998?cursor=observed&pickup=false',label:'Pizza Hut 4.5(2k+)•6.8 mi•49 min$0 delivery fee'}]};
  assert.equal(selectDoorDashRestaurant(numeric,'Pizza Hut'),'https://www.doordash.com/store/23594998?cursor=observed&pickup=false');assert.equal(selectDoorDashRestaurant(numeric,'McDonalds'),null);
});
test('selection rejects foreign hosts, invented IDs, invisible links and unobserved restaurant URLs',()=>{
  const base={url:'https://www.doordash.com/search/store/McDonalds/'};
  for(const href of ['https://doordash.com.evil.example/store/mcdonalds-123/','https://evil.com/store/mcdonalds-123/','http://www.doordash.com/store/mcdonalds-123/','https://user:pass@www.doordash.com/store/mcdonalds-123/','/store/mcdonalds/','/store/mcdonaldsville-123/','/store/mcdonalds-123/menu/'])assert.equal(selectDoorDashRestaurant({...base,links:[{href,label:href.includes('mcdonaldsville')?'McDonaldsville':''}]},'McDonalds'),null,href);
  assert.equal(selectDoorDashRestaurant({...base,links:[{href:'/store/mcdonalds-123/',label:'McDonalds',visible:false}]},'McDonalds'),null);
  assert.equal(selectDoorDashRestaurant({...base,text:'McDonalds has a restaurant somewhere.'},'McDonalds'),null);
  assert.equal(selectDoorDashRestaurant({url:'https://www.google.com/',links:[{href:'https://www.doordash.com/store/mcdonalds-123/',label:'McDonalds'}]},'McDonalds'),null);
});
test('the first clearly matching ranked store is selected and an observed brand is usable when no store appears',()=>{
  const page={url:'https://www.doordash.com/',links:[{href:'/store/mcdonalds-vancouver-123/',label:'McDonalds'},{href:'/store/mcdonalds-burnaby-456/',label:'McDonalds'}]};
  assert.equal(selectDoorDashRestaurant(page,'McDonalds'),'https://www.doordash.com/store/mcdonalds-vancouver-123/');
  page.links.push({href:'/en-CA/business/mcdonalds-61/',label:'McDonald’s'});
  assert.equal(selectDoorDashRestaurant(page,'McDonalds'),'https://www.doordash.com/store/mcdonalds-vancouver-123/');
  assert.equal(selectDoorDashRestaurant({url:page.url,links:[page.links[2]]},'McDonalds'),'https://www.doordash.com/en-CA/business/mcdonalds-61/');
  const duplicate={url:page.url,links:[{href:'/store/mcdonalds-123/?tracking=one',label:'McDonalds'},{href:'/en-CA/store/mcdonalds-123/',label:'McDonalds'}]};
  assert.ok(selectDoorDashRestaurant(duplicate,'McDonalds'));
});
test('verification requires the same store or brand path and exact numeric identity across locales',()=>{
  const expected='https://www.doordash.com/en-US/store/mcdonalds-vancouver-123/';
  assert.equal(verifyDoorDashRestaurant({url:'https://doordash.com/en-CA/store/mcdonalds-vancouver-123/?pickup=false'},expected),true);
  for(const url of ['https://www.doordash.com/store/mcdonalds-vancouver-1234/','https://www.doordash.com/store/mcdonalds-burnaby-123/','https://www.doordash.com/business/mcdonalds-vancouver-123/','https://www.doordash.com/consumer/login/?next=/store/mcdonalds-vancouver-123/','https://evil.com/store/mcdonalds-vancouver-123/'])assert.equal(verifyDoorDashRestaurant({url},expected),false,url);
  assert.equal(verifyDoorDashRestaurant({url:'https://www.doordash.com/business/mcdonald-s-61/'},'https://www.doordash.com/en-CA/business/mcdonalds-61/'),true);
  assert.equal(verifyDoorDashRestaurant({url:'https://www.doordash.com/en/store/pizza-hut-vancouver-23594998/'},'https://www.doordash.com/store/23594998?pickup=false'),true);
  assert.equal(verifyDoorDashRestaurant({url:"https://www.doordash.com/business/mcdonald's-437107/"},'https://www.doordash.com/business/mcdonald%27s-437107/'),true);
});
test('actual challenge pages cannot be selected or verified as a restaurant',()=>{
  const url='https://www.doordash.com/business/mcdonalds-61/';
  for(const challenge of [{title:'Just a moment...'},{title:'Access Denied'},{text:'Verify you are human to continue.'},{text:'Complete the security check to continue.'},{title:'Checking if the site connection is secured'},{text:'Checking if the site connection is secured'}]){
    const page={url,...challenge,links:[{href:url,label:'McDonalds'}]};assert.equal(doorDashBlocked(page),true);assert.equal(selectDoorDashRestaurant(page,'McDonalds'),null);assert.equal(verifyDoorDashRestaurant(page,url),false);
  }
  assert.equal(doorDashBlocked({url,title:'McDonald’s | DoorDash',text:'Verify the delivery address before placing an order.'}),false);
});
