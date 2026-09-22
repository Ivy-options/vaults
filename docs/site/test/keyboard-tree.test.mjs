import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startServer} from './_server.mjs';
import {openPage} from './_browser.mjs';

async function withMap(run, width=1440, reduced=true) {
  const server=await startServer();
  const {page,errors,close}=await openPage(server.url+'index.html?view=map',{width,height:900});
  try {
    await page.waitForFunction(()=>window.IvyMap?.mounted);
    if(reduced) await page.emulateMedia({reducedMotion:'reduce'});
    await run(page);
    assert.deepEqual(errors,[]);
  } finally {await close();await server.close();}
}
const card=(page,id)=>page.locator(`.card[data-id="${id}"]`);
async function select(page,id) {
  await page.evaluate(id=>IvyMap.flyTo(id,false),id);
  await card(page,id).focus();
}
async function selected(page,id,scale) {
  const state=await page.evaluate(()=>({ ...IvyMap.state(), focus:document.activeElement?.dataset.id }));
  assert.equal(state.path.at(-1),id);
  assert.equal(state.focus,id);
  if(scale!==undefined) assert.ok(Math.abs(state.scale-scale)<1e-5,`zoom changed: ${state.scale} vs ${scale}`);
}

for(const width of [1440,390]) test(`tree arrows expand, fold and stay among siblings at ${width}px`,()=>withMap(async page=>{
  await select(page,'exercise-windows');
  const scale=await page.evaluate(()=>IvyMap.state().scale);
  await page.keyboard.press('ArrowRight');
  await selected(page,'physical-american-start',scale);
  await page.keyboard.press('ArrowUp'); // first sibling: no wrapping
  await selected(page,'physical-american-start',scale);
  await page.keyboard.press('ArrowRight'); // terminal leaf: no jump
  await selected(page,'physical-american-start',scale);
  await page.keyboard.press('ArrowDown');
  await selected(page,'physical-european-start',scale);
  await page.keyboard.press('ArrowDown');
  await selected(page,'physical-window-duration',scale);
  await page.keyboard.press('ArrowDown'); // last sibling: no wrapping
  await selected(page,'physical-window-duration',scale);
  await page.keyboard.press('ArrowRight');
  await selected(page,'physical-window-example',scale);
  await page.keyboard.press('ArrowUp'); // only child: no parent jump
  await selected(page,'physical-window-example',scale);
  await page.keyboard.press('ArrowLeft');
  await selected(page,'physical-window-duration',scale);
  assert.equal(await page.locator('[data-expand="physical-window-example"]').getAttribute('aria-expanded'),'false');
  await page.keyboard.press('ArrowLeft');
  await selected(page,'exercise-windows',scale);
  assert.equal(await page.locator('[data-expand="physical-window-duration"]').getAttribute('aria-expanded'),'false');
  assert.equal(await page.locator('[data-expand="physical-american-start"]').getAttribute('aria-expanded'),'false');
  await page.keyboard.press('ArrowRight'); // reopen the first child after folding this level
  await selected(page,'physical-american-start',scale);
  const box=await card(page,'physical-american-start').boundingBox(),view=await page.locator('#map').boundingBox();
  assert.ok(Math.abs(box.x+box.width/2-view.x-view.width/2)<1);
},width));

test('focused branch rows open their named child and keyboard folding returns to the parent tile',()=>withMap(async page=>{
  await select(page,'exercise-windows');
  await page.locator('[data-expand="physical-window-duration"]').focus();
  const scale=await page.evaluate(()=>IvyMap.state().scale);
  await page.keyboard.press('ArrowRight');
  await selected(page,'physical-window-duration',scale);
  await page.keyboard.press('ArrowLeft');
  await selected(page,'exercise-windows',scale);
  await page.keyboard.press('ArrowRight');
  await selected(page,'physical-american-start',scale);
}));

