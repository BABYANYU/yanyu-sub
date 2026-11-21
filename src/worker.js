import assets from './assets.generated.js';
import buildInfo from './build-info.generated.js';
import {validateResolvedSource} from './source-policy.js';
import {convertTexts} from '../public/converter.js';
const LIMIT=1024*1024;
// JSON and short-link responses are never rendered as documents, but they travel
// through the same edge as the UI: ship the restrictive CSP there as well so a
// 404/405/429/503 on any route still carries the full header set.
const CSP_API="default-src 'none'; frame-ancestors 'none'; base-uri 'none'";
const secure={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY','Permissions-Policy':'camera=(), microphone=(), geolocation=()','Content-Security-Policy':CSP_API,'Strict-Transport-Security':'max-age=15552000'};
const rate=new Map();
let lastPrune=0;
function json(body,status=200,extra={}){return Response.json(body,{status,headers:{...secure,...extra}});}
// Cloudflare rejects timers and I/O in the global scope, so prune lazily per request.
function prune(map,window,now){for(const [host,x]of map)if(now-x.start>window)map.delete(host);}
// Buckets are keyed by client address, and an isolate only holds a fixed slice of
// memory, so the table is capped. Once a table is full an unknown address fails
// closed (429) instead of growing the map; keeping live buckets on eviction would
// hand an attacker a way to reset other callers' quotas.
function bucket(map,host,{quota,window,cap}){
 const x=map.get(host);
 if(x&&Date.now()-x.start<window){x.n+=1;return x.n<=quota}
 if(!x&&map.size>=cap)return false;
 map.set(host,{start:Date.now(),n:1});
 return 1<=quota;
}
const RATE_WINDOW=60000, RATE_QUOTA=20, RATE_MAX_BUCKETS=20000;
function limited(host){
 const now=Date.now();if(now-lastPrune>RATE_WINDOW){prune(rate,RATE_WINDOW,now);lastPrune=now}
 return bucket(rate,host,{quota:RATE_QUOTA,window:RATE_WINDOW,cap:RATE_MAX_BUCKETS});
}
// Short subscription hosting (POST /api/publish, GET|HEAD /s/:token, DELETE /api/publish/:token).
// Publishing writes durable state, so it gets its own, much smaller bucket than /api/fetch:
// 15 requests per 5 minutes per CF-Connecting-IP, counted for publish and revoke together.
const PUBLISH_MAX=2*1024*1024;
const PUBLISH_WINDOW=5*60*1000;
const PUBLISH_QUOTA=15;
const PUBLISH_ATTEMPTS=5;
// Publishing writes durable state for a small number of callers, so this table is
// capped far lower than the read-only /api/fetch one.
const PUBLISH_MAX_BUCKETS=1000;
// Loopback is the one exception to the HTTPS-only edge: `wrangler dev` serves plain
// HTTP on it, and it never carries a published link in production.
const LOCAL_HOSTS=new Set(['localhost','127.0.0.1','[::1]','::1']);
// A permanent link never expires, so the only thing that bounds how much one caller
// can park in KV is this per-address cap on live records. 50 is a blunt abuse brake,
// not an entitlement: the page publishes one link per conversion and revoking an old
// one is a single click, so a legitimate caller never comes close.
const OWNER_MAX=100;
// The per-address counter is housekeeping, not data: it lapses after 30 days so an
// address that published once long ago leaves no key behind forever. The records
// themselves are unaffected — a lapsed counter only means the next publish starts
// counting again from what it finds.
const OWNER_TTL=30*24*60*60;
// An expiring record counts while it is live but its KV expiry cannot decrement the
// counter, so a caller who publishes TTL links and never revokes them keeps a high
// count until the counter lapses (at most 30 days after the last publish). Accepted:
// the UI only creates permanent links, and over-counting only ever throttles one
// address instead of letting it grow without bound.
const HEX64=/^[0-9a-f]{64}$/;
// SHA-256 verifier for a randomly generated 256-bit PagerMaid credential.
const PLUGIN_TOKEN_HASH='6c7ccb3018fd066d9a7111bbcd91cdb88bb682a3f08b4938c428caf0ff8a9d67';
const OWNER_LIMIT='短链数量已达上限，请先撤销旧链接';
// KV has no atomic increment or decrement, so the counter below is best-effort: two
// concurrent publishes can both read N and both write N+1, letting one address exceed
// OWNER_MAX by however many requests are in flight, and a counter that lapsed while
// its records survived starts over from the next publish. That makes it a speed bump
// against bulk abuse, never a security boundary and never exact accounting. It is also
// read tolerantly: a missing, empty or malformed key simply means "no count yet", so a
// pruned counter can never break publishing.
async function ownerCount(kv,hash){
 try{const n=Number(await kv.get('own:'+hash));return Number.isFinite(n)&&n>0?Math.floor(n):0}catch{return null}
}
// Decrement is clamped at 0 and swallows its own failures: the record is already gone
// by the time this runs, so bookkeeping must never turn a successful revoke into a 5xx.
async function releaseOwner(kv,hash){
 try{
  const n=Number(await kv.get('own:'+hash));
  const next=Number.isFinite(n)&&n>0?Math.floor(n)-1:0;
  await kv.put('own:'+hash,String(next),{expirationTtl:OWNER_TTL});
 }catch{}
}
// Short links are permanent unless the caller explicitly asks for a TTL; the legacy
// values stay accepted so an older UI (or a script) that still sends ttlSeconds keeps
// working, but omitting the field means "never expires" and skips expirationTtl.
const TTLS=new Set([3600,86400,604800,2592000]);
const TARGETS=new Set(['Surge','Mihomo']);
const TOKEN=/^[A-Za-z0-9]{8}$/;
const ALPHABET='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const publishRate=new Map();
let lastPublishPrune=0;
function publishLimited(host){const now=Date.now();if(now-lastPublishPrune>PUBLISH_WINDOW){prune(publishRate,PUBLISH_WINDOW,now);lastPublishPrune=now}return bucket(publishRate,host,{quota:PUBLISH_QUOTA,window:PUBLISH_WINDOW,cap:PUBLISH_MAX_BUCKETS})}
// 256 is not a multiple of 62, so bytes >= limit are rejected rather than folded in.
function randomToken(){const limit=Math.floor(256/ALPHABET.length)*ALPHABET.length;let out='';while(out.length<8){const buf=new Uint8Array(8);crypto.getRandomValues(buf);for(const b of buf){if(b<limit&&out.length<8)out+=ALPHABET[b%ALPHABET.length]}}return out}
function randomHex(bytes){const buf=new Uint8Array(bytes);crypto.getRandomValues(buf);let out='';for(const b of buf)out+=b.toString(16).padStart(2,'0');return out}
async function sha256Hex(value){const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));let out='';for(const b of digest)out+=b.toString(16).padStart(2,'0');return out}
function equalHex(a,b){if(typeof a!=='string'||typeof b!=='string'||a.length!==64||b.length!==64)return false;let diff=0;for(let i=0;i<64;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);return diff===0}
const shortText=(message,status,extra)=>json({message},status,extra);
const SHORT_DOWN='短链接暂时不可用，请稍后重试';
const SHORT_MISSING='短链接不存在';
function binding(env){const kv=env?.CONFIGS;return kv&&typeof kv.get==='function'&&typeof kv.put==='function'&&typeof kv.delete==='function'?kv:null}
async function handlePublish(request,env,url,plugin=false){
 if(request.method!=='POST')return shortText('请使用 POST 请求',405,{Allow:'POST'});
 if(!request.headers.get('content-type')?.startsWith('application/json')||(!plugin&&request.headers.get('Origin')!==url.origin))return shortText('请求来源不匹配',403);
 if(plugin){
  const token=request.headers.get('Authorization')?.match(/^Bearer ([0-9a-f]{64})$/)?.[1];
  if(!token||!equalHex(await sha256Hex(token),env?.PLUGIN_TOKEN_HASH??PLUGIN_TOKEN_HASH))return shortText('插件令牌无效',401);
 }
 const kv=binding(env);if(!kv)return shortText('短链接服务未配置',503);
 const ip=request.headers.get('CF-Connecting-IP')||'unknown';if(!publishLimited(ip))return shortText('请求过于频繁，请稍后重试',429);
 let text;
 try{text=await limitedText(request,PUBLISH_MAX)}catch(error){
  if(error?.message==='SIZE')return shortText('请求内容超过 2 MiB',413);
  return shortText('请求内容不是有效的 UTF-8 文本',400);
 }
 let data;
 try{data=JSON.parse(text)}catch{return shortText('请求内容不是有效的 JSON',400)}
 if(!data||typeof data!=='object'||Array.isArray(data))return shortText('请求内容不是有效的 JSON 对象',400);
 const sources=plugin&&Array.isArray(data.sources)?data.sources:null;
 let content=data.content;
 if(!sources&&(typeof content!=='string'||!content.trim()))return shortText('配置内容不能为空',422);
 if(typeof data.target!=='string'||!TARGETS.has(data.target))return shortText('输出格式必须是 Surge 或 Mihomo',422);
 let dynamic=false;
 if(sources){
  try{
   if(!sources.length||sources.length>4||sources.some(source=>typeof source!=='string'||!source.trim()))throw Error('SOURCE');
   dynamic=sources.some(isRemoteSource);
   content=await convertPluginSources(sources,data.target,env,url.hostname);
  }catch{return shortText('无法转换订阅，请检查来源及目标格式',422)}
 }
 if(new TextEncoder().encode(content).length>PUBLISH_MAX)return shortText('配置超过 2 MiB',413);
 // Permanent by default: no ttlSeconds means no expirationTtl and expiresAt=null.
 let ttl;
 if(data.ttlSeconds!==undefined){
  if(!TTLS.has(data.ttlSeconds)&&!(plugin&&data.ttlSeconds===365*86400))return shortText('有效期参数不在允许范围内',400);
  ttl=data.ttlSeconds;
 }
 // One address cannot park unbounded permanent state in KV. The count is read before
 // the record is written and bumped after it lands, so a failed write under-counts
 // (absorbed by the cap) instead of inflating the counter.
 let ownerHash;
 try{ownerHash=await sha256Hex(ip)}catch{return shortText(SHORT_DOWN,503)}
 const owned=await ownerCount(kv,ownerHash);
 if(owned===null)return shortText(SHORT_DOWN,503);
 if(owned>=OWNER_MAX)return shortText(OWNER_LIMIT,429);
 // The short token is the only thing in the URL, so it must be unguessable enough
 // that a published profile is not discoverable by enumeration.
 let token='';
 for(let attempt=0;attempt<PUBLISH_ATTEMPTS;attempt+=1){
  const candidate=randomToken();let existing;
  try{existing=await kv.get('s:'+candidate)}catch{return shortText(SHORT_DOWN,503)}
  if(existing===null||existing===undefined){token=candidate;break}
 }
 if(!token)return shortText(SHORT_DOWN,503);
 const manageToken=randomHex(32);
 let manageHash;
 try{manageHash=await sha256Hex(manageToken)}catch{return shortText(SHORT_DOWN,503)}
 const createdAt=new Date();
 const expiresAt=typeof ttl==='number'?new Date(createdAt.getTime()+ttl*1000):null;
 // Only the SHA-256 of the address is stored: the record needs a stable owner handle
 // for its quota counter, never the address itself (no IP, no account, no UA in KV).
 const record={...(dynamic?{sources}:{content}),target:data.target,createdAt:createdAt.toISOString(),expiresAt:expiresAt?expiresAt.toISOString():null,manageHash,ownerHash};
 try{await kv.put('s:'+token,JSON.stringify(record),expiresAt?{expirationTtl:ttl}:{})}catch{return shortText(SHORT_DOWN,503)}
 // Best-effort (see ownerCount): the link is already live and about to be returned, so
 // a counter write that fails only under-counts the address and must not fail the call.
 try{await kv.put('own:'+ownerHash,String(owned+1),{expirationTtl:OWNER_TTL})}catch{}
 return json({url:url.origin+'/s/'+token,expiresAt:expiresAt?expiresAt.toISOString():null,manageToken});
}
async function serveShort(request,env,url){
 if(request.method!=='GET'&&request.method!=='HEAD')return shortText('请求方法不受支持',405,{Allow:'GET, HEAD'});
 const token=url.pathname.slice('/s/'.length);
 // Anything that is not an exact 8-character token is simply "not found": no
 // traversal, no debug text, and no echo of the requested path.
 if(!TOKEN.test(token))return shortText(SHORT_MISSING,404);
 const kv=binding(env);if(!kv)return shortText('短链接服务未配置',503);
 let raw;
 try{raw=await kv.get('s:'+token)}catch{return shortText(SHORT_DOWN,503)}
 if(raw===null||raw===undefined)return shortText(SHORT_MISSING,404);
 let record;
 try{record=JSON.parse(raw)}catch{record=null}
 if(!record||!(typeof record.content==='string'||Array.isArray(record.sources)))return shortText(SHORT_MISSING,404);
 // KV expiry is authoritative. A permanent record stores expiresAt=null and never
 // lapses here; a record with a real timestamp (older data) keeps its original expiry.
 if(typeof record.expiresAt==='string'){
  const expiry=Date.parse(record.expiresAt);
  if(Number.isFinite(expiry)&&expiry<=Date.now())return shortText(SHORT_MISSING,404);
 }
 const headers={'Content-Type':'text/plain; charset=utf-8','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY','X-Robots-Tag':'noindex, nofollow','Content-Security-Policy':CSP_API};
 if(request.method==='HEAD')return new Response(null,{status:200,headers});
 let content=record.content;
 if(Array.isArray(record.sources)){
  if(!limited('short:'+token))return shortText('请求过于频繁，请稍后重试',429);
  try{content=await convertPluginSources(record.sources,record.target,env,url.hostname)}
  catch{return shortText('暂时无法更新上游订阅',502)}
 }
 return new Response(content,{status:200,headers});
}
async function revokeShort(request,env,url,pathToken){
 if(request.method!=='DELETE')return shortText('请求方法不受支持',405,{Allow:'DELETE'});
 if(request.headers.get('Origin')!==url.origin)return shortText('请求来源不匹配',403);
 // Validate the path shape before touching storage so a malformed URL is a plain
 // 404 and never reveals whether the hosting backend is configured.
 // Only the short token addresses a record. A 64-hex manage token in the path (the
 // shape an older UI produced) is a plain 404: accepting it would need a KV list
 // scan per request and would let the secret alone revoke, without proving the
 // caller also holds the short link.
 const token=pathToken;
 if(!TOKEN.test(token))return shortText(SHORT_MISSING,404);
 const kv=binding(env);if(!kv)return shortText('短链接服务未配置',503);
 const ip=request.headers.get('CF-Connecting-IP')||'unknown';if(!publishLimited(ip))return shortText('请求过于频繁，请稍后重试',429);
 let raw;
 try{raw=await kv.get('s:'+token)}catch{return shortText(SHORT_DOWN,503)}
 if(raw===null||raw===undefined)return shortText(SHORT_MISSING,404);
 let record;
 try{record=JSON.parse(raw)}catch{record=null}
 const provided=request.headers.get('X-Manage-Token')||'';
 if(!record||typeof record.manageHash!=='string'||!provided)return shortText('管理令牌无效',403);
 let digest;
 try{digest=await sha256Hex(provided)}catch{return shortText(SHORT_DOWN,503)}
 if(!equalHex(digest,record.manageHash.toLowerCase()))return shortText('管理令牌无效',403);
 try{await kv.delete('s:'+token)}catch{return shortText('撤销失败，请稍后重试',503)}
 // The record is gone, so this returns the caller's budget. Best-effort by design:
 // a legacy record without ownerHash (written before the cap) and a failed counter
 // write both leave the count as-is rather than failing a completed revocation.
 if(record&&typeof record.ownerHash==='string'&&HEX64.test(record.ownerHash))await releaseOwner(kv,record.ownerHash);
 return new Response(null,{status:204,headers:secure});
}
export function validateSource(value,ownHost){
 if(typeof value!=='string'||value.length>8192||/[\u0000-\u0020\\]/u.test(value))throw Error('URL');
 const u=new URL(value);
 if(u.protocol!=='https:'||u.username||u.password||u.hash||(u.port&&u.port!=='443'))throw Error('URL');
 const h=u.hostname.toLowerCase();
 if(h===ownHost||h==='fakeyou.eu.org'||h.endsWith('.fakeyou.eu.org')||h==='localhost'||h.endsWith('.')||h.includes(':')||h.startsWith('[')||/^\d+(?:\.\d+)*$/.test(h)||!h.includes('.')||/\.(?:local|internal|localhost|test|invalid)$/.test(h))throw Error('URL');
 return u;
}
async function limitedText(response,max=LIMIT){
 if(Number(response.headers.get('content-length'))>max)throw Error('SIZE');
 const reader=response.body?.getReader();if(!reader)return '';const chunks=[];let total=0;
 while(true){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>max){await reader.cancel();throw Error('SIZE')}chunks.push(value)}
 const data=new Uint8Array(total);let at=0;for(const c of chunks){data.set(c,at);at+=c.length}return new TextDecoder('utf-8',{fatal:true}).decode(data);
}
function isRemoteSource(source){return /^https?:\/\/\S+$/i.test(source.trim())}
async function readRemoteSource(source,env,ownHost){
 if(env.SKIP_DNS_PREFLIGHT!==true&&env.SKIP_DNS_PREFLIGHT!=='true')await validateResolvedSource(source,{ownHost});
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),10000);
 try{
  const response=await fetch(source.href,{method:'GET',redirect:'manual',signal:controller.signal,headers:{'User-Agent':'Surge/6.0 YanyuSub/1.0','Accept':'text/plain, application/yaml, application/json, */*'},cache:'no-store'});
  if(!response.ok)return {message:response.status>=300&&response.status<400?'订阅链接发生跳转，请填写最终的 HTTPS 地址':'订阅源暂时未返回可用内容'};
  const text=await limitedText(response);
  if(!text.trim())return {message:'订阅源暂时未返回可用内容'};
  if(/^\s*<(?:!doctype|html)/i.test(text))return {message:'来源返回了网页，请检查是否填写订阅链接'};
  return {text};
 }finally{clearTimeout(timer)}
}
async function convertPluginSources(sources,target,env,host){
 const bodies=await Promise.all(sources.map(async value=>{
  if(!isRemoteSource(value))return value;
  const result=await readRemoteSource(validateSource(value.trim(),host),env,host);
  if(typeof result.text!=='string')throw Error('SOURCE');
  return result.text;
 }));
 return convertTexts({target,sources:bodies}).content;
}
export default {async fetch(request,env){
 const url=new URL(request.url);
 // Short links are bearer credentials and the publish/revoke API writes durable state,
 // so no host is served over cleartext: every http request is bounced to the same
 // path and query on https. Loopback is exempt so `wrangler dev` (and the tests that
 // speak HTTP) keep working locally; it never carries a published link in production.
 if(url.protocol==='http:'&&!LOCAL_HOSTS.has(url.hostname.toLowerCase())){const target=new URL(url);target.protocol='https:';return Response.redirect(target.href,301);}
 if(url.pathname==='/api/health')return json({ok:true,engine:'Sub-Store 2.44.16',targets:['Surge','Mihomo'],...buildInfo});
 if(url.pathname==='/api/fetch'){
  if(request.method!=='POST')return json({message:'请使用 POST 请求'},405,{Allow:'POST'});
  if(request.headers.get('Origin')!==url.origin||!request.headers.get('content-type')?.startsWith('application/json'))return json({message:'请求来源不匹配'},403);
  const ip=request.headers.get('CF-Connecting-IP')||'unknown';if(!limited(ip))return json({message:'请求过于频繁，请稍后重试'},429);
  try{
   let text;
   try{text=await limitedText(request,16384)}catch(error){if(error?.message==='SIZE')return json({message:'请求内容过长'},413);throw error}
   const data=JSON.parse(text);const source=validateSource(data.url,url.hostname);
   const result=await readRemoteSource(source,env,url.hostname);
   return json(result,result.message?422:200);
  }catch(error){return json({message:error?.message==='SIZE'?'订阅内容超过 1 MiB':error?.message==='SOURCE_DENIED'?'订阅地址未通过网络策略检查':'订阅读取失败，请检查 HTTPS 链接或粘贴订阅内容'},error?.message==='SIZE'?413:422)}
 }
 if(url.pathname==='/api/publish')return handlePublish(request,env,url);
 if(url.pathname==='/api/plugin/publish')return handlePublish(request,env,url,true);
 if(url.pathname.startsWith('/api/publish/'))return revokeShort(request,env,url,url.pathname.slice('/api/publish/'.length));
 if(url.pathname.startsWith('/s/'))return serveShort(request,env,url);
 if(url.pathname.startsWith('/api/'))return json({message:'接口不存在'},404);
 const item=assets[url.pathname==='/'?'/index.html':url.pathname];if(!item)return json({message:'页面不存在'},404);
 const body=item.base64?Uint8Array.from(atob(item.body),c=>c.charCodeAt(0)):item.body;
 const response=new Response(request.method==='HEAD'?null:body,{headers:{'Content-Type':item.type}});const headers=new Headers(response.headers);
 for(const[k,v]of Object.entries(secure))headers.set(k,v);
 headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
 return new Response(response.body,{status:response.status,headers});
}};
