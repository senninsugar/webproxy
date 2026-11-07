import { parse } from "acorn";
import { enc } from "./codec.js";

const ABS = /^[a-z][a-z0-9+.-]*:/i;
const LIMIT = 3_000_000;

const LOC = new Set(["location", "document.location", "window.location", "self.location"]);
const OPENERS = new Set(["open", "assign", "replace", "pushState", "replaceState"]);

function walk(node, fn, parent) {
  if (!node || typeof node.type !== "string") return;
  fn(node, parent);
  for (const k in node) {
    if (k === "type" || k === "start" || k === "end" || k === "loc") continue;
    const v = node[k];
    if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === "string") walk(c, fn, node); }
    else if (v && typeof v.type === "string") walk(v, fn, node);
  }
}

function flatten(n) {
  if (!n) return "";
  if (n.type === "Identifier") return n.name;
  if (n.type === "ThisExpression") return "this";
  if (n.type === "MemberExpression" && !n.computed) return flatten(n.object) + "." + n.property.name;
  return "";
}

const str = (n) => {
  if (!n) return null;
  if (n.type === "Literal" && typeof n.value === "string") return n.value;
  if (n.type === "TemplateLiteral" && n.expressions.length === 0) return n.quasis[0].value.cooked;
  return null;
};

export function rewriteJs(src, base) {
  if (src.length > LIMIT) return src;
  let ast;
  try {
    ast = parse(src, {
      ecmaVersion: "latest", sourceType: "module", allowHashBang: true,
      allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true,
      allowImportExportEverywhere: true
    });
  } catch { return src; }

  const edits = [];
  const add = (node, { bare = false } = {}) => {
    const v = str(node);
    if (!v) return;
    if (bare && !v.startsWith(".") && !v.startsWith("/") && !ABS.test(v)) return;
    let abs;
    try { abs = new URL(v, base).href; } catch { return; }
    if (!/^https?:/.test(abs)) return;
    edits.push([node.start, node.end, JSON.stringify("/svc/" + enc(abs))]);
  };

  walk(ast, (n, p) => {
    switch (n.type) {
      case "ImportDeclaration":
      case "ExportNamedDeclaration":
      case "ExportAllDeclaration":
        add(n.source, { bare: true });
        break;
      case "ImportExpression":
        add(n.source);
        break;
      case "NewExpression":
        if (n.callee.type === "Identifier" && n.callee.name === "Worker") add(n.arguments[0]);
        break;
      case "CallExpression": {
        if (n.callee.type === "Identifier") {
          if (n.callee.name === "fetch" || n.callee.name === "importScripts") add(n.arguments[0]);
          break;
        }
        if (n.callee.type !== "MemberExpression" || n.callee.computed) break;
        const obj = flatten(n.callee.object);
        const prop = n.callee.property.name;
        if (LOC.has(obj) && OPENERS.has(prop)) {
          add(n.arguments[prop === "open" ? 0 : prop === "pushState" || prop === "replaceState" ? 2 : 0]);
        } else if (prop === "open" && /XMLHttpRequest/.test(obj + n.callee.object?.name)) {
          add(n.arguments[1]);
        } else if (prop === "sendBeacon") {
          add(n.arguments[0]);
        }
        break;
      }
      case "AssignmentExpression": {
        const l = n.left;
        if (l.type !== "MemberExpression" || l.computed) break;
        const obj = flatten(l.object);
        if ((LOC.has(obj) || obj === "window") && l.property.name === "href") add(n.right);
        else if (obj === "location" && (l.property.name === "pathname" || l.property.name === "search")) add(n.right);
        break;
      }
    }
  }, null);

  if (!edits.length) return src;
  edits.sort((a, b) => b[0] - a[0]);
  let out = src;
  for (const [s, e, r] of edits) out = out.slice(0, s) + r + out.slice(e);
  return out;
}
