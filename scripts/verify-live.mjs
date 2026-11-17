const expected=process.env.GITHUB_SHA;
if(!expected)throw Error('GITHUB_SHA is required');
for(let attempt=0;attempt<12;attempt++){
 try{const response=await fetch('https://sub.fakeyou.eu.org/api/health',{signal:AbortSignal.timeout(10000),headers:{'Cache-Control':'no-cache'}});const data=await response.json();if(response.ok&&data.ok&&data.revision===expected){console.log('Live revision verified: '+expected);process.exit(0)}}catch{}
 if(attempt<11)await new Promise(resolve=>setTimeout(resolve,5000));
}
throw Error('Live revision was not confirmed; inspect this workflow and Cloudflare deployment');
