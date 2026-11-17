import fs from 'node:fs/promises';
import path from 'node:path';
import {gzipSync}from'node:zlib';
const selected=['.gitignore','.github','LICENSE','NOTICE.md','README.md','CHANGELOG.md','docs','package.json','package-lock.json','wrangler.json','src','scripts','test','vendor','public/index.html','public/app.js','public/style.css'];
const excluded=new Set(['src/assets.generated.js','src/build-info.generated.js','scripts/deploy-browser.cjs','scripts/browser-test.cjs']);
const files=[];
async function walk(p){let stat;try{stat=await fs.lstat(p)}catch(e){if(e.code==='ENOENT')return;throw e}if(stat.isSymbolicLink())throw Error('Source archive does not include symlinks');if(stat.isDirectory()){for(const n of(await fs.readdir(p)).sort())await walk(p+'/'+n)}else if(!excluded.has(p))files.push(p)}
for(const p of selected)await walk(p);
const blocks=[];
for(const p of files){const body=await fs.readFile(p);const header=Buffer.alloc(512);const name=p.replaceAll('\\','/');let leaf=name,prefix='';if(Buffer.byteLength(name)>100){const cut=name.lastIndexOf('/');prefix=name.slice(0,cut);leaf=name.slice(cut+1);if(Buffer.byteLength(prefix)>155||Buffer.byteLength(leaf)>100)throw Error('Archive path too long')}
 header.write(leaf,0,100);const oct=(n,size)=>n.toString(8).padStart(size-1,'0')+'\0';header.write(oct(0o644,8),100);header.write(oct(0,8),108);header.write(oct(0,8),116);header.write(oct(body.length,12),124);header.write(oct(0,12),136);header.fill(32,148,156);header.write('0',156);header.write('ustar\0',257);header.write('00',263);header.write(prefix,345,155);let sum=0;for(const b of header)sum+=b;header.write(sum.toString(8).padStart(6,'0')+'\0 ',148,8);blocks.push(header,body,Buffer.alloc((512-body.length%512)%512));}
blocks.push(Buffer.alloc(1024));await fs.mkdir('public',{recursive:true});await fs.writeFile('public/source.tar.gz',gzipSync(Buffer.concat(blocks),{level:9}));console.log(`Packaged ${files.length} corresponding source files (no credentials or generated bundles)`);
