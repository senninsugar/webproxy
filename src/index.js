import { enc, dec } from "./codec.js";
import { buildRuntime } from "./runtime.js";
import { rewriteJs } from "./jsrewrite.js";
import { KEY } from "./key.js";

const P = "/svc/";
const HOP = new Set(["host","connection","keep-alive","transfer-encoding","upgrade","proxy-connection","cf-connecting-ip","cf-ray","cf-visitor","x-forwarded-proto","x-real-ip","x-uv-target","accept-encoding","origin","referer","cookie"]);
const STRIP = new Set(["content-security-policy","content-security-policy-report-only","x-frame-options","content-encoding","content-length","transfer-encoding","connection","strict-transport-security","cross-origin-opener-policy","cross-origin-embedder-policy","cross-origin-resource-policy","permissions-policy","report-to","nel","alt-svc","x-content-type-options"]);
const ATTRS = ["href","src","action","poster","formaction","data-src","xlink:href"];

const pfx = (h) => "__" + h.replace(/\./g, "_") + "__";
const filterCookie = (raw, host) => raw
  ? raw.split(/;\s*/).filter(c => c.startsWith(pfx(host))).map(c => c.slice(pfx(host).length)).join("; ")
  : "";
function prefixCookie(c, host) {
  const eq = c.indexOf("=");
  if (eq < 0) return c;
  const parts = c.split(";");
  const name = parts.shift().trim();
  const attrs = parts.filter(a => !/^\s*domain=/i.test(a));
  if (!attrs.some(a => /^\s*path=/i.test(a))) attrs.push(" Path=/");
  return pfx(host) + name + ";" + attrs.join(";");
}

