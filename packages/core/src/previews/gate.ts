// The page a preview host answers a request that holds no viewer cookie (BC-4). Opened on its own it
// says where to open the preview from. Framed by Forge it is the one place a preview host runs a
// script of Forge's own: a browser that keeps no cookie for a frame on another site (Safari blocks
// every third-party cookie, and WebKit has no partitioned ones) shows "Allow this preview", which asks
// the Storage Access API for the cookie, then asks Forge, the frame's parent, for a fresh one-minute
// ticket and enters again. One re-entry per minute: a frame that still cannot keep its cookie stops
// and says why, never loops. The script is served under a CSP naming its own hash.

import { createHash } from 'node:crypto';
import {
  PREVIEW_ENTER_PATH,
  PREVIEW_FRAME_MESSAGES,
  PREVIEW_LIMITS,
} from '@forge/contracts/preview';

/** The gate's script for a Forge whose pages are served from `appOrigin`. Plain ES5-compatible JS. */
export function gateScript(appOrigin: string): string {
  const m = PREVIEW_FRAME_MESSAGES;
  return `(function(){
var APP=${JSON.stringify(appOrigin)},ENTER=${JSON.stringify(PREVIEW_ENTER_PATH)},KEY="forge.previewReentry",WINDOW=${PREVIEW_LIMITS.ticketSeconds * 1000};
var framed=false;try{framed=window.top!==window.self}catch(e){framed=true}
if(!framed)return;
var $=function(id){return document.getElementById(id)};
$("top").hidden=true;$("framed").hidden=false;
var say=function(t){$("msg").textContent=t};
var tried=function(){try{var v=window.sessionStorage.getItem(KEY);return v!==null&&Date.now()-Number(v)<WINDOW}catch(e){return window.name==="forge-reentry"}};
var mark=function(){try{window.sessionStorage.setItem(KEY,String(Date.now()))}catch(e){window.name="forge-reentry"}};
var tell=function(type){try{window.parent.postMessage({type:type},APP)}catch(e){}};
var stop=function(t){$("allow").hidden=true;say(t);tell(${JSON.stringify(m.storageRefused)})};
var ask=function(){mark();say("Asking Forge for a new link...");tell(${JSON.stringify(m.ticketRequest)});setTimeout(function(){say("Forge did not answer. Use Open in tab above.")},10000)};
window.addEventListener("message",function(e){
if(e.origin!==APP||e.source!==window.parent)return;
var d=e.data;if(!d||d.type!==${JSON.stringify(m.ticket)}||typeof d.url!=="string")return;
var u;try{u=new URL(d.url)}catch(x){return}
if(u.origin!==location.origin||u.pathname!==ENTER)return;
location.replace(u.href)});
if(tried()){stop("This frame still cannot keep its cookie after it was allowed. Use Open in tab above to see this preview.");return}
$("allow").onclick=function(){
$("allow").disabled=true;say("Asking the browser...");
var rsa=document.requestStorageAccess?document.requestStorageAccess():Promise.resolve();
rsa.then(ask,function(){$("allow").disabled=false;stop("The browser did not allow it. Use Open in tab above to see this preview.")})};
if(document.hasStorageAccess){document.hasStorageAccess().then(function(has){if(has)ask()},function(){})}
})();`;
}

export const gateCsp = (script: string, appOrigin: string): string =>
  `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${createHash('sha256').update(script).digest('base64')}'; frame-ancestors ${appOrigin}`;
