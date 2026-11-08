#!/usr/bin/env python3
"""Builds pdf-to-dxf.html from tools/pdf2dxf/page.tpl.html: copies the main page's CSS so the two
pages look the same, and fills in the UI strings and FAQ (visible HTML + FAQPage JSON-LD).
Run from the repo root: python3 tools/pdf2dxf/build-page.py"""
import json, re, os
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
idx = open(os.path.join(ROOT, 'index.html'), encoding='utf-8').read()
a = idx.index('<style>\n/* Layout'); b = idx.index('</style>', a) + 8
css = idx[a:b]
m = re.search(r'/\* tabs \*/.*?/\* /tabs \*/', idx, re.S)
tabcss = m.group(0) if m else ''

FAQ = [
 ("怎么把 PDF 转成 DWG？", "点「选择或拖入 PDF」，选好 PDF 文件，右边会显示能转出来的线条和文字。选输出格式（DWG 或 DXF）、单位和图纸比例，再点「生成 DWG」，文件会直接下载。多页 PDF 默认每页一个文件，打包成 ZIP。",
  "How do I convert a PDF to DWG?", "Click “Choose or drop PDFs”, pick a PDF, and the preview shows the lines and text that will come across. Choose the format (DWG or DXF), units and drawing scale, then click “Create DWG”. The file downloads straight away. A multi-page PDF gives one file per page, packed in a ZIP."),
 ("什么样的 PDF 能转？", "从 AutoCAD、Revit 等软件直接导出或打印的矢量 PDF 效果最好，线条和文字都能还原。扫描件或照片是图片，里面没有线条，转不出来（预览会提示）。",
  "Which PDFs work?", "Vector PDFs exported or printed from AutoCAD, Revit and similar programs work best: lines and text come back. Scans and photos are pictures with no lines in them, so they can't be converted (the preview tells you)."),
 ("转出来的尺寸对吗？", "PDF 里只记录纸面尺寸，不记录图纸比例。默认按纸面 1:1 输出；在「图纸比例」里选图上标的比例（比如 1/4\" = 1'-0\" 或 1:100），DWG 里量出来就是实际尺寸。转完可以量一段已知长度核对。",
  "Will the dimensions be right?", "A PDF only records paper size, not the drawing scale. By default the drawing is at paper size (1:1). Pick the scale shown on the sheet (for example 1/4\" = 1'-0\" or 1:100) and distances in the drawing measure true size. Measure a known length afterwards to check."),
 ("DWG 和 DXF 选哪个？", "要在 AutoCAD 里用，选 DWG（默认）：AutoCAD 2000 格式，AutoCAD 2000 到最新版、BricsCAD、DWG TrueView 都能直接打开，文件也比 DXF 小得多。DXF（R12 格式）几乎所有 CAD 和绘图软件都能读，适合 LibreCAD、激光切割、CNC 等软件。两种文件里的内容完全一样。",
  "DWG or DXF?", "For AutoCAD, choose DWG (the default): AutoCAD 2000 format, which AutoCAD 2000 through the latest version, BricsCAD and DWG TrueView open directly, and much smaller than DXF. DXF (R12) is read by almost every CAD and drawing program, handy for LibreCAD, laser cutting and CNC software. Both contain exactly the same drawing."),
 ("转出来的图里有什么？", "线条和多段线（曲线由短线段组成）、虚线、颜色、填充区域的外轮廓（在 PDF_FILL 图层），以及可编辑的文字（在 PDF_TEXT 图层）。原图的图层、图块和标注对象 PDF 里没有保存，所以无法还原；图片不转换。",
  "What ends up in the drawing?", "Lines and polylines (curves become short segments), dashed lines, colors, outlines of filled areas (on layer PDF_FILL) and editable text (on layer PDF_TEXT). The original layers, blocks and dimension objects aren't stored in a PDF, so they can't be recovered; pictures are not converted."),
 ("文字是乱码或变成了线条怎么办？", "有些 PDF 把文字存成了轮廓线，这种文字会变成线条，看起来一样但不能编辑。少数 PDF 的字体编码特殊，文字会是乱码，可以取消「包含文字」，只要线条。",
  "Text is garbled or turned into lines?", "Some PDFs store text as outlines; that text comes across as lines, which look the same but can't be edited. A few PDFs use unusual font encodings and their text comes out garbled; untick “Include text” to keep only the lines."),
 ("文件会上传到服务器吗？", "不会。PDF 只在你自己的浏览器里读取和转换，不经过任何服务器。",
  "Are my files uploaded?", "No. The PDF is read and converted in your own browser and never goes to a server."),
 ("收费吗？需要注册吗？", "完全免费，不用注册，电脑和手机都能用。",
  "Is it free? Do I need an account?", "It's completely free, with no sign-up, on computers and phones."),
]

