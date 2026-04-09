import { getContext, saveMetadataDebounced, extension_settings } from "../../../extensions.js";
import { eventSource, event_types } from "../../../../script.js";

const EXT = "flow-and-brand-sheet";
const META_KEY = "fabSheetData";
const SETTINGS_KEY = "fabSheet";

// ============================================================
// DEFAULT SCHEMA
// ============================================================

const DEFAULT_SCHEMA = [
  { name: "시공간", columns: ["날짜", "시간", "위치", "등장 인물"] },
  { name: "캐릭터 시트", columns: ["인물", "신체적 특징", "성격", "직업", "취미", "좋아하는 것", "거주지", "기타 중요 정보"] },
  { name: "관계", columns: ["인물", "관계", "태도", "호감도"] },
  { name: "임무/특성", columns: ["인물", "임무 or 특성", "위치 or 계열", "기간 or 효과"] },
  { name: "이벤트/의식", columns: ["인물", "이벤트/의식", "날짜", "위치", "감정/결과"] },
  { name: "소지품/전투", columns: ["소유자", "아이템/전투", "상세", "효과/상태"] },
];

// ============================================================
// SETTINGS
// ============================================================

function getSettings() {
  if (!extension_settings[SETTINGS_KEY]) {
    extension_settings[SETTINGS_KEY] = {
      schema: JSON.parse(JSON.stringify(DEFAULT_SCHEMA)),
      hideTableEdit: true,
      panelWidth: 400,
      injectEnabled: true,
      injectTables: {},
      injectDepth: 4,
    };
  }

  const s = extension_settings[SETTINGS_KEY];

  // Ensure injectTables has entry for every schema table
  if (!s.injectTables) s.injectTables = {};
  for (let i = 0; i < s.schema.length; i++) {
    if (s.injectTables[i] === undefined) s.injectTables[i] = true;
  }

  // Clean up entries beyond schema length
  for (const k of Object.keys(s.injectTables)) {
    if (parseInt(k) >= s.schema.length) delete s.injectTables[k];
  }

  if (s.injectEnabled === undefined) s.injectEnabled = true;
  if (s.injectDepth === undefined) s.injectDepth = 4;

  return s;
}

function saveSettings() {
  const context = getContext();
  context.saveSettingsDebounced();
}

function getSchema() { return getSettings().schema; }

function setSchema(ns) {
  getSettings().schema = ns;
  saveSettings();
}

function resetSchema() {
  const s = getSettings();
  s.schema = JSON.parse(JSON.stringify(DEFAULT_SCHEMA));
  s.injectTables = {};
  for (let i = 0; i < s.schema.length; i++) s.injectTables[i] = true;
  saveSettings();
}

// ============================================================
// DATA
// ============================================================

function buildEmpty() {
  const schema = getSchema();
  const tables = {};
  for (let i = 0; i < schema.length; i++) {
    tables[i] = { name: schema[i].name, columns: [...schema[i].columns], rows: [] };
  }
  return tables;
}

function getTables() {
  const ctx = getContext();
  if (!ctx.chatMetadata[META_KEY]) {
    ctx.chatMetadata[META_KEY] = buildEmpty();
    saveMetadataDebounced();
  }

  const schema = getSchema();
  const tables = ctx.chatMetadata[META_KEY];

  for (let i = 0; i < schema.length; i++) {
    if (!tables[i]) {
      tables[i] = { name: schema[i].name, columns: [...schema[i].columns], rows: [] };
    } else {
      tables[i].name = schema[i].name;
      const oldCols = tables[i].columns;
      const newCols = schema[i].columns;
      if (JSON.stringify(oldCols) !== JSON.stringify(newCols)) {
        for (const row of tables[i].rows) {
          for (let ci = 0; ci < newCols.length; ci++) {
            if (row[ci] === undefined) row[ci] = "";
          }
          for (const key of Object.keys(row)) {
            if (parseInt(key) >= newCols.length) delete row[key];
          }
        }
        tables[i].columns = [...newCols];
      }
    }
  }

  for (const k of Object.keys(tables).map(Number)) {
    if (k >= schema.length) delete tables[k];
  }

  return tables;
}

function saveTables() { saveMetadataDebounced(); }

function resetTables() {
  const ctx = getContext();
  ctx.chatMetadata[META_KEY] = buildEmpty();
}

function execInsert(ti, data) {
  const t = getTables()[ti];
  if (!t) return;
  const row = {};
  for (let i = 0; i < t.columns.length; i++) row[i] = data[i] !== undefined ? String(data[i]) : "";
  t.rows.push(row);
}

function execDelete(ti, ri) {
  const t = getTables()[ti];
  if (!t || !t.rows[ri]) return;
  t.rows.splice(ri, 1);
}

