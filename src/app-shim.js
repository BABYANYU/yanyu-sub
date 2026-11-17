// The conversion subset must never log nodes, credentials or input lines.
const noop=()=>{};
export default {info:noop,warn:noop,error:noop,log:noop,debug:noop,env:{isNode:false}};
