import { getContext, saveMetadataDebounced, extension_settings } from "../../../extensions.js";
import { eventSource, event_types, generateRaw } from "../../../../script.js";

const EXT = "flow-and-brand-sheet";
const EXT_DISPLAY = "Flow & Brand Sheet";
const META_KEY = "fabSheetData";
const SETTINGS_KEY = "fabSheet";

/* ============================================================
   SCHEMA — 3 tables only
   ============================================================ */

const DEFAULT_SCHEMA = [
  { name: "시공간", columns: ["날짜", "시간", "위치", "등장인물"] },
  { name: "캐릭터", columns: ["인물", "신체", "성격", "관계", "특성", "소지품", "기타"] },
  { name: "활동기록", columns: ["인물", "유형", "내용", "위치", "기간", "상태"] },
];

const DEFAULT_COLORS = { accent: "#6c5ce7" };

/* ============================================================
   SETTINGS
   ============================================================ */

function getSettings() {
  if (!extension_settings[SETTINGS_KEY]) {
    extension_settings[SETTINGS_KEY] = {
      schema: JSON.parse(JSON.stringify(DEFAULT_SCHEMA)),
      hideTableEdit: true, panelWidth: 440,
      injectEnabled: true, injectTables: {}, injectDepth: 4,
      colors: JSON.parse(JSON.stringify(DEFAULT_COLORS)),
    };
  }
  const s = extension_settings[SETTINGS_KEY];
  if (!s.injectTables) s.injectTables = {};
  for (let i = 0; i < s.schema.length; i++) if (s.injectTables[i] === undefined) s.injectTables[i] = true;
  for (const k of Object.keys(s.injectTables)) if (parseInt(k) >= s.schema.length) delete s.injectTables[k];
  if (s.injectEnabled === undefined) s.injectEnabled = true;
  if (s.injectDepth === undefined) s.injectDepth = 4;
  if (!s.colors) s.colors = JSON.parse(JSON.stringify(DEFAULT_COLORS));
  return s;
}
function saveSettings() { getContext().saveSettingsDebounced(); }
function getSchema() { return getSettings().schema; }
function setSchema(ns) { getSettings().schema = ns; saveSettings(); }
function resetSchema() {
  const s = getSettings();
  s.schema = JSON.parse(JSON.stringify(DEFAULT_SCHEMA));
  s.injectTables = {};
  for (let i = 0; i < s.schema.length; i++) s.injectTables[i] = true;
  saveSettings();
}
function applyColors() {
  const c = getSettings().colors;
  document.documentElement.style.setProperty("--fab-accent", c.accent || "#6c5ce7");
  const rgb = hexToRgb(c.accent || "#6c5ce7");
  document.documentElement.style.setProperty("--fab-accent-rgb", rgb);
}
function hexToRgb(hex) {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return `${r},${g},${b}`;
}

/* ============================================================
   DATA
   ============================================================ */

function buildEmpty() {
  const schema = getSchema(); const tables = {};
  for (let i = 0; i < schema.length; i++) tables[i] = { name: schema[i].name, columns: [...schema[i].columns], rows: [] };
  return tables;
}
function isRowEmpty(row, n) { for (let i = 0; i < n; i++) if ((row[i] || "").trim()) return false; return true; }
function cleanRows(t) { if (t?.rows) t.rows = t.rows.filter(r => !isRowEmpty(r, t.columns.length)); }

function getTables() {
  const ctx = getContext();
  if (!ctx.chatMetadata[META_KEY]) { ctx.chatMetadata[META_KEY] = buildEmpty(); saveMetadataDebounced(); }
  const schema = getSchema(); const tables = ctx.chatMetadata[META_KEY];
  for (let i = 0; i < schema.length; i++) {
    if (!tables[i]) { tables[i] = { name: schema[i].name, columns: [...schema[i].columns], rows: [] }; }
    else {
      tables[i].name = schema[i].name;
      const oc = tables[i].columns, nc = schema[i].columns;
      if (JSON.stringify(oc) !== JSON.stringify(nc)) {
        for (const row of tables[i].rows) {
          for (let ci = 0; ci < nc.length; ci++) if (row[ci] === undefined) row[ci] = "";
          for (const key of Object.keys(row)) if (parseInt(key) >= nc.length) delete row[key];
        }
        tables[i].columns = [...nc];
      }
    }
    cleanRows(tables[i]);
  }
  for (const k of Object.keys(tables).map(Number)) if (k >= schema.length) delete tables[k];
  return tables;
}
function saveTables() { saveMetadataDebounced(); }
function resetTables() { getContext().chatMetadata[META_KEY] = buildEmpty(); }
function execInsert(ti, data) { const t = getTables()[ti]; if (!t) return; const row = {}; for (let i = 0; i < t.columns.length; i++) row[i] = data[i] !== undefined ? String(data[i]) : ""; if (!isRowEmpty(row, t.columns.length)) t.rows.push(row); }
function execDelete(ti, ri) { const t = getTables()[ti]; if (t?.rows[ri]) t.rows.splice(ri, 1); }
function execUpdate(ti, ri, data) { const t = getTables()[ti]; if (!t?.rows[ri]) return; for (const [ci, val] of Object.entries(data)) t.rows[ri][parseInt(ci)] = String(val); }

/* ============================================================
   PARSER
   ============================================================ */

