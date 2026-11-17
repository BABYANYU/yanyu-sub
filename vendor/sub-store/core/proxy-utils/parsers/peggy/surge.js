import * as generated from './surge.generated.js';
import { setSurgeXhttpOption } from '../../surge-xhttp';


let parser;
export default function getParser() {
    if (!parser) {
        
        parser = {
            parse: (input) => generated.parse(input, { setSurgeXhttpOption }),
        };
    }
    return parser;
}
