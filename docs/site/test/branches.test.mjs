import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startServer} from './_server.mjs';
import {openPage} from './_browser.mjs';
async function withMap(run, width=1440, hash='') {
  const server=await startServer();
  const {page,errors,close}=await openPage(server.url+'index.html?view=map'+hash,{width,height:900});
  try {await page.waitForFunction(()=>window.IvyMap?.mounted);await run(page);assert.deepEqual(errors,[]);}
  finally {await close();await server.close();}
}
const card=(page,id)=>page.locator(`.card[data-id="${id}"]`);
const row=(page,id)=>page.locator(`#world [data-expand="${id}"]`);
const toggle=async(page,id)=>row(page,id).evaluate(el=>el.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1})));

test('detail branches start folded; independent siblings and nested leaves retain their state',()=>withMap(async page=>{
  assert.equal(await page.locator('.card.tile:not([hidden]), .card.lab:not([hidden])').count(),0);
  await page.evaluate(()=>IvyMap.flyTo('exercise-windows',false));
  await row(page,'physical-american-start').click();
  await page.keyboard.press('ArrowUp');
  await row(page,'physical-window-duration').click();
  assert.equal(await row(page,'physical-window-duration').getAttribute('aria-expanded'),'true');
  await page.waitForTimeout(750);
  assert.equal(await row(page,'physical-american-start').getAttribute('aria-expanded'),'true');
  assert.equal(await card(page,'physical-european-start').isVisible(),false);
  await row(page,'physical-window-example').focus();await page.keyboard.press('Enter');
  assert.equal(await card(page,'physical-window-example').isVisible(),true);
  await row(page,'physical-window-duration').focus();await page.keyboard.press('Enter');
  assert.equal(await card(page,'physical-window-duration').isVisible(),false);
  assert.equal(await card(page,'physical-window-example').isVisible(),false);
  assert.equal(await card(page,'physical-american-start').isVisible(),true);
  await page.keyboard.press('Enter');
  assert.equal(await card(page,'physical-window-example').isVisible(),true);
}));

test('growth draws the stem before the card and rapid reversal leaves no stale animation',()=>withMap(async page=>{
  await page.evaluate(()=>IvyMap.flyTo('exercise-windows',false));
  await toggle(page,'physical-american-start');
  await page.waitForTimeout(90);
  const phase=await page.evaluate(()=>{
    const stem=document.querySelector('[data-edge="physical-american-start"] .stem');
    return {dash:parseFloat(getComputedStyle(stem).strokeDashoffset),opacity:+getComputedStyle(document.querySelector('.card[data-id="physical-american-start"]')).opacity};
  });
  assert.ok(phase.dash>0&&phase.dash<1,JSON.stringify(phase));
  assert.equal(phase.opacity,0);
  await toggle(page,'physical-american-start');await page.waitForTimeout(50);
  await toggle(page,'physical-american-start');await page.waitForTimeout(100);
  await toggle(page,'physical-american-start');await page.waitForTimeout(800);
  assert.equal(await card(page,'physical-american-start').isVisible(),false);
  assert.equal(await card(page,'physical-american-start').evaluate(el=>el.inert),true);
  await toggle(page,'physical-american-start');await page.waitForTimeout(800);
  assert.equal(await card(page,'physical-american-start').evaluate(el=>getComputedStyle(el).opacity),'1');
  assert.equal(await page.locator('#world').evaluate(el=>el.getAnimations({subtree:true}).filter(a=>a.playState==='running').length),0);
  assert.equal(await row(page,'physical-american-start').getAttribute('aria-expanded'),'true');
}));

