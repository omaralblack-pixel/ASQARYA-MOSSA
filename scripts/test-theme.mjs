import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {dirname,resolve} from 'node:path';
import ts from 'typescript';

const cache=new Map();
function load(file){
 file=resolve(file);if(cache.has(file))return cache.get(file);
 const exports={};cache.set(file,exports);
 const js=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 new Function('exports','require',js)(exports,name=>name.startsWith('.')?load(resolve(dirname(file),name+'.ts')):createRequire(file)(name));
 return exports;
}
const {themeRuntimeScript}=load('lib/theme.ts');
function browser({saved=null,systemDark=false,blockedStorage=false}={}){
 const events={},store=new Map(saved===null?[]:[['institution-theme',saved]]);
 const classes=new Set(),root={dataset:{},style:{},classList:{toggle:(name,on)=>on?classes.add(name):classes.delete(name)}};
 class Element{constructor(toggle=false){this.toggle=toggle}closest(selector){return this.toggle&&selector==='[data-theme-toggle]'?this:null}}
 const media={matches:systemDark,addEventListener:(name,fn)=>{events.media=fn}};
 const context={Element,document:{documentElement:root,addEventListener:(name,fn)=>{events[name]=fn}},
  window:{addEventListener:(name,fn)=>{events[name]=fn}},matchMedia:()=>media,
  localStorage:{getItem:key=>{if(blockedStorage)throw Error('blocked');return store.get(key)??null},
   setItem:(key,value)=>{if(blockedStorage)throw Error('blocked');store.set(key,value)}}};
 vm.runInNewContext(themeRuntimeScript,context);
 return {root,store,classes,click:()=>events.click({target:new Element(true)}),
  unrelatedClick:()=>events.click({target:new Element(false)}),
  system:dark=>{media.matches=dark;events.media()},storage:(value,key='institution-theme')=>events.storage({key,newValue:value})};
}
const fresh=browser();assert.equal(fresh.root.dataset.theme,'light');
fresh.system(true);assert.equal(fresh.root.dataset.theme,'dark');
fresh.click();assert.equal(fresh.root.dataset.theme,'light');assert.equal(fresh.store.get('institution-theme'),'light');
fresh.system(true);assert.equal(fresh.root.dataset.theme,'light','Explicit choice must survive system changes');
fresh.unrelatedClick();assert.equal(fresh.root.dataset.theme,'light');
const persisted=browser({saved:'dark'});assert.equal(persisted.root.dataset.theme,'dark');assert.ok(persisted.classes.has('dark'));
assert.equal(persisted.root.style.colorScheme,'dark','Native date/select controls follow the chosen appearance');
persisted.storage('light');assert.equal(persisted.root.dataset.theme,'light');assert.ok(!persisted.classes.has('dark'));
persisted.storage('dark','unrelated-setting');assert.equal(persisted.root.dataset.theme,'light');
persisted.system(true);persisted.storage(null);assert.equal(persisted.root.dataset.theme,'dark','Cleared preference returns to system appearance');
assert.equal(browser({saved:'invalid',systemDark:true}).root.dataset.theme,'dark');
const blocked=browser({blockedStorage:true,systemDark:true});blocked.click();assert.equal(blocked.root.dataset.theme,'light');
blocked.system(true);assert.equal(blocked.root.dataset.theme,'light','Unavailable storage must not crash switching or forget the current choice');

// Verify the actual dark palette's readable text against every status surface.
const css=fs.readFileSync('app/theme.css','utf8');
const palette=Object.fromEntries([...css.matchAll(/--theme-([\w-]+):\s*(#[\da-f]{6})/g)].map(m=>[m[1],m[2]]));
function luminance(hex){return [1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0)}
function contrast(a,b){const [lo,hi]=[luminance(a),luminance(b)].sort((a,b)=>a-b);return (hi+.05)/(lo+.05)}
for(const foreground of ['text','secondary','muted'])for(const background of ['canvas','surface','surface-soft','surface-hover'])
 assert.ok(contrast(palette[foreground],palette[background])>=4.5,foreground+' must be readable on '+background);
for(const status of ['info','success','warning','danger'])
 assert.ok(contrast(palette[status+'-text'],palette[status+'-surface'])>=4.5,status+' status text must remain readable');
for(const surface of ['surface','surface-soft'])
 assert.ok(contrast(palette['control-border'],palette[surface])>=3,'Form boundaries must remain visible on '+surface);
assert.ok(/@media print\s*\{\s*:root\s*\{\s*color-scheme:\s*light\s*!important/.test(css),'Print must force the original light palette regardless of saved theme');

// Login keeps the same preference while permitting only its nonce-bound script.
const {handleInstitution}=load('worker/institution.ts');
const env={INSTITUTION_PASSWORD:'local-test-only',INSTITUTION_SESSION_SECRET:'test-only-'.repeat(5)};
const login=await handleInstitution(new Request('https://example.test/login'),env);
assert.equal(login.status,200);
const html=await login.text(),csp=login.headers.get('Content-Security-Policy');
const nonce=html.match(/<script nonce="([^"]+)"/)[1];
assert.ok(csp.includes("script-src 'nonce-"+nonce+"'"));
assert.ok(!csp.match(/script-src[^;]*unsafe-inline/));
assert.ok(csp.includes("form-action 'self'")&&csp.includes("frame-ancestors 'none'"));
assert.ok(html.includes(themeRuntimeScript)&&html.includes('data-theme-toggle'));
const next=await handleInstitution(new Request('https://example.test/login'),env);
assert.notEqual((await next.text()).match(/<script nonce="([^"]+)"/)[1],nonce);
console.log('PASS: pre-paint theme, persistence, system preference, cross-tab changes, blocked storage, WCAG AA dark palette, light printing and nonce-protected login.');
