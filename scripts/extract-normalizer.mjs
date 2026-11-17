import fs from 'node:fs/promises';
const original=await fs.readFile('../sub-store-engine-20261117/backend/src/core/proxy-utils/index.js','utf8');
const start=original.indexOf('function formatTransportPath(');
let functions=original.slice(start);
functions=functions.replace('function lastParse(proxy)', 'export function lastParse(proxy)');
const imports=`// Adapted from the pinned AGPL Sub-Store commit in vendor/UPSTREAM.json.\nimport {Buffer} from 'buffer';\nimport {isValidPortNumber,isIPv4,isIPv6,numberToString} from '@/utils';\nimport {normalizeWireGuardInterface} from '@/core/proxy-utils/producers/utils';\nimport $ from '../src/app-shim.js';\nconst rs={generateFingerprint(){throw new Error('Certificate conversion requires explicit certificate fingerprint')}};\n`;
await fs.writeFile('vendor/normalizer.js',imports+functions);
console.log('Pinned input normalization isolated');
