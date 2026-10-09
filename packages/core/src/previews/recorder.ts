// The recorder a reproduce preview's pages carry (REQ-41 BC-18): rrweb 2.x (MIT) with its console
// and network plugins, served by core at `/__forge_preview/rec.js` on the preview's own origin, so a
// page whose CSP is `script-src 'self'` admits it and no Forge credential ever reaches the page. Its
// options are `RECORDER_OPTIONS`, written into the script by core and never read from the page, so
// an app cannot turn masking off. The relay puts the script tag after `<head>` of every HTML answer.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { SNAPSHOT_ANSWER, SNAPSHOT_ASK } from '@forge/contracts/preview';
import {
  RECORDER_EVENTS,
  RECORDER_OPTIONS,
  RECORDER_PATHS,
  RECORDING_LIMITS,
} from '@forge/contracts/reproduce';
import type { PreviewRow } from '../db/schema-previews.js';

const require = createRequire(import.meta.url);

/** A package's minified browser build, read beside the entry node resolves for it (its `dist`). */
function bundleOf(pkg: string, file: string): string {
  return readFileSync(join(dirname(require.resolve(pkg)), file), 'utf8');
}

let vendored: string | null = null;

/**
 * rrweb and its two plugins as globals (`rrweb`, `rrwebPluginConsoleRecord`,
 * `rrwebPluginNetworkRecord`), each UMD build run with no `exports`, `module` or `define` in reach,
 * so a page that defines an AMD loader of its own does not swallow them.
 */
function vendor(): string {
  vendored ??= (
    [
      ['rrweb', 'rrweb.umd.min.cjs'],
      ['@rrweb/rrweb-plugin-console-record', 'rrweb-plugin-console-record.umd.min.cjs'],
      ['@rrweb/rrweb-plugin-network-record', 'rrweb-plugin-network-record.umd.min.cjs'],
    ] as const
  )
    .map(
      ([pkg, file]) =>
        `(function(){var exports,module,define;\n${bundleOf(pkg, file).replace(/\/\/# sourceMappingURL=\S+\s*$/, '')}\n}).call(window);`,
    )
    .join('\n');
  return vendored;
}

/** What starts the recording: the options, the batching, and the two events rrweb lacks. */
function bootstrap(recordingId: string): string {
  const config = {
    recordingId,
    ingest: RECORDER_PATHS.ingest,
    reserved: RECORDER_PATHS.ingest.slice(0, RECORDER_PATHS.ingest.lastIndexOf('/') + 1),
    flushMs: RECORDING_LIMITS.flushSeconds * 1000,
    batchEvents: RECORDING_LIMITS.batchEvents,
    events: RECORDER_EVENTS,
    options: RECORDER_OPTIONS,
  };
  return `(function(){
var C=${JSON.stringify(config)};
var R=window.rrweb;if(!R||!R.record)return;
var seq=0,buf=[],sending=false,stopped=false;
function send(keepalive){
  if(sending||stopped||buf.length===0)return;
  var events=buf.splice(0,C.batchEvents);sending=true;
  fetch(C.ingest,{method:'POST',credentials:'same-origin',keepalive:!!keepalive,headers:{'content-type':'application/json'},body:JSON.stringify({recordingId:C.recordingId,seq:seq,events:events})})
  .then(function(r){
    if(r.ok){seq++;return;}
    return r.json().then(function(b){
      if(b&&b.code==='RECORDING_SEQ_GAP'&&typeof b.owes==='number'){seq=b.owes;buf=events.concat(buf);return;}
      if(b&&(b.code==='RECORDING_CLOSED'||b.code==='RECORDING_TOO_LARGE'||b.code==='RECORDING_NOT_FOUND')){stopped=true;if(stop)stop();return;}
      buf=events.concat(buf);
    });
  })
  .catch(function(){buf=events.concat(buf);})
  .then(function(){sending=false;});
}
var net=Object.assign({},C.options.network,{transformRequestFn:function(q){return q&&typeof q.name==='string'&&q.name.indexOf(C.reserved)!==-1?undefined:q;}});
var plugins=[];
if(window.rrwebPluginConsoleRecord)plugins.push(window.rrwebPluginConsoleRecord.getRecordConsolePlugin(C.options.console));
if(window.rrwebPluginNetworkRecord)plugins.push(window.rrwebPluginNetworkRecord.getRecordNetworkPlugin(net));
var stop=R.record(Object.assign({},C.options.record,{plugins:plugins,emit:function(e){buf.push(e);if(buf.length>=C.batchEvents)send();}}));
function label(el){
  var t=el&&el.closest?el.closest('button,a,[role=button],[role=link],[role=menuitem],[role=tab],input,select,textarea,label,summary')||el:el;
  if(!t)return null;
  var aria=t.getAttribute&&t.getAttribute('aria-label');if(aria)return aria.slice(0,80);
  var tag=(t.tagName||'').toLowerCase();
  if(tag==='input'||tag==='select'||tag==='textarea')return (t.getAttribute('name')||t.getAttribute('type')||tag)+' field';
  var text=(t.innerText||t.textContent||'').replace(/\\s+/g,' ').trim();
  return text?text.slice(0,80):null;
}
document.addEventListener('click',function(ev){try{R.record.addCustomEvent(C.events.click,{label:label(ev.target)});}catch(_){}} ,true);
function route(){try{R.record.addCustomEvent(C.events.route,{href:location.href});}catch(_){}}
['pushState','replaceState'].forEach(function(k){var o=history[k];history[k]=function(){var r=o.apply(this,arguments);route();return r;};});
window.addEventListener('popstate',route);
setInterval(send,C.flushMs);
window.addEventListener('pagehide',function(){send(true);});
})();`;
}

