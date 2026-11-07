#!/usr/bin/env node
// Builds en.html (served at /en/) from index.html: the same page with its English text written
// into the HTML, so search engines index an English version at its own address.
// index.html stays the one source; run this after every change to it:
//   node tools/i18n/build-en.cjs
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..", "..");
let s = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

// The page's own strings (the STR object in its script).
const a = s.indexOf("const STR = {"), b = s.indexOf("\n  };", a);
const STR = new Function("return " + s.slice(a + "const STR = ".length, b + 4))();
const en = STR.en, zh = STR.zh;
const esc = (x) => String(x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attr = (x) => esc(x).replace(/"/g, "&quot;");
const must = (from, to) => { if (!s.includes(from)) throw new Error("not found: " + from.slice(0, 80)); s = s.split(from).join(to); };

// <head>
must('<html lang="zh-CN">', '<html lang="en">');
s = s.replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${attr("Free online DWG to PDF converter: turn AutoCAD DWG and DXF drawings into PDF, one page per title block, color or black and white, ARCH D 24×36 and other sheet sizes, sharp vector output. Files are converted in your browser and never uploaded.")}">`);
must('<link rel="canonical" href="https://5cad2pdf.com/">', '<link rel="canonical" href="https://5cad2pdf.com/en/">');
must('<meta property="og:url" content="https://5cad2pdf.com/">', '<meta property="og:url" content="https://5cad2pdf.com/en/">');
s = s.replace(/<meta property="og:title" content="[^"]*">/, '<meta property="og:title" content="DWG to PDF Converter – Free, Online · cad2pdf">');
s = s.replace(/<meta property="og:description" content="[^"]*">/, '<meta property="og:description" content="Convert AutoCAD DWG / DXF drawings to PDF in your browser: one page per title block, sharp vector output, nothing uploaded.">');
must('<meta property="og:locale" content="zh_CN">\n<meta property="og:locale:alternate" content="en_US">', '<meta property="og:locale" content="en_US">\n<meta property="og:locale:alternate" content="zh_CN">');
s = s.replace(/<meta property="og:image:alt" content="[^"]*">/, '<meta property="og:image:alt" content="DWG to PDF converter · 5cad2pdf.com">');
s = s.replace(/<title>[^<]*<\/title>/, `<title>${esc(en.docTitle)}</title>`);
s = s.replace('"alternateName":"DWG 转 PDF"', '"alternateName":"DWG to PDF"').replace('"inLanguage":["zh-CN","en"]', '"inLanguage":"en"');
// FAQ structured data: the same questions, in English
s = s.replace(/<script type="application\/ld\+json">(\{"@context": "https:\/\/schema.org", "@type": "FAQPage".*?)<\/script>/s, (m, j) => {
  const d = JSON.parse(j);
  for (const q of d.mainEntity) {
    const k = Object.keys(zh).find(k => /^q\d+$/.test(k) && zh[k] === q.name);
    if (!k) throw new Error("FAQ question without English: " + q.name);
    q.name = en[k]; q.acceptedAnswer.text = en["a" + k.slice(1)];
  }
  return '<script type="application/ld+json">' + JSON.stringify(d) + "</script>";
});

// <body>: every translated element gets its English text
let n = 0;
s = s.replace(/(<([a-z0-9]+)\b[^>]*\bdata-i18n="(\w+)"[^>]*>)([^<]*)(<\/\2>)/g, (m, open, tag, k, text, close) => {
  if (!(k in en)) throw new Error("no English for " + k);
  n++; return open + esc(en[k]) + close;
});
s = s.replace(/(data-i18n-ph="(\w+)"[^>]*?placeholder=")[^"]*"/g, (m, pre, k) => pre + attr(en[k]) + '"');
s = s.replace(/<([a-z]+)([^>]*)data-i18n-aria="(\w+)"/g, (m, tag, rest, k) => `<${tag}${rest}data-i18n-aria="${k}" aria-label="${attr(en[k])}"`);
s = s.replace(/(<a [^>]*)href="([^"]*)" data-path="([^"]*)"/g, (m, pre, href, p) => `${pre}href="${p === "/" ? "/en/" : "/en" + p}" data-path="${p}"`);

s = s.split("https://5cad2pdf.com/og.png").join("https://5cad2pdf.com/og-en.png");
fs.writeFileSync(path.join(ROOT, "en.html"), s);
console.log("wrote en.html,", n, "texts in English");
