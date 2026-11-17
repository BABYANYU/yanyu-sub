import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import peggy from 'peggy';
const source=process.env.SUBSTORE_SOURCE || '../sub-store-engine-20261117/backend/src';
const dest='vendor/sub-store';
await fs.mkdir(dest,{recursive:true});
for(const item of ['core/proxy-utils/parsers','core/proxy-utils/producers','core/proxy-utils/preprocessors','core/proxy-utils/xhttp-utils.js','core/proxy-utils/surge-xhttp.js','core/proxy-utils/transport-path.js','core/proxy-utils/ech-utils.js','core/proxy-utils/vmess-security.js','utils/index.js','utils/yaml.js']){
  const to=path.join(dest,item);await fs.mkdir(path.dirname(to),{recursive:true});await fs.cp(path.join(source,item),to,{recursive:true});
}
for(const name of ['surge','loon','qx']){
 const file=path.join(dest,'core/proxy-utils/parsers/peggy',name+'.js');let text=await fs.readFile(file,'utf8');
 const start=text.indexOf('const grammars = ');const end=text.indexOf('\nlet parser;',start);
 if(start<0||end<0)throw Error('Unrecognized grammar '+name);
 const expr=text.slice(start,end).replace('const grammars = ','').trim().replace(/;$/,'');
 const grammar=vm.runInNewContext(expr,{String});
 const generated=peggy.generate(grammar,{output:'source',format:'es'});
 const genFile=path.join(path.dirname(file),name+'.generated.js');await fs.writeFile(genFile,generated);
 text=text.replace(/import peggy from 'peggy';/,`import * as generated from './${name}.generated.js';`);
 const s=text.indexOf('const grammars = ');const e=text.indexOf('\nlet parser;',s);text=text.slice(0,s)+text.slice(e);
 text=text.replace('const generated = peggy.generate(grammars);','').replace('parser = peggy.generate(grammars);','parser = generated;');
 await fs.writeFile(file,text);
}
await fs.copyFile('../sub-store-engine-20261117/LICENSE','LICENSE');
await fs.writeFile('vendor/UPSTREAM.json',JSON.stringify({project:'Sub-Store',repository:'https://github.com/sub-store-org/Sub-Store',commit:'2a173b88dcbd7d232864f05087998855da59eec1',version:'2.44.16',license:'AGPL-3.0',notes:'Parser/producer subset. Peggy compiled at build time. Runtime app logging replaced; no script operators or remote include execution.'},null,2));
console.log('Pinned conversion source and precompiled grammars ready');
