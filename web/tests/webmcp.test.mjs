import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';
const source = await fs.readFile(new URL('../src/lib/webmcp.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { registerPublishingTools } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
async function setup(overrides = {}) {
  const tools = new Map();
  const lifetime = new AbortController();
  const calls = [];
  const deps = {
    confirm: async input => { calls.push(['confirm', input]); return true; },
    publish: async input => { calls.push(['publish', input]); return 'https://example.pages.dev/p/test/'; }, ...overrides
  };
  const context = { registerTool(tool, { signal }) {
    tools.set(tool.name, tool);
    signal.addEventListener('abort', () => tools.delete(tool.name));
  } };
  await registerPublishingTools(context, lifetime.signal, deps);
  const publish = tools.get('publish_content');
  return { tools, lifetime, calls, run: (args = {content:'<h1>hi</h1>', format:'html'}, signal = new AbortController().signal) => publish.execute(args, {signal}) };
}
test('registers only scoped tools, accurate consequential hints and schemas', async () => {
  const {tools} = await setup();
  assert.deepEqual([...tools.keys()], ['get_publish_capabilities', 'publish_content']);
  assert.equal(tools.get('publish_content').annotations.consequentialHint, true);
  assert.equal(tools.get('publish_content').inputSchema.additionalProperties, false);
  assert.equal((await tools.get('get_publish_capabilities').execute()).localFilesAccessible, false);
});
for (const format of ['html','markdown']) test(`confirms exact immutable ${format} before publication`, async () => {
  const {run,calls} = await setup();
  assert.equal((await run({content:'# Hello',format})).status, 'published');
  assert.deepEqual(calls.map(x=>x[0]), ['confirm','publish']);
  assert.equal(calls[0][1], calls[1][1]);
  assert.ok(Object.isFrozen(calls[0][1]));
});
test('refusal never publishes', async () => {
  const {run,calls} = await setup({confirm:async()=>false});
  assert.equal((await run()).code,'DECLINED'); assert.deepEqual(calls,[]);
});
test('invalid, oversized byte payloads and paths are refused before confirmation', async () => {
  const {run,calls} = await setup();
  for(const input of [null, {}, {content:' ',format:'html'}, {content:'ok',format:'svg'}, {content:'é'.repeat(32769),format:'html'}, {content:'ok',format:'html',path:'/tmp/private'}])
    assert.equal((await run(input)).code,'INVALID_INPUT');
  assert.deepEqual(calls,[]);
});
test('failure does not leak server errors or claim publication', async () => {
  const {run} = await setup({publish:async()=>{throw Error('/private/token');}});
  const result = await run(); assert.equal(result.code,'PUBLISH_FAILED');
  assert.ok(!JSON.stringify(result).includes('/private'));
});
test('opt-out during confirmation prevents publication and removes discovery', async () => {
  let s;
  s=await setup({confirm:async()=>{s.lifetime.abort();return true;}});
  assert.equal((await s.run()).code,'CANCELLED'); assert.equal(s.tools.size,0); assert.deepEqual(s.calls,[]);
  assert.equal((await s.run()).code,'DISABLED');
});
test('agent cancellation prevents publication', async () => {
  const c = new AbortController(); c.abort();
  const {run,calls}=await setup(); assert.equal((await run(undefined,c.signal)).code,'CANCELLED'); assert.deepEqual(calls,[]);
});
test('concurrent calls cannot reuse a confirmation', async () => {
  let approve;
  const s=await setup({confirm:()=>new Promise(resolve=>{approve=resolve;})});
  const first=s.run(); assert.equal((await s.run()).code,'BUSY'); approve(true);
  assert.equal((await first).status,'published'); assert.equal(s.calls.length,1);
});
test('partial registration failures can be cleaned up by owner', async () => {
  const c=new AbortController();let count=0;
  await assert.rejects(registerPublishingTools({registerTool(){if(++count===2)throw Error('unavailable');}},c.signal,{}));
  c.abort(); assert.equal(count,2);
});
