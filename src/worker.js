import assets from './assets.generated.js';
import buildInfo from './build-info.generated.js';
import {validateResolvedSource} from './source-policy.js';
const LIMIT=1024*1024;
const secure={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY','Permissions-Policy':'camera=(), microphone=(), geolocation=()'};
const rate=new Map();
let lastPrune=0;
function json(body,status=200){return Response.json(body,{status,headers:secure});}
// Cloudflare rejects timers and I/O in the global scope, so prune lazily per request.
function prune(now){for(const [host,x]of rate)if(now-x.start>60000)rate.delete(host);lastPrune=now}
function limited(host){const now=Date.now();if(now-lastPrune>60000)prune(now);const x=rate.get(host)||{start:now,n:0};if(now-x.start>=60000){x.start=now;x.n=0}x.n++;rate.set(host,x);return x.n<=10}
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
export default {async fetch(request,env){
 const url=new URL(request.url);
 if(url.pathname==='/api/health')return json({ok:true,engine:'Sub-Store 2.44.16',targets:['Surge','Mihomo'],...buildInfo});
 if(url.pathname==='/api/fetch'){
  if(request.method!=='POST')return json({message:'请使用 POST 请求'},405);
  const ip=request.headers.get('CF-Connecting-IP')||'unknown';if(!limited(ip))return json({message:'请求过于频繁，请稍后重试'},429);
  if(request.headers.get('Origin')!==url.origin||!request.headers.get('content-type')?.startsWith('application/json'))return json({message:'请求来源不匹配'},403);
  try{
   const text=await limitedText(request,16384);const data=JSON.parse(text);const source=validateSource(data.url,url.hostname);
   if(env.SKIP_DNS_PREFLIGHT!==true&&env.SKIP_DNS_PREFLIGHT!=='true')await validateResolvedSource(source,{ownHost:url.hostname});
   const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),10000);
   try{
    const response=await fetch(source.href,{method:'GET',redirect:'manual',signal:controller.signal,headers:{'User-Agent':'Surge/6.0 YanyuSub/1.0','Accept':'text/plain, application/yaml, application/json, */*'},cache:'no-store'});
    if(!response.ok)return json({message:response.status>=300&&response.status<400?'订阅链接发生跳转，请填写最终的 HTTPS 地址':'订阅源暂时未返回可用内容'},422);
    const body=await limitedText(response);if(/^\s*<(?:!doctype|html)/i.test(body))return json({message:'来源返回了网页，请检查是否填写订阅链接'},422);
    return json({text:body});
   }finally{clearTimeout(timer)}
  }catch(error){return json({message:error?.message==='SIZE'?'订阅内容超过 1 MiB':error?.message==='SOURCE_DENIED'?'订阅地址未通过网络策略检查':'订阅读取失败，请检查 HTTPS 链接或粘贴订阅内容'},error?.message==='SIZE'?413:422)}
 }
 if(url.pathname.startsWith('/api/'))return json({message:'接口不存在'},404);
 const item=assets[url.pathname==='/'?'/index.html':url.pathname];if(!item)return json({message:'页面不存在'},404);
 const body=item.base64?Uint8Array.from(atob(item.body),c=>c.charCodeAt(0)):item.body;
 const response=new Response(request.method==='HEAD'?null:body,{headers:{'Content-Type':item.type}});const headers=new Headers(response.headers);
 for(const[k,v]of Object.entries(secure))headers.set(k,v);
 headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
 return new Response(response.body,{status:response.status,headers});
}};