const rwAttr = (v, base) => {
  if (!v) return v;
  const t = v.trim();
  if (!t || /^(#|data:|javascript:|blob:|about:|mailto:|tel:)/i.test(t)) return v;
  try { return P + enc(new URL(t, base).href); } catch { return v; }
};
const fixSrcset = (v, base) => v.split(",").map(s => {
  const [p, d] = s.trim().split(/\s+/);
  return rwAttr(p, base) + (d ? " " + d : "");
}).join(", ");
const fixCss = (v, base) => v.replace(/url\((['"]?)([^)'"\s]*)\1\)/g, (m, q, u) => `url(${q}${rwAttr(u, base)}${q})`);

function buildRewriter(base) {
  const ctx = { base };
  const r = new HTMLRewriter();
  for (const a of ATTRS) r.on(`[${a}]`, { element(el) { const v = el.getAttribute(a); if (v) el.setAttribute(a, rwAttr(v, ctx.base)); } });
  r.on("[srcset]", { element(el) { const v = el.getAttribute("srcset"); if (v) el.setAttribute("srcset", fixSrcset(v, ctx.base)); } });
  r.on("[style]", { element(el) { const v = el.getAttribute("style"); if (v) el.setAttribute("style", fixCss(v, ctx.base)); } });
  r.on("style", { text(t) { t.text = fixCss(t.text, ctx.base); } });
  r.on("script[integrity],link[integrity]", { element(el) { el.removeAttribute("integrity"); } });
  r.on("base[href]", { element(el) { try { ctx.base = new URL(el.getAttribute("href"), ctx.base).href; } catch {} el.remove(); } });
  for (const v of ["refresh", "Refresh"]) r.on(`meta[http-equiv="${v}"]`, { element(el) {
    const c = el.getAttribute("content");
    if (c) el.setAttribute("content", c.replace(/url=([^;]+)/i, (m, u) => "url=" + rwAttr(u.trim(), ctx.base)));
  } });
  for (const v of ["content-security-policy", "Content-Security-Policy"]) r.on(`meta[http-equiv="${v}"]`, { element(el) { el.remove(); } });
  r.on("head", { element(el) { el.prepend(`<script>${buildRuntime(base)}</script>`, { html: true }); } });
  return r;
}

async function fetchUpstream({ method, url, headers, body, signal }) {
  let tu;
  try { tu = new URL(url); } catch { throw new Error("bad url"); }
  if (!/^https?:$/.test(tu.protocol)) throw new Error("bad protocol");
  const h = new Headers();
  for (const [k, v] of Object.entries(headers || {})) if (!HOP.has(k.toLowerCase())) h.set(k, v);
  const ck = filterCookie(headers?.cookie, tu.host);
  if (ck) h.set("cookie", ck);
  h.set("referer", tu.origin + "/");
  h.set("origin", tu.origin);
  const res = await fetch(tu.href, { method, headers: h, body, redirect: "manual", signal });
  return { res, tu };
}

async function finalize(res, tu) {
  if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
    let loc;
    try { loc = new URL(res.headers.get("location"), tu.href).href; } catch { loc = tu.href; }
    return { status: res.status, headers: { location: P + enc(loc) }, body: null };
  }
  const out = {};
  for (const [k, v] of res.headers) if (!STRIP.has(k) && k !== "set-cookie") out[k] = v;
  const sc = res.headers.getAll("set-cookie");
  if (sc.length) out["set-cookie"] = sc.map(c => prefixCookie(c, tu.host));

  const ct = (res.headers.get("content-type") || "").toLowerCase();
  let body = res.body;

  if (ct.includes("text/html")) {
    out["content-type"] = "text/html; charset=utf-8";
    body = buildRewriter(tu.href).transform(res).body;
  } else if (ct.includes("text/css")) {
    const t = await res.text();
    body = new Blob([t.replace(/url\((['"]?)([^)'"\s]*)\1\)/g, (m, q, u) => `url(${q}${rwAttr(u, tu.href)}${q})`)]).stream();
  } else if (/javascript|ecmascript/.test(ct) && !ct.includes("json")) {
    const raw = await res.text();
    let outJs = rewriteJs(raw, tu.href);
    if (outJs === raw) {
      try {
        const ast2 = raw; // 古典スクリプトとして再試行
        outJs = rewriteJsScript(raw, tu.href);
      } catch {}
    }
    body = new Blob([outJs]).stream();
  }
  return { status: res.status, headers: out, body };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/api/key") return new Response(KEY, { headers: { "content-type": "text/plain" } });

    if (url.pathname === "/api/ws" && request.headers.get("upgrade") === "websocket") return mux(request);

    if (url.pathname === "/api/fetch") {
      const t = request.headers.get("x-uv-target");
      if (!t) return new Response("no target", { status: 400 });
      let r;
      try { r = await fetchUpstream({ method: request.method, url: decodeURIComponent(t), headers: Object.fromEntries(request.headers), body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body }); }
      catch (e) { return new Response("upstream: " + e.message, { status: 502 }); }
      const f = await finalize(r.res, r.tu);
      const hb = new TextEncoder().encode(JSON.stringify({ status: f.status, headers: f.headers }));
      const head = new Uint8Array(4 + hb.length);
      new DataView(head.buffer).setUint32(0, hb.length);
      head.set(hb, 4);
      if (!f.body) return new Response(head);
      const rd = f.body.getReader();
      return new Response(new ReadableStream({
        start(c) { c.enqueue(head); },
        async pull(c) { const { value, done } = await rd.read(); if (done) c.close(); else c.enqueue(value); },
        cancel(x) { rd.cancel(x); }
      }));
    }

    if (url.pathname.startsWith(P)) {
      let target;
      try { target = dec(decodeURIComponent(url.pathname.slice(P.length))); } catch { return new Response("bad url", { status: 400 }); }
      let r;
      try { r = await fetchUpstream({ method: request.method, url: target, headers: Object.fromEntries(request.headers), body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body }); }
      catch (e) { return new Response("upstream: " + e.message, { status: 502 }); }
      const f = await finalize(r.res, r.tu);
      const hh = new Headers();
      for (const k in f.headers) { if (k === "set-cookie") for (const c of f.headers[k]) hh.append(k, c); else hh.set(k, f.headers[k]); }
      return new Response([204, 205, 304].includes(f.status) ? null : f.body, { status: f.status, headers: hh });
    }

    return new Response("uv-engine", { status: 200 });
  }
};

// ---------- WS 多重化 ----------
const T_OPEN = 1, T_RESP = 2, T_DATA = 3, T_END = 4, T_ERR = 5, T_CANCEL = 6;

function frame(type, id, payload) {
  const p = payload || new Uint8Array(0);
  const b = new Uint8Array(5 + p.length);
  const dv = new DataView(b.buffer);
  dv.setUint8(0, type);
  dv.setUint32(1, id);
  b.set(p, 5);
  return b;
}

function mux(request) {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();

  const live = new Map();

  server.addEventListener("message", async (ev) => {
    if (typeof ev.data === "string") return;
    const dv = new DataView(ev.data);
    const type = dv.getUint8(0);
    const id = dv.getUint32(1);
    const payload = new Uint8Array(ev.data, 5);

    if (type === T_OPEN) {
      const st = { chunks: [], meta: null };
      live.set(id, st);
      let meta;
      try { meta = JSON.parse(new TextDecoder().decode(payload)); } catch { server.send(frame(T_ERR, id, new TextEncoder().encode("bad meta"))); live.delete(id); return; }
      st.meta = meta;
      st.done = new Promise(r => (st.flush = r));
      run(server, id, st, live);
    } else if (type === T_DATA) {
      const st = live.get(id);
      if (st) st.chunks.push(payload.slice());
    } else if (type === T_END) {
      const st = live.get(id);
      if (st) st.flush();
    } else if (type === T_CANCEL) {
      const st = live.get(id);
      if (st) { st.ac?.abort(); live.delete(id); }
    }
  });

  return new Response(null, { status: 101, webSocket: client });
}

async function run(ws, id, st, live) {
  const ac = new AbortController();
  st.ac = ac;
  try {
    await st.done;
    const body = st.chunks.length ? new Blob(st.chunks) : undefined;
    const { res, tu } = await fetchUpstream({
      method: st.meta.method, url: st.meta.url,
      headers: st.meta.headers, body, signal: ac.signal
    });
    const f = await finalize(res, tu);
    ws.send(frame(T_RESP, id, new TextEncoder().encode(JSON.stringify({ status: f.status, headers: f.headers }))));
    if (f.body) {
      const rd = f.body.getReader();
      for (;;) {
        const { value, done } = await rd.read();
        if (done) break;
        ws.send(frame(T_DATA, id, value));
      }
    }
    ws.send(frame(T_END, id));
  } catch (e) {
    try { ws.send(frame(T_ERR, id, new TextEncoder().encode(String(e.message || e)))); } catch {}
  } finally { live.delete(id); }
}
