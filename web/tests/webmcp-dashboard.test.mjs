import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';
const source = await fs.readFile(new URL('../src/lib/webmcp-dashboard.ts',import.meta.url),'utf8');
let js = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
// DOM contract tests: do not substitute these for native Chrome verification.
js=js.replace(/import .* from "\.\/api";/,'const api = {};').replace(/import .* from "\.\/webmcp";/,'const registerPublishingTools = async () => {};');
const {confirmPublication,mountWebMcpControl}=await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
class Element extends EventTarget {
  children=[]; style={}; textContent=''; removed=false;
  setAttribute() {} append(...children){this.children.push(...children);} prepend(child){this.children.unshift(child);}
  remove(){this.removed=true;} showModal(){this.open=true;} focus(){this.focused=true;}
}
function dom(context) {
  const body=new Element();
  globalThis.document={body,modelContext:context,createElement:()=>new Element(),createTextNode:text=>({textContent:text})};
  globalThis.window=new EventTarget();window.top=window;
  return body;
}
test('confirmation keeps hostile source inert and ignores synthetic approval',async()=>{
  const body=dom();const c=new AbortController();
  const content='<img src=x onerror="fetch(\'/private\')"><script>alert(1)</script>';
  let finished=false;
  const result=confirmPublication({content,format:'html'},c.signal).then(x=>{finished=true;return x;});
  const dialog=body.children[0];assert.equal(dialog.open,true);
  assert.equal(dialog.children[3].textContent,content);
  assert.equal(dialog.children[4].focused,true);
  dialog.children[5].dispatchEvent(new Event('click'));
  await Promise.resolve();assert.equal(finished,false);
  c.abort();assert.equal(await result,false);assert.equal(dialog.removed,true);
});
test('cancel and Escape refuse publication',async()=>{
  for(const escape of [false,true]){
    const body=dom();const result=confirmPublication({content:'hello',format:'markdown'},new AbortController().signal);
    const dialog=body.children[0];
    if(escape)dialog.dispatchEvent(new Event('cancel',{cancelable:true}));
    else dialog.children[4].dispatchEvent(new Event('click'));
    assert.equal(await result,false);assert.equal(dialog.removed,true);
  }
});
test('unsupported browser and iframe expose no opt-in control',()=>{
  const body=dom();mountWebMcpControl(async()=>{});assert.equal(body.children.length,0);
  document.modelContext={registerTool(){}};window.top={};
  mountWebMcpControl(async()=>{});assert.equal(body.children.length,0);
});
test('opt-in defaults off and synthetic change cannot register tools',async()=>{
  let registered=0;const body=dom({registerTool(){registered++;}});
  mountWebMcpControl(async()=>{});
  const checkbox=body.children[0].children[0];assert.ok(!checkbox.checked);
  checkbox.checked=true;checkbox.dispatchEvent(new Event('change'));
  await Promise.resolve();assert.equal(checkbox.checked,false);assert.equal(registered,0);
});