function parseDataObj(str) { const d = {}; const re = /(\d+)\s*:\s*(?:"([^"]*?)"|'([^']*?)'|([^\s,}]+))/g; let m; while ((m = re.exec(str))) d[parseInt(m[1])] = m[2] ?? m[3] ?? m[4] ?? ""; return d; }
function parseEdits(text) {
  const ops = []; const re = /<tableEdit>([\s\S]*?)<\/tableEdit>|<!--\s*tableEdit\s*-->([\s\S]*?)<!--\s*\/tableEdit\s*-->/gi; let em;
  while ((em = re.exec(text))) {
    const block = (em[1] || em[2] || "").replace(/<!--/g, "").replace(/-->/g, "");
    for (const line of block.split("\n")) {
      const t = line.trim(); if (!t || t.startsWith("//")) continue; let m;
      if ((m = t.match(/insertRow\(\s*(\d+)\s*,\s*\{([^}]+)\}\s*\)/))) ops.push({ type: "insert", ti: +m[1], data: parseDataObj(m[2]) });
      else if ((m = t.match(/deleteRow\(\s*(\d+)\s*,\s*(\d+)\s*\)/))) ops.push({ type: "delete", ti: +m[1], ri: +m[2] });
      else if ((m = t.match(/updateRow\(\s*(\d+)\s*,\s*(\d+)\s*,\s*\{([^}]+)\}\s*\)/))) ops.push({ type: "update", ti: +m[1], ri: +m[2], data: parseDataObj(m[3]) });
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

/* ============================================================
   MESSAGE PROCESSING
   ============================================================ */

function processMsg(text) { if (!text) return false; const ops = parseEdits(text); if (ops.length) { applyOps(ops); saveTables(); refreshPanel(); updateExtSlot(); return true; } return false; }
function scanAll() {
  const ctx = getContext(); if (!ctx.chat?.length) return;
  resetTables();
  for (const msg of ctx.chat) { if (msg.mes) { const ops = parseEdits(msg.mes); if (ops.length) applyOps(ops); } }
  saveTables(); refreshPanel(); updateExtSlot();
}

/* ============================================================
   PROMPT INJECTION
   ============================================================ */

function buildPrompt() {
  const settings = getSettings(); if (!settings.injectEnabled) return "";
  const tables = getTables();
  const enabled = Object.entries(settings.injectTables).filter(([_, v]) => v).map(([k]) => +k).sort((a, b) => a - b);
  if (!enabled.length) return "";
  let p = "\n[FAB Sheet — Current Data]\n";
  for (const idx of enabled) {
    const t = tables[idx]; if (!t) continue;
    p += `\n### Table ${idx}: ${t.name}\nColumns: ${t.columns.join(" | ")}\n`;
    if (!t.rows.length) p += "(empty)\n";
    else for (let ri = 0; ri < t.rows.length; ri++) p += `[${ri}] ${t.columns.map((_, ci) => t.rows[ri][ci] || "").join(" | ")}\n`;
  }
  p += `\n[Table Edit Instructions]
When table data changes, output a <tableEdit> block at the END of your response.
Commands: insertRow(tableIndex, {colIndex: "value"}) / updateRow(tableIndex, rowIndex, {colIndex: "newValue"}) / deleteRow(tableIndex, rowIndex)
Table indices: ${enabled.join(", ")}
Table 2 "활동기록" column 1 "유형" accepts: 임무, 이벤트, 전투, or any free text.
Include <tableEdit> ONLY when data changes. Place AFTER narrative.\n`;
  return p;
}
function injectPrompt() {
  const ctx = getContext(); if (!ctx.extensionPrompts) ctx.extensionPrompts = {};
  const prompt = buildPrompt();
  if (!prompt) { delete ctx.extensionPrompts[EXT]; return; }
  ctx.extensionPrompts[EXT] = { value: prompt, position: 1, depth: getSettings().injectDepth, role: 0 };
}

/* ============================================================
   AI GENERATION
   ============================================================ */

async function aiGenerate(instruction, mode) {
  const schema = getSchema(); const tables = getTables();
  let data = "";
  for (let i = 0; i < schema.length; i++) {
    const t = tables[i]; if (!t) continue;
    data += `Table ${i}: "${t.name}" — Cols: ${t.columns.map((c, ci) => `[${ci}]${c}`).join(", ")}\n`;
    if (t.rows.length) for (let ri = 0; ri < t.rows.length; ri++) data += `  [${ri}] ${t.columns.map((_, ci) => t.rows[ri][ci] || "").join(" | ")}\n`;
    else data += "  (empty)\n";
  }
  const ctx = getContext(); let chat = "";
  if (ctx.chat?.length) for (const msg of ctx.chat.slice(-15)) {
    const text = (msg.mes || "").replace(/<tableEdit>[\s\S]*?<\/tableEdit>/gi, "").trim();
    if (text) chat += `[${msg.is_user ? "User" : "Char"}]: ${text.substring(0, 600)}\n`;
  }
  const sys = mode === "setup"
    ? `You are a data assistant. Analyze chat and populate ALL tables.\n\nSchema:\n${data}\nChat:\n${chat || "(none)"}\n\nRULES:\n- Output ONLY <tableEdit> block.\n- For Table 1 (캐릭터): include 관계, 특성, 소지품 in single row per character.\n- For Table 2 (활동기록): set column 1 (유형) to 임무/이벤트/전투 etc.\n- NO empty rows. Be thorough.`
    : `Data assistant. Generate table edits.\n\nSchema+Data:\n${data}\n${chat ? `Chat:\n${chat}` : ""}\n\nRULES:\n- Output ONLY <tableEdit>. NO empty rows.`;
  try { return await generateRaw(instruction, "", false, false, sys); }
  catch { try { return await generateRaw(sys + "\n\n" + instruction, ""); } catch { return null; } }
}

/* ============================================================
   HIDE BLOCKS
   ============================================================ */

function hideBlocks() {
  if (!getSettings().hideTableEdit) return;
  document.querySelectorAll(".mes_text").forEach(el => {
    if (el.dataset.fabProcessed) return; el.dataset.fabProcessed = "true";
    const h = el.innerHTML;
    const c = h.replace(/<tableEdit>[\s\S]*?<\/tableEdit>/gi, "").replace(/<tableEdit>[\s\S]*?<\/tableEdit>/gi, "");
    if (c !== h) el.innerHTML = c;
  });
}

/* ============================================================
   RENDER — TRPG OVERVIEW
   ============================================================ */

function esc(s) { return (s || "").replace(/&/g, "&").replace(/</g, "<").replace(/>/g, ">"); }

// -- Scene Banner (Table 0) --
function renderSceneBanner(table) {
  if (!table?.rows.length) return "";
  const last = table.rows[table.rows.length - 1];
  let h = `<div class="fab-scene-banner"><div class="fab-scene-label">Current Scene</div><div class="fab-scene-row">`;
  if (last[0]) h += `<span class="fab-scene-chip date">${esc(last[0])}</span>`;
  if (last[1]) h += `<span class="fab-scene-chip">${esc(last[1])}</span>`;
  if (last[2]) h += `<span class="fab-scene-chip loc">${esc(last[2])}</span>`;
  h += `</div>`;
  if (last[3]) h += `<div class="fab-scene-row"><span class="fab-scene-chip who">${esc(last[3])}</span></div>`;
  h += `</div>`;
  // Previous scenes collapsed
  if (table.rows.length > 1) {
    h += `<div class="fab-section"><div class="fab-section-header" data-action="toggle-table" data-idx="scene-history" style="padding:8px 12px;">
      <span style="font-size:10px;color:var(--fab-muted);">이전 씬 (${table.rows.length - 1}건)</span>
      <span class="fab-section-arrow" id="fab-arrow-scene-history" style="font-size:10px;">▸</span>
    </div><div id="fab-tbody-scene-history" style="display:none;padding:6px 0;">`;
    for (let ri = table.rows.length - 2; ri >= 0; ri--) {
      const r = table.rows[ri];
      h += `<div style="display:flex;gap:6px;padding:3px 8px;font-size:10px;color:var(--fab-sub);">`;
      h += `<span style="color:var(--fab-accent);font-weight:600;">${esc(r[0])}</span>`;
      if (r[1]) h += `<span>${esc(r[1])}</span>`;
      if (r[2]) h += `<span style="color:#2d6a4f;">${esc(r[2])}</span>`;
      if (r[3]) h += `<span>${esc(r[3])}</span>`;
      h += `</div>`;
    }
    h += `</div></div>`;
  }
  return h;
}

// -- Character Sheets (Table 1) --
function renderCharacterSheets(table) {
  if (!table?.rows.length) return '<div class="fab-empty">등록된 캐릭터가 없습니다.</div>';

  const TAG_COLS = new Set();
  const INV_COLS = new Set();
  const STAT_REGEX = /^[A-Z가-힣]+\s*:\s*.+/;

  for (let ci = 0; ci < table.columns.length; ci++) {
    const lower = table.columns[ci].toLowerCase();
    if (["관계", "특성", "태그", "trait", "tag"].some(k => lower.includes(k))) TAG_COLS.add(ci);
    if (["소지품", "인벤", "아이템", "item", "inventory"].some(k => lower.includes(k))) INV_COLS.add(ci);
  }

  let h = "";
  for (let ri = 0; ri < table.rows.length; ri++) {
    const row = table.rows[ri];
    const name = row[0] || "???";
    const initial = name.charAt(0).toUpperCase();

    h += `<div class="fab-cs"><div class="fab-cs-strip"></div>
      <div class="fab-cs-header" data-action="toggle-table" data-idx="char-${ri}">
        <div class="fab-cs-avatar">${esc(initial)}</div>
        <div class="fab-cs-name">${esc(name)}</div>
        <span class="fab-cs-toggle" id="fab-arrow-char-${ri}">▸</span>
      </div>
      <div class="fab-cs-body" id="fab-tbody-char-${ri}" style="display:none;">`;

    // Basic info section
    let basicFields = [];
    for (let ci = 1; ci < table.columns.length; ci++) {
      if (TAG_COLS.has(ci) || INV_COLS.has(ci)) continue;
      const val = (row[ci] || "").trim();
      if (!val) continue;
      // Check if stat-like
      const parts = val.split(/[/;·]/).map(s => s.trim()).filter(Boolean);
      const isStats = parts.length >= 2 && parts.every(p => STAT_REGEX.test(p));
      if (isStats) {
        basicFields.push({ type: "stats", label: table.columns[ci], parts });
      } else {
        basicFields.push({ type: "field", label: table.columns[ci], val });
      }
    }

    if (basicFields.length) {
      h += `<div class="fab-cs-sec"><div class="fab-cs-sec-title"><span class="fab-cs-sec-icon">📋</span>기본 정보</div>`;
      for (const f of basicFields) {
        if (f.type === "stats") {
          h += `<div class="fab-cs-stats">`;
          for (const p of f.parts) {
            const [k, ...vp] = p.split(":"); const v = vp.join(":").trim();
            h += `<div class="fab-cs-stat"><span class="fab-cs-stat-k">${esc(k.trim())}</span><span class="fab-cs-stat-v">${esc(v)}</span></div>`;
          }
          h += `</div>`;
        } else {
          h += `<div class="fab-cs-field"><span class="fab-cs-lbl">${esc(f.label)}</span><span class="fab-cs-val">${esc(f.val)}</span></div>`;
        }
      }
      h += `</div>`;
    }

    // Relationship tags
    for (const ci of TAG_COLS) {
      const val = (row[ci] || "").trim();
      if (!val) continue;
      const colName = table.columns[ci];
      const isRel = colName.toLowerCase().includes("관계") || colName.toLowerCase().includes("rel");
      const icon = isRel ? "🔗" : "✦";
      h += `<div class="fab-cs-sec"><div class="fab-cs-sec-title"><span class="fab-cs-sec-icon">${icon}</span>${esc(colName)}</div><div class="fab-cs-tags">`;
      const tags = val.split(/[,;·]/).map(s => s.trim()).filter(Boolean);
      for (const tag of tags) h += `<span class="fab-cs-tag ${isRel ? "rel" : ""}">${esc(tag)}</span>`;
      h += `</div></div>`;
    }

    // Inventory
    for (const ci of INV_COLS) {
      const val = (row[ci] || "").trim();
      if (!val) continue;
      h += `<div class="fab-cs-sec"><div class="fab-cs-sec-title"><span class="fab-cs-sec-icon">🎒</span>${esc(table.columns[ci])}</div><div class="fab-cs-inv">`;
      const items = val.split(/[,;·]/).map(s => s.trim()).filter(Boolean);
      for (const item of items) {
        // item might be "검(+2 공격)" format
        const m = item.match(/^(.+?)\((.+?)\)$/);
        if (m) {
          h += `<div class="fab-cs-inv-item"><span class="fab-cs-inv-name">${esc(m[1].trim())}</span><span class="fab-cs-inv-desc">${esc(m[2].trim())}</span></div>`;
        } else {
          h += `<div class="fab-cs-inv-item"><span class="fab-cs-inv-name">${esc(item)}</span></div>`;
        }
      }
      h += `</div></div>`;
    }

    h += `</div></div>`;
  }
  return h;
}

// -- Activity Log (Table 2) --
function renderActivityLog(table) {
  if (!table?.rows.length) return '<div class="fab-empty">기록 없음</div>';
  let h = '<div class="fab-logs">';
  for (const row of table.rows) {
    const type = (row[1] || "").trim().toLowerCase();
    let badge = "default";
    if (type.includes("임무") || type.includes("mission")) badge = "mission";
    else if (type.includes("이벤트") || type.includes("event")) badge = "event";
    else if (type.includes("전투") || type.includes("combat")) badge = "combat";

    const status = (row[5] || "").trim().toLowerCase();
    let statusClass = "done";
    if (status.includes("진행") || status.includes("active")) statusClass = "active";
    else if (status.includes("실패") || status.includes("fail")) statusClass = "fail";

    h += `<div class="fab-log">
      <span class="fab-log-badge ${badge}">${esc(row[1] || "기타")}</span>
      <div class="fab-log-body">
        <div class="fab-log-title">${esc(row[0])}${row[2] ? " — " + esc(row[2]) : ""}</div>
        <div class="fab-log-meta">`;
    if ((row[3] || "").trim()) h += `<span>${esc(row[3])}</span>`;
    if ((row[4] || "").trim()) h += `<span>${esc(row[4])}</span>`;
    if ((row[5] || "").trim()) h += `<span class="fab-log-status ${statusClass}">${esc(row[5])}</span>`;
    h += `</div></div></div>`;
  }
  return h + '</div>';
}

// -- Plain table fallback --
function renderPlainTable(table) {
  if (!table?.rows.length) return '<div class="fab-empty">비어 있음</div>';
  let h = `<table class="fab-rt"><thead><tr><th class="fab-rth">#</th>`;
  for (const col of table.columns) h += `<th class="fab-rth">${esc(col)}</th>`;
  h += '</tr></thead><tbody>';
  for (let ri = 0; ri < table.rows.length; ri++) {
    h += `<tr><td class="fab-rtd fab-ri">${ri}</td>`;
    for (let ci = 0; ci < table.columns.length; ci++) h += `<td class="fab-rtd">${esc(table.rows[ri][ci])}</td>`;
    h += '</tr>';
  }
  return h + '</tbody></table>';
}

/* ============================================================
   RENDER — OVERVIEW (TRPG SHEET)
   ============================================================ */

function renderOverview() {
  const tables = getTables(); const schema = getSchema();
  let h = "";

  // Scene banner — always Table 0 if it exists and name matches
  const sceneIdx = schema.findIndex(s => s.name.includes("시공간") || s.name.toLowerCase().includes("scene"));
  if (sceneIdx >= 0 && tables[sceneIdx]) h += renderSceneBanner(tables[sceneIdx]);

  // Character sheets — find table named 캐릭터 or similar
  const charIdx = schema.findIndex(s => s.name.includes("캐릭터") || s.name.toLowerCase().includes("character"));
  if (charIdx >= 0 && tables[charIdx]) {
    h += `<div class="fab-sheet-section-title">Characters</div>`;
    h += renderCharacterSheets(tables[charIdx]);
  }

  // Activity log — find table named 활동 or similar
  const actIdx = schema.findIndex(s => s.name.includes("활동") || s.name.toLowerCase().includes("activity") || s.name.toLowerCase().includes("log"));
  if (actIdx >= 0 && tables[actIdx]) {
    h += `<div class="fab-sheet-section-title">Activity Log</div>`;
    h += renderActivityLog(tables[actIdx]);
  }

  // Any other tables not caught above
  for (let i = 0; i < schema.length; i++) {
    if (i === sceneIdx || i === charIdx || i === actIdx) continue;
    const t = tables[i]; if (!t?.rows.length) continue;
    h += `<div class="fab-sheet-section-title">${esc(t.name)}</div>`;
    h += renderPlainTable(t);
  }

  return h || '<div class="fab-empty">데이터 없음. AI 탭에서 초기 생성을 해보세요.</div>';
}

function renderRaw() {
  const tables = getTables(); let h = "";
  for (const [idx, t] of Object.entries(tables)) h += `<div class="fab-card"><div class="fab-ch">T${idx}: ${t.name}</div>${renderPlainTable(t)}</div>`;
  return h;
}

/* ============================================================
   RENDER — GENERATE
   ============================================================ */

function renderGenerate() {
  const tables = getTables();
  const hasData = Object.values(tables).some(t => t.rows.length > 0);
  let h = "";
  if (!hasData) {
    h += `<div class="fab-card fab-setup-card"><div class="fab-ch">✨ AI 초기 셋업</div>
      <div class="fab-setup-info">채팅 내용을 분석하여 <strong>캐릭터 시트 + 활동기록을 자동 생성</strong>합니다.</div>
      <textarea id="fab-setup-input" class="fab-gen-textarea" placeholder="예: 현재 채팅을 분석해서 시트를 채워줘" rows="3"></textarea>
      <div class="fab-gen-actions"><button class="fab-set-btn primary" data-action="ai-setup">✨ 초기 생성</button></div>
      <div id="fab-setup-status" class="fab-gen-status"></div><div id="fab-setup-preview" class="fab-gen-preview"></div></div>`;
  }
  h += `<div class="fab-card"><div class="fab-ch">🤖 AI 데이터 편집</div>
    <div class="fab-gen-desc">캐릭터 정보를 추가하거나 활동기록을 수정합니다.</div>
    <textarea id="fab-gen-input" class="fab-gen-textarea" placeholder="예: 키안의 소지품에 단검 추가해줘" rows="4"></textarea>
    <div class="fab-gen-actions"><button class="fab-set-btn primary" data-action="ai-generate">생성</button></div>
    <div id="fab-gen-status" class="fab-gen-status"></div><div id="fab-gen-preview" class="fab-gen-preview"></div></div>`;
  return h;
}

/* ============================================================
   RENDER — SETTINGS
   ============================================================ */

function renderSettings() {
  const settings = getSettings(); const schema = settings.schema; const colors = settings.colors;
  let h = `<div class="fab-card"><div class="fab-ch">⚙ 일반</div>
    <div class="fab-set-section"><label class="fab-set-chk"><input type="checkbox" id="fab-opt-hide" ${settings.hideTableEdit ? "checked" : ""}><span><tableEdit> 숨기기</span></label></div>
    <div class="fab-set-section"><div class="fab-set-label">패널 너비</div><input type="number" id="fab-opt-width" class="fab-set-input" value="${settings.panelWidth}" min="300" max="800" step="50"></div></div>`;

  h += `<div class="fab-card"><div class="fab-ch">🎨 색상</div>
    <div class="fab-color-row"><span class="fab-color-label">액센트</span><input type="color" class="fab-color-picker" data-color-key="accent" value="${colors.accent || "#6c5ce7"}"><span class="fab-color-hex">${colors.accent || "#6c5ce7"}</span></div>
    <button class="fab-set-btn danger" data-action="reset-colors" style="margin-top:8px">초기화</button></div>`;

  h += `<div class="fab-card"><div class="fab-ch">🧠 AI 참조</div>
    <label class="fab-set-chk"><input type="checkbox" id="fab-opt-inject" ${settings.injectEnabled ? "checked" : ""}><span>AI에 시트 데이터 전달</span></label>
    <div id="fab-inject-tables" class="${settings.injectEnabled ? "" : "fab-disabled"}" style="margin-top:8px;">
    ${schema.map((s, i) => `<label class="fab-set-chk fab-inject-row"><input type="checkbox" data-inject-idx="${i}" ${settings.injectTables[i] ? "checked" : ""}><span><span class="fab-inject-idx">${i}</span>${esc(s.name)}</span><span class="fab-inject-info">${s.columns.length}컬럼·${(getTables()[i]?.rows?.length || 0)}행</span></label>`).join("")}
    </div>
    <div class="fab-set-section" style="margin-top:10px"><div class="fab-set-label">삽입 깊이</div><input type="number" id="fab-opt-depth" class="fab-set-input" value="${settings.injectDepth}" min="0" max="999"></div></div>`;

  h += `<div class="fab-card"><div class="fab-ch">📐 스키마</div>`;
  for (let i = 0; i < schema.length; i++) {
    const s = schema[i];
    h += `<div class="fab-schema-block"><div class="fab-schema-toggle" data-action="toggle-schema" data-idx="${i}">
      <span class="fab-schema-arrow" id="fab-sarrow-${i}">▸</span><span class="fab-schema-idx">${i}</span>
      <span class="fab-schema-preview-name">${esc(s.name)}</span><span class="fab-schema-preview-cols">${s.columns.length}컬럼</span>
    </div><div class="fab-schema-detail" id="fab-sdetail-${i}" style="display:none;">
      <div class="fab-schema-head"><input type="text" class="fab-schema-name" value="${esc(s.name)}" data-schema-name-idx="${i}"><button class="fab-ab2" data-action="del-table" data-idx="${i}">✕</button></div>
      <div class="fab-schema-cols">
        ${s.columns.map((col, ci) => `<div class="fab-schema-col-row"><input type="text" class="fab-schema-col" value="${esc(col)}" data-col-ti="${i}" data-col-ci="${ci}"><button class="fab-col-btn" data-action="del-col" data-ti="${i}" data-ci="${ci}">−</button></div>`).join("")}
        <button class="fab-col-btn add" data-action="add-col" data-ti="${i}">+ 컬럼</button>
      </div></div></div>`;
  }
  h += `<div class="fab-schema-actions"><button class="fab-set-btn" data-action="add-table">+ 테이블</button><button class="fab-set-btn primary" data-action="save-schema">저장</button><button class="fab-set-btn danger" data-action="reset-schema">기본값</button></div></div>`;

  h += `<div class="fab-card"><div class="fab-ch">📋 JSON</div>
    <textarea id="fab-json-input" class="fab-json-textarea" rows="5"></textarea>
    <div class="fab-json-actions"><button class="fab-set-btn primary" data-action="json-apply">적용</button><button class="fab-set-btn" data-action="json-export">내보내기</button></div>
    <div id="fab-json-status" class="fab-gen-status"></div></div>`;
  return h;
}

/* ============================================================
   AI HANDLER
   ============================================================ */

async function handleAiAction(mode) {
  const isSetup = mode === "setup";
  const inputEl = document.getElementById(isSetup ? "fab-setup-input" : "fab-gen-input");
  const statusEl = document.getElementById(isSetup ? "fab-setup-status" : "fab-gen-status");
  const previewEl = document.getElementById(isSetup ? "fab-setup-preview" : "fab-gen-preview");
  const btn = document.querySelector(isSetup ? "[data-action='ai-setup']" : "[data-action='ai-generate']");
  const instruction = (inputEl?.value || "").trim() || (isSetup ? "채팅 내용 분석해서 모든 테이블 채워줘" : "");
  if (!instruction && !isSetup) { if (statusEl) statusEl.innerHTML = '<span class="fab-gen-err">입력 필요.</span>'; return; }
  if (btn) { btn.disabled = true; btn.textContent = "생성 중..."; }
  if (statusEl) statusEl.innerHTML = '<span class="fab-gen-loading">⏳ 요청 중...</span>';
  if (previewEl) previewEl.innerHTML = "";
  try {
    const resp = await aiGenerate(instruction, mode);
    if (!resp) { if (statusEl) statusEl.innerHTML = '<span class="fab-gen-err">응답 실패.</span>'; return; }
    const ops = parseEdits(resp);
    if (!ops.length) {
      if (statusEl) statusEl.innerHTML = '<span class="fab-gen-err">유효한 명령 없음.</span>';
      if (previewEl) previewEl.innerHTML = `<div class="fab-gen-raw"><pre>${esc(resp.substring(0, 2000))}</pre></div>`;
      return;
    }
    let ph = `<div class="fab-gen-ops-label">${ops.length}개 명령:</div>`;
    for (const op of ops) {
      if (op.type === "insert") ph += `<div class="fab-gen-op insert">+ T${op.ti} insert</div>`;
      else if (op.type === "update") ph += `<div class="fab-gen-op update">~ T${op.ti}[${op.ri}] update</div>`;
      else if (op.type === "delete") ph += `<div class="fab-gen-op delete">- T${op.ti}[${op.ri}] delete</div>`;
    }
    ph += `<div class="fab-gen-confirm-actions"><button class="fab-set-btn primary" data-action="ai-apply" data-source="${mode}">적용</button><button class="fab-set-btn" data-action="ai-cancel" data-source="${mode}">취소</button></div>`;
    if (statusEl) statusEl.innerHTML = '<span class="fab-gen-ok">✅ 확인 후 적용.</span>';
    if (previewEl) { previewEl.innerHTML = ph; previewEl.dataset.pendingOps = JSON.stringify(ops); }
  } catch (err) { if (statusEl) statusEl.innerHTML = `<span class="fab-gen-err">${err.message}</span>`; }
  finally { if (btn) { btn.disabled = false; btn.textContent = isSetup ? "✨ 초기 생성" : "생성"; } }
}

/* ============================================================
   EVENT DELEGATION
   ============================================================ */

function setupDelegation() {
  const content = document.getElementById("fab-content"); if (!content) return;

  content.addEventListener("click", (e) => {
    const el = e.target.closest("[data-action]"); if (!el) return;
    const act = el.dataset.action;
    switch (act) {
      case "toggle-table": {
        const idx = el.dataset.idx;
        const body = document.getElementById(`fab-tbody-${idx}`);
        const arrow = document.getElementById(`fab-arrow-${idx}`);
        if (body) { const o = body.style.display !== "none"; body.style.display = o ? "none" : "block"; if (arrow) arrow.textContent = o ? "▸" : "▾"; }
        break;
      }
      case "toggle-schema": {
        const idx = el.dataset.idx;
        const d = document.getElementById(`fab-sdetail-${idx}`);
        const a = document.getElementById(`fab-sarrow-${idx}`);
        if (d) { const o = d.style.display !== "none"; d.style.display = o ? "none" : "block"; if (a) a.textContent = o ? "▸" : "▾"; }
        break;
      }
      case "del-table": {
        const idx = +el.dataset.idx; const schema = getSchema();
        if (schema.length <= 1) break;
        if (confirm(`"${schema[idx].name}" 삭제?`)) {
          schema.splice(idx, 1);
          const ni = {}; for (let i = 0; i < schema.length; i++) ni[i] = getSettings().injectTables[i >= idx ? i + 1 : i] ?? true;
          getSettings().injectTables = ni; setSchema(schema); refreshPanel(); updateExtSlot();
        }
        break;
      }
      case "add-col": { const ti = +el.dataset.ti; const s = getSchema(); if (s[ti]) { s[ti].columns.push(`Col${s[ti].columns.length + 1}`); setSchema(s); refreshPanel(); } break; }
      case "del-col": { const ti = +el.dataset.ti, ci = +el.dataset.ci; const s = getSchema(); if (s[ti]?.columns.length > 1) { s[ti].columns.splice(ci, 1); setSchema(s); refreshPanel(); } break; }
      case "add-table": { const s = getSchema(); s.push({ name: `Table ${s.length}`, columns: ["Col1"] }); getSettings().injectTables[s.length - 1] = true; setSchema(s); refreshPanel(); break; }
      case "save-schema": {
        const schema = getSchema();
        document.querySelectorAll("[data-schema-name-idx]").forEach(input => { const i = +input.dataset.schemaNameIdx; if (schema[i]) schema[i].name = input.value.trim() || `Table ${i}`; });
        for (let i = 0; i < schema.length; i++) { const cols = []; document.querySelectorAll(`[data-col-ti="${i}"]`).forEach(inp => { const v = inp.value.trim(); if (v) cols.push(v); }); if (cols.length) schema[i].columns = cols; }
        setSchema(schema); getTables(); saveTables(); injectPrompt(); updateExtSlot();
        alert("저장."); refreshPanel();
        break;
      }
      case "reset-schema": { if (confirm("기본값?")) { resetSchema(); refreshPanel(); updateExtSlot(); } break; }
      case "reset-colors": { getSettings().colors = JSON.parse(JSON.stringify(DEFAULT_COLORS)); saveSettings(); applyColors(); refreshPanel(); break; }
      case "json-apply": {
        const input = document.getElementById("fab-json-input"); const st = document.getElementById("fab-json-status");
        try {
          const parsed = JSON.parse((input?.value || "").trim());
          if (!Array.isArray(parsed)) throw new Error("배열 필요");
          if (!confirm(`${parsed.length}개 교체?`)) break;
          const ns = parsed.map(t => ({ name: String(t.name), columns: t.columns.map(c => String(c)) }));
          const s = getSettings(); s.schema = ns; s.injectTables = {};
          for (let i = 0; i < ns.length; i++) s.injectTables[i] = true;
          saveSettings(); getTables(); saveTables(); refreshPanel(); updateExtSlot();
          st.innerHTML = '<span class="fab-gen-ok">✅ 완료.</span>';
        } catch (err) { st.innerHTML = `<span class="fab-gen-err">${err.message}</span>`; }
        break;
      }
      case "json-export": { const inp = document.getElementById("fab-json-input"); if (inp) inp.value = JSON.stringify(getSchema(), null, 2); break; }
      case "ai-generate": handleAiAction("generate"); break;
      case "ai-setup": handleAiAction("setup"); break;
      case "ai-apply": {
        const src = el.dataset.source || "generate";
        const p = document.getElementById(src === "setup" ? "fab-setup-preview" : "fab-gen-preview");
        if (p?.dataset.pendingOps) { applyOps(JSON.parse(p.dataset.pendingOps)); saveTables(); refreshPanel(); updateExtSlot(); }
        break;
      }
      case "ai-cancel": {
        const src = el.dataset.source || "generate";
        const p = document.getElementById(src === "setup" ? "fab-setup-preview" : "fab-gen-preview");
        const s = document.getElementById(src === "setup" ? "fab-setup-status" : "fab-gen-status");
        if (p) p.innerHTML = ""; if (s) s.innerHTML = '<span class="fab-gen-info">취소.</span>';
        break;
      }
    }
  });

  content.addEventListener("change", (e) => {
    const t = e.target;
    if (t.id === "fab-opt-hide") { getSettings().hideTableEdit = t.checked; saveSettings(); }
    else if (t.id === "fab-opt-width") { getSettings().panelWidth = +t.value || 440; saveSettings(); applyPanelWidth(); }
    else if (t.id === "fab-opt-inject") { getSettings().injectEnabled = t.checked; saveSettings(); document.getElementById("fab-inject-tables")?.classList.toggle("fab-disabled", !t.checked); updateExtSlot(); }
    else if (t.dataset.injectIdx !== undefined) { getSettings().injectTables[+t.dataset.injectIdx] = t.checked; saveSettings(); updateExtSlot(); }
    else if (t.id === "fab-opt-depth") { getSettings().injectDepth = +t.value || 4; saveSettings(); }
  });

  content.addEventListener("input", (e) => {
    const t = e.target;
    if (t.classList.contains("fab-color-picker") && t.dataset.colorKey) {
      getSettings().colors[t.dataset.colorKey] = t.value;
      const hex = t.parentElement?.querySelector(".fab-color-hex"); if (hex) hex.textContent = t.value;
      saveSettings(); applyColors();
    }
  });
}

/* ============================================================
   EXT SLOT
   ============================================================ */

function createExtSlot() {
  const c = document.getElementById("extensions_settings2"); if (!c) return;
  const w = document.createElement("div"); w.id = "fab-ext-slot"; w.classList.add("extension_container");
  w.innerHTML = `<div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header"><div class="inline-drawer-icon fa-solid fa-diamond" style="color:var(--fab-accent)"></div><span class="inline-drawer-title">${EXT_DISPLAY}</span><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
    <div class="inline-drawer-content" style="display:none"><div id="fab-ext-status" class="fab-ext-info"></div>
    <div class="fab-ext-actions"><input id="fab-ext-btn-open" class="menu_button" type="button" value="📋 시트"><input id="fab-ext-btn-scan" class="menu_button" type="button" value="↻ 재스캔"></div><hr>
    <div class="fab-ext-quick"><label class="checkbox_label"><input type="checkbox" id="fab-ext-chk-hide"><span><tableEdit> 숨기기</span></label><label class="checkbox_label"><input type="checkbox" id="fab-ext-chk-inject"><span>AI에 데이터 전달</span></label></div></div></div>`;
  c.appendChild(w);
  w.querySelector(".inline-drawer-toggle").addEventListener("click", function () {
    const ct = w.querySelector(".inline-drawer-content"); const a = w.querySelector(".inline-drawer-icon.down");
    const o = ct.style.display !== "none"; ct.style.display = o ? "none" : "block";
    if (a) { a.classList.toggle("fa-circle-chevron-down", o); a.classList.toggle("fa-circle-chevron-up", !o); }
  });
  document.getElementById("fab-ext-btn-open").addEventListener("click", () => { if (!panelOpen) togglePanel(); });
  document.getElementById("fab-ext-btn-scan").addEventListener("click", scanAll);
  const h = document.getElementById("fab-ext-chk-hide"); h.checked = getSettings().hideTableEdit;
  h.addEventListener("change", () => { getSettings().hideTableEdit = h.checked; saveSettings(); });
  const i = document.getElementById("fab-ext-chk-inject"); i.checked = getSettings().injectEnabled;
  i.addEventListener("change", () => { getSettings().injectEnabled = i.checked; saveSettings(); updateExtSlot(); });
  updateExtSlot();
}
function updateExtSlot() {
  const s = document.getElementById("fab-ext-status"); if (!s) return;
  const st = getSettings(); const t = getTables();
  const total = Object.values(t).reduce((n, t) => n + (t.rows?.length || 0), 0);
  const ec = Object.values(st.injectTables).filter(v => v).length;
  s.innerHTML = `<div class="fab-ext-row"><span>테이블</span><span>${st.schema.length}개 (${total}행)</span></div>
    <div class="fab-ext-row"><span>AI</span><span style="color:${st.injectEnabled ? "var(--fab-success)" : "var(--fab-danger)"}">${st.injectEnabled ? `ON (${ec}/${st.schema.length})` : "OFF"}</span></div>`;
}

/* ============================================================
   WAND
   ============================================================ */

function registerWandAction() {
  const w = document.getElementById("extensionsMenu");
  if (w) { addWand(w); return; }
  new MutationObserver((_, o) => { const w = document.getElementById("extensionsMenu"); if (w) { o.disconnect(); addWand(w); } }).observe(document.body, { childList: true, subtree: true });
}
function addWand(c) {
  if (document.getElementById("fab-wand-btn")) return;
  const b = document.createElement("div"); b.id = "fab-wand-btn"; b.classList.add("list-group-item", "flex-container", "flexGap5");
  b.innerHTML = `<span class="fa-solid fa-diamond" style="color:var(--fab-accent)"></span> FAB 시트`;
  b.addEventListener("click", () => { if (!panelOpen) togglePanel(); }); c.appendChild(b);
}

/* ============================================================
   PANEL
   ============================================================ */

let currentTab = "overview", panelOpen = false, rawMode = false;

function applyPanelWidth() {
  const p = document.getElementById("fab-panel"); if (!p) return;
  const w = getSettings().panelWidth || 440;
  p.style.width = w + "px"; p.style.right = panelOpen ? "0" : `-${w + 20}px`;
}

function createUI() {
  const btn = document.createElement("div"); btn.id = "fab-btn"; btn.innerHTML = "⟐"; btn.title = "FAB Sheet";
  document.body.appendChild(btn);
  const panel = document.createElement("div"); panel.id = "fab-panel";
  panel.innerHTML = `<div class="fab-ph"><div class="fab-pt">⟐ F&B ⟐</div><div class="fab-pa">
    <button id="fab-raw-btn" class="fab-raw-toggle">{ }</button>
    <button id="fab-rescan" class="fab-ab2">↻</button>
    <button id="fab-close" class="fab-ab2">✕</button></div></div>
    <div class="fab-tabs"><button class="fab-tab active" data-tab="overview">시트</button><button class="fab-tab" data-tab="generate">AI</button><button class="fab-tab" data-tab="settings">⚙</button></div>
    <div id="fab-content" class="fab-ct"></div>`;
  document.body.appendChild(panel);
  applyPanelWidth(); setupDelegation();
  btn.addEventListener("click", togglePanel);
  document.getElementById("fab-close").addEventListener("click", togglePanel);
  document.getElementById("fab-rescan").addEventListener("click", scanAll);
  document.getElementById("fab-raw-btn").addEventListener("click", () => {
    rawMode = !rawMode; document.getElementById("fab-raw-btn").classList.toggle("active", rawMode);
    if (rawMode) { currentTab = "raw"; panel.querySelectorAll(".fab-tab").forEach(t => t.classList.remove("active")); }
    else { currentTab = "overview"; panel.querySelectorAll(".fab-tab").forEach(t => t.classList.toggle("active", t.dataset.tab === "overview")); }
    refreshPanel();
  });
  panel.querySelectorAll(".fab-tab").forEach(tab => tab.addEventListener("click", () => {
    rawMode = false; document.getElementById("fab-raw-btn").classList.remove("active");
    panel.querySelectorAll(".fab-tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active"); currentTab = tab.dataset.tab; refreshPanel();
  }));
}

function togglePanel() { panelOpen = !panelOpen; applyPanelWidth(); if (panelOpen) refreshPanel(); }

function refreshPanel() {
  const el = document.getElementById("fab-content"); if (!el) return;
  switch (currentTab) {
    case "overview": el.innerHTML = renderOverview(); break;
    case "raw": el.innerHTML = renderRaw(); break;
    case "generate": el.innerHTML = renderGenerate(); break;
    case "settings": el.innerHTML = renderSettings(); break;
  }
}

/* ============================================================
   INIT
   ============================================================ */

jQuery(async () => {
  createUI(); createExtSlot(); registerWandAction(); applyColors();
  eventSource.on(event_types.GENERATION_STARTED, () => injectPrompt());
  eventSource.on(event_types.MESSAGE_RECEIVED, (idx) => { const msg = getContext().chat[idx]; if (msg?.mes) processMsg(msg.mes); setTimeout(hideBlocks, 300); });
  eventSource.on(event_types.MESSAGE_EDITED, () => { scanAll(); setTimeout(hideBlocks, 300); });
  eventSource.on(event_types.CHAT_CHANGED, () => setTimeout(() => { scanAll(); hideBlocks(); }, 1000));
  setTimeout(() => { scanAll(); hideBlocks(); }, 2000);
  console.log(`[FAB] ${EXT_DISPLAY} v5.0 — TRPG Sheet`);
});
