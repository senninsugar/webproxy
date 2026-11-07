import { KEY } from "./key.js";

const K = new TextEncoder().encode(KEY);

export function enc(url) {
  const b = new TextEncoder().encode(url);
  for (let i = 0; i < b.length; i++) b[i] ^= K[i % K.length];
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function dec(code) {
  const s = atob(code.replace(/-/g, "+").replace(/_/g, "/"));
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) ^ K[i % K.length];
  return new TextDecoder().decode(b);
}