zh = dict(
 title="PDF 转 DXF 在线免费转换 · PDF to DXF Converter | cad2pdf",
 h1="PDF 图纸转 DXF", tag="PDF → DXF · 文件只在本机浏览器里处理，不上传",
 tabCad="CAD 转 PDF", tabPdf="PDF 转 DXF",
 pick="选择或拖入 PDF（可多选）", pickSub="从 AutoCAD 等软件导出的矢量 PDF",
 unitL="单位", uIn="英寸", uMm="毫米", scaleL="图纸比例", s1="1:1（纸面尺寸）", sArch="建筑（英制）", sEng="工程（英制）", sMet="公制",
 scaleH1="按纸面尺寸输出。选图上标的比例，可以还原实际尺寸。",
 scaleHin="图纸单位是英寸，按所选比例放大成实际尺寸。", scaleHmm="图纸单位是毫米，按所选比例放大成实际尺寸。",
 pagesL="多页 PDF", pgEach="每页一个 DXF", pgOne="合成一个 DXF", txtL="包含文字（可编辑）",
 go="生成 DXF", hint="适合从 CAD 软件导出的 PDF。扫描件是图片，转不出线条。",
 empty="选好 PDF 后，这里显示能转出来的线条和文字。", reading="正在读取 PDF…",
 pageCap="第 {p} 页 · 线条 {l} · 文字 {t}", morePages="还有 {n} 页，预览只显示前几页，转换时全部包括。",
 metaPages="{n} 页", metaPage1="1 页", metaSize="{w} × {h} in（{mw} × {mh} mm）",
 scanned="这页是图片（扫描件或照片），没有可转换的线条。", blank="这页没有可转换的线条或文字。",
 batchH="{n} 个文件 · 点文件名预览", st_wk="转换中", st_ok="完成", st_bad="读不了",
 onlyPdf="请选择 .pdf 文件。", skipped="已跳过 {n} 个不是 PDF 的文件。", needFile="请先选择 PDF 文件。",
 badPdf="这个 PDF 打不开，可能已损坏。", locked="这个 PDF 有密码保护，请先去掉密码再转换。", libFail="转换组件没有加载成功，请检查网络后刷新页面。",
 working="正在转换 {x}…", pageN="第 {p}/{n} 页", zipping="正在打包 ZIP…",
 done="完成：{n} 个 DXF（{mb} MB）已下载。", doneSome="完成：{n} 个 DXF 已下载，{b} 个文件读不了。",
 doneEmpty="已下载，但有的文件里没有矢量线条（可能是扫描件），DXF 会是空的。", allBad="这些 PDF 都打不开。", fail="生成 DXF 失败，请再试一次。",
 aboutH="常见问题", aboutP="5cad2pdf 的 PDF 转 DXF 是免费的在线工具：把从 CAD 导出的 PDF 图纸还原成 AutoCAD 能编辑的 DXF，线条、虚线、颜色和文字都保留，可以按图纸比例还原实际尺寸。",
 footFb="意见反馈请到", footFbA="主页", footOther="DWG 转 PDF",
)
en = dict(
 title="PDF to DXF Converter, free and online | cad2pdf",
 h1="PDF to DXF", tag="PDF → DXF · files stay in your browser, nothing is uploaded",
 tabCad="CAD to PDF", tabPdf="PDF to DXF",
 pick="Choose or drop PDFs (one or many)", pickSub="Vector PDFs exported from AutoCAD and similar",
 unitL="Units", uIn="Inches", uMm="Millimeters", scaleL="Drawing scale", s1="1:1 (paper size)", sArch="Architectural", sEng="Engineering", sMet="Metric",
 scaleH1="Output at paper size. Pick the scale on the sheet to get true dimensions.",
 scaleHin="Drawing units are inches, enlarged by the scale to true size.", scaleHmm="Drawing units are millimeters, enlarged by the scale to true size.",
 pagesL="Multi-page PDF", pgEach="One DXF per page", pgOne="One DXF", txtL="Include text (editable)",
 go="Create DXF", hint="Works on PDFs exported from CAD programs. Scans are pictures and have no lines to convert.",
 empty="Choose a PDF and the lines and text that will come across show here.", reading="Reading the PDF…",
 pageCap="Page {p} · {l} lines · {t} texts", morePages="{n} more pages: the preview shows the first few, the conversion includes all.",
 metaPages="{n} pages", metaPage1="1 page", metaSize="{w} × {h} in ({mw} × {mh} mm)",
 scanned="This page is a picture (scan or photo) with no lines to convert.", blank="This page has no lines or text to convert.",
 batchH="{n} files · click a name to preview", st_wk="converting", st_ok="done", st_bad="can't read",
 onlyPdf="Please choose .pdf files.", skipped="Skipped {n} files that aren't PDFs.", needFile="Choose a PDF first.",
 badPdf="This PDF can't be opened; it may be damaged.", locked="This PDF is password-protected. Remove the password, then convert.", libFail="The converter didn't load. Check your connection and reload the page.",
 working="Converting {x}…", pageN="page {p}/{n}", zipping="Packing the ZIP…",
 done="Done: {n} DXF ({mb} MB) downloaded.", doneSome="Done: {n} DXF downloaded; {b} files couldn't be read.",
 doneEmpty="Downloaded, but some files have no vector lines (probably scans), so their DXF is empty.", allBad="None of these PDFs could be opened.", fail="Couldn't create the DXF. Please try again.",
 aboutH="FAQ", aboutP="5cad2pdf PDF to DXF is a free online tool that turns PDF drawings exported from CAD back into DXF that AutoCAD can edit, keeping lines, dashes, colors and text, with the drawing scale restored if you choose it.",
 footFb="Feedback:", footFbA="main page", footOther="DWG to PDF",
)
zh.update({'title': 'PDF 转 DWG 在线免费转换 · PDF to DWG / DXF Converter | cad2pdf', 'h1': 'PDF 图纸转 DWG / DXF', 'tag': 'PDF → DWG · DXF · 文件只在本机浏览器里处理，不上传', 'tabPdf': 'PDF 转 DWG', 'fmtL': '输出格式', 'fmtHdwg': 'AutoCAD 2000 格式，AutoCAD 各版本都能直接打开。', 'fmtHdxf': 'R12 格式，几乎所有 CAD 软件都能读。', 'goDwg': '生成 DWG', 'goDxf': '生成 DXF', 'pgEach': '每页一个文件', 'pgOne': '合成一个文件', 'done': '完成：{n} 个文件（{mb} MB）已下载。', 'done1': '完成：文件（{mb} MB）已下载。', 'doneSome': '完成：{n} 个文件已下载，{b} 个文件读不了。', 'doneEmpty': '已下载，但有的 PDF 里没有矢量线条（可能是扫描件），转出来会是空的。', 'fail': '生成文件失败，请再试一次。', 'aboutP': '5cad2pdf 的 PDF 转 DWG 是免费的在线工具：把从 CAD 导出的 PDF 图纸还原成 AutoCAD 能编辑的 DWG 或 DXF，线条、虚线、颜色和文字都保留，可以按图纸比例还原实际尺寸。'})
en.update({'title': 'PDF to DWG Converter, free and online (DWG / DXF) | cad2pdf', 'h1': 'PDF to DWG / DXF', 'tag': 'PDF → DWG · DXF · files stay in your browser, nothing is uploaded', 'tabPdf': 'PDF to DWG', 'fmtL': 'Format', 'fmtHdwg': 'AutoCAD 2000 format; every AutoCAD version opens it.', 'fmtHdxf': 'R12 format; read by almost every CAD program.', 'goDwg': 'Create DWG', 'goDxf': 'Create DXF', 'pgEach': 'One file per page', 'pgOne': 'One file', 'done': 'Done: {n} files ({mb} MB) downloaded.', 'done1': 'Done: the file ({mb} MB) is downloaded.', 'doneSome': "Done: {n} files downloaded; {b} files couldn't be read.", 'doneEmpty': 'Downloaded, but some PDFs have no vector lines (probably scans), so their drawings are empty.', 'fail': "Couldn't create the file. Please try again.", 'aboutP': '5cad2pdf PDF to DWG is a free online tool that turns PDF drawings exported from CAD back into DWG or DXF that AutoCAD can edit, keeping lines, dashes, colors and text, with the drawing scale restored if you choose it.'})
faq_html = []
for i, (qz, az, qe, ae) in enumerate(FAQ):
    zh[f'q{i}'] = qz; zh[f'a{i}'] = az; en[f'q{i}'] = qe; en[f'a{i}'] = ae
    faq_html.append(f'    <details><summary data-i18n="q{i}">{qz}</summary><p data-i18n="a{i}">{az}</p></details>')
