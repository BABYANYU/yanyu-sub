const base=(process.env.BASE_URL||'https://sub.fakeyou.eu.org').replace(/\/+$/,'');
const healthUrl='https://sub.fakeyou.eu.org/api/health';
if(new URL(healthUrl).origin!==base)throw Error('BASE_URL must match the deployed custom domain');
const expected=process.env.GITHUB_SHA;
if(!expected)throw Error('GITHUB_SHA is required');
const get=(path,options={})=>fetch(base+path,{...options,signal:AbortSignal.timeout(12000),headers:{'Cache-Control':'no-cache',...options.headers}});
let healthy=false;
for(let attempt=0;attempt<12;attempt++){
 try{const response=await get('/api/health');const data=await response.json();if(response.ok&&data.ok&&data.revision===expected){healthy=true;break}}catch{}
 if(attempt<11)await new Promise(r=>setTimeout(r,5000));
}
if(!healthy)throw Error('Live revision was not confirmed; inspect this workflow and Cloudflare deployment');
console.log('Live revision verified: '+expected);

// Static assets are served from the tested build; a stale or missing asset must fail here.
const home=await get('/');
if(home.status!==200||!home.headers.get('content-type')?.includes('text/html'))throw Error('Homepage unavailable');
const html=await home.text();
if(!html.includes('id="convert-form"')||!html.includes('id="source-input"'))throw Error('Homepage markup missing converter contract');
const csp=home.headers.get('content-security-policy')||'';
for(const rule of ["default-src 'self'","script-src 'self'","frame-ancestors 'none'","base-uri 'none'"])if(!csp.includes(rule))throw Error('CSP missing: '+rule);
if(home.headers.get('x-content-type-options')!=='nosniff')throw Error('Missing nosniff');
if(!home.headers.get('referrer-policy'))throw Error('Missing referrer policy');
for(const [path,type]of [['/app.js','javascript'],['/style.css','css'],['/converter.js','javascript']]){
 const response=await get(path,{method:'HEAD'});
 if(response.status!==200)throw Error('Asset unavailable: '+path);
 if(!(response.headers.get('content-type')||'').includes(type))throw Error('Asset content-type mismatch: '+path);
}
const source=await get('/source.tar.gz');
if(source.status!==200||!source.headers.get('content-type')?.includes('gzip'))throw Error('AGPL source archive unavailable');
const magic=new Uint8Array(await source.arrayBuffer()).subarray(0,2);
if(magic[0]!==0x1f||magic[1]!==0x8b)throw Error('AGPL source archive is not gzip');
console.log('Static assets, security headers and source archive verified');

const method=await get('/api/fetch');
if(method.status!==405||(method.headers.get('allow')||'')!=='POST')throw Error('api/fetch must reject GET with 405 and Allow: POST');
const crossSite=await get('/api/fetch',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://example.invalid'},body:JSON.stringify({url:'https://example.com/sub'})});
if(crossSite.status!==403)throw Error('Cross-origin api/fetch must be rejected');
const invalid=await get('/api/fetch',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({url:'not-a-url'})});
if(invalid.status!==422)throw Error('Invalid source URL must be rejected with 422');
const missing=await get('/api/unknown');
if(missing.status!==404)throw Error('Unknown API must return 404');
console.log('API guards verified');
console.log('Deployment verification passed');
