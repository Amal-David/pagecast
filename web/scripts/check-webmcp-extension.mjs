import fs from 'node:fs/promises';
import ts from 'typescript';
import path from 'node:path';
if (!process.argv[2]) throw new Error('Pass the path to a checkout of GoogleChromeLabs/webmcp-extension');
import assert from 'node:assert/strict';
async function load(path){const source=await fs.readFile(path,'utf8');const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);}
const google=await load(path.join(process.argv[2], 'extension/sidepanel/services/toolPermissions.ts'));
const pagecast=await load(new URL('../src/lib/webmcp.ts', import.meta.url));
const tools=[];
await pagecast.registerPublishingTools({registerTool:t=>tools.push(t)},new AbortController().signal,{});
for(const alerts of [false,true]) {
 const query={origin:'http://127.0.0.1:4173',toolName:'publish_content',tabId:1,sensitiveActionAlerts:alerts,...tools[1].annotations};
 google.allowToolForSession(query.origin,query.toolName,query.tabId);
 assert.equal(google.needsToolPermission(query),true);
 assert.equal(google.isGrantEligible(query),false);
 assert.equal(google.applyToolPermissionDecision('deny',query),false);
}
assert.equal(google.needsToolPermission({origin:'http://127.0.0.1:4173',toolName:tools[0].name,tabId:1,sensitiveActionAlerts:true,...tools[0].annotations}),false);
console.log('Google extension permission contract: PASS (alerts on/off, standing grant, deny, read-only capability).');