function execUpdate(ti, ri, data) {
  const t = getTables()[ti];
  if (!t || !t.rows[ri]) return;
  for (const [ci, val] of Object.entries(data)) t.rows[ri][parseInt(ci)] = String(val);
}

// ============================================================
// PARSER
// ============================================================

function parseDataObj(str) {
  const d = {};
  const re = /(\d+)\s*:\s*(?:"([^"]*?)"|'([^']*?)'|([^\s,}]+))/g;
  let m;
  while ((m = re.exec(str)) !== null) d[parseInt(m[1])] = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] || "";
  return d;
}

function parseEdits(text) {
  const ops = [];
  const re = /<tableEdit>([\s\S]*?)<\/tableEdit>|<!--\s*tableEdit\s*-->([\s\S]*?)<!--\s*\/tableEdit\s*-->/gi;
  let em;
  while ((em = re.exec(text)) !== null) {
    const block = (em[1] || em[2] || "").replace(/<!--/g, "").replace(/-->/g, "");
    for (const line of block.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("//")) continue;
      let m;
      if ((m = t.match(/insertRow\(\s*(\d+)\s*,\s*\{([^}]+)\}\s*\)/))) ops.push({ type: "insert", ti: parseInt(m[1]), data: parseDataObj(m[2]) });
      else if ((m = t.match(/deleteRow\(\s*(\d+)\s*,\s*(\d+)\s*\)/))) ops.push({ type: "delete", ti: parseInt(m[1]), ri: parseInt(m[2]) });
      else if ((m = t.match(/updateRow\(\s*(\d+)\s*,\s*(\d+)\s*,\s*\{([^}]+)\}\s*\)/))) ops.push({ type: "update", ti: parseInt(m[1]), ri: parseInt(m[2]), data: parseDataObj(m[3]) });
    }
  }
  return ops;
}

function applyOps(ops) {
  const del = ops.filter(o => o.type === "delete").sort((a, b) => a.ti !== b.ti ? b.ti - a.ti : b.ri - a.ri);
  for (const o of del) execDelete(o.ti, o.ri);
  for (const o of ops.filter(o => o.type === "update")) execUpdate(o.ti, o.ri, o.data);
  for (const o of ops.filter(o => o.type === "insert")) execInsert(o.ti, o.data);
}

// ============================================================
// MESSAGE PROCESSING
// ============================================================

function processMsg(text) {
  if (!text) return false;
  const ops = parseEdits(text);
  if (ops.length > 0) { applyOps(ops); saveTables(); refreshPanel(); return true; }
  return false;
}

function scanAll() {
  const ctx = getContext();
  if (!ctx.chat || ctx.chat.length === 0) return;
  resetTables();
  for (const msg of ctx.chat) {
    if (msg.mes) { const ops = parseEdits(msg.mes); if (ops.length > 0) applyOps(ops); }
  }
  saveTables();
  refreshPanel();
  console.log("[FAB] Full scan complete.");
}

// ============================================================
// SYSTEM PROMPT INJECTION
// ============================================================

function buildPrompt() {
  const settings = getSettings();

  // If injection is globally disabled, return empty
  if (!settings.injectEnabled) return "";

  const tables = getTables();
  const enabledIndices = Object.entries(settings.injectTables)
    .filter(([_, v]) => v)
    .map(([k]) => parseInt(k))
    .sort((a, b) => a - b);

  // If no tables enabled, return empty
  if (enabledIndices.length === 0) return "";

  let p = "\n[FAB TRPG Data Tables — Current State]\n";
  p += `(Injected tables: ${enabledIndices.join(", ")})\n`;

  for (const idx of enabledIndices) {
    const table = tables[idx];
    if (!table) continue;

    p += `\n### Table ${idx}: ${table.name}\n`;
    p += `Columns: ${table.columns.join(" | ")}\n`;
    if (table.rows.length === 0) {
      p += "(empty)\n";
    } else {
      for (let ri = 0; ri < table.rows.length; ri++) {
        const vals = table.columns.map((_, ci) => table.rows[ri][ci] || "").join(" | ");
        p += `[${ri}] ${vals}\n`;
      }
    }
  }

  p += `\n[Table Edit Instructions]
When table data changes during the narrative, output modifications inside a <tableEdit> block at the END of your response.
Commands:
  insertRow(tableIndex, {colIndex: "value", ...})
  updateRow(tableIndex, rowIndex, {colIndex: "newValue", ...})
  deleteRow(tableIndex, rowIndex)

Available table indices for editing: ${enabledIndices.join(", ")}

Example:
<tableEdit>
updateRow(1, 0, {2: "newValue"})
insertRow(3, {0: "name", 1: "data", 2: "location", 3: "Active"})
</tableEdit>

Rules:
- Include <tableEdit> ONLY when data changes. Omit when nothing changes.
- Use exact row indices from the current state above.
- Place <tableEdit> AFTER the narrative response.
- Do NOT include <tableEdit> inside narrative prose.\n`;

  return p;
}