ld = {"@context": "https://schema.org", "@type": "FAQPage", "mainEntity": [
    {"@type": "Question", "name": qz, "acceptedAnswer": {"@type": "Answer", "text": az}} for (qz, az, _, _) in FAQ]}
tpl = open(os.path.join(ROOT, 'tools/pdf2dxf/page.tpl.html'), encoding='utf-8').read()
out = (tpl.replace('%%CSS%%', css).replace('%%TABCSS%%', tabcss)
       .replace('%%FAQLD%%', '<script type="application/ld+json">' + json.dumps(ld, ensure_ascii=False) + '</script>')
       .replace('%%FAQ%%', '\n'.join(faq_html))
       .replace('%%STR%%', json.dumps({"zh": zh, "en": en}, ensure_ascii=False)))
out = out.replace('<p class="about-lead" data-i18n="aboutP"></p>', f'<p class="about-lead" data-i18n="aboutP">{zh["aboutP"]}</p>')
out = out.replace('<p class="hint" data-i18n="hint"></p>', f'<p class="hint" data-i18n="hint">{zh["hint"]}</p>')
open(os.path.join(ROOT, 'zh-pdf-to-dwg.html'), 'w', encoding='utf-8').write(out)
print('wrote zh-pdf-to-dwg.html', len(out))

