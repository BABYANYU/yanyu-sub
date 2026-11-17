import {Base64} from 'js-base64';
import {parseDocument,stringify,visit,isAlias} from 'yaml';
import PARSERS from '../vendor/sub-store/core/proxy-utils/parsers/index.js';
import SurgeProducer from '../vendor/sub-store/core/proxy-utils/producers/surge.js';
import MihomoProducer from '../vendor/sub-store/core/proxy-utils/producers/clashmeta.js';
import {lastParse} from '../vendor/normalizer.js';

const MAX_BYTES=1024*1024, MAX_NODES=2000;
const supported=new Set(['ss','ssr','vmess','vless','trojan','anytls','hysteria2','hysteria','tuic','socks5','http','snell','wireguard']);
const blocked=new Set(['__proto__','prototype','constructor']);
// Surge built-in policy names may not be redefined as node names.
const RESERVED=new Set(['DIRECT','REJECT','REJECT-DROP','REJECT-NO-DROP','REJECT-TINYGIF','CELLULAR','CELLULAR-ONLY','HYBRID','NO-HYBRID','Proxy']);
// Fields the Surge producer writes without surrounding quotes.
const UNQUOTED=new Set(['ws-opts.path','ws-opts.headers','grpc-opts.grpc-service-name','xhttp-opts.path','uuid','token','reality-opts.short-id','reality-opts.public-key','obfs','obfs-password','plugin-opts.password','plugin-opts.host','obfs-opts.password','obfs-opts.host','servername','test-url']);
// Boolean-like parameters the Surge producer writes inline; a string value can smuggle another option.
const BOOL_FIELDS=new Set(['tfo','udp','tls','skip-cert-verify','reuse','block-quic','ecn','hybrid','vmess-aead','ws','ws-http-upgrade','grpc','xhttp','xudp','tls-fingerprint','udp-relay']);
export class ConversionError extends Error{constructor(message){super(message);this.name='ConversionError'}}
function bad(message){throw new ConversionError(message)}
function checkTree(obj,depth=0){
 if(depth>20)bad('配置嵌套过深');
 if(typeof obj==='string'&&/[\r\n\u0000-\u001f\u007f\u2028\u2029]/u.test(obj))bad('节点参数含控制字符，请检查来源');
 if(obj&&typeof obj==='object'){for(const [k,v] of Object.entries(obj)){if(blocked.has(k))bad('来源含不安全字段');checkTree(v,depth+1)}}
}
function yamlLoad(raw){
 const doc=parseDocument(raw,{uniqueKeys:true,merge:false,logLevel:'silent'});
 if(doc.errors.length)bad('YAML 格式错误或键名重复');
 visit(doc,{Node(_,node){if(isAlias(node)||node.anchor)bad('请展开 YAML 引用后再转换')}});
 return doc.toJS({maxAliasCount:0});
}
function parseOne(line,index){
 if(line.length>32768)bad(`第 ${index+1} 行过长`);
 for(const parser of PARSERS){if(!parser.test(line))continue;try{return lastParse(parser.parse(line))}catch{}}
 bad(`第 ${index+1} 个节点格式无效或协议暂不支持`);
}
export function parseInput(text){
 let raw=String(text).replace(/^\uFEFF/,'').trim();
 if(!raw)bad('请填写订阅内容');if(new TextEncoder().encode(raw).length>MAX_BYTES)bad('每个来源最多 1 MiB');
 if(!raw.includes('://')&&!raw.includes(':')&&/^[A-Za-z0-9+/_=\s-]+$/.test(raw)){
   try{raw=Base64.decode(raw.replace(/\s/g,''))}catch{bad('Base64 订阅编码无效')}
 }
 if(new TextEncoder().encode(raw).length>MAX_BYTES)bad('解码后来源过大');
 let nodes;
 if(/^\s*(?:proxies\s*:|\[\s*\{|\{\s*"?proxies|-[ \t]+(?:\{|name:))/m.test(raw)){
   const data=yamlLoad(raw);nodes=Array.isArray(data)?data:data?.proxies;
   if(!Array.isArray(nodes))bad('配置缺少内联 proxies 节点');
   nodes=nodes.map((p,i)=>{checkTree(p);return parseOne(JSON.stringify(p),i)});
 }else{
   let lines=raw.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
   if(lines.some(s=>/^\[Proxy\]$/i.test(s))){let section='';lines=lines.filter(s=>{if(/^\[.*\]$/.test(s)){section=s.toLowerCase();return false}return section==='[proxy]'&&!s.startsWith('#')});}
   else lines=lines.filter(s=>!s.startsWith('#'));
   nodes=lines.map(parseOne);
 }
 if(!nodes.length)bad('没有找到可转换的节点；外部 provider 请先导出节点内容');
 if(nodes.length>MAX_NODES)bad(`节点数量最多 ${MAX_NODES} 个`);
 return nodes;
}
function normalize(p,i){
 const n=structuredClone(p);checkTree(n);
 n.type=String(n.type||'').toLowerCase();if(n.type==='hy2')n.type='hysteria2';
 if(!supported.has(n.type))bad(`第 ${i+1} 个节点协议不支持`);
 n.server=String(n.server||'').replace(/^\[|\]$/g,'');n.port=Number(n.port);
 if(!n.server||/[\s,=;"'|\[\]\/\\?#]/u.test(n.server)||!Number.isInteger(n.port)||n.port<1||n.port>65535)bad(`第 ${i+1} 个节点缺少有效地址或端口`);
 if(n.uuid&&/[\s,=;"'|\r\n]/u.test(String(n.uuid)))bad(`第 ${i+1} 个节点用户 ID 含配置分隔符`);
 n.name=String(n.name||`节点 ${i+1}`).trim();if(!n.name||n.name.length>120)bad(`第 ${i+1} 个节点名称无效`);
 // Surge policy/group names have structural delimiters; use explicit safe aliases.
 n.name=n.name.replace(/[,=;"'\[\]|#]/g,' ').replace(/\s+/g,' ').trim()||`节点 ${i+1}`;
 if(RESERVED.has(n.name))n.name+=' 节点';
 if(['vless','vmess'].includes(n.type)){if(!n.uuid)bad(`第 ${i+1} 个节点缺少用户 ID`);n.network ||= 'tcp';n.sni ||= n.servername;}
 if(['trojan','anytls','hysteria2','tuic'].includes(n.type))n.tls=true;
 if(n.type==='trojan')n.network ||= 'tcp';
 if(n.type==='vmess'){n.cipher ||= 'auto';n.alterId ??= 0;}
 if(n['reality-opts']){
   if(n.type!=='vless')bad(`第 ${i+1} 个节点的 REALITY 组合不受支持`);
   const r=n['reality-opts'];if(typeof r['public-key']!=='string'||!r['public-key'])bad('REALITY 公钥缺失');
   if(r['short-id']!==undefined&&(typeof r['short-id']!=='string'||!/^(?:[0-9a-fA-F]{2}){0,8}$/.test(r['short-id'])))bad('REALITY short-id 必须是带引号的十六进制字符串');
   n.tls=true;n['client-fingerprint'] ||= 'chrome';
 }
 if(n.type==='tuic'&&n.token&&(n.uuid||n.password))bad('TUIC v4 与 v5 认证字段不能混合');
 // The generated profile contains exactly one select group, so cross-node references cannot survive.
 if(n['dialer-proxy']||n['underlying-proxy'])bad(`第 ${i+1} 个节点依赖其他策略，当前单组模板无法保留该引用`);
 return n;
}
function surgeGuard(n){
 if(n.type==='ssr'||n.type==='hysteria'||n.type==='wireguard')bad(`节点“${n.name}”暂不支持输出 Surge`);
 if(n['ech-opts']||n.smux||n['dialer-proxy']||n['underlying-proxy'])bad(`节点“${n.name}”含依赖其他策略或目标不兼容参数`);
 if(n.type==='anytls'&&(n.plugin||n['plugin-opts']||n['shadow-tls-opts']||n['restls-opts']||n['jls-opts']))bad(`节点“${n.name}”的 TLS 伪装插件在 Surge 无等值配置`);
 if(n.type==='anytls'&&(n['reality-opts']||['idle-session-check-interval','idle-session-timeout','min-idle-session','client-metadata'].some(k=>n[k]!==undefined)))bad(`节点“${n.name}”的 AnyTLS 会话参数在 Surge 无等值配置`);
 if(n.type==='hysteria2'&&n.obfs==='salamander')bad(`节点“${n.name}”使用的 Salamander 混淆未在 Surge iOS 文档中提供支持`);
 if(n.type==='vless'&&n.network==='grpc'&&n.flow)bad(`节点“${n.name}”不能同时使用 gRPC 和 Vision`);
 if(n['xhttp-opts']?.['download-settings'])bad(`节点“${n.name}”的 XHTTP 分离下载配置不受 Surge 支持`);
 if(n.type==='vless'&&['xtls-rprx-vision','xtls-rprx-vision-udp443'].includes(n.flow)===false&&n.flow)bad(`节点“${n.name}”的 flow 取值不受支持`);
 // The upstream producer writes many parameters unquoted; structure separators must not reach the profile.
 function walk(v,path){
  if(typeof v==='string'&&path!=='name'){
   if(/[\r\n\u0000-\u001f\u007f\u2028\u2029\\"]/u.test(v))bad(`节点“${n.name}”的参数无法安全写入 Surge`);
   if(UNQUOTED.has(path)&&/[,=]/u.test(v))bad(`节点“${n.name}”的 ${path} 含 Surge 结构分隔符`);
   if(BOOL_FIELDS.has(path)&&!['true','false'].includes(v))bad(`节点“${n.name}”的 ${path} 必须是布尔值`);
  }
  if(v&&typeof v==='object')for(const [k,val]of Object.entries(v))walk(val,path?`${path}.${k}`:k);
 }
 walk(n,'');
}
// Parameters that decide whether the connection is verified and whom it talks to.
const CRITICAL_FIELDS=['skip-cert-verify','tls','sni','servername','server','port','password','uuid','token','encrypt-method','username','underlying-proxy','interface','block-quic','obfs','obfs-password'];
// Re-read the produced line and refuse any option the source did not ask for.
function verifySurgeLine(node,line){
 let parsed;
 try{parsed=lastParse(PARSERS.find(p=>p.test(line)).parse(line))}catch{bad(`节点“${node.name}”的输出无法被解析，已停止导出`)}
 const before=key=>key.startsWith('reality-')?node['reality-opts']?.[key.slice(8)]:node[key];
 for(const key of CRITICAL_FIELDS){
  const a=before(key),b=parsed[key];
  if(a===undefined&&b===undefined)continue;
  if(String(a??'')!==String(b??''))bad(`节点“${node.name}”的 ${key} 在输出中发生异常变化`);
 }
 if(parsed['skip-cert-verify']===true&&node['skip-cert-verify']!==true)bad(`节点“${node.name}”的输出被注入了证书校验开关`);
}
// A quoted value must end the parameter: anything but a comma after the closing quote is malformed.
function checkQuoting(line,name){
 for(let p=0;p<line.length;p++){
  if(line[p]!=='"')continue;
  const close=line.indexOf('"',p+1);
  if(close<0)bad(`节点“${name}”的输出引号未闭合`);
  const next=line[close+1];
  if(next!==undefined&&next!==','&&!/\s/u.test(next))bad(`节点“${name}”的输出引号结构异常`);
  p=close;
 }
}
export function convertTexts({target,sources}){
 if(!['Surge','Mihomo'].includes(target))bad('仅支持 Surge 或 Mihomo');
 if(!Array.isArray(sources)||!sources.length||sources.length>4)bad('请填写 1–4 个订阅来源');
 const nodes=sources.flatMap(parseInput).map(normalize);if(nodes.length>MAX_NODES)bad('合并后的节点过多');
 const names=new Set();const warnings=[];
 nodes.forEach(n=>{const orig=n.name;let suffix=2;while(names.has(n.name))n.name=`${orig} ${suffix++}`;names.add(n.name)});
 let content;
 if(target==='Mihomo'){
  const result=MihomoProducer().produce(structuredClone(nodes),'internal',{});
  if(!Array.isArray(result)||result.length!==nodes.length)bad('存在 Mihomo 不支持的节点，已停止导出，未静默删除节点');
  content=stringify({'mixed-port':7890,'allow-lan':false,mode:'rule','log-level':'info',ipv6:false,dns:{enable:true,nameserver:['223.5.5.5']},proxies:result,'proxy-groups':[{name:'Proxy',type:'select',proxies:result.map(n=>n.name)}],rules:['GEOIP,cn,DIRECT','MATCH,Proxy']},{lineWidth:0});
 }else{
  const prod=SurgeProducer();const lines=nodes.map(n=>{surgeGuard(n);let line;try{line=prod.produce(structuredClone(n),'text',{})}catch{bad(`节点“${n.name}”有 Surge 不支持的协议或参数，请检查来源`)}if(!line||/[\r\n]/.test(line))bad('节点输出无效');checkQuoting(line,n.name);verifySurgeLine(n,line);return line});
  content=['[General]','dns-server = 223.5.5.5','ipv6 = false','','[Proxy]',...lines,'','[Proxy Group]',`Proxy = select, ${nodes.map(n=>n.name).join(', ')}`,'','[Rule]','GEOIP,CN,DIRECT','FINAL,Proxy',''].join('\n');
 }
 if(new TextEncoder().encode(content).length>4*MAX_BYTES)bad('生成配置过大');
 return {content,count:nodes.length,warnings};
}
export async function convertSources({target,sources}){
 const bodies=[];for(const [index,source]of sources.entries()){
  const text=String(source).trim();
  if(/^https?:\/\/[^\s]+$/.test(text)){
   const r=await fetch('/api/fetch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:text}),credentials:'same-origin',cache:'no-store',referrerPolicy:'no-referrer'});
   const data=await r.json();if(!r.ok)bad(data.message||`订阅 ${index+1} 读取失败`);bodies.push(data.text);
  }else bodies.push(text);
 }
 return convertTexts({target,sources:bodies});
}
