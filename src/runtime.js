import { KEY } from "./codec.js";

const SRC = String.raw`(function(){
if(window.__uv$)return;window.__uv$=1;
var P="/svc/",T=__T__,K=__K__;
var HOST=new URL(T).host,PFX="__"+HOST.replace(/\./g,"_")+"__";
/* …前回の enc/dec/abs/sk/px/Location/History/fetch/XHR/setAttribute/innerHTML/cookie/Worker/beacon/submit/attachShadow/click… */
window.__uv={enc:enc,dec:dec,px:px,key:K};
})();`;

export function buildRuntime(target) {
  return SRC.replace("__T__", JSON.stringify(target)).replace("__K__", JSON.stringify(KEY));
}