function injectPrompt() {
  const ctx = getContext();
  if (!ctx.extensionPrompts) ctx.extensionPrompts = {};

  const settings = getSettings();
  const prompt = buildPrompt();

  if (!prompt) {
    // Remove injection if disabled
    delete ctx.extensionPrompts[EXT];
    return;
  }

  ctx.extensionPrompts[EXT] = {
    value: prompt,
    position: 1,
    depth: settings.injectDepth,
    role: 0,
  };
}

// ============================================================
// HIDE <tableEdit>
// ============================================================

function hideBlocks() {
  if (!getSettings().hideTableEdit) return;
  document.querySelectorAll(".mes_text").forEach(el => {
    if (el.dataset.fabProcessed) return;
    el.dataset.fabProcessed = "true";
    const html = el.innerHTML;
    const cleaned = html
      .replace(/<tableEdit>[\s\S]*?<\/tableEdit>/gi, "")
      .replace(/<tableEdit>[\s\S]*?<\/tableEdit>/gi, "");
    if (cleaned !== html) el.innerHTML = cleaned;
  });
}

// ============================================================
// RENDER HELPERS
// ============================================================

function parseAttrs(s) { const r = {}; if (!s) return r; s.split("/").forEach(p => { const [k, v] = p.split(":"); if (k && v) r[k.trim()] = parseInt(v) || v.trim(); }); return r; }
function parseDerived(s) { const r = {}; if (!s) return r; s.split("/").forEach(p => { const [k, v] = p.split(":"); if (!k || !v) return; const m = v.match(/(\d+)\((\d+)\)/); if (m) r[k.trim()] = { c: parseInt(m[1]), m: parseInt(m[2]) }; else { const n = parseInt(v) || 0; r[k.trim()] = { c: n, m: n }; } }); return r; }
const ATTR_KR = { COR: "육신", SEN: "감응", VOL: "의지", COD: "지식", NEX: "연결" };
function attrKr(k) { return ATTR_KR[k] || k; }
function demClr(v) { return v <= 5 ? "#66bb6a" : v <= 10 ? "#fdd835" : v <= 15 ? "#ff9800" : v <= 19 ? "#ef5350" : "#333"; }
function demGrd(v) { return v <= 5 ? "#2e7d32,#66bb6a" : v <= 10 ? "#f9a825,#fdd835" : v <= 15 ? "#ef6c00,#ff9800" : v <= 19 ? "#c62828,#ef5350" : "#1a1a1a,#333"; }
function demStg(v) { return v <= 5 ? "불안" : v <= 10 ? "균열" : v <= 15 ? "침식" : v <= 19 ? "심연" : "붕괴"; }
function grdClr(g) { return { D: "#888", C: "#4fc3f7", B: "#ab47bc", A: "#ffa726", S: "#ef5350" }[(g || "").toUpperCase()] || "#888"; }
function trtClr(l) { const s = (l || "").toLowerCase(); return s.includes("확장") || s.includes("expanded") ? "#7733cc" : s.includes("변질") || s.includes("corrupted") ? "#cc3333" : "#3366cc"; }
function trtLbl(l) { const s = (l || "").toLowerCase(); return s.includes("확장") || s.includes("expanded") ? "확장" : s.includes("변질") || s.includes("corrupted") ? "변질" : "기본"; }
function stClr(s) { const l = (s || "").toLowerCase(); return l.includes("active") || l.includes("진행") ? "#66bb6a" : l.includes("complete") || l.includes("완료") ? "#4fc3f7" : l.includes("fail") || l.includes("실패") ? "#ef5350" : "#888"; }
function stLbl(s) { const l = (s || "").toLowerCase(); return l.includes("active") || l.includes("진행") ? "진행중" : l.includes("complete") || l.includes("완료") ? "완료" : l.includes("fail") || l.includes("실패") ? "실패" : l.includes("cancel") || l.includes("취소") ? "취소" : s || "?"; }
function pct(c, m) { return Math.round((c / Math.max(m, 1)) * 100); }
function hpClr(c, m) { const r = m > 0 ? c / m : 0; return r > 0.5 ? "#66bb6a" : r > 0.25 ? "#ff9800" : "#ef5350"; }

// ============================================================
// RENDER TABS (character, inventory, missions, status, raw unchanged)
// ============================================================