test('arrows follow current selection after breadcrumbs and restart predictably after Fit',()=>withMap(async page=>{
  await select(page,'physical-window-duration');
  // Breadcrumb navigation can leave the old card focused in the DOM.
  await page.locator('#crumbs [data-fly="exercise-windows"]').evaluate(el=>el.click());
  await page.keyboard.press('ArrowRight');
  await selected(page,'physical-american-start');
  await page.evaluate(()=>IvyMap.home(false));
  await page.focus('#map');
  await page.keyboard.press('ArrowRight');
  const first=await page.locator('.card.station').first().getAttribute('data-id');
  await selected(page,first);
  await page.keyboard.press('ArrowUp');
  await selected(page,first);
}));

test('native range inputs retain arrow behavior without moving the map',async()=>{
  const server=await startServer();
  const {page,errors,close}=await openPage(server.url+'test/fixtures/tree.html#fee-lab');
  try {
    await page.waitForFunction(()=>window.IvyMap?.mounted);
    await page.locator('#world #fee-rate').focus();
    const before=await page.evaluate(()=>IvyMap.state());
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#world #fee-rate').inputValue(),'210');
    assert.deepEqual(await page.evaluate(()=>IvyMap.state()),before);
    assert.deepEqual(errors,[]);
  } finally {await close();await server.close();}
});

test('rapid arrow navigation during growth preserves the final focus and zoom',()=>withMap(async page=>{
  await select(page,'exercise-windows');
  const scale=await page.evaluate(()=>IvyMap.state().scale);
  for(const key of ['ArrowRight','ArrowDown','ArrowDown','ArrowRight','ArrowLeft','ArrowLeft','ArrowRight']) await page.keyboard.press(key);
  await page.waitForTimeout(850);
  await selected(page,'physical-american-start',scale);
  for(const id of ['physical-european-start','physical-window-duration','physical-window-example']) {
    assert.equal(await card(page,id).evaluate(el=>el.inert),true,id);
    assert.equal(await card(page,id).isVisible(),false,id);
  }
  assert.equal(await page.locator('#world').evaluate(el=>el.getAnimations({subtree:true}).filter(a=>a.playState==='running').length),0);
},1440,false));

for(const width of [1440,390]) test(`Left folds the whole sibling level and keeps unrelated branches open at ${width}px`,()=>withMap(async page=>{
  await select(page,'physical-american-start'); // unrelated branch stays open
  await select(page,'cash-the-vault-needs-a-price');
  await page.keyboard.press('ArrowRight'); // publisher
  await page.keyboard.press('ArrowDown'); // report selection
  await page.keyboard.press('ArrowRight'); // freshness
  await page.keyboard.press('ArrowDown'); // final price
  const scale=await page.evaluate(()=>IvyMap.state().scale);
  await page.keyboard.press('ArrowLeft');
  await selected(page,'cash-exercise-price-selection',scale);
  for(const id of ['cash-live-observation','cash-final-expiry-price']) {
    assert.equal(await card(page,id).isVisible(),false,id);
    assert.equal(await page.locator(`[data-expand="${id}"]`).getAttribute('aria-expanded'),'false',id);
  }
  assert.equal(await card(page,'cash-price-publisher').isVisible(),true);
  // Open a descendant again, then return to its parent without folding it.
  await page.keyboard.press('ArrowRight');
  await select(page,'cash-exercise-price-selection');
  const parentScale=await page.evaluate(()=>IvyMap.state().scale);
  await page.keyboard.press('ArrowLeft');
  await selected(page,'cash-the-vault-needs-a-price',parentScale);
  for(const id of ['cash-price-publisher','cash-exercise-price-selection','cash-live-observation']) {
    assert.equal(await card(page,id).isVisible(),false,id);
    assert.equal(await card(page,id).evaluate(el=>el.inert),true,id);
  }
  for(const id of ['cash-price-publisher','cash-exercise-price-selection']) {
    assert.equal(await page.locator(`[data-expand="${id}"]`).getAttribute('aria-expanded'),'false',id);
  }
  assert.equal(await card(page,'physical-american-start').isVisible(),true);
  const box=await card(page,'cash-the-vault-needs-a-price').boundingBox(),view=await page.locator('#map').boundingBox();
  assert.ok(Math.abs(box.x+box.width/2-view.x-view.width/2)<1);
  await page.keyboard.press('ArrowRight');
  await selected(page,'cash-price-publisher',parentScale);
  assert.equal(await card(page,'cash-exercise-price-selection').isVisible(),false);
},width));
