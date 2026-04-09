import { getContext, saveMetadataDebounced, extension_settings } from "../../../extensions.js";
import { eventSource, event_types, generateRaw } from "../../../../script.js";

const EXT = "flow-and-brand-sheet";
const EXT_DISPLAY = "Flow & Brand Sheet";
const META_KEY = "fabSheetData";
const SETTINGS_KEY = "fabSheet";

// ============================================================
// DEFAULT SCHEMA — displayMode: timeline | profile | log | table
// ============================================================

const DISPLAY_MODES = ["timeline", "profile", "log", "table"];

const DEFAULT_SCHEMA = [
  { name: "시공간", columns: ["날짜", "시간", "위치", "등장인물"], displayMode: "timeline" },
  { name: "캐릭터", columns: ["인물", "신체적특징", "성격", "관계", "특성", "기타"], displayMode: "profile" },
  { name: "임무", columns: ["인물", "임무", "위치", "기간", "상태"], displayMode: "log" },
  { name: "이벤트", columns: ["인물", "이벤트/의식", "날짜", "위치", "결과"], displayMode: "log" },
  { name: "소지품/전투", columns: ["소유자", "아이템/전투", "상세", "효과/상태"], displayMode: "table" },
];

const DEFAULT_COLORS = { accent: "#6c5ce7", tableIdx: "#6c5ce7", insert: "#27ae60", update: "#b7791f", delete: "#e74c3c" };

// ============================================================
// SETTINGS
// ============================================================

function getSettings() {
  if (!extension_settings[SETTINGS_KEY]) {
    extension_settings[SETTINGS_KEY] = {
      schema: JSON.parse(JSON.stringify(DEFAULT_SCHEMA)),
      hideTableEdit: true, panelWidth: 420, injectEnabled: true,
      injectTables: {}, injectDepth: 4,
      colors: JSON.parse(JSON.stringify(DEFAULT_COLORS)),
    };
  }
  const s = extension_settings[SETTINGS_KEY];
  if (!s.injectTables) s.injectTables = {};
  for (let i = 0; i < s.schema.length; i++) {
    if (s.injectTables[i] === undefined) s.injectTables[i] = true;
    if (!s.schema[i].displayMode) s.schema[i].displayMode = "table";
  }
  for (const k of Object.keys(s.injectTables)) { if (parseInt(k) >= s.schema.length) delete s.injectTables[k]; }
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
  document.documentElement.style.setProperty("--fab-accent", c.accent || DEFAULT_COLORS.accent);
}

// ============================================================
// DATA
// ============================================================

function buildEmpty() {
  const schema = getSchema(); const tables = {};
  for (let i = 0; i < schema.length; i++) tables[i] = { name: schema[i].name, columns: [...schema[i].columns], rows: [] };
  return tables;
}

function isRowEmpty(row, colCount) {
  for (let i = 0; i < colCount; i++) {
    const v = (row[i] || "").trim();
    if (v && v !== "CharName" && v !== "name" && v !== "data" && v !== "location" && v !== "Active"
      && v !== "캐릭터명" && v !== "Tall, dark hair" && v !== "Some notes"
      && v !== "Mission:임무명") return false;
  }
  return true;
}

function cleanRows(table) {
  if (!table || !table.rows) return;
  table.rows = table.rows.filter(row => !isRowEmpty(row, table.columns.length));
}

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
          for (let ci = 0; ci < nc.length; ci++) { if (row[ci] === undefined) row[ci] = ""; }
          for (const key of Object.keys(row)) { if (parseInt(key) >= nc.length) delete row[key]; }
        }
        tables[i].columns = [...nc];
      }
    }
    cleanRows(tables[i]);
  }
  for (const k of Object.keys(tables).map(Number)) { if (k >= schema.length) delete tables[k]; }
  return tables;
}

function saveTables() { saveMetadataDebounced(); }
function resetTables() { getContext().chatMetadata[META_KEY] = buildEmpty(); }
function execInsert(ti, data) {
  const t = getTables()[ti]; if (!t) return;
  const row = {}; for (let i = 0; i < t.columns.length; i++) row[i] = data[i] !== undefined ? String(data[i]) : "";
  if (!isRowEmpty(row, t.columns.length)) t.rows.push(row);
}
function execDelete(ti, ri) { const t = getTables()[ti]; if (!t || !t.rows[ri]) return; t.rows.splice(ri, 1); }
function execUpdate(ti, ri, data) { const t = getTables()[ti]; if (!t || !t.rows[ri]) return; for (const [ci, val] of Object.entries(data)) t.rows[ri][parseInt(ci)] = String(val); }

// ============================================================
// PARSER
// ============================================================

function parseDataObj(str) { const d = {}; const re = /(\d+)\s*:\s*(?:"([^"]*?)"|'([^']*?)'|([^\s,}]+))/g; let m; while ((m = re.exec(str)) !== null) d[parseInt(m[1])] = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] || ""; return d; }