function renderCharacter() {
  const t = getTables(); const t1 = t[1], t2 = t[2], t3 = t[3];
  if (!t1 || t1.rows.length === 0) return '<div class="fab-empty">캐릭터 데이터 없음</div>';
  let h = "";
  for (const row of t1.rows) {
    const nm = row[0] || "?", at = parseAttrs(row[1]), dr = parseDerived(row[2]);
    const jobs = row[3] || "?", magic = row[4] || "?", stage = row[5] || "?";
    const affil = (row[6] || "?").replace(/\//g, " · "), other = row[7] || "";
    const vit = dr.VIT || { c: 0, m: 1 }, ani = dr.ANI || { c: 0, m: 1 }, dem = dr.DEM || { c: 0, m: 20 }, dv = dem.c;
    let status = "없음"; const sm = other.match(/[Ss]tatus:([^/]*)/i) || other.match(/상태:([^/]*)/i); if (sm) status = sm[1].trim() || "없음";
    const traits = []; if (t3) for (const r of t3.rows) if ((r[0] || "").toLowerCase().includes(nm.toLowerCase()) && ((r[1] || "").startsWith("특성:") || (r[1] || "").startsWith("Trait:"))) traits.push({ name: (r[1] || "").replace(/^(특성:|Trait:)/, ""), lineage: r[2] || "", effect: r[3] || "" });
    const rels = []; if (t2) for (const r of t2.rows) if ((r[0] || "").toLowerCase().includes(nm.toLowerCase())) rels.push({ dir: r[0] || "", att: r[2] || "", bond: parseInt(r[3]) || 0 });
    h += `<div class="fab-card"><div class="fab-char-hd"><div class="fab-char-nm">${nm}</div><div class="fab-char-sub">${jobs} — ${stage}</div><div class="fab-char-af">${affil}</div></div><div class="fab-ag">${["COR", "SEN", "VOL", "COD", "NEX"].map(k => `<div class="fab-ab"><div class="fab-al">${attrKr(k)}</div><div class="fab-av">${at[k] || "?"}</div><div class="fab-ae">${k}</div></div>`).join("")}</div><div class="fab-bs"><div class="fab-bg"><div class="fab-bh"><span><span class="fab-ic" style="color:#66bb6a">♥</span> 생명력</span><span class="fab-bn">${vit.c}/${vit.m}</span></div><div class="fab-bt"><div class="fab-bf fab-vit" style="width:${pct(vit.c, vit.m)}%"></div></div></div><div class="fab-bg"><div class="fab-bh"><span><span class="fab-ic" style="color:#42a5f5">✦</span> 정신력</span><span class="fab-bn">${ani.c}/${ani.m}</span></div><div class="fab-bt"><div class="fab-bf fab-ani" style="width:${pct(ani.c, ani.m)}%"></div></div></div><div class="fab-bg"><div class="fab-bh"><span><span class="fab-ic" style="color:${demClr(dv)}">◆</span> 광기도 <span class="fab-dt" style="color:${demClr(dv)}">[${demStg(dv)}]</span></span><span class="fab-bn">${dv}/20</span></div><div class="fab-bt"><div class="fab-bf" style="width:${pct(dv, 20)}%;background:linear-gradient(90deg,${demGrd(dv)})"></div></div></div></div><div class="fab-sc"><div class="fab-sl">상태</div><span class="fab-tg">${status}</span></div>${traits.length > 0 ? `<div class="fab-sc"><div class="fab-st">⟐ 특성</div>${traits.map(t => `<div class="fab-tr"><span class="fab-tb" style="background:${trtClr(t.lineage)}">${trtLbl(t.lineage)}</span><span class="fab-tn">${t.name}</span><span class="fab-tl">${(t.lineage || "").split("/")[0]}</span></div><div class="fab-te">${t.effect}</div>`).join("")}</div>` : ""}${rels.length > 0 ? `<div class="fab-sc"><div class="fab-st">⟐ 인연</div>${rels.map(r => `<div class="fab-rr"><span class="fab-rn">${r.dir}</span><span class="fab-ra">${r.att}</span><div class="fab-bd">${Array.from({ length: 10 }, (_, i) => `<div class="fab-d ${i < r.bond ? "f" : ""}"></div>`).join("")}</div></div>`).join("")}</div>` : ""}<div class="fab-ft">마법 구현: <span class="fab-hl">${magic}</span></div></div>`;
  }
  return h;
}

function renderInventory() {
  const t = getTables(); const t1 = t[1], t5 = t[5];
  if (!t1 || t1.rows.length === 0) return '<div class="fab-empty">데이터 없음</div>';
  let h = "";
  for (const cr of t1.rows) {
    const cn = cr[0] || "?"; const items = [];
    if (t5) for (const r of t5.rows) { const o = (r[0] || "").toLowerCase(), c1 = r[1] || ""; if (o.includes(cn.toLowerCase()) && (c1.startsWith("Equip:") || c1.startsWith("장비:"))) { const nm = c1.replace(/^(Equip:|장비:)/, "").trim(), pts = (r[2] || "").split("/"); items.push({ name: nm, grade: pts[0] || "?", type: pts[1] || "?", eq: (pts[2] || "").toUpperCase() === "Y", qty: parseInt(pts[3]) || 1, eff: r[3] || "" }); } }
    h += `<div class="fab-card"><div class="fab-ch">⟐ ${cn} ⟐</div>${items.length === 0 ? '<div class="fab-empty">소지품 없음</div>' : items.map(i => `<div class="fab-ii${i.eq ? " eq" : ""}" style="border-left:3px solid ${grdClr(i.grade)}"><div class="fab-it"><div><span class="fab-in">${i.name}</span><span class="fab-ig" style="background:${grdClr(i.grade)}">${i.grade}</span></div><span class="fab-iq">x${i.qty}</span></div><div class="fab-ix"><span class="fab-iv">${i.type}</span><span class="fab-iv ${i.eq ? "teq" : "tuq"}">${i.eq ? "장착중" : "미장착"}</span></div><div class="fab-ie">${i.eff}</div></div>`).join("")}</div>`;
  }
  return h;
}

function renderMissions() {
  const t = getTables(); const t3 = t[3], t4 = t[4];
  let h = '<div class="fab-card"><div class="fab-ch">⟐ 임무 기록 ⟐</div>';
  const ms = []; if (t3) for (const r of t3.rows) { const c1 = (r[1] || "").toLowerCase(); if (c1.startsWith("mission:") || c1.startsWith("임무:")) ms.push({ char: r[0] || "", name: (r[1] || "").replace(/^(Mission:|임무:|mission:)/i, "").trim(), loc: r[2] || "", st: r[3] || "" }); }
  h += ms.length === 0 ? '<div class="fab-empty">등록된 임무 없음</div>' : ms.map(m => `<div class="fab-mi" style="border-left:3px solid ${stClr(m.st)}"><div class="fab-mt"><span class="fab-mn">${m.name.replace(/_/g, " ")}</span><span class="fab-ms" style="background:${stClr(m.st)}">${stLbl(m.st)}</span></div><div class="fab-md">📍 ${m.loc.replace(/_/g, " ")} · 👤 ${m.char}</div></div>`).join("");
  const evs = []; if (t4) for (const r of t4.rows) evs.push({ char: r[0] || "", sum: r[1] || "", date: r[2] || "", loc: r[3] || "", emo: r[4] || "" });
  if (evs.length > 0) { h += '<div class="fab-st" style="margin-top:16px">⟐ 이벤트 ⟐</div>'; h += evs.map(e => `<div class="fab-ei" style="border-left:3px solid ${(e.sum.startsWith("Ritual:") || e.sum.startsWith("의식:")) ? "#ab47bc" : "#444477"}"><div class="fab-es">${e.sum.replace(/_/g, " ")}</div><div class="fab-ed">${e.char} · ${e.date} · ${(e.loc || "").replace(/_/g, " ")}</div>${e.emo ? `<div class="fab-ee">${e.emo.replace(/_/g, " ")}</div>` : ""}</div>`).join(""); }
  return h + "</div>";
}

function renderStatus() {
  const t = getTables(); const t0 = t[0], t1 = t[1], t3 = t[3], t5 = t[5];
  const sc = t0 && t0.rows.length > 0 ? { date: t0.rows[0][0] || "?", time: t0.rows[0][1] || "?", loc: (t0.rows[0][2] || "?").replace(/_/g, " "), chars: (t0.rows[0][3] || "?").replace(/\//g, ", ") } : { date: "?", time: "?", loc: "?", chars: "?" };
  let h = `<div class="fab-card"><div class="fab-sb"><span>📅 ${sc.date}</span><span>🕐 ${sc.time}</span><span>📍 ${sc.loc}</span></div><div class="fab-scc">등장: ${sc.chars}</div>`;
  if (t1) for (const row of t1.rows) {
    const nm = row[0] || "?", dr = parseDerived(row[2]), jobs = row[3] || "?", stage = row[5] || "?", other = row[7] || "";
    const vit = dr.VIT || { c: 0, m: 1 }, ani = dr.ANI || { c: 0, m: 1 }, dem = dr.DEM || { c: 0, m: 20 }, dv = dem.c;
    let status = "없음"; const sm = other.match(/[Ss]tatus:([^/]*)/i) || other.match(/상태:([^/]*)/i); if (sm) status = sm[1].trim() || "없음";
    let mc = 0; if (t3) for (const r of t3.rows) { const c1 = (r[1] || "").toLowerCase(); if ((r[0] || "").toLowerCase().includes(nm.toLowerCase()) && (c1.startsWith("mission:") || c1.startsWith("임무:"))) mc++; }
    let ic = 0; if (t5) for (const r of t5.rows) { const c1 = (r[1] || "").toLowerCase(); if ((r[0] || "").toLowerCase().includes(nm.toLowerCase()) && (c1.startsWith("equip:") || c1.startsWith("장비:"))) ic++; }
    h += `<div class="fab-sr"><div class="fab-srt"><span class="fab-srn">${nm}</span><span class="fab-srs">${stage} — ${jobs}</span></div><div class="fab-ss"><span><span style="color:#66bb6a">♥</span> <span style="color:${hpClr(vit.c, vit.m)}">${vit.c}</span><span class="fab-dm">/${vit.m}</span></span><span><span style="color:#42a5f5">✦</span> ${ani.c}<span class="fab-dm">/${ani.m}</span></span><span><span style="color:${demClr(dv)}">◆</span> <span style="color:${demClr(dv)}">${dv}</span></span></div><div class="fab-smm"><span class="fab-sm">${status}</span><span class="fab-sm">임무:${mc}개</span><span class="fab-sm">장비:${ic}개</span></div></div>`;
  }
  return h + "</div>";
}

function renderRaw() {
  const tables = getTables(); let h = "";
  for (const [idx, table] of Object.entries(tables)) {
    h += `<div class="fab-card"><div class="fab-ch">테이블 ${idx}: ${table.name}</div><table class="fab-rt"><thead><tr><th class="fab-rth">#</th>${table.columns.map(c => `<th class="fab-rth">${c}</th>`).join("")}</tr></thead><tbody>${table.rows.length === 0 ? `<tr><td colspan="${table.columns.length + 1}" class="fab-rte">데이터 없음</td></tr>` : table.rows.map((row, ri) => `<tr><td class="fab-rtd fab-ri">${ri}</td>${table.columns.map((_, ci) => `<td class="fab-rtd">${row[ci] || ""}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  }
  return h;
}

// ============================================================
// RENDER — SETTINGS (UPDATED)
// ============================================================

function renderSettings() {
  const settings = getSettings();
  const schema = settings.schema;

  let h = "";

  // ---- General Options ----
  h += `<div class="fab-card">
    <div class="fab-ch">⚙ 일반 설정</div>
    <div class="fab-set-section">
      <label class="fab-set-chk">
        <input type="checkbox" id="fab-opt-hide" ${settings.hideTableEdit ? "checked" : ""}>
        <span>채팅에서 <tableEdit> 숨기기</span>
      </label>
    </div>
    <div class="fab-set-section">
      <div class="fab-set-label">패널 너비 (px)</div>
      <input type="number" id="fab-opt-width" class="fab-set-input" value="${settings.panelWidth}" min="300" max="800" step="50">
    </div>
  </div>`;

  // ---- AI Injection Options ----
  h += `<div class="fab-card">
    <div class="fab-ch">🧠 AI 참조 설정</div>
    <div class="fab-set-section">
      <label class="fab-set-chk">
        <input type="checkbox" id="fab-opt-inject" ${settings.injectEnabled ? "checked" : ""}>
        <span>테이블 데이터를 AI에 전달 (시스템 프롬프트 주입)</span>
      </label>
      <div class="fab-set-hint">활성화하면 AI가 테이블 내용을 참고하여 응답합니다. 비활성화하면 AI는 테이블을 인식하지 못합니다.</div>
    </div>

    <div id="fab-inject-tables" class="${settings.injectEnabled ? "" : "fab-disabled"}">
      <div class="fab-set-label">테이블별 주입 설정</div>
      <div class="fab-set-hint">AI에 전달할 테이블을 개별적으로 선택합니다. 체크 해제된 테이블은 AI가 참조하지 않습니다.</div>
      ${schema.map((s, i) => `
        <label class="fab-set-chk fab-inject-row">
          <input type="checkbox" class="fab-inject-table-chk" data-idx="${i}" ${settings.injectTables[i] ? "checked" : ""}>
          <span><span class="fab-inject-idx">${i}</span> ${s.name}</span>
          <span class="fab-inject-info">${s.columns.length}개 컬럼 · ${(getTables()[i]?.rows?.length || 0)}행</span>
        </label>
      `).join("")}
    </div>

    <div class="fab-set-section" style="margin-top:12px">
      <div class="fab-set-label">프롬프트 삽입 깊이 (Depth)</div>
      <div class="fab-set-hint">시스템 프롬프트 내에서 테이블 데이터가 삽입되는 위치. 숫자가 작을수록 최근 메시지에 가깝게 삽입됩니다.</div>
      <input type="number" id="fab-opt-depth" class="fab-set-input" value="${settings.injectDepth}" min="0" max="999" step="1">
    </div>
  </div>`;

  // ---- Schema Editor ----
  h += '<div class="fab-card"><div class="fab-ch">⟐ 테이블 스키마 편집 ⟐</div>';

  for (let i = 0; i < schema.length; i++) {
    const s = schema[i];
    h += `<div class="fab-schema-block" data-idx="${i}">
      <div class="fab-schema-head">
        <span class="fab-schema-idx">${i}</span>
        <input type="text" class="fab-schema-name" value="${s.name}" data-idx="${i}" placeholder="테이블 이름">
        <button class="fab-schema-del-table fab-ab2" data-idx="${i}" title="테이블 삭제">✕</button>
      </div>
      <div class="fab-schema-cols">
        ${s.columns.map((col, ci) => `<div class="fab-schema-col-row"><input type="text" class="fab-schema-col" value="${col}" data-ti="${i}" data-ci="${ci}" placeholder="컬럼명"><button class="fab-schema-del-col fab-col-btn" data-ti="${i}" data-ci="${ci}" title="컬럼 삭제">−</button></div>`).join("")}
        <button class="fab-schema-add-col fab-col-btn add" data-ti="${i}">+ 컬럼 추가</button>
      </div>
    </div>`;
  }

  h += `<div class="fab-schema-actions">
    <button id="fab-add-table" class="fab-set-btn">+ 테이블 추가</button>
    <button id="fab-save-schema" class="fab-set-btn primary">저장</button>
    <button id="fab-reset-schema" class="fab-set-btn danger">기본값 복원</button>
  </div></div>`;

  return h;
}

// ============================================================
// BIND SETTINGS EVENTS (UPDATED)
// ============================================================

function bindSettingsEvents() {
  // Hide tableEdit
  const hideOpt = document.getElementById("fab-opt-hide");
  if (hideOpt) hideOpt.addEventListener("change", () => { getSettings().hideTableEdit = hideOpt.checked; saveSettings(); });

  // Panel width
  const widthOpt = document.getElementById("fab-opt-width");
  if (widthOpt) widthOpt.addEventListener("change", () => { getSettings().panelWidth = parseInt(widthOpt.value) || 400; saveSettings(); applyPanelWidth(); });

  // Global inject toggle
  const injectOpt = document.getElementById("fab-opt-inject");
  if (injectOpt) {
    injectOpt.addEventListener("change", () => {
      getSettings().injectEnabled = injectOpt.checked;
      saveSettings();
      const tableSection = document.getElementById("fab-inject-tables");
      if (tableSection) tableSection.classList.toggle("fab-disabled", !injectOpt.checked);
    });
  }

  // Per-table inject toggles
  document.querySelectorAll(".fab-inject-table-chk").forEach(chk => {
    chk.addEventListener("change", () => {
      const idx = parseInt(chk.dataset.idx);
      getSettings().injectTables[idx] = chk.checked;
      saveSettings();
    });
  });

  // Depth
  const depthOpt = document.getElementById("fab-opt-depth");
  if (depthOpt) depthOpt.addEventListener("change", () => { getSettings().injectDepth = parseInt(depthOpt.value) || 4; saveSettings(); });

  // Add table
  const addTable = document.getElementById("fab-add-table");
  if (addTable) addTable.addEventListener("click", () => {
    const schema = getSchema();
    schema.push({ name: `테이블 ${schema.length}`, columns: ["컬럼1"] });
    getSettings().injectTables[schema.length - 1] = true;
    setSchema(schema);
    refreshPanel(); bindSettingsEvents();
  });

  // Save schema
  const saveBtn = document.getElementById("fab-save-schema");
  if (saveBtn) saveBtn.addEventListener("click", () => {
    const schema = getSchema();
    document.querySelectorAll(".fab-schema-name").forEach(input => {
      const idx = parseInt(input.dataset.idx);
      if (schema[idx]) schema[idx].name = input.value.trim() || `테이블 ${idx}`;
    });
    for (let i = 0; i < schema.length; i++) {
      const cols = [];
      document.querySelectorAll(`.fab-schema-col[data-ti="${i}"]`).forEach(input => { const v = input.value.trim(); if (v) cols.push(v); });
      if (cols.length > 0) schema[i].columns = cols;
    }
    setSchema(schema);
    getTables(); saveTables(); injectPrompt();
    alert("스키마 저장 완료. 다음 AI 응답부터 새 스키마가 적용됩니다.");
    refreshPanel(); bindSettingsEvents();
  });

  // Reset schema
  const resetBtn = document.getElementById("fab-reset-schema");
  if (resetBtn) resetBtn.addEventListener("click", () => {
    if (confirm("기본값으로 복원하시겠습니까? 현재 스키마 설정이 초기화됩니다.")) {
      resetSchema(); refreshPanel(); bindSettingsEvents();
    }
  });

  // Delete table
  document.querySelectorAll(".fab-schema-del-table").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.idx);
      const schema = getSchema();
      if (schema.length <= 1) { alert("최소 1개의 테이블은 필요합니다."); return; }
      if (confirm(`테이블 ${idx}: ${schema[idx].name}을(를) 삭제하시겠습니까?`)) {
        schema.splice(idx, 1);
        // Re-index injectTables
        const newInject = {};
        for (let i = 0; i < schema.length; i++) {
          const oldIdx = i >= idx ? i + 1 : i;
          newInject[i] = getSettings().injectTables[oldIdx] !== undefined ? getSettings().injectTables[oldIdx] : true;
        }
        getSettings().injectTables = newInject;
        setSchema(schema);
        refreshPanel(); bindSettingsEvents();
      }
    });
  });

  // Add column
  document.querySelectorAll(".fab-schema-add-col").forEach(btn => {
    btn.addEventListener("click", () => {
      const ti = parseInt(btn.dataset.ti);
      const schema = getSchema();
      if (schema[ti]) { schema[ti].columns.push(`컬럼${schema[ti].columns.length + 1}`); setSchema(schema); refreshPanel(); bindSettingsEvents(); }
    });
  });

  // Delete column
  document.querySelectorAll(".fab-schema-del-col").forEach(btn => {
    btn.addEventListener("click", () => {
      const ti = parseInt(btn.dataset.ti), ci = parseInt(btn.dataset.ci);
      const schema = getSchema();
      if (schema[ti] && schema[ti].columns.length > 1) { schema[ti].columns.splice(ci, 1); setSchema(schema); refreshPanel(); bindSettingsEvents(); }
    });
  });
}

// ============================================================
// PANEL
// ============================================================

let currentTab = "status";
let panelOpen = false;

function applyPanelWidth() {
  const panel = document.getElementById("fab-panel");
  if (!panel) return;
  const w = getSettings().panelWidth || 400;
  panel.style.width = w + "px";
  panel.style.right = panelOpen ? "0" : `-${w + 20}px`;
}

function createUI() {
  const btn = document.createElement("div");
  btn.id = "fab-btn"; btn.innerHTML = "⟐"; btn.title = "Flow & Brand 시트";
  document.body.appendChild(btn);

  const panel = document.createElement("div");
  panel.id = "fab-panel";
  panel.innerHTML = `
    <div class="fab-ph"><div class="fab-pt">⟐ Flow & Brand ⟐</div><div class="fab-pa"><button id="fab-rescan" class="fab-ab2" title="전체 재스캔">↻</button><button id="fab-close" class="fab-ab2" title="닫기">✕</button></div></div>
    <div class="fab-tabs">
      <button class="fab-tab active" data-tab="status">상태</button>
      <button class="fab-tab" data-tab="character">캐릭터</button>
      <button class="fab-tab" data-tab="inventory">소지품</button>
      <button class="fab-tab" data-tab="missions">임무</button>
      <button class="fab-tab" data-tab="raw">원본</button>
      <button class="fab-tab" data-tab="settings">⚙</button>
    </div>
    <div id="fab-content" class="fab-ct"></div>
  `;
  document.body.appendChild(panel);
  applyPanelWidth();

  btn.addEventListener("click", togglePanel);
  document.getElementById("fab-close").addEventListener("click", togglePanel);
  document.getElementById("fab-rescan").addEventListener("click", scanAll);

  panel.querySelectorAll(".fab-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      panel.querySelectorAll(".fab-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      currentTab = tab.dataset.tab;
      refreshPanel();
      if (currentTab === "settings") bindSettingsEvents();
    });
  });
}

function togglePanel() {
  panelOpen = !panelOpen;
  const w = getSettings().panelWidth || 400;
  const panel = document.getElementById("fab-panel");
  if (panel) panel.style.right = panelOpen ? "0" : `-${w + 20}px`;
  if (panelOpen) { refreshPanel(); if (currentTab === "settings") bindSettingsEvents(); }
}

function refreshPanel() {
  const el = document.getElementById("fab-content");
  if (!el) return;
  switch (currentTab) {
    case "character": el.innerHTML = renderCharacter(); break;
    case "inventory": el.innerHTML = renderInventory(); break;
    case "missions": el.innerHTML = renderMissions(); break;
    case "status": el.innerHTML = renderStatus(); break;
    case "raw": el.innerHTML = renderRaw(); break;
    case "settings": el.innerHTML = renderSettings(); break;
  }
}

// ============================================================
// INIT
// ============================================================

jQuery(async () => {
  createUI();
  eventSource.on(event_types.GENERATION_STARTED, () => { injectPrompt(); });
  eventSource.on(event_types.MESSAGE_RECEIVED, (idx) => { const ctx = getContext(); const msg = ctx.chat[idx]; if (msg && msg.mes) processMsg(msg.mes); setTimeout(hideBlocks, 300); });
  eventSource.on(event_types.MESSAGE_EDITED, () => { scanAll(); setTimeout(hideBlocks, 300); });
  eventSource.on(event_types.CHAT_CHANGED, () => { setTimeout(() => { scanAll(); hideBlocks(); }, 1000); });
  setTimeout(() => { scanAll(); hideBlocks(); }, 2000);
  console.log("[FAB] Flow & Brand TRPG Sheet v1.2 loaded.");
});
