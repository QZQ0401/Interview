(() => {
  "use strict";

  const NS = {
    w: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    wp: "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
    a: "http://schemas.openxmlformats.org/drawingml/2006/main",
    r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    rel: "http://schemas.openxmlformats.org/package/2006/relationships",
    wps: "http://schemas.microsoft.com/office/word/2010/wordprocessingShape",
    wpg: "http://schemas.microsoft.com/office/word/2010/wordprocessingGroup",
    pic: "http://schemas.openxmlformats.org/drawingml/2006/picture"
  };
  const EMU_PER_PT = 12700;
  const TWIP_PER_PT = 20;
  const DEFAULT_FONT = '"Microsoft YaHei","PingFang SC","Noto Sans CJK SC","Microsoft JhengHei",Arial,sans-serif';

  const q = (node, ns, local) => node?.getElementsByTagNameNS(ns, local)?.[0] || null;
  const qa = (node, ns, local) => [...(node?.getElementsByTagNameNS(ns, local) || [])];
  const direct = (node, ns, local) => [...(node?.children || [])].find(el => el.namespaceURI === ns && el.localName === local) || null;
  const directAll = (node, ns, local) => [...(node?.children || [])].filter(el => el.namespaceURI === ns && el.localName === local);
  const wattr = (el, name) => el?.getAttributeNS(NS.w, name) ?? el?.getAttribute(`w:${name}`) ?? el?.getAttribute(name) ?? null;
  const rattr = (el, name) => el?.getAttributeNS(NS.r, name) ?? el?.getAttribute(`r:${name}`) ?? el?.getAttribute(name) ?? null;
  const num = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const emuPt = value => num(value) / EMU_PER_PT;
  const twipPt = value => num(value) / TWIP_PER_PT;
  const halfPt = value => num(value) / 2;
  const px = pt => `${Math.max(0, pt) * 96 / 72}px`;
  const xml = text => new DOMParser().parseFromString(text, "application/xml");
  const isParserError = doc => Boolean(doc.getElementsByTagName("parsererror")[0]);

  async function readXml(zip, path, optional = false) {
    const entry = zip.file(path);
    if (!entry) {
      if (optional) return null;
      throw new Error(`Word 文件缺少 ${path}`);
    }
    const text = await entry.async("text");
    const parsed = xml(text);
    if (isParserError(parsed)) throw new Error(`无法解析 ${path}`);
    return parsed;
  }

  function textLength(node) {
    return qa(node, NS.w, "t").reduce((sum, el) => sum + (el.textContent || "").length, 0);
  }

  async function inspect(file) {
    if (!window.JSZip) return { layoutHeavy: false, textBoxRatio: 0, anchors: 0 };
    const zip = await window.JSZip.loadAsync(await file.arrayBuffer());
    const doc = await readXml(zip, "word/document.xml");
    const total = textLength(doc);
    const tx = qa(doc, NS.w, "txbxContent").reduce((sum, el) => sum + textLength(el), 0);
    const anchors = qa(doc, NS.wp, "anchor").length;
    const ratio = total ? Math.min(1, tx / total) : 0;
    return {
      layoutHeavy: anchors >= 3 && ratio >= 0.55,
      textBoxRatio: ratio,
      anchors
    };
  }

  function pageMetrics(doc) {
    const sect = q(doc, NS.w, "sectPr");
    const pgSz = direct(sect, NS.w, "pgSz") || q(sect, NS.w, "pgSz");
    const pgMar = direct(sect, NS.w, "pgMar") || q(sect, NS.w, "pgMar");
    return {
      width: twipPt(wattr(pgSz, "w") || 11906),
      height: twipPt(wattr(pgSz, "h") || 16838),
      marginTop: twipPt(wattr(pgMar, "top") || 1440),
      marginBottom: twipPt(wattr(pgMar, "bottom") || 1440),
      marginLeft: twipPt(wattr(pgMar, "left") || 1440),
      marginRight: twipPt(wattr(pgMar, "right") || 1440)
    };
  }

  function buildRelationships(relsDoc) {
    const map = new Map();
    if (!relsDoc) return map;
    for (const rel of [...relsDoc.getElementsByTagName("Relationship")]) {
      const id = rel.getAttribute("Id");
      const target = rel.getAttribute("Target");
      if (id && target) map.set(id, target);
    }
    return map;
  }

  function normalizeWordTarget(target) {
    if (!target) return "";
    if (/^[a-z]+:/i.test(target)) return target;
    const parts = (target.startsWith("/") ? target.slice(1) : `word/${target}`).split("/");
    const out = [];
    for (const part of parts) {
      if (!part || part === ".") continue;
      if (part === "..") out.pop();
      else out.push(part);
    }
    return out.join("/");
  }

  function mimeFor(path) {
    const ext = String(path).split(".").pop().toLowerCase();
    return ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml", webp: "image/webp", emf: "image/x-emf", wmf: "image/wmf" })[ext] || "application/octet-stream";
  }

  async function resolveImage(zip, rels, rid, cache) {
    if (!rid) return "";
    if (cache.has(rid)) return cache.get(rid);
    const target = rels.get(rid);
    if (!target || /^[a-z]+:/i.test(target)) return "";
    const path = normalizeWordTarget(target);
    const entry = zip.file(path);
    if (!entry) return "";
    const b64 = await entry.async("base64");
    const url = `data:${mimeFor(path)};base64,${b64}`;
    cache.set(rid, url);
    return url;
  }

  function parseStyles(stylesDoc) {
    const styles = new Map();
    if (!stylesDoc) return styles;
    for (const style of qa(stylesDoc, NS.w, "style")) {
      const id = wattr(style, "styleId");
      if (!id) continue;
      styles.set(id, {
        basedOn: wattr(direct(style, NS.w, "basedOn"), "val") || "",
        pPr: direct(style, NS.w, "pPr"),
        rPr: direct(style, NS.w, "rPr")
      });
    }
    return styles;
  }

  function mergeStyleChain(styles, id, key, seen = new Set()) {
    if (!id || seen.has(id)) return [];
    seen.add(id);
    const item = styles.get(id);
    if (!item) return [];
    return [...mergeStyleChain(styles, item.basedOn, key, seen), item[key]].filter(Boolean);
  }

  function parseNumbering(numberingDoc) {
    const abstract = new Map();
    const nums = new Map();
    if (!numberingDoc) return { abstract, nums };
    for (const node of qa(numberingDoc, NS.w, "abstractNum")) {
      const id = wattr(node, "abstractNumId");
      if (!id) continue;
      const levels = new Map();
      for (const lvl of directAll(node, NS.w, "lvl")) {
        const ilvl = wattr(lvl, "ilvl") || "0";
        const pPr = direct(lvl, NS.w, "pPr");
        const ind = pPr ? direct(pPr, NS.w, "ind") : null;
        const rPr = direct(lvl, NS.w, "rPr");
        levels.set(ilvl, {
          fmt: wattr(direct(lvl, NS.w, "numFmt"), "val") || "bullet",
          text: wattr(direct(lvl, NS.w, "lvlText"), "val") || "•",
          start: num(wattr(direct(lvl, NS.w, "start"), "val"), 1),
          left: twipPt(wattr(ind, "left") || 0),
          hanging: twipPt(wattr(ind, "hanging") || 0),
          rPr
        });
      }
      abstract.set(id, levels);
    }
    for (const node of qa(numberingDoc, NS.w, "num")) {
      const id = wattr(node, "numId");
      const abs = wattr(direct(node, NS.w, "abstractNumId"), "val");
      if (id && abs) nums.set(id, abs);
    }
    return { abstract, nums };
  }

  function numberingInfo(numbering, numId, ilvl) {
    const absId = numbering.nums.get(String(numId));
    return numbering.abstract.get(String(absId))?.get(String(ilvl)) || null;
  }

  function parseColor(rPr) {
    const c = rPr ? direct(rPr, NS.w, "color") : null;
    const val = wattr(c, "val");
    if (!val || val === "auto") return "";
    return /^([0-9A-F]{6}|[0-9A-F]{3})$/i.test(val) ? `#${val}` : "";
  }

  function parseFont(rPr) {
    const fonts = rPr ? direct(rPr, NS.w, "rFonts") : null;
    const name = wattr(fonts, "eastAsia") || wattr(fonts, "ascii") || wattr(fonts, "hAnsi");
    return name ? `"${name}",${DEFAULT_FONT}` : "";
  }

  function applyRunPr(el, rPr) {
    if (!rPr) return;
    const font = parseFont(rPr);
    const color = parseColor(rPr);
    const size = halfPt(wattr(direct(rPr, NS.w, "sz"), "val") || 0);
    if (font) el.style.fontFamily = font;
    if (color) el.style.color = color;
    if (size) el.style.fontSize = `${size}pt`;
    if (direct(rPr, NS.w, "b") && wattr(direct(rPr, NS.w, "b"), "val") !== "0") el.style.fontWeight = "700";
    if (direct(rPr, NS.w, "i") && wattr(direct(rPr, NS.w, "i"), "val") !== "0") el.style.fontStyle = "italic";
    if (direct(rPr, NS.w, "u") && wattr(direct(rPr, NS.w, "u"), "val") !== "none") el.style.textDecoration = "underline";
    const spacing = wattr(direct(rPr, NS.w, "spacing"), "val");
    if (spacing) el.style.letterSpacing = `${num(spacing) / 20}pt`;
  }

  function applyParagraphPr(el, pPr) {
    if (!pPr) return;
    const spacing = direct(pPr, NS.w, "spacing");
    if (spacing) {
      const before = wattr(spacing, "before");
      const after = wattr(spacing, "after");
      const line = wattr(spacing, "line");
      const rule = wattr(spacing, "lineRule");
      if (before) el.style.marginTop = `${twipPt(before)}pt`;
      if (after) el.style.marginBottom = `${twipPt(after)}pt`;
      if (line) {
        if (rule === "exact" || rule === "atLeast") el.style.lineHeight = `${twipPt(line)}pt`;
        else el.style.lineHeight = String(num(line) / 240);
      }
    }
    const jc = wattr(direct(pPr, NS.w, "jc"), "val");
    if (jc === "center") el.style.textAlign = "center";
    else if (jc === "right" || jc === "end") el.style.textAlign = "right";
    else if (["both", "distribute", "thaiDistribute"].includes(jc)) el.style.textAlign = "justify";
    const ind = direct(pPr, NS.w, "ind");
    if (ind) {
      const left = twipPt(wattr(ind, "left") || wattr(ind, "start") || 0);
      const right = twipPt(wattr(ind, "right") || wattr(ind, "end") || 0);
      const first = twipPt(wattr(ind, "firstLine") || 0);
      const hanging = twipPt(wattr(ind, "hanging") || 0);
      if (left) el.style.paddingLeft = `${left}pt`;
      if (right) el.style.paddingRight = `${right}pt`;
      if (first) el.style.textIndent = `${first}pt`;
      if (hanging) el.style.textIndent = `${-hanging}pt`;
    }
    applyRunPr(el, direct(pPr, NS.w, "rPr"));
  }

  function renderRun(run, ctx) {
    const span = document.createElement("span");
    applyRunPr(span, direct(run, NS.w, "rPr"));
    for (const child of [...run.childNodes]) {
      if (child.nodeType !== 1) continue;
      if (child.namespaceURI === NS.w && child.localName === "t") {
        span.append(document.createTextNode(child.textContent || ""));
      } else if (child.namespaceURI === NS.w && child.localName === "tab") {
        span.append(document.createTextNode("\t"));
      } else if (child.namespaceURI === NS.w && ["br", "cr"].includes(child.localName)) {
        span.append(document.createElement("br"));
      } else if (child.namespaceURI === NS.w && child.localName === "drawing") {
        const inline = q(child, NS.wp, "inline");
        const blip = q(child, NS.a, "blip");
        const rid = rattr(blip, "embed");
        if (rid) {
          const holder = document.createElement("span");
          holder.dataset.resumeInlineRid = rid;
          const extent = q(inline, NS.wp, "extent");
          if (extent) {
            holder.dataset.resumeInlineWidth = String(emuPt(extent.getAttribute("cx")));
            holder.dataset.resumeInlineHeight = String(emuPt(extent.getAttribute("cy")));
          }
          span.append(holder);
          ctx.inlineImages.push(holder);
        }
      }
    }
    return span;
  }

  function appendInline(node, parent, ctx) {
    for (const child of [...node.childNodes]) {
      if (child.nodeType !== 1) continue;
      if (child.namespaceURI === NS.w && child.localName === "r") {
        parent.append(renderRun(child, ctx));
      } else if (child.namespaceURI === NS.w && child.localName === "hyperlink") {
        const a = document.createElement("span");
        a.style.color = "#1687bd";
        a.style.textDecoration = "underline";
        appendInline(child, a, ctx);
        parent.append(a);
      } else if (!(child.namespaceURI === NS.w && child.localName === "pPr")) {
        appendInline(child, parent, ctx);
      }
    }
  }

  function formatDecimal(n, fmt) {
    if (fmt === "lowerLetter") return `${String.fromCharCode(96 + Math.max(1, Math.min(26, n)))}`;
    if (fmt === "upperLetter") return `${String.fromCharCode(64 + Math.max(1, Math.min(26, n)))}`;
    return String(n);
  }

  function renderParagraph(p, ctx, counters) {
    const el = document.createElement("div");
    el.className = "resume-ooxml-p";
    const pPr = direct(p, NS.w, "pPr");
    const styleId = wattr(direct(pPr, NS.w, "pStyle"), "val");
    for (const stylePPr of mergeStyleChain(ctx.styles, styleId, "pPr")) applyParagraphPr(el, stylePPr);
    for (const styleRPr of mergeStyleChain(ctx.styles, styleId, "rPr")) applyRunPr(el, styleRPr);
    applyParagraphPr(el, pPr);

    const numPr = pPr ? direct(pPr, NS.w, "numPr") : null;
    if (numPr) {
      const numId = wattr(direct(numPr, NS.w, "numId"), "val");
      const ilvl = wattr(direct(numPr, NS.w, "ilvl"), "val") || "0";
      const info = numberingInfo(ctx.numbering, numId, ilvl);
      if (info) {
        const key = `${numId}:${ilvl}`;
        let label = info.text || "•";
        if (info.fmt !== "bullet") {
          const current = (counters.get(key) || (info.start - 1)) + 1;
          counters.set(key, current);
          label = label.replace(/%\d+/g, formatDecimal(current, info.fmt));
        } else if (/^[\uF000-\uF8FF]$/.test(label)) {
          label = "●";
        }
        const mark = document.createElement("span");
        mark.className = "resume-ooxml-num";
        mark.textContent = `${label} `;
        applyRunPr(mark, info.rPr);
        const left = info.left || 22;
        const hanging = info.hanging || 22;
        el.style.paddingLeft = `${left}pt`;
        el.style.textIndent = `${-hanging}pt`;
        el.append(mark);
      }
    }

    appendInline(p, el, ctx);
    if (!el.textContent && !el.querySelector("[data-resume-inline-rid]")) el.append(document.createElement("br"));
    return el;
  }

  function renderTable(tbl, ctx) {
    const table = document.createElement("table");
    table.className = "resume-ooxml-table";
    table.style.borderCollapse = "collapse";
    table.style.tableLayout = "fixed";
    table.style.width = "100%";
    const gridCols = direct(direct(tbl, NS.w, "tblGrid"), NS.w, "gridCol") ? directAll(direct(tbl, NS.w, "tblGrid"), NS.w, "gridCol") : [];
    const widths = gridCols.map(col => twipPt(wattr(col, "w") || 0));
    const total = widths.reduce((a, b) => a + b, 0);
    const counters = new Map();
    for (const tr of directAll(tbl, NS.w, "tr")) {
      const row = document.createElement("tr");
      let colIndex = 0;
      for (const tc of directAll(tr, NS.w, "tc")) {
        const cell = document.createElement("td");
        cell.style.padding = "0";
        cell.style.verticalAlign = "top";
        if (total && widths[colIndex]) cell.style.width = `${(widths[colIndex] / total) * 100}%`;
        const tcPr = direct(tc, NS.w, "tcPr");
        const tcMar = tcPr ? direct(tcPr, NS.w, "tcMar") : null;
        if (tcMar) {
          const top = twipPt(wattr(direct(tcMar, NS.w, "top"), "w") || 0);
          const right = twipPt(wattr(direct(tcMar, NS.w, "right"), "w") || 0);
          const bottom = twipPt(wattr(direct(tcMar, NS.w, "bottom"), "w") || 0);
          const left = twipPt(wattr(direct(tcMar, NS.w, "left"), "w") || 0);
          cell.style.padding = `${top}pt ${right}pt ${bottom}pt ${left}pt`;
        }
        for (const child of [...tc.children]) {
          if (child.namespaceURI === NS.w && child.localName === "p") cell.append(renderParagraph(child, ctx, counters));
          else if (child.namespaceURI === NS.w && child.localName === "tbl") cell.append(renderTable(child, ctx));
        }
        row.append(cell);
        colIndex += 1;
      }
      table.append(row);
    }
    return table;
  }

  function renderTextBoxContent(txbxContent, box, bodyPr, ctx) {
    const wrap = document.createElement("div");
    wrap.className = "resume-ooxml-textbox";
    wrap.style.position = "absolute";
    wrap.style.inset = "0";
    wrap.style.boxSizing = "border-box";
    wrap.style.overflow = "hidden";
    wrap.style.fontFamily = DEFAULT_FONT;
    wrap.style.fontSize = "10.5pt";
    wrap.style.color = "#404040";
    wrap.style.whiteSpace = "pre-wrap";
    wrap.style.wordBreak = "normal";
    wrap.style.overflowWrap = "break-word";

    const l = emuPt(bodyPr?.getAttribute("lIns") ?? 91440);
    const r = emuPt(bodyPr?.getAttribute("rIns") ?? 91440);
    const t = emuPt(bodyPr?.getAttribute("tIns") ?? 45720);
    const b = emuPt(bodyPr?.getAttribute("bIns") ?? 45720);
    wrap.style.padding = `${t}pt ${r}pt ${b}pt ${l}pt`;

    const anchor = bodyPr?.getAttribute("anchor");
    if (anchor === "ctr") {
      wrap.style.display = "flex";
      wrap.style.flexDirection = "column";
      wrap.style.justifyContent = "center";
    } else if (anchor === "b") {
      wrap.style.display = "flex";
      wrap.style.flexDirection = "column";
      wrap.style.justifyContent = "flex-end";
    }

    const counters = new Map();
    for (const child of [...txbxContent.children]) {
      if (child.namespaceURI === NS.w && child.localName === "p") wrap.append(renderParagraph(child, ctx, counters));
      else if (child.namespaceURI === NS.w && child.localName === "tbl") wrap.append(renderTable(child, ctx));
    }
    return wrap;
  }

  function solidFill(spPr) {
    const fill = direct(spPr, NS.a, "solidFill");
    if (!fill) return "";
    const rgb = direct(fill, NS.a, "srgbClr");
    const val = rgb?.getAttribute("val");
    return val ? `#${val}` : "";
  }

  function lineColor(spPr) {
    const ln = direct(spPr, NS.a, "ln");
    if (!ln || direct(ln, NS.a, "noFill")) return "";
    return solidFill(ln);
  }

  function geometry(spPr) {
    return direct(spPr, NS.a, "prstGeom")?.getAttribute("prst") || "rect";
  }

  function clipForGeometry(prst) {
    if (prst === "trapezoid") return "polygon(18% 0,82% 0,100% 100%,0 100%)";
    if (prst === "parallelogram") return "polygon(12% 0,100% 0,88% 100%,0 100%)";
    if (prst === "triangle") return "polygon(50% 0,100% 100%,0 100%)";
    if (prst === "rtTriangle") return "polygon(0 0,100% 100%,0 100%)";
    return "";
  }

  function xfrmValues(xfrm) {
    const off = direct(xfrm, NS.a, "off");
    const ext = direct(xfrm, NS.a, "ext");
    return {
      x: num(off?.getAttribute("x")),
      y: num(off?.getAttribute("y")),
      w: num(ext?.getAttribute("cx")),
      h: num(ext?.getAttribute("cy"))
    };
  }

  function mapperForGroup(group, outerBox) {
    const grpSpPr = direct(group, NS.wpg, "grpSpPr") || direct(group, NS.a, "grpSpPr");
    const xfrm = grpSpPr ? direct(grpSpPr, NS.a, "xfrm") : null;
    const chOff = xfrm ? direct(xfrm, NS.a, "chOff") : null;
    const chExt = xfrm ? direct(xfrm, NS.a, "chExt") : null;
    const cx0 = num(chOff?.getAttribute("x"));
    const cy0 = num(chOff?.getAttribute("y"));
    const cw = num(chExt?.getAttribute("cx"), outerBox.w * EMU_PER_PT);
    const ch = num(chExt?.getAttribute("cy"), outerBox.h * EMU_PER_PT);
    return value => ({
      x: outerBox.x + (value.x - cx0) * outerBox.w / (cw || 1),
      y: outerBox.y + (value.y - cy0) * outerBox.h / (ch || 1),
      w: value.w * outerBox.w / (cw || 1),
      h: value.h * outerBox.h / (ch || 1)
    });
  }

  function outerBoxForNestedGroup(group, parentMapper) {
    const grpSpPr = direct(group, NS.wpg, "grpSpPr") || direct(group, NS.a, "grpSpPr");
    const xfrm = grpSpPr ? direct(grpSpPr, NS.a, "xfrm") : null;
    if (!xfrm) return null;
    return parentMapper(xfrmValues(xfrm));
  }

  function makeBoxElement(box, z = 1) {
    const el = document.createElement("div");
    el.style.position = "absolute";
    el.style.left = `${box.x}pt`;
    el.style.top = `${box.y}pt`;
    el.style.width = `${Math.max(0.1, box.w)}pt`;
    el.style.height = `${Math.max(0.1, box.h)}pt`;
    el.style.boxSizing = "border-box";
    el.style.zIndex = String(z);
    return el;
  }

  function renderShape(wsp, box, page, ctx, z) {
    const spPr = direct(wsp, NS.wps, "spPr");
    const el = makeBoxElement(box, z);
    const bg = solidFill(spPr);
    const line = lineColor(spPr);
    if (bg) el.style.background = bg;
    const prst = geometry(spPr);
    const clip = clipForGeometry(prst);
    if (clip && !q(wsp, NS.w, "txbxContent")) el.style.clipPath = clip;
    if (line) {
      const ln = direct(spPr, NS.a, "ln");
      el.style.border = `${Math.max(0.4, emuPt(ln?.getAttribute("w") || 6350))}pt solid ${line}`;
    }
    const tx = q(wsp, NS.w, "txbxContent");
    if (tx) {
      const bodyPr = direct(wsp, NS.wps, "bodyPr");
      el.append(renderTextBoxContent(tx, box, bodyPr, ctx));
    }
    page.append(el);
  }

  async function renderGroup(group, outerBox, page, ctx, zBase) {
    const mapper = mapperForGroup(group, outerBox);
    let order = 0;
    for (const child of [...group.children]) {
      if (child.namespaceURI === NS.wps && child.localName === "wsp") {
        const spPr = direct(child, NS.wps, "spPr");
        const xfrm = spPr ? direct(spPr, NS.a, "xfrm") : null;
        if (!xfrm) continue;
        renderShape(child, mapper(xfrmValues(xfrm)), page, ctx, zBase + order++);
      } else if (child.namespaceURI === NS.wpg && ["grpSp", "wgp"].includes(child.localName)) {
        const nestedBox = outerBoxForNestedGroup(child, mapper);
        if (nestedBox) await renderGroup(child, nestedBox, page, ctx, zBase + order++);
      }
    }
  }

  function posOffset(anchor, axis, metrics) {
    const node = direct(anchor, NS.wp, axis === "x" ? "positionH" : "positionV");
    const offset = direct(node, NS.wp, "posOffset");
    if (!offset) return 0;
    const pt = emuPt(offset.textContent || 0);
    if (axis === "x") {
      const ref = node?.getAttribute("relativeFrom");
      if (ref === "page") return pt;
      if (ref === "margin") return metrics.marginLeft + pt;
      return metrics.marginLeft + pt;
    }
    const ref = node?.getAttribute("relativeFrom");
    if (ref === "page") return pt;
    if (ref === "margin") return metrics.marginTop + pt;
    // Word anchors positioned relative to the first paragraph need the paragraph baseline/origin.
    // The extra ~40 pt mirrors Word's first-line placement for floating resume canvases.
    return metrics.marginTop + 40 + pt;
  }

  function anchorBox(anchor, metrics) {
    const ext = direct(anchor, NS.wp, "extent");
    return {
      x: posOffset(anchor, "x", metrics),
      y: posOffset(anchor, "y", metrics),
      w: emuPt(ext?.getAttribute("cx")),
      h: emuPt(ext?.getAttribute("cy"))
    };
  }

  async function hydrateInlineImages(ctx) {
    for (const holder of ctx.inlineImages) {
      const rid = holder.dataset.resumeInlineRid;
      const src = await resolveImage(ctx.zip, ctx.rels, rid, ctx.imageCache);
      if (!src) continue;
      const img = document.createElement("img");
      img.src = src;
      img.style.display = "inline-block";
      img.style.verticalAlign = "top";
      const w = num(holder.dataset.resumeInlineWidth);
      const h = num(holder.dataset.resumeInlineHeight);
      if (w) img.style.width = `${w}pt`;
      if (h) img.style.height = `${h}pt`;
      img.style.objectFit = "cover";
      holder.replaceWith(img);
    }
    ctx.inlineImages.length = 0;
  }

  async function render(file, host) {
    if (!window.JSZip) throw new Error("Word 兼容渲染组件 JSZip 未加载");
    const zip = await window.JSZip.loadAsync(await file.arrayBuffer());
    const [doc, relsDoc, stylesDoc, numberingDoc] = await Promise.all([
      readXml(zip, "word/document.xml"),
      readXml(zip, "word/_rels/document.xml.rels", true),
      readXml(zip, "word/styles.xml", true),
      readXml(zip, "word/numbering.xml", true)
    ]);
    const metrics = pageMetrics(doc);
    const page = document.createElement("section");
    page.className = "resume-ooxml-page";
    page.style.position = "relative";
    page.style.boxSizing = "border-box";
    page.style.width = `${metrics.width}pt`;
    page.style.height = `${metrics.height}pt`;
    page.style.background = "#fff";
    page.style.overflow = "hidden";
    page.style.fontFamily = DEFAULT_FONT;

    host.innerHTML = "";
    host.append(page);
    const ctx = {
      zip,
      rels: buildRelationships(relsDoc),
      styles: parseStyles(stylesDoc),
      numbering: parseNumbering(numberingDoc),
      imageCache: new Map(),
      inlineImages: []
    };

    const anchors = qa(doc, NS.wp, "anchor");
    for (let index = 0; index < anchors.length; index += 1) {
      const anchor = anchors[index];
      const box = anchorBox(anchor, metrics);
      const gd = q(anchor, NS.a, "graphicData");
      const uri = gd?.getAttribute("uri") || "";
      const z = num(anchor.getAttribute("relativeHeight"), 1) + index;
      if (uri.includes("wordprocessingGroup")) {
        const group = direct(gd, NS.wpg, "wgp") || q(gd, NS.wpg, "wgp");
        if (group) await renderGroup(group, box, page, ctx, z);
      } else if (uri.includes("wordprocessingShape")) {
        const wsp = direct(gd, NS.wps, "wsp") || q(gd, NS.wps, "wsp");
        if (wsp) renderShape(wsp, box, page, ctx, z);
      } else if (uri.includes("picture")) {
        const blip = q(gd, NS.a, "blip");
        const rid = rattr(blip, "embed");
        const src = await resolveImage(zip, ctx.rels, rid, ctx.imageCache);
        if (src) {
          const holder = makeBoxElement(box, z);
          const img = document.createElement("img");
          img.src = src;
          img.style.width = "100%";
          img.style.height = "100%";
          img.style.objectFit = "cover";
          holder.append(img);
          page.append(holder);
        }
      }
    }
    await hydrateInlineImages(ctx);
    return [page];
  }

  window.ResumeDocxFallback = { inspect, render };
})();