test('mobile branches grow downward at reading width and folding returns to the source',()=>withMap(async page=>{
  await page.evaluate(()=>IvyMap.flyTo('exercise-windows',false));
  await row(page,'physical-american-start').click();await page.waitForTimeout(800);
  const geometry=await page.evaluate(()=>{
    const p=document.querySelector('.card[data-id="exercise-windows"]'), c=document.querySelector('.card[data-id="physical-american-start"]');
    return {below:c.offsetTop>=p.offsetTop+p.offsetHeight,width:c.offsetWidth,box:c.getBoundingClientRect().toJSON()};
  });
  assert.equal(geometry.below,true);assert.equal(geometry.width,296);
  await page.evaluate(()=>IvyMap.flyTo('physical-american-start',false));
  await card(page,'physical-american-start').locator('[data-fold]').click();await page.waitForTimeout(500);
  assert.equal(await card(page,'physical-american-start').isVisible(),false);
  const trigger=await row(page,'physical-american-start').boundingBox();
  assert.ok(trigger.y>=0&&trigger.y<900,JSON.stringify(trigger));
  assert.equal(await row(page,'physical-american-start').evaluate(el=>el===document.activeElement),true);
},320));

test('reduced motion reveals immediately, and resize preserves open branches without overlap',()=>withMap(async page=>{
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.evaluate(()=>IvyMap.flyTo('exercise-windows',false));
  await toggle(page,'physical-window-duration');
  assert.equal(await card(page,'physical-window-duration').evaluate(el=>getComputedStyle(el).opacity),'1');
  assert.equal(await page.locator('#world').evaluate(el=>el.getAnimations({subtree:true}).filter(a=>a.playState==='running').length),0);
  for(const width of [320,1920]) {
    await page.setViewportSize({width,height:900});await page.waitForTimeout(80);
    const overlaps=await page.evaluate(()=>{
      const nodes=[...document.querySelectorAll('#world .card:not([hidden])')];
      return nodes.flatMap((a,i)=>nodes.slice(i+1).filter(b=>a.offsetLeft<b.offsetLeft+b.offsetWidth&&a.offsetLeft+a.offsetWidth>b.offsetLeft&&a.offsetTop<b.offsetTop+b.offsetHeight&&a.offsetTop+a.offsetHeight>b.offsetTop).map(b=>[a.dataset.id,b.dataset.id]));
    });
    assert.deepEqual(overlaps,[]);
    assert.equal(await row(page,'physical-window-duration').getAttribute('aria-expanded'),'true');
  }
}));

test('deep bookmarks and search reveal their hidden ancestors without opening unrelated leaves',()=>withMap(async page=>{
  assert.equal(await card(page,'physical-window-duration').isVisible(),true);
  assert.equal(await card(page,'physical-window-example').isVisible(),true);
  assert.equal(await card(page,'physical-american-start').isVisible(),false);
  const input=page.locator('#search-input');await input.fill('Which duration applies');await input.press('Enter');
  assert.equal(await card(page,'auction-cancellation-clock').isVisible(),true);
  assert.equal(await card(page,'auction-timeout-setting').isVisible(),true);
  assert.equal(await row(page,'auction-timeout-setting').getAttribute('aria-expanded'),'true');
},1440,'#physical-window-example'));

test('expansion centers and focuses each new card while preserving zoom; folding returns to its parent',()=>withMap(async page=>{
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.evaluate(()=>IvyMap.flyTo('sign-a-bid',false));
  const scale=await page.evaluate(()=>IvyMap._cam().s);
  const ids=await card(page,'sign-a-bid').locator('[data-expand]').evaluateAll(rows=>rows.map(el=>el.dataset.expand));
  for(const [id,opening] of [...ids.map(id=>[id,true]),...ids.slice().reverse().map(id=>[id,false])]) {
    await toggle(page,id);
    const target=opening?id:'sign-a-bid';
    const cam=await page.evaluate(()=>IvyMap._cam()),box=await card(page,target).boundingBox(),view=await page.locator('#map').boundingBox();
    assert.equal(cam.s,scale);
    assert.equal(await page.evaluate(()=>IvyMap.here().at(-1)?.id),target);
    assert.ok(Math.abs(box.x+box.width/2-view.x-view.width/2)<1,JSON.stringify({box,view}));
    if(box.height<=view.height-24) assert.ok(Math.abs(box.y+box.height/2-view.y-view.height/2)<1);
    else assert.ok(Math.abs(box.y-view.y-12)<1);
    if(opening) assert.equal(await card(page,id).evaluate(el=>el===document.activeElement),true);
  }
}));