/** rrweb alone, as a global: the page only answers a snapshot ask, with no plugin to run. */
function rrwebOnly(): string {
  return `(function(){var exports,module,define;\n${bundleOf('rrweb', 'rrweb.umd.min.cjs').replace(/\/\/# sourceMappingURL=\S+\s*$/, '')}\n}).call(window);`;
}

/** Whether the preview's pages answer Forge's ask for one snapshot (an idea, kept as a picture; BC-16). */
export const takesSnapshots = (row: PreviewRow) => row.subjectKind === 'idea';

/**
 * What an idea preview's pages carry: rrweb, with its record options from core (inputs masked), keeping
 * only the latest Meta and FullSnapshot pair, and a listener that answers ONE ask, from Forge's own
 * origin and the frame's parent only, by taking a fresh full snapshot and posting the pair back to
 * that origin. It sends nothing anywhere else and keeps no recording.
 */
export function snapshotScript(parentOrigin: string): string {
  const config = {
    parent: parentOrigin,
    options: RECORDER_OPTIONS.record,
    ask: SNAPSHOT_ASK,
    answer: SNAPSHOT_ANSWER,
  };
  const boot = `(function(){
var C=${JSON.stringify(config)};
var R=window.rrweb;if(!R||!R.record||window.parent===window)return;
var meta=null,full=null;
R.record(Object.assign({},C.options,{emit:function(e){if(e.type===4)meta=e;else if(e.type===2)full=e;}}));
window.addEventListener('message',function(ev){
  if(ev.origin!==C.parent||ev.source!==window.parent||!ev.data||ev.data.type!==C.ask)return;
  var id=ev.data.id,ok=false;
  try{meta=null;full=null;R.record.takeFullSnapshot(true);ok=!!(meta&&full);}catch(_){}
  ev.source.postMessage({type:C.answer,id:id,events:ok?[meta,full]:null},C.parent);
});
})();`;
  return `${rrwebOnly()}\n${boot}\n`;
}

/** The whole recorder for one viewer's recording. */
export function recorderScript(recordingId: string): string {
  return `${vendor()}\n${bootstrap(recordingId)}\n`;
}

/** The tag the relay puts after `<head>`: same origin, so the app's own `script-src 'self'` admits it. */
export const RECORDER_TAG = `<script src="${RECORDER_PATHS.script}"></script>`;

/** An HTML answer with the recorder's tag after its `<head>` (or at its top where it has none). */
export function withRecorderTag(html: string): string {
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return `${html.slice(0, at)}${RECORDER_TAG}${html.slice(at)}`;
  }
  const doc = /<html(?:\s[^>]*)?>/i.exec(html);
  if (doc) {
    const at = doc.index + doc[0].length;
    return `${html.slice(0, at)}<head>${RECORDER_TAG}</head>${html.slice(at)}`;
  }
  return `${RECORDER_TAG}${html}`;
}

/** A body as the dev server encoded it, decoded: the relay asks for `identity`, and a server may not listen. */
export function decoded(body: Buffer, encoding: string | undefined): Buffer {
  switch ((encoding ?? 'identity').trim().toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return gunzipSync(body);
    case 'br':
      return brotliDecompressSync(body);
    case 'deflate':
      return inflateSync(body);
    default:
      return body;
  }
}
