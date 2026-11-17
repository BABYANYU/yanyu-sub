import * as generated from './loon.generated.js';

let parser;
export default function getParser() {
    if (!parser) {
        parser = generated;
    }
    return parser;
}