test('tablet expansion uses downward branches instead of shrinking the text',()=>withMap(async page=>{
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.evaluate(()=>IvyMap.flyTo('exercise-windows',false));
  await toggle(page,'physical-american-start');
  const result=await page.evaluate(()=>{
    const parent=document.querySelector('.card[data-id="exercise-windows"]'),child=document.querySelector('.card[data-id="physical-american-start"]');
    const box=child.getBoundingClientRect();
    return {below:child.offsetTop>=parent.offsetTop+parent.offsetHeight,font:parseFloat(getComputedStyle(child.querySelector('.body')).fontSize)*IvyMap.state().scale,left:box.left,right:box.right};
  });
  assert.equal(result.below,true);assert.ok(result.font>=15,JSON.stringify(result));
},800));


test('stages and topics expand independently and direct links reveal every ancestor',()=>withMap(async page=>{
  assert.equal(await page.locator('.card.moment:not([hidden]), .card.action:not([hidden])').count(),0);
  await page.evaluate(()=>IvyMap.flyTo('live',false));
  const scale=await page.evaluate(()=>IvyMap._cam().s);
  await row(page,'buyer-may-now-exercise').focus();await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(()=>IvyMap._cam().s),scale);
  assert.equal(await card(page,'buyer-may-now-exercise').isVisible(),true);
  assert.equal(await card(page,'exercise-windows').isVisible(),false);
  await row(page,'exercise-windows').focus();await page.keyboard.press('Enter');
  assert.equal(await card(page,'exercise-windows').isVisible(),true);
  await row(page,'buyer-may-now-exercise').focus();await page.keyboard.press('Enter');
  assert.equal(await card(page,'exercise-windows').isVisible(),false);
  await page.evaluate(()=>IvyMap.flyTo('physical-window-example',false));
  for(const id of ['buyer-may-now-exercise','exercise-windows','physical-window-duration','physical-window-example']) {
    assert.equal(await card(page,id).isVisible(),true,id);
    assert.equal(await row(page,id).getAttribute('aria-expanded'),'true',id);
  }
}));

test('olive leaves stay attached to their rendered stem during growth and layout changes',()=>withMap(async page=>{
  await page.evaluate(()=>IvyMap.flyTo('exercise-windows',false));
  await toggle(page,'physical-american-start');
  for(const delay of [260,340,200]) {
    await page.waitForTimeout(delay);
    const gaps=await page.evaluate(()=>[...document.querySelectorAll('.branch-foliage')].filter(g=>getComputedStyle(g).visibility==='visible'&&g.parentElement.style.display!=='none').map(g=>{
      const stem=g.parentElement.querySelector('.stem'),length=stem.getTotalLength(),p=stem.getPointAtLength(Math.max(0,length-30));
      const matrix=g.transform.baseVal.consolidate().matrix;
      return Math.hypot(matrix.e-p.x,matrix.f-p.y);
    }));
    assert.ok(gaps.length>0);
    assert.ok(gaps.every(gap=>gap<1),JSON.stringify(gaps));
  }
  await toggle(page,'physical-european-start');await page.waitForTimeout(700);
  assert.equal(await page.evaluate(()=>document.querySelectorAll('[data-edge="physical-american-start"] .olive-leaf[d^="M 0 0"], [data-edge="physical-european-start"] .olive-leaf[d^="M 0 0"]').length),4);
}));


test('folding into a tall parent keeps the restored keyboard focus visible on a short screen',()=>withMap(async page=>{
  await page.setViewportSize({width:390,height:600});
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.evaluate(()=>IvyMap.flyTo('physical-window-duration',false));
  const scale=await page.evaluate(()=>IvyMap._cam().s);
  await card(page,'physical-window-duration').locator('[data-fold]').focus();await page.keyboard.press('Enter');
  const button=row(page,'physical-window-duration'),box=await button.boundingBox(),view=await page.locator('#map').boundingBox();
  assert.equal(await button.evaluate(el=>el===document.activeElement),true);
  assert.equal(await page.evaluate(()=>IvyMap._cam().s),scale);
  assert.ok(box.y>=view.y&&box.y+box.height<=view.y+view.height,JSON.stringify({box,view}));
},390));
