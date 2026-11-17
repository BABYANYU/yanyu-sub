import {test} from 'node:test';import assert from 'node:assert/strict';import {parse}from'yaml';
import {convertTexts,parseInput}from'../public/converter.js';
const uri='trojan://fixture-pass@node.example.com:443?sni=tls.example.com#Test';
const reality=`proxies:\n  - {name: Reality, type: vless, server: node.example.com, port: 443, uuid: 00000000-0000-4000-8000-000000000001, tls: true, flow: xtls-rprx-vision, servername: tls.example.com, reality-opts: {public-key: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA, short-id: "0001"}}`;
for(const target of ['Surge','Mihomo']){
 test(target+' URI conversion',()=>{const r=convertTexts({target,sources:[uri]});assert.equal(r.count,1);assert.match(r.content,/223\.5\.5\.5/);assert.match(r.content,target==='Surge'?/FINAL,Proxy/:/MATCH,Proxy/);assert.doesNotMatch(r.content,/url-test|fallback/)});
 test(target+' REALITY preserved',()=>{const r=convertTexts({target,sources:[reality]});assert.equal(r.count,1);if(target==='Surge'){assert.match(r.content,/reality-short-id=0001/);assert.match(r.content,/sni="?tls.example.com/)}else{const c=parse(r.content);assert.equal(c.proxies[0]['reality-opts']['short-id'],'0001');assert.deepEqual(c.rules,['GEOIP,cn,DIRECT','MATCH,Proxy']);assert.equal(c['proxy-groups'].length,1)}});
}
for(const type of ['anytls','hysteria2','tuic'])for(const target of ['Surge','Mihomo'])test(`${target} ${type} credentials preserved`,()=>{const node={name:'Fixture',type,server:'node.example.com',port:443,password:'pass:@#%中',sni:'tls.example.com'};if(type==='tuic')node.uuid='00000000-0000-4000-8000-000000000001';const r=convertTexts({target,sources:[JSON.stringify({proxies:[node]})]});assert.equal(r.count,1);if(target==='Mihomo')assert.equal(parse(r.content).proxies[0].password,node.password);else {const parsed=parseInput(r.content);assert.equal(parsed[0].password,node.password)}});
test('base64 input',()=>assert.equal(parseInput(Buffer.from(uri).toString('base64')).length,1));
test('unknown node fails without dropping',()=>assert.throws(()=>convertTexts({target:'Surge',sources:[uri+'\nunknown://user@node.example.com:443']})));
test('AnyTLS Reality rejects',()=>assert.throws(()=>convertTexts({target:'Mihomo',sources:['proxies:\n- {name: bad, type: anytls, server: a.example.com, port: 443, password: fixture, reality-opts: {public-key: xxx}}']})));
test('node control character rejects',()=>assert.throws(()=>convertTexts({target:'Surge',sources:[uri.replace('#Test','#bad%0A%5BRule%5D')]})));
test('duplicate names unique',()=>{const c=parse(convertTexts({target:'Mihomo',sources:[uri,uri]}).content);assert.equal(new Set(c.proxies.map(n=>n.name)).size,2)});
const node=o=>JSON.stringify({proxies:[{name:'N',type:'trojan',server:'node.example.com',port:443,password:'fixture',...o}]});
test('Surge ws-path separator injection blocked',()=>assert.throws(()=>convertTexts({target:'Surge',sources:[node({network:'ws','ws-opts':{path:'/,skip-cert-verify=true'}})]}),/分隔符/));
test('Surge test-url separator injection blocked',()=>assert.throws(()=>convertTexts({target:'Surge',sources:[node({'test-url':'https://example.com/,skip-cert-verify=true'})]}),/Surge/));
test('AnyTLS TLS plugin chain blocked instead of dropped',()=>assert.throws(()=>convertTexts({target:'Surge',sources:[node({type:'anytls',plugin:'shadow-tls','plugin-opts':{version:3,password:'f',host:'front.example.com'}})]}),/插件/));
test('cross-node dependency blocked on both targets',()=>{for(const t of ['Surge','Mihomo'])assert.throws(()=>convertTexts({target:t,sources:[node({'dialer-proxy':'Upstream'})]}),/依赖/)});
test('built-in Surge policy name is renamed',()=>{const c=convertTexts({target:'Surge',sources:[node({name:'REJECT-DROP'})]}).content;assert.match(c,/REJECT-DROP 节点=vless|REJECT-DROP 节点=trojan/)});
test('boolean field smuggling blocked',()=>assert.throws(()=>convertTexts({target:'Surge',sources:[node({tfo:'true,skip-cert-verify=true'})]}),/布尔/));