function parseEdits(text) {
  const ops = []; const re = /<tableEdit>([\s\S]*?)<\/tableEdit>|<!--\s*tableEdit\s*-->([\s\S]*?)<!--\s*\/tableEdit\s*-->/gi; let em;
  while ((em = re.exec(text)) !== null) {
    const block = (em[1] || em[2] || "").replace(/<!--/g, "").replace(/-->/g, "");
    for (const line of block.split("\n")) {
      const t = line.trim(); if (!t || t.startsWith("//")) continue; let m;
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

function processMsg(text) { if (!text) return false; const ops = parseEdits(text); if (ops.length > 0) { applyOps(ops); saveTables(); refreshPanel(); updateExtSlot(); return true; } return false; }

function scanAll() {
  const ctx = getContext(); if (!ctx.chat || ctx.chat.length === 0) return;
  resetTables();
  for (const msg of ctx.chat) { if (msg.mes) { const ops = parseEdits(msg.mes); if (ops.length > 0) applyOps(ops); } }
  saveTables(); refreshPanel(); updateExtSlot();
}

// ============================================================
// PROMPT INJECTION
// ============================================================

function buildPrompt() {
  const settings = getSettings();
  if (!settings.injectEnabled) return "";
  const tables = getTables();
  const enabled = Object.entries(settings.injectTables).filter(([_, v]) => v).map(([k]) => parseInt(k)).sort((a, b) => a - b);
  if (enabled.length === 0) return "";
  let p = "\n[FAB Sheet — Current Data]\n(Injected tables: " + enabled.join(", ") + ")\n";
  for (const idx of enabled) {
    const table = tables[idx]; if (!table) continue;
    p += `\n### Table ${idx}: ${table.name}\nColumns: ${table.columns.join(" | ")}\n`;
    if (table.rows.length === 0) p += "(empty)\n";
    else for (let ri = 0; ri < table.rows.length; ri++) { p += `[${ri}] ${table.columns.map((_, ci) => table.rows[ri][ci] || "").join(" | ")}\n`; }
  }
  p += `\n[Table Edit Instructions]
When table data changes during the narrative, output modifications inside a <tableEdit> block at the END of your response.
Commands:
  insertRow(tableIndex, {colIndex: "value", ...})
  updateRow(tableIndex, rowIndex, {colIndex: "newValue", ...})
  deleteRow(tableIndex, rowIndex)
Available table indices for editing: ${enabled.join(", ")}
Example:
<tableEdit>
updateRow(1, 0, {2: "newValue"})
insertRow(2, {0: "name", 1: "data", 2: "location", 3: "duration", 4: "Active"})
</tableEdit>
Rules:
- Include <tableEdit> ONLY when data changes. Omit when nothing changes.
- Use exact row indices from the current state above.
- Place <tableEdit> AFTER the narrative response.
- Do NOT include <tableEdit> inside narrative prose.\n`;
  return p;
}

function injectPrompt() {
  const ctx = getContext(); if (!ctx.extensionPrompts) ctx.extensionPrompts = {};
  const prompt = buildPrompt();
  if (!prompt) { delete ctx.extensionPrompts[EXT]; return; }
  ctx.extensionPrompts[EXT] = { value: prompt, position: 1, depth: getSettings().injectDepth, role: 0 };
}

// ============================================================
// AI GENERATION
// ============================================================

async function aiGenerate(userInstruction, mode) {
  const schema = getSchema(); const tables = getTables();
  let currentData = "";
  for (let i = 0; i < schema.length; i++) {
    const t = tables[i]; if (!t) continue;
    currentData += `Table ${i}: "${t.name}" (displayMode: ${schema[i].displayMode}) — Columns: ${t.columns.map((c, ci) => `[${ci}]${c}`).join(", ")}\n`;
    if (t.rows.length > 0) { for (let ri = 0; ri < t.rows.length; ri++) currentData += `  [${ri}] ${t.columns.map((_, ci) => t.rows[ri][ci] || "").join(" | ")}\n`; }
    else currentData += "  (empty)\n";
  }
  const ctx = getContext(); let chatContext = "";
  if (ctx.chat && ctx.chat.length > 0) {
    const recent = ctx.chat.slice(-15);
    for (const msg of recent) {
      const role = msg.is_user ? "User" : "Character";
      const text = (msg.mes || "").replace(/<tableEdit>[\s\S]*?<\/tableEdit>/gi, "").trim();
      if (text) chatContext += `[${role}]: ${text.substring(0, 600)}\n`;
    }
  }

  let systemPrompt;
  if (mode === "setup") {
    systemPrompt = `You are a data assistant for a roleplay tracking sheet. Analyze the recent chat context and generate initial table data.

Current table schema:
${currentData}

Recent chat context:
${chatContext || "(no chat yet)"}

User instruction: ${userInstruction}

RULES:
- Output ONLY a <tableEdit> block. No other text.
- Generate insertRow commands to populate tables based on the chat context.
- Only insert rows with meaningful data. Do NOT insert placeholder/empty rows.
- Use the exact table indices and column indices from the schema.
- For characters, include relationships and traits in the same row if the schema supports it.
- Be thorough — extract all characters, locations, events, items mentioned in the chat.

Example:
<tableEdit>
insertRow(0, {0: "사념월 7일", 1: "밤", 2: "넬사라", 3: "네이/키안"})
insertRow(1, {0: "네이", 1: "검은 머리, 창백한 피부", 2: "경계심이 강함", 3: "키안→경계/호기심", 4: "본성 각성, 자아 소멸", 5: "현현자/환무술사"})
</tableEdit>`;
  } else {
    systemPrompt = `You are a data assistant. Generate table edit commands based on the user's request.

Current table schema and data:
${currentData}

${chatContext ? `Recent chat context:\n${chatContext}\n` : ""}

RULES:
- Output ONLY a <tableEdit> block. No other text.
- Use the exact table indices and column indices from the schema.
- Only create rows with actual data. Never insert empty or placeholder rows.`;
  }

  try {
    const response = await generateRaw(userInstruction, "", false, false, systemPrompt);
    return response;
  } catch (e) {
    console.error("[FAB] AI generation failed:", e);
    try { return await generateRaw(systemPrompt + "\n\nUser request: " + userInstruction, ""); }
    catch (e2) { console.error("[FAB] Fallback also failed:", e2); return null; }
  }
}

// ============================================================
// HIDE <tableEdit>
// ============================================================

function hideBlocks() {
  if (!getSettings().hideTableEdit) return;
  document.querySelectorAll(".mes_text").forEach(el => {
    if (el.dataset.fabProcessed) return; el.dataset.fabProcessed = "true";
    const html = el.innerHTML;
    const cleaned = html.replace(/<tableEdit>[\s\S]*?<\/tableEdit>/gi, "").replace(/<tableEdit>[\s\S]*?<\/tableEdit>/gi, "");
    if (cleaned !== html) el.innerHTML = cleaned;
  });
}

// ============================================================
// RENDER — DESIGNED OVERVIEW
// ============================================================

function esc(s) { return (s || "").replace(/</g, "<").replace(/>/g, ">"); }

function renderTimeline(table) {
  if (!table.rows.length) return '<div class="fab-empty">비어 있음</div>';
  let h = '<div class="fab-tl">';
  for (const row of table.rows) {
    h += `<div class="fab-tl-item">
      <div class="fab-tl-top">
        <span class="fab-tl-date">${esc(row[0])}</span>
        <span class="fab-tl-time">${esc(row[1])}</span>
      </div>
      <div class="fab-tl-loc">${esc(row[2])}</div>
      <div class="fab-tl-chars">${esc(row[3])}</div>
    </div>`;
  }
  return h + '</div>';
}

function renderProfiles(table) {
  if (!table.rows.length) return '<div class="fab-empty">비어 있음</div>';
  let h = '<div class="fab-profiles">';
  for (const row of table.rows) {
    const name = row[0] || "???";
    const initial = name.charAt(0).toUpperCase();
    h += `<div class="fab-pf">
      <div class="fab-pf-header">
        <div class="fab-pf-avatar">${esc(initial)}</div>
        <div class="fab-pf-name">${esc(name)}</div>
      </div>
      <div class="fab-pf-body">`;
    for (let ci = 1; ci < table.columns.length; ci++) {
      const val = (row[ci] || "").trim();
      if (!val) continue;
      const colName = table.columns[ci];
      if (colName === "관계" || colName === "특성") {
        h += `<div class="fab-pf-section-title">${esc(colName)}</div>`;
        const parts = val.split(/[,/;·]/).map(s => s.trim()).filter(Boolean);
        h += '<div>';
        for (const part of parts) h += `<span class="fab-pf-tag">${esc(part)}</span>`;
        h += '</div>';
      } else {
        h += `<div class="fab-pf-row"><span class="fab-pf-label">${esc(colName)}</span><span class="fab-pf-val">${esc(val)}</span></div>`;
      }
    }
    h += '</div></div>';
  }
  return h + '</div>';
}

function renderLogs(table, iconClass) {
  if (!table.rows.length) return '<div class="fab-empty">비어 있음</div>';
  let h = '<div class="fab-logs">';
  for (const row of table.rows) {
    const iconLetter = iconClass === "mission" ? "M" : iconClass === "event" ? "E" : "?";
    const statusVal = (row[table.columns.length - 1] || "").trim().toLowerCase();
    const statusClass = (statusVal.includes("active") || statusVal.includes("진행") || statusVal.includes("성공")) ? "active" : "done";

    h += `<div class="fab-log">
      <div class="fab-log-icon ${iconClass}">${iconLetter}</div>
      <div class="fab-log-content">
        <div class="fab-log-title">${esc(row[0])} — ${esc(row[1])}</div>
        <div class="fab-log-meta">`;
    for (let ci = 2; ci < table.columns.length - 1; ci++) {
      if ((row[ci] || "").trim()) h += `<span>${esc(table.columns[ci])}: ${esc(row[ci])}</span>`;
    }
    const lastVal = (row[table.columns.length - 1] || "").trim();
    if (lastVal) h += `<span class="fab-log-status ${statusClass}">${esc(lastVal)}</span>`;
    h += '</div></div></div>';
  }
  return h + '</div>';
}

function renderPlainTable(table) {
  if (!table.rows.length) return '<div class="fab-empty">비어 있음</div>';
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

function renderTableDesigned(tableIndex) {
  const tables = getTables(); const schema = getSchema();
  const table = tables[tableIndex]; if (!table) return '<div class="fab-empty">없음</div>';
  const mode = schema[tableIndex]?.displayMode || "table";
  switch (mode) {
    case "timeline": return renderTimeline(table);
    case "profile": return renderProfiles(table);
    case "log": {
      const name = (schema[tableIndex]?.name || "").toLowerCase();
      const icon = name.includes("임무") || name.includes("mission") ? "mission" : "event";
      return renderLogs(table, icon);
    }
    default: return renderPlainTable(table);
  }
}

function renderOverview() {
  const tables = getTables(); const schema = getSchema(); let h = "";
  for (let i = 0; i < schema.length; i++) {
    const t = tables[i]; if (!t) continue;
    const rc = t.rows?.length || 0;
    const mode = schema[i].displayMode || "table";
    const modeLabels = { timeline: "타임라인", profile: "프로필", log: "로그", table: "테이블" };
    h += `<div class="fab-section">
      <div class="fab-section-header" data-action="toggle-table" data-idx="${i}">
        <span class="fab-section-title"><span class="fab-section-idx">${i}</span>${esc(t.name)}<span class="fab-section-count">${rc}건</span></span>
        <span class="fab-section-mode">${modeLabels[mode] || mode}</span>
        <span class="fab-section-arrow" id="fab-arrow-${i}">▸</span>
      </div>
      <div class="fab-section-body" id="fab-tbody-${i}" style="display:none;">${renderTableDesigned(i)}</div>
    </div>`;
  }
  return h || '<div class="fab-empty">테이블이 없습니다.</div>';
}

function renderRaw() {
  const tables = getTables(); let h = "";
  for (const [idx, table] of Object.entries(tables)) {
    h += `<div class="fab-card"><div class="fab-ch">테이블 ${idx}: ${table.name}</div>` + renderPlainTable(table) + '</div>';
  }
  return h;
}

// ============================================================
// RENDER — AI GENERATE
// ============================================================

function renderGenerate() {
  const tables = getTables();
  const hasData = Object.values(tables).some(t => t.rows.length > 0);

  let h = '';

  // AI Setup (shown when tables are mostly empty)
  if (!hasData) {
    h += `<div class="fab-card fab-setup-card">
      <div class="fab-ch">✨ AI 초기 셋업</div>
      <div class="fab-setup-info">채팅 내용을 분석하여 캐릭터, 관계, 이벤트 등 <strong>시트 전체를 자동으로 채워넣습니다.</strong> 데이터가 비어있을 때 사용하세요.</div>
      <textarea id="fab-setup-input" class="fab-gen-textarea" placeholder="예: 현재 채팅 내용을 바탕으로 시트를 전부 채워줘
예: 등장인물, 관계, 위치, 이벤트 전부 분석해서 넣어줘" rows="3"></textarea>
      <div class="fab-gen-actions"><button class="fab-set-btn primary" data-action="ai-setup">✨ 초기 생성</button></div>
      <div id="fab-setup-status" class="fab-gen-status"></div>
      <div id="fab-setup-preview" class="fab-gen-preview"></div>
    </div>`;
  }

  // Regular AI generate
  h += `<div class="fab-card">
    <div class="fab-ch">🤖 AI 데이터 생성</div>
    <div class="fab-gen-desc">특정 테이블에 데이터를 추가하거나 수정합니다.</div>
    <textarea id="fab-gen-input" class="fab-gen-textarea" placeholder="예: 키안의 소지품을 추가해줘
예: 네이의 특성을 업데이트해줘" rows="4"></textarea>
    <div class="fab-gen-actions"><button class="fab-set-btn primary" data-action="ai-generate">생성 요청</button></div>
    <div id="fab-gen-status" class="fab-gen-status"></div>
    <div id="fab-gen-preview" class="fab-gen-preview"></div>
  </div>`;

  return h;
}

// ============================================================
// RENDER — SETTINGS
// ============================================================

function renderSettings() {
  const settings = getSettings(); const schema = settings.schema; const colors = settings.colors;
  const modeLabels = { timeline: "타임라인", profile: "프로필", log: "로그", table: "테이블" };

  let h = `<div class="fab-card"><div class="fab-ch">⚙ 일반</div>
    <div class="fab-set-section"><label class="fab-set-chk"><input type="checkbox" id="fab-opt-hide" ${settings.hideTableEdit ? "checked" : ""}><span>채팅에서 <tableEdit> 숨기기</span></label></div>
    <div class="fab-set-section"><div class="fab-set-label">패널 너비 (px)</div><input type="number" id="fab-opt-width" class="fab-set-input" value="${settings.panelWidth}" min="300" max="800" step="50"></div></div>`;

  h += `<div class="fab-card"><div class="fab-ch">🎨 색상</div>`;
  for (const [key, label] of [["accent","액센트"],["tableIdx","인덱스"],["insert","Insert"],["update","Update"],["delete","Delete"]]) {
    h += `<div class="fab-color-row"><span class="fab-color-label">${label}</span><input type="color" class="fab-color-picker" data-color-key="${key}" value="${colors[key] || DEFAULT_COLORS[key]}"><span class="fab-color-hex">${colors[key] || DEFAULT_COLORS[key]}</span></div>`;
  }
  h += `<div style="margin-top:10px"><button class="fab-set-btn danger" data-action="reset-colors">색상 초기화</button></div></div>`;

  h += `<div class="fab-card"><div class="fab-ch">🧠 AI 참조</div>
    <div class="fab-set-section"><label class="fab-set-chk"><input type="checkbox" id="fab-opt-inject" ${settings.injectEnabled ? "checked" : ""}><span>테이블 데이터를 AI에 전달</span></label><div class="fab-set-hint">활성화하면 AI가 테이블 내용을 참고하여 응답합니다.</div></div>
    <div id="fab-inject-tables" class="${settings.injectEnabled ? "" : "fab-disabled"}"><div class="fab-set-label">테이블별 주입</div>
    ${schema.map((s, i) => `<label class="fab-set-chk fab-inject-row"><input type="checkbox" class="fab-inject-table-chk" data-inject-idx="${i}" ${settings.injectTables[i] ? "checked" : ""}><span><span class="fab-inject-idx">${i}</span> ${s.name}</span><span class="fab-inject-info">${s.columns.length}컬럼 · ${(getTables()[i]?.rows?.length || 0)}행</span></label>`).join("")}
    </div>
    <div class="fab-set-section" style="margin-top:12px"><div class="fab-set-label">삽입 깊이</div><div class="fab-set-hint">숫자가 작을수록 최근 메시지에 가깝게 삽입.</div><input type="number" id="fab-opt-depth" class="fab-set-input" value="${settings.injectDepth}" min="0" max="999" step="1"></div></div>`;

  h += `<div class="fab-card"><div class="fab-ch">📐 스키마 편집</div>`;
  for (let i = 0; i < schema.length; i++) {
    const s = schema[i];
    h += `<div class="fab-schema-block" data-schema-idx="${i}">
      <div class="fab-schema-toggle" data-action="toggle-schema" data-idx="${i}">
        <span class="fab-schema-arrow" id="fab-sarrow-${i}">▸</span><span class="fab-schema-idx">${i}</span>
        <span class="fab-schema-preview-name">${esc(s.name)}</span><span class="fab-schema-preview-cols">${s.columns.length}컬럼 · ${modeLabels[s.displayMode] || s.displayMode}</span>
      </div>
      <div class="fab-schema-detail" id="fab-sdetail-${i}" style="display:none;">
        <div class="fab-schema-head"><input type="text" class="fab-schema-name" value="${esc(s.name)}" data-schema-name-idx="${i}" placeholder="테이블 이름"><button class="fab-ab2" data-action="del-table" data-idx="${i}" title="삭제">✕</button></div>
        <div class="fab-schema-mode-row"><span class="fab-set-label" style="margin:0">표시 모드</span><select class="fab-set-select" data-mode-idx="${i}">${DISPLAY_MODES.map(m => `<option value="${m}" ${s.displayMode === m ? "selected" : ""}>${modeLabels[m]}</option>`).join("")}</select></div>
        <div class="fab-schema-cols" id="fab-scols-${i}">
          ${s.columns.map((col, ci) => `<div class="fab-schema-col-row"><input type="text" class="fab-schema-col" value="${esc(col)}" data-col-ti="${i}" data-col-ci="${ci}" placeholder="컬럼명"><button class="fab-col-btn" data-action="del-col" data-ti="${i}" data-ci="${ci}">−</button></div>`).join("")}
          <button class="fab-col-btn add" data-action="add-col" data-ti="${i}">+ 컬럼</button>
        </div>
      </div>
    </div>`;
  }
  h += `<div class="fab-schema-actions"><button class="fab-set-btn" data-action="add-table">+ 테이블</button><button class="fab-set-btn primary" data-action="save-schema">저장</button><button class="fab-set-btn danger" data-action="reset-schema">기본값 복원</button></div></div>`;

  h += `<div class="fab-card"><div class="fab-ch">📋 JSON 임포트</div>
    <div class="fab-set-hint">형식: [{"name":"이름","columns":["컬럼1"],"displayMode":"table"}]</div>
    <textarea id="fab-json-input" class="fab-json-textarea" rows="6" placeholder='[{"name":"Characters","columns":["Name","Desc"],"displayMode":"profile"}]'></textarea>
    <div class="fab-json-actions"><button class="fab-set-btn primary" data-action="json-apply">JSON 적용</button><button class="fab-set-btn" data-action="json-export">내보내기</button></div>
    <div id="fab-json-status" class="fab-gen-status"></div></div>`;

  return h;
}

// ============================================================
// AI HANDLERS
// ============================================================

async function handleAiAction(mode) {
  const isSetup = mode === "setup";
  const inputEl = document.getElementById(isSetup ? "fab-setup-input" : "fab-gen-input");
  const statusEl = document.getElementById(isSetup ? "fab-setup-status" : "fab-gen-status");
  const previewEl = document.getElementById(isSetup ? "fab-setup-preview" : "fab-gen-preview");
  const btnSelector = isSetup ? "[data-action='ai-setup']" : "[data-action='ai-generate']";
  const runBtn = document.querySelector(btnSelector);

  const instruction = (inputEl?.value || "").trim() || (isSetup ? "채팅 내용을 분석해서 모든 테이블을 채워줘" : "");
  if (!instruction && !isSetup) { if (statusEl) statusEl.innerHTML = '<span class="fab-gen-err">요청 내용을 입력해주세요.</span>'; return; }

  if (runBtn) { runBtn.disabled = true; runBtn.textContent = "생성 중..."; }
  if (statusEl) statusEl.innerHTML = '<span class="fab-gen-loading">⏳ AI에 요청 중...</span>';
  if (previewEl) previewEl.innerHTML = "";

  try {
    const response = await aiGenerate(instruction, mode);
    if (!response) { if (statusEl) statusEl.innerHTML = '<span class="fab-gen-err">AI 응답을 받지 못했습니다.</span>'; return; }
    const ops = parseEdits(response);
    if (ops.length === 0) {
      if (statusEl) statusEl.innerHTML = '<span class="fab-gen-err">유효한 명령을 찾지 못했습니다.</span>';
      if (previewEl) previewEl.innerHTML = `<div class="fab-gen-raw"><div class="fab-gen-raw-label">AI 원본 응답:</div><pre>${esc(response.substring(0, 2000))}</pre></div>`;
      return;
    }
    let ph = `<div class="fab-gen-ops-label">감지된 명령 (${ops.length}개):</div>`;
    for (const op of ops) {
      if (op.type === "insert") ph += `<div class="fab-gen-op insert">+ insertRow(${op.ti}, {...})</div>`;
      else if (op.type === "update") ph += `<div class="fab-gen-op update">~ updateRow(${op.ti}, ${op.ri}, {...})</div>`;
      else if (op.type === "delete") ph += `<div class="fab-gen-op delete">- deleteRow(${op.ti}, ${op.ri})</div>`;
    }
    ph += `<div class="fab-gen-confirm-actions"><button class="fab-set-btn primary" data-action="ai-apply" data-source="${mode}">적용</button><button class="fab-set-btn" data-action="ai-cancel" data-source="${mode}">취소</button></div>`;
    if (statusEl) statusEl.innerHTML = '<span class="fab-gen-ok">✅ 생성 완료. 확인 후 적용하세요.</span>';
    if (previewEl) { previewEl.innerHTML = ph; previewEl.dataset.pendingOps = JSON.stringify(ops); }
  } catch (err) {
    if (statusEl) statusEl.innerHTML = `<span class="fab-gen-err">오류: ${err.message || err}</span>`;
  } finally {
    if (runBtn) { runBtn.disabled = false; runBtn.textContent = isSetup ? "✨ 초기 생성" : "생성 요청"; }
  }
}

// ============================================================
// CENTRAL EVENT DELEGATION
// ============================================================

function setupDelegation() {
  const content = document.getElementById("fab-content");
  if (!content) return;

  content.addEventListener("click", (e) => {
    const target = e.target;
    const action = target.closest("[data-action]");
    if (!action) return;
    const act = action.dataset.action;

    switch (act) {
      case "toggle-table": {
        const idx = action.dataset.idx;
        const body = document.getElementById(`fab-tbody-${idx}`);
        const arrow = document.getElementById(`fab-arrow-${idx}`);
        if (body) { const o = body.style.display !== "none"; body.style.display = o ? "none" : "block"; if (arrow) arrow.textContent = o ? "▸" : "▾"; }
        break;
      }
      case "toggle-schema": {
        const idx = action.dataset.idx;
        const detail = document.getElementById(`fab-sdetail-${idx}`);
        const arrow = document.getElementById(`fab-sarrow-${idx}`);
        if (detail) { const o = detail.style.display !== "none"; detail.style.display = o ? "none" : "block"; if (arrow) arrow.textContent = o ? "▸" : "▾"; }
        break;
      }
      case "del-table": {
        const idx = parseInt(action.dataset.idx); const schema = getSchema();
        if (schema.length <= 1) { alert("최소 1개 필요."); break; }
        if (confirm(`"${schema[idx].name}" 삭제?`)) {
          schema.splice(idx, 1);
          const ni = {}; for (let i = 0; i < schema.length; i++) { const oi = i >= idx ? i + 1 : i; ni[i] = getSettings().injectTables[oi] !== undefined ? getSettings().injectTables[oi] : true; }
          getSettings().injectTables = ni; setSchema(schema); refreshPanel(); updateExtSlot();
        }
        break;
      }
      case "add-col": {
        const ti = parseInt(action.dataset.ti); const schema = getSchema();
        if (schema[ti]) { schema[ti].columns.push(`Column${schema[ti].columns.length + 1}`); setSchema(schema); refreshPanel(); }
        break;
      }
      case "del-col": {
        const ti = parseInt(action.dataset.ti), ci = parseInt(action.dataset.ci); const schema = getSchema();
        if (schema[ti] && schema[ti].columns.length > 1) { schema[ti].columns.splice(ci, 1); setSchema(schema); refreshPanel(); }
        break;
      }
      case "add-table": {
        const schema = getSchema(); schema.push({ name: `Table ${schema.length}`, columns: ["Column1"], displayMode: "table" });
        getSettings().injectTables[schema.length - 1] = true; setSchema(schema); refreshPanel();
        break;
      }
      case "save-schema": {
        const schema = getSchema();
        document.querySelectorAll("[data-schema-name-idx]").forEach(input => { const idx = parseInt(input.dataset.schemaNameIdx); if (schema[idx]) schema[idx].name = input.value.trim() || `Table ${idx}`; });
        document.querySelectorAll("[data-mode-idx]").forEach(sel => { const idx = parseInt(sel.dataset.modeIdx); if (schema[idx]) schema[idx].displayMode = sel.value; });
        for (let i = 0; i < schema.length; i++) { const cols = []; document.querySelectorAll(`[data-col-ti="${i}"]`).forEach(input => { const v = input.value.trim(); if (v) cols.push(v); }); if (cols.length > 0) schema[i].columns = cols; }
        setSchema(schema); getTables(); saveTables(); injectPrompt(); updateExtSlot();
        alert("스키마 저장 완료."); refreshPanel();
        break;
      }
      case "reset-schema": { if (confirm("기본값으로 복원?")) { resetSchema(); refreshPanel(); updateExtSlot(); } break; }
      case "reset-colors": { getSettings().colors = JSON.parse(JSON.stringify(DEFAULT_COLORS)); saveSettings(); applyColors(); refreshPanel(); break; }
      case "json-apply": {
        const input = document.getElementById("fab-json-input"); const statusEl = document.getElementById("fab-json-status");
        const raw = (input?.value || "").trim();
        if (!raw) { statusEl.innerHTML = '<span class="fab-gen-err">JSON을 입력해주세요.</span>'; break; }
        try {
          const parsed = JSON.parse(raw);
          if (!Array.isArray(parsed)) throw new Error("배열이어야 합니다.");
          for (let i = 0; i < parsed.length; i++) { if (!parsed[i].name || !Array.isArray(parsed[i].columns) || !parsed[i].columns.length) throw new Error(`항목 ${i} 오류`); }
          if (!confirm(`${parsed.length}개 테이블로 교체?`)) break;
          const ns = parsed.map(t => ({ name: String(t.name), columns: t.columns.map(c => String(c)), displayMode: DISPLAY_MODES.includes(t.displayMode) ? t.displayMode : "table" }));
          const s = getSettings(); s.schema = ns; s.injectTables = {};
          for (let i = 0; i < ns.length; i++) s.injectTables[i] = true;
          saveSettings(); getTables(); saveTables(); injectPrompt(); updateExtSlot();
          statusEl.innerHTML = `<span class="fab-gen-ok">✅ ${ns.length}개 테이블로 교체 완료.</span>`; refreshPanel();
        } catch (e2) { statusEl.innerHTML = `<span class="fab-gen-err">오류: ${e2.message}</span>`; }
        break;
      }
      case "json-export": { const input = document.getElementById("fab-json-input"); if (input) input.value = JSON.stringify(getSchema(), null, 2); break; }
      case "ai-generate": { handleAiAction("generate"); break; }
      case "ai-setup": { handleAiAction("setup"); break; }
      case "ai-apply": {
        const source = action.dataset.source || "generate";
        const previewEl = document.getElementById(source === "setup" ? "fab-setup-preview" : "fab-gen-preview");
        if (previewEl?.dataset.pendingOps) {
          const pending = JSON.parse(previewEl.dataset.pendingOps);
          applyOps(pending); saveTables(); refreshPanel(); updateExtSlot();
          setTimeout(() => {
            const s = document.getElementById(source === "setup" ? "fab-setup-status" : "fab-gen-status");
            if (s) s.innerHTML = `<span class="fab-gen-ok">✅ ${pending.length}개 명령 적용 완료.</span>`;
          }, 100);
        }
        break;
      }
      case "ai-cancel": {
        const source = action.dataset.source || "generate";
        const previewEl = document.getElementById(source === "setup" ? "fab-setup-preview" : "fab-gen-preview");
        const statusEl = document.getElementById(source === "setup" ? "fab-setup-status" : "fab-gen-status");
        if (previewEl) previewEl.innerHTML = "";
        if (statusEl) statusEl.innerHTML = '<span class="fab-gen-info">취소됨.</span>';
        break;
      }
    }
  });

  content.addEventListener("change", (e) => {
    const target = e.target;
    if (target.id === "fab-opt-hide") { getSettings().hideTableEdit = target.checked; saveSettings(); }
    else if (target.id === "fab-opt-width") { getSettings().panelWidth = parseInt(target.value) || 420; saveSettings(); applyPanelWidth(); }
    else if (target.id === "fab-opt-inject") { getSettings().injectEnabled = target.checked; saveSettings(); const ts = document.getElementById("fab-inject-tables"); if (ts) ts.classList.toggle("fab-disabled", !target.checked); updateExtSlot(); }
    else if (target.dataset.injectIdx !== undefined) { getSettings().injectTables[parseInt(target.dataset.injectIdx)] = target.checked; saveSettings(); updateExtSlot(); }
    else if (target.id === "fab-opt-depth") { getSettings().injectDepth = parseInt(target.value) || 4; saveSettings(); }
  });

  content.addEventListener("input", (e) => {
    const target = e.target;
    if (target.classList.contains("fab-color-picker") && target.dataset.colorKey) {
      getSettings().colors[target.dataset.colorKey] = target.value;
      const hex = target.parentElement?.querySelector(".fab-color-hex"); if (hex) hex.textContent = target.value;
      saveSettings(); applyColors();
    }
  });
}

// ============================================================
// EXTENSIONS PANEL SLOT
// ============================================================

function createExtSlot() {
  const container = document.getElementById("extensions_settings2");
  if (!container) return;
  const wrapper = document.createElement("div");
  wrapper.id = "fab-ext-slot"; wrapper.classList.add("extension_container");
  wrapper.innerHTML = `<div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <div class="inline-drawer-icon fa-solid fa-diamond" style="color:var(--fab-accent, #6c5ce7)"></div>
      <span class="inline-drawer-title">${EXT_DISPLAY}</span>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content" style="display:none">
      <div id="fab-ext-status" class="fab-ext-info"></div>
      <div class="fab-ext-actions">
        <input id="fab-ext-btn-open" class="menu_button" type="button" value="📋 시트 열기">
        <input id="fab-ext-btn-scan" class="menu_button" type="button" value="↻ 재스캔">
      </div>
      <hr>
      <div class="fab-ext-quick">
        <label class="checkbox_label"><input type="checkbox" id="fab-ext-chk-hide"><span>채팅에서 <tableEdit> 숨기기</span></label>
        <label class="checkbox_label"><input type="checkbox" id="fab-ext-chk-inject"><span>AI에 테이블 데이터 전달</span></label>
      </div>
    </div>
  </div>`;
  container.appendChild(wrapper);
  wrapper.querySelector(".inline-drawer-toggle").addEventListener("click", function () {
    const c = wrapper.querySelector(".inline-drawer-content");
    const a = wrapper.querySelector(".inline-drawer-icon.down");
    const o = c.style.display !== "none";
    c.style.display = o ? "none" : "block";
    if (a) { a.classList.toggle("fa-circle-chevron-down", o); a.classList.toggle("fa-circle-chevron-up", !o); }
  });
  document.getElementById("fab-ext-btn-open").addEventListener("click", () => { if (!panelOpen) togglePanel(); });
  document.getElementById("fab-ext-btn-scan").addEventListener("click", scanAll);
  const hideChk = document.getElementById("fab-ext-chk-hide");
  hideChk.checked = getSettings().hideTableEdit;
  hideChk.addEventListener("change", () => { getSettings().hideTableEdit = hideChk.checked; saveSettings(); });
  const injectChk = document.getElementById("fab-ext-chk-inject");
  injectChk.checked = getSettings().injectEnabled;
  injectChk.addEventListener("change", () => { getSettings().injectEnabled = injectChk.checked; saveSettings(); updateExtSlot(); });
  updateExtSlot();
}

function updateExtSlot() {
  const statusEl = document.getElementById("fab-ext-status"); if (!statusEl) return;
  const settings = getSettings(); const tables = getTables();
  const totalRows = Object.values(tables).reduce((sum, t) => sum + (t.rows?.length || 0), 0);
  const enabledCount = Object.values(settings.injectTables).filter(v => v).length;
  statusEl.innerHTML = `
    <div class="fab-ext-row"><span>테이블</span><span>${settings.schema.length}개 (${totalRows}행)</span></div>
    <div class="fab-ext-row"><span>AI 참조</span><span style="color:${settings.injectEnabled ? "#27ae60" : "#e74c3c"}">${settings.injectEnabled ? `ON (${enabledCount}/${settings.schema.length})` : "OFF"}</span></div>`;
  const hideChk = document.getElementById("fab-ext-chk-hide"); if (hideChk) hideChk.checked = settings.hideTableEdit;
  const injectChk = document.getElementById("fab-ext-chk-inject"); if (injectChk) injectChk.checked = settings.injectEnabled;
}

// ============================================================
// WAND MENU
// ============================================================

function registerWandAction() {
  const wand = document.getElementById("extensionsMenu");
  if (wand) { addWandButton(wand); return; }
  const observer = new MutationObserver((_, obs) => { const w = document.getElementById("extensionsMenu"); if (w) { obs.disconnect(); addWandButton(w); } });
  observer.observe(document.body, { childList: true, subtree: true });
}

function addWandButton(container) {
  if (document.getElementById("fab-wand-btn")) return;
  const btn = document.createElement("div");
  btn.id = "fab-wand-btn"; btn.classList.add("list-group-item", "flex-container", "flexGap5");
  btn.innerHTML = `<span class="fa-solid fa-diamond" style="color:var(--fab-accent, #6c5ce7)"></span> FAB 시트 열기`;
  btn.addEventListener("click", () => { if (!panelOpen) togglePanel(); });
  container.appendChild(btn);
}

// ============================================================
// PANEL
// ============================================================

let currentTab = "overview";
let panelOpen = false;
let rawMode = false;

function applyPanelWidth() {
  const panel = document.getElementById("fab-panel"); if (!panel) return;
  const w = getSettings().panelWidth || 420;
  panel.style.width = w + "px";
  panel.style.right = panelOpen ? "0" : `-${w + 20}px`;
}

function createUI() {
  const btn = document.createElement("div");
  btn.id = "fab-btn"; btn.innerHTML = "⟐"; btn.title = "Flow & Brand Sheet";
  document.body.appendChild(btn);

  const panel = document.createElement("div");
  panel.id = "fab-panel";
  panel.innerHTML = `
    <div class="fab-ph">
      <div class="fab-pt">⟐ Flow & Brand ⟐</div>
      <div class="fab-pa">
        <button id="fab-raw-btn" class="fab-raw-toggle" title="원본 데이터">{ }</button>
        <button id="fab-rescan" class="fab-ab2" title="전체 재스캔">↻</button>
        <button id="fab-close" class="fab-ab2" title="닫기">✕</button>
      </div>
    </div>
    <div class="fab-tabs">
      <button class="fab-tab active" data-tab="overview">개요</button>
      <button class="fab-tab" data-tab="generate">AI</button>
      <button class="fab-tab" data-tab="settings">⚙</button>
    </div>
    <div id="fab-content" class="fab-ct"></div>`;
  document.body.appendChild(panel);
  applyPanelWidth();
  setupDelegation();

  btn.addEventListener("click", togglePanel);
  document.getElementById("fab-close").addEventListener("click", togglePanel);
  document.getElementById("fab-rescan").addEventListener("click", scanAll);

  document.getElementById("fab-raw-btn").addEventListener("click", () => {
    rawMode = !rawMode;
    document.getElementById("fab-raw-btn").classList.toggle("active", rawMode);
    if (rawMode) { currentTab = "raw"; panel.querySelectorAll(".fab-tab").forEach(t => t.classList.remove("active")); }
    else { currentTab = "overview"; panel.querySelectorAll(".fab-tab").forEach(t => { t.classList.toggle("active", t.dataset.tab === "overview"); }); }
    refreshPanel();
  });

  panel.querySelectorAll(".fab-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      rawMode = false; document.getElementById("fab-raw-btn").classList.remove("active");
      panel.querySelectorAll(".fab-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active"); currentTab = tab.dataset.tab; refreshPanel();
    });
  });
}

function togglePanel() {
  panelOpen = !panelOpen;
  const w = getSettings().panelWidth || 420;
  const panel = document.getElementById("fab-panel");
  if (panel) panel.style.right = panelOpen ? "0" : `-${w + 20}px`;
  if (panelOpen) refreshPanel();
}

function refreshPanel() {
  const el = document.getElementById("fab-content"); if (!el) return;
  switch (currentTab) {
    case "overview": el.innerHTML = renderOverview(); break;
    case "raw": el.innerHTML = renderRaw(); break;
    case "generate": el.innerHTML = renderGenerate(); break;
    case "settings": el.innerHTML = renderSettings(); break;
  }
}

// ============================================================
// INIT
// ============================================================

jQuery(async () => {
  createUI(); createExtSlot(); registerWandAction(); applyColors();
  eventSource.on(event_types.GENERATION_STARTED, () => { injectPrompt(); });
  eventSource.on(event_types.MESSAGE_RECEIVED, (idx) => { const ctx = getContext(); const msg = ctx.chat[idx]; if (msg && msg.mes) processMsg(msg.mes); setTimeout(hideBlocks, 300); });
  eventSource.on(event_types.MESSAGE_EDITED, () => { scanAll(); setTimeout(hideBlocks, 300); });
  eventSource.on(event_types.CHAT_CHANGED, () => { setTimeout(() => { scanAll(); hideBlocks(); }, 1000); });
  setTimeout(() => { scanAll(); hideBlocks(); }, 2000);
  console.log(`[FAB] ${EXT_DISPLAY} v3.0 loaded.`);
});