# English page (/pdf-to-dwg): the same page with the English text written in.
import html as H
e = out
def must(a, b):
    global e
    if a not in e: raise SystemExit('not found: ' + a[:80])
    e = e.replace(a, b)
must('<html lang="zh-CN">', '<html lang="en">')
e = re.sub(r'<meta name="description" content="[^"]*">', '<meta name="description" content="' + H.escape("Free online PDF to DWG converter: turn PDF drawings exported from AutoCAD back into editable DWG (AutoCAD 2000) or DXF. Lines, dashes, colors and text are kept and the drawing scale can be restored. Runs in your browser; nothing is uploaded.") + '">', e)
must('<link rel="canonical" href="https://5cad2pdf.com/zh/pdf-to-dwg">', '<link rel="canonical" href="https://5cad2pdf.com/pdf-to-dwg">')
must('<meta property="og:url" content="https://5cad2pdf.com/zh/pdf-to-dwg">', '<meta property="og:url" content="https://5cad2pdf.com/pdf-to-dwg">')
e = e.replace('"url":"https://5cad2pdf.com/zh/pdf-to-dwg"', '"url":"https://5cad2pdf.com/pdf-to-dwg"')
e = re.sub(r'<meta property="og:title" content="[^"]*">', '<meta property="og:title" content="PDF to DWG Converter – Free, Online · cad2pdf">', e)
e = re.sub(r'<meta property="og:description" content="[^"]*">', '<meta property="og:description" content="Turn PDF drawings into editable DWG or DXF in your browser: lines and text kept, scale restored, nothing uploaded.">', e)
must('<meta property="og:locale" content="zh_CN">\n<meta property="og:locale:alternate" content="en_US">', '<meta property="og:locale" content="en_US">\n<meta property="og:locale:alternate" content="zh_CN">')
e = re.sub(r'<meta property="og:image:alt" content="[^"]*">', '<meta property="og:image:alt" content="PDF to DWG converter · 5cad2pdf.com">', e)
e = re.sub(r'<title>[^<]*</title>', '<title>' + H.escape(en['title']) + '</title>', e)
e = e.replace('"alternateName":"PDF 转 DWG"', '"alternateName":"PDF to DWG"').replace('"inLanguage":["zh-CN","en"]', '"inLanguage":"en"')
ld_en = {"@context": "https://schema.org", "@type": "FAQPage", "mainEntity": [
    {"@type": "Question", "name": qe, "acceptedAnswer": {"@type": "Answer", "text": ae}} for (_, _, qe, ae) in FAQ]}
e = re.sub(r'<script type="application/ld\+json">\{"@context": "https://schema.org", "@type": "FAQPage".*?</script>', lambda m: '<script type="application/ld+json">' + json.dumps(ld_en, ensure_ascii=False) + '</script>', e, flags=re.S)
cnt = [0]
def tr(m):
    k = m.group(3)
    if k not in en: raise SystemExit('no English for ' + k)
    cnt[0] += 1
    return m.group(1) + H.escape(en[k], quote=False) + m.group(5)
e = re.sub(r'(<([a-z0-9]+)\b[^>]*\bdata-i18n="(\w+)"[^>]*>)([^<]*)(</\2>)', tr, e)
e = re.sub(r'(<optgroup [^>]*data-i18n-label="(\w+)"[^>]*?)label="[^"]*"', lambda m: m.group(1) + 'label="' + H.escape(en[m.group(2)]) + '"', e)
e = re.sub(r'(<a [^>]*)href="([^"]*)" data-path="([^"]*)"( data-hash="([^"]*)")?', lambda m: m.group(1) + 'href="' + m.group(3) + (m.group(5) or '') + '" data-path="' + m.group(3) + '"' + (m.group(4) or ''), e)
e = e.replace('<button class="go" id="go" type="button">生成 DWG</button>', '<button class="go" id="go" type="button">Create DWG</button>')
e = e.replace('https://5cad2pdf.com/og-pdf2dwg.png', 'https://5cad2pdf.com/og-pdf2dwg-en.png')
open(os.path.join(ROOT, 'pdf-to-dwg.html'), 'w', encoding='utf-8').write(e)
print('wrote pdf-to-dwg.html,', cnt[0], 'texts in English')
