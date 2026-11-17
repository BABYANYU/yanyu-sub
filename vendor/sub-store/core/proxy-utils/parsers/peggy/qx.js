import { Buffer } from 'buffer';
import * as generated from './qx.generated.js';

function decodeQxAlpn(raw) {
    if (typeof raw !== 'string') return undefined;
    const hex = raw.trim().replace(/:/g, '');
    if (!hex || hex.length % 2 || /[^0-9a-f]/i.test(hex)) return undefined;

    const bytes = Buffer.from(hex, 'hex');
    const alpn = [];
    for (let offset = 0; offset < bytes.length; ) {
        const length = bytes[offset++];
        if (!length || offset + length > bytes.length) return undefined;
        alpn.push(bytes.subarray(offset, offset + length).toString('utf8'));
        offset += length;
    }
    return alpn;
}


let parser;
export default function getParser() {
    if (!parser) {
        
        parser = {
            parse(input, options) {
                const proxy = generated.parse(input, options);
                const alpn = decodeQxAlpn(proxy['tls-alpn']);
                if (alpn) proxy.alpn = alpn;
                return proxy;
            },
        };
    }
    return parser;
}
