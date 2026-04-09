import { getContext, saveMetadataDebounced, extension_settings } from "../../../extensions.js";
import { eventSource, event_types, generateRaw } from "../../../../script.js";

const EXT = "flow-and-brand-sheet";
const EXT_DISPLAY = "Flow & Brand Sheet";
const META_KEY = "fabSheetData";
const SETTINGS_KEY = "fabSheet";

// ============================================================
// DEFAULT SCHEMA
// ============================================================

const DEFAULT_SCHEMA = [
  { name: "Scene", columns: ["Date", "Time", "Location", "Characters"] },
  { name: "Characters", columns: ["Name", "Description", "Notes"] },
  { name: "Relationships", columns: ["From", "To", "Type", "Level"] },
  { name: "Events", columns: ["Character", "Event", "Details", "Status"] },
  { name: "Inventory", columns: ["Owner", "Item", "Details", "Status"] },
];

const DEFAULT_COLORS = {
  accent: "#6c5ce7",
  tableIdx: "#6c5ce7",
  insert: "#27ae60",
  update: "#b7791f",
  delete: "#e74c3c",
};

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
      colors: JSON.parse(JSON.stringify(DEFAULT_COLORS)),
    };
  }
  const s = extension_settings[SETTINGS_KEY];
  if (!s.injectTables) s.injectTables = {};
  for (let i = 0; i < s.schema.length; i++) {
    if (s.injectTables[i] === undefined) s.injectTables[i] = true;
  }
  for (const k of Object.keys(s.injectTables)) {
    if (parseInt(k) >= s.schema.length) delete s.injectTables[k];
  }
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
  document.documentElement.style.setProperty("--fab-table-idx", c.tableIdx || c.accent || DEFAULT_COLORS.tableIdx);
  document.documentElement.style.setProperty("--fab-insert", c.insert || DEFAULT_COLORS.insert);
  document.documentElement.style.setProperty("--fab-update", c.update || DEFAULT_COLORS.update);
  document.documentElement.style.setProperty("--fab-delete", c.delete || DEFAULT_COLORS.delete);
}

// ============================================================
// DATA
// ============================================================

function buildEmpty() {
  const schema = getSchema(); const tables = {};
  for (let i = 0; i < schema.length; i++) tables[i] = { name: schema[i].name, columns: [...schema[i].columns], rows: [] };
  return tables;
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
  }
  for (const k of Object.keys(tables).map(Number)) { if (k >= schema.length) delete tables[k]; }
  return tables;
}

function saveTables() { saveMetadataDebounced(); }
function resetTables() { getContext().chatMetadata[META_KEY] = buildEmpty(); }
function execInsert(ti, data) { const t = getTables()[ti]; if (!t) return; const row = {}; for (let i = 0; i < t.columns.length; i++) row[i] = data[i] !== undefined ? String(data[i]) : ""; t.rows.push(row); }
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

  let p = "\n[FAB Sheet — Current Data]\n";
  p += `(Injected tables: ${enabled.join(", ")})\n`;
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
  const ctx = getContext(); if (!ctx.extensionPrompts) ctx.extensionPrompts = {};
  const prompt = buildPrompt();
  if (!prompt) { delete ctx.extensionPrompts[EXT]; return; }
  ctx.extensionPrompts[EXT] = { value: prompt, position: 1, depth: getSettings().injectDepth, role: 0 };
}

// ============================================================
// AI GENERATION
// ============================================================

async function aiGenerate(userInstruction) {
  const schema = getSchema();
  const tables = getTables();

  let currentData = "";
  for (let i = 0; i < schema.length; i++) {
    const t = tables[i]; if (!t) continue;
    currentData += `Table ${i}: "${t.name}" — Columns: ${t.columns.map((c, ci) => `[${ci}]${c}`).join(", ")}\n`;
    if (t.rows.length > 0) {
      for (let ri = 0; ri < t.rows.length; ri++) {
        currentData += `  [${ri}] ${t.columns.map((_, ci) => t.rows[ri][ci] || "").join(" | ")}\n`;
      }
    } else {
      currentData += "  (empty)\n";
    }
  }

  const ctx = getContext();
  let chatContext = "";
  if (ctx.chat && ctx.chat.length > 0) {
    const recent = ctx.chat.slice(-10);
    for (const msg of recent) {
      const role = msg.is_user ? "User" : "Character";
      const text = (msg.mes || "").replace(/<tableEdit>[\s\S]*?<\/tableEdit>/gi, "").trim();
      if (text) chatContext += `[${role}]: ${text.substring(0, 500)}\n`;
    }
  }

  const systemPrompt = `You are a data assistant. Your ONLY job is to generate table edit commands based on the user's request.

Current table schema and data:
${currentData}

${chatContext ? `Recent chat context:\n${chatContext}\n` : ""}

Available commands:
  insertRow(tableIndex, {colIndex: "value", ...})
  updateRow(tableIndex, rowIndex, {colIndex: "newValue", ...})
  deleteRow(tableIndex, rowIndex)

RULES:
- Output ONLY a <tableEdit> block. No other text.
- Use the exact table indices and column indices from the schema above.
- Fill in reasonable data based on the user's request and chat context.

Example output:
<tableEdit>
insertRow(1, {0: "CharName", 1: "Tall, dark hair", 2: "Some notes"})
</tableEdit>`;

  try {
    const response = await generateRaw(userInstruction, "", false, false, systemPrompt);
    return response;
  } catch (e) {
    console.error("[FAB] AI generation failed:", e);
    try {
      const response = await generateRaw(systemPrompt + "\n\nUser request: " + userInstruction, "");
      return response;
    } catch (e2) {
      console.error("[FAB] AI generation fallback also failed:", e2);
      return null;
    }
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
// RENDER — OVERVIEW
// ============================================================

function renderTableView(tableIndex) {
  const tables = getTables();
  const table = tables[tableIndex];
  if (!table) return `<div class="fab-empty">테이블 ${tableIndex} 없음</div>`;
  if (table.rows.length === 0) return `<div class="fab-empty">비어 있음</div>`;
  let h = `<table class="fab-rt"><thead><tr><th class="fab-rth">#</th>`;
  for (const col of table.columns) h += `<th class="fab-rth">${col}</th>`;
  h += `</tr></thead><tbody>`;
  for (let ri = 0; ri < table.rows.length; ri++) {
    h += `<tr><td class="fab-rtd fab-ri">${ri}</td>`;
    for (let ci = 0; ci < table.columns.length; ci++) h += `<td class="fab-rtd">${table.rows[ri][ci] || ""}</td>`;
    h += `</tr>`;
  }
  return h + `</tbody></table>`;
}

function renderOverview() {
  const tables = getTables(); const schema = getSchema(); let h = "";
  for (let i = 0; i < schema.length; i++) {
    const t = tables[i]; if (!t) continue;
    const rc = t.rows?.length || 0;
    h += `<div class="fab-card">
      <div class="fab-table-header" data-idx="${i}">
        <span class="fab-table-title"><span class="fab-table-idx">${i}</span>${t.name}<span class="fab-table-count">${rc}행</span></span>
        <span class="fab-table-arrow">▸</span>
      </div>
      <div class="fab-table-body" data-idx="${i}" style="display:none">${rc > 0 ? renderTableView(i) : '<div class="fab-empty">비어 있음</div>'}</div>
    </div>`;
  }
  return h;
}

function renderRaw() {
  const tables = getTables(); let h = "";
  for (const [idx, table] of Object.entries(tables)) {
    h += `<div class="fab-card"><div class="fab-ch">테이블 ${idx}: ${table.name}</div><table class="fab-rt"><thead><tr><th class="fab-rth">#</th>${table.columns.map(c => `<th class="fab-rth">${c}</th>`).join("")}</tr></thead><tbody>${table.rows.length === 0 ? `<tr><td colspan="${table.columns.length + 1}" class="fab-rte">데이터 없음</td></tr>` : table.rows.map((row, ri) => `<tr><td class="fab-rtd fab-ri">${ri}</td>${table.columns.map((_, ci) => `<td class="fab-rtd">${row[ci] || ""}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  }
  return h;
}

// ============================================================
// RENDER — AI GENERATE
// ============================================================

function renderGenerate() {
  return `<div class="fab-card">
    <div class="fab-ch">🤖 AI 데이터 생성</div>
    <div class="fab-gen-desc">현재 연결된 API를 사용하여 채팅 맥락에서 시트 데이터를 자동 생성합니다.</div>
    <textarea id="fab-gen-input" class="fab-gen-textarea" placeholder="예: 현재 채팅에 등장하는 캐릭터들의 시트를 만들어줘
예: 관계 테이블에 캐릭터 간 관계를 추가해줘" rows="4"></textarea>
    <div class="fab-gen-actions"><button id="fab-gen-run" class="fab-set-btn primary">생성 요청</button></div>
    <div id="fab-gen-status" class="fab-gen-status"></div>
    <div id="fab-gen-preview" class="fab-gen-preview"></div>
  </div>`;
}

function bindGenerateEvents() {
  const runBtn = document.getElementById("fab-gen-run");
  if (!runBtn) return;
  runBtn.addEventListener("click", async () => {
    const input = document.getElementById("fab-gen-input");
    const statusEl = document.getElementById("fab-gen-status");
    const previewEl = document.getElementById("fab-gen-preview");
    const instruction = (input?.value || "").trim();
    if (!instruction) { statusEl.innerHTML = '<span class="fab-gen-err">요청 내용을 입력해주세요.</span>'; return; }

    runBtn.disabled = true; runBtn.textContent = "생성 중...";
    statusEl.innerHTML = '<span class="fab-gen-loading">⏳ AI에 요청 중...</span>';
    previewEl.innerHTML = "";

    try {
      const response = await aiGenerate(instruction);
      if (!response) { statusEl.innerHTML = '<span class="fab-gen-err">AI 응답을 받지 못했습니다. API 연결을 확인해주세요.</span>'; return; }
      const ops = parseEdits(response);
      if (ops.length === 0) {
        statusEl.innerHTML = '<span class="fab-gen-err">유효한 명령을 찾지 못했습니다.</span>';
        previewEl.innerHTML = `<div class="fab-gen-raw"><div class="fab-gen-raw-label">AI 원본 응답:</div><pre>${response.substring(0, 2000)}</pre></div>`;
        return;
      }

      let ph = `<div class="fab-gen-ops-label">감지된 명령 (${ops.length}개):</div>`;
      for (const op of ops) {
        if (op.type === "insert") ph += `<div class="fab-gen-op insert">+ insertRow(${op.ti}, {...})</div>`;
        else if (op.type === "update") ph += `<div class="fab-gen-op update">~ updateRow(${op.ti}, ${op.ri}, {...})</div>`;
        else if (op.type === "delete") ph += `<div class="fab-gen-op delete">- deleteRow(${op.ti}, ${op.ri})</div>`;
      }
      ph += `<div class="fab-gen-confirm-actions"><button id="fab-gen-apply" class="fab-set-btn primary">적용</button><button id="fab-gen-cancel" class="fab-set-btn">취소</button></div>`;

      statusEl.innerHTML = '<span class="fab-gen-ok">✅ 생성 완료. 확인 후 적용하세요.</span>';
      previewEl.innerHTML = ph;
      previewEl.dataset.pendingOps = JSON.stringify(ops);

      document.getElementById("fab-gen-apply")?.addEventListener("click", () => {
        const pending = JSON.parse(previewEl.dataset.pendingOps || "[]");
        applyOps(pending); saveTables(); refreshPanel(); updateExtSlot();
        const el = document.getElementById("fab-content");
        if (el && currentTab === "generate") { el.innerHTML = renderGenerate(); bindGenerateEvents(); document.getElementById("fab-gen-status").innerHTML = `<span class="fab-gen-ok">✅ ${pending.length}개 명령 적용 완료.</span>`; }
      });
      document.getElementById("fab-gen-cancel")?.addEventListener("click", () => { previewEl.innerHTML = ""; statusEl.innerHTML = '<span class="fab-gen-info">취소됨.</span>'; });
    } catch (err) {
      statusEl.innerHTML = `<span class="fab-gen-err">오류: ${err.message || err}</span>`;
    } finally { runBtn.disabled = false; runBtn.textContent = "생성 요청"; }
  });
}

// ============================================================
// RENDER — SETTINGS
// ============================================================

function renderSettings() {
  const settings = getSettings(); const schema = settings.schema; const colors = settings.colors;

  // General
  let h = `<div class="fab-card"><div class="fab-ch">⚙ 일반</div>
    <div class="fab-set-section"><label class="fab-set-chk"><input type="checkbox" id="fab-opt-hide" ${settings.hideTableEdit ? "checked" : ""}><span>채팅에서 <tableEdit> 숨기기</span></label></div>
    <div class="fab-set-section"><div class="fab-set-label">패널 너비 (px)</div><input type="number" id="fab-opt-width" class="fab-set-input" value="${settings.panelWidth}" min="300" max="800" step="50"></div></div>`;

  // Colors
  h += `<div class="fab-card"><div class="fab-ch">🎨 색상</div>
    <div class="fab-color-row"><span class="fab-color-label">액센트</span><input type="color" class="fab-color-picker" id="fab-clr-accent" value="${colors.accent || DEFAULT_COLORS.accent}"><span class="fab-color-hex" id="fab-clr-accent-hex">${colors.accent || DEFAULT_COLORS.accent}</span></div>
    <div class="fab-color-row"><span class="fab-color-label">테이블 인덱스</span><input type="color" class="fab-color-picker" id="fab-clr-tableIdx" value="${colors.tableIdx || DEFAULT_COLORS.tableIdx}"><span class="fab-color-hex" id="fab-clr-tableIdx-hex">${colors.tableIdx || DEFAULT_COLORS.tableIdx}</span></div>
    <div class="fab-color-row"><span class="fab-color-label">Insert</span><input type="color" class="fab-color-picker" id="fab-clr-insert" value="${colors.insert || DEFAULT_COLORS.insert}"><span class="fab-color-hex" id="fab-clr-insert-hex">${colors.insert || DEFAULT_COLORS.insert}</span></div>
    <div class="fab-color-row"><span class="fab-color-label">Update</span><input type="color" class="fab-color-picker" id="fab-clr-update" value="${colors.update || DEFAULT_COLORS.update}"><span class="fab-color-hex" id="fab-clr-update-hex">${colors.update || DEFAULT_COLORS.update}</span></div>
    <div class="fab-color-row"><span class="fab-color-label">Delete</span><input type="color" class="fab-color-picker" id="fab-clr-delete" value="${colors.delete || DEFAULT_COLORS.delete}"><span class="fab-color-hex" id="fab-clr-delete-hex">${colors.delete || DEFAULT_COLORS.delete}</span></div>
    <div style="margin-top:10px"><button id="fab-clr-reset" class="fab-set-btn danger">색상 초기화</button></div></div>`;

  // AI Injection
  h += `<div class="fab-card"><div class="fab-ch">🧠 AI 참조</div>
    <div class="fab-set-section"><label class="fab-set-chk"><input type="checkbox" id="fab-opt-inject" ${settings.injectEnabled ? "checked" : ""}><span>테이블 데이터를 AI에 전달</span></label><div class="fab-set-hint">활성화하면 AI가 테이블 내용을 참고하여 응답합니다.</div></div>
    <div id="fab-inject-tables" class="${settings.injectEnabled ? "" : "fab-disabled"}"><div class="fab-set-label">테이블별 주입</div>
    ${schema.map((s, i) => `<label class="fab-set-chk fab-inject-row"><input type="checkbox" class="fab-inject-table-chk" data-idx="${i}" ${settings.injectTables[i] ? "checked" : ""}><span><span class="fab-inject-idx">${i}</span> ${s.name}</span><span class="fab-inject-info">${s.columns.length}컬럼 · ${(getTables()[i]?.rows?.length || 0)}행</span></label>`).join("")}
    </div>
    <div class="fab-set-section" style="margin-top:12px"><div class="fab-set-label">삽입 깊이</div><div class="fab-set-hint">숫자가 작을수록 최근 메시지에 가깝게 삽입.</div><input type="number" id="fab-opt-depth" class="fab-set-input" value="${settings.injectDepth}" min="0" max="999" step="1"></div></div>`;

  // Schema (collapsible)
  h += `<div class="fab-card"><div class="fab-ch">📐 스키마 편집</div>`;
  for (let i = 0; i < schema.length; i++) {
    const s = schema[i];
    h += `<div class="fab-schema-block" data-idx="${i}">
      <div class="fab-schema-toggle" data-idx="${i}">
        <span class="fab-schema-arrow">▸</span><span class="fab-schema-idx">${i}</span>
        <span class="fab-schema-preview-name">${s.name}</span><span class="fab-schema-preview-cols">${s.columns.length}컬럼</span>
      </div>
      <div class="fab-schema-detail" data-idx="${i}" style="display:none">
        <div class="fab-schema-head"><input type="text" class="fab-schema-name" value="${s.name}" data-idx="${i}" placeholder="테이블 이름"><button class="fab-schema-del-table fab-ab2" data-idx="${i}" title="삭제">✕</button></div>
        <div class="fab-schema-cols">
          ${s.columns.map((col, ci) => `<div class="fab-schema-col-row"><input type="text" class="fab-schema-col" value="${col}" data-ti="${i}" data-ci="${ci}" placeholder="컬럼명"><button class="fab-schema-del-col fab-col-btn" data-ti="${i}" data-ci="${ci}">−</button></div>`).join("")}
          <button class="fab-schema-add-col fab-col-btn add" data-ti="${i}">+ 컬럼</button>
        </div>
      </div>
    </div>`;
  }
  h += `<div class="fab-schema-actions"><button id="fab-add-table" class="fab-set-btn">+ 테이블</button><button id="fab-save-schema" class="fab-set-btn primary">저장</button><button id="fab-reset-schema" class="fab-set-btn danger">기본값 복원</button></div></div>`;

  // JSON
  h += `<div class="fab-card"><div class="fab-ch">📋 JSON 임포트</div>
    <div class="fab-set-hint">JSON 배열로 스키마를 일괄 교체합니다. 형식: [{"name":"이름","columns":["컬럼1","컬럼2"]}]</div>
    <textarea id="fab-json-input" class="fab-json-textarea" rows="6" placeholder='[{"name":"Characters","columns":["Name","Desc","Notes"]}]'></textarea>
    <div class="fab-json-actions"><button id="fab-json-apply" class="fab-set-btn primary">JSON 적용</button><button id="fab-json-export" class="fab-set-btn">현재 스키마 내보내기</button></div>
    <div id="fab-json-status" class="fab-gen-status"></div></div>`;

  return h;
}

// ============================================================
// BIND SETTINGS EVENTS
// ============================================================

function bindSettingsEvents() {
  // General
  const hideOpt = document.getElementById("fab-opt-hide");
  if (hideOpt) hideOpt.addEventListener("change", () => { getSettings().hideTableEdit = hideOpt.checked; saveSettings(); });
  const widthOpt = document.getElementById("fab-opt-width");
  if (widthOpt) widthOpt.addEventListener("change", () => { getSettings().panelWidth = parseInt(widthOpt.value) || 400; saveSettings(); applyPanelWidth(); });

  // Colors
  for (const key of ["accent", "tableIdx", "insert", "update", "delete"]) {
    const picker = document.getElementById(`fab-clr-${key}`);
    const hex = document.getElementById(`fab-clr-${key}-hex`);
    if (picker) {
      picker.addEventListener("input", () => {
        getSettings().colors[key] = picker.value;
        if (hex) hex.textContent = picker.value;
        saveSettings();
        applyColors();
      });
    }
  }
  const clrReset = document.getElementById("fab-clr-reset");
  if (clrReset) clrReset.addEventListener("click", () => {
    getSettings().colors = JSON.parse(JSON.stringify(DEFAULT_COLORS));
    saveSettings(); applyColors(); refreshPanel(); bindSettingsEvents();
  });

  // AI Injection
  const injectOpt = document.getElementById("fab-opt-inject");
  if (injectOpt) injectOpt.addEventListener("change", () => {
    getSettings().injectEnabled = injectOpt.checked; saveSettings();
    const ts = document.getElementById("fab-inject-tables"); if (ts) ts.classList.toggle("fab-disabled", !injectOpt.checked);
    updateExtSlot();
  });
  document.querySelectorAll(".fab-inject-table-chk").forEach(chk => {
    chk.addEventListener("change", () => { getSettings().injectTables[parseInt(chk.dataset.idx)] = chk.checked; saveSettings(); updateExtSlot(); });
  });
  const depthOpt = document.getElementById("fab-opt-depth");
  if (depthOpt) depthOpt.addEventListener("change", () => { getSettings().injectDepth = parseInt(depthOpt.value) || 4; saveSettings(); });

  // Schema toggles
  document.querySelectorAll(".fab-schema-toggle").forEach(toggle => {
    toggle.addEventListener("click", () => {
      const idx = toggle.dataset.idx;
      const detail = document.querySelector(`.fab-schema-detail[data-idx="${idx}"]`);
      const arrow = toggle.querySelector(".fab-schema-arrow");
      if (detail) { const open = detail.style.display !== "none"; detail.style.display = open ? "none" : "block"; if (arrow) arrow.textContent = open ? "▸" : "▾"; }
    });
  });

  const addTable = document.getElementById("fab-add-table");
  if (addTable) addTable.addEventListener("click", () => {
    const schema = getSchema(); schema.push({ name: `Table ${schema.length}`, columns: ["Column1"] });
    getSettings().injectTables[schema.length - 1] = true; setSchema(schema); refreshPanel(); bindSettingsEvents();
  });

  const saveBtn = document.getElementById("fab-save-schema");
  if (saveBtn) saveBtn.addEventListener("click", () => {
    const schema = getSchema();
    document.querySelectorAll(".fab-schema-name").forEach(input => { const idx = parseInt(input.dataset.idx); if (schema[idx]) schema[idx].name = input.value.trim() || `Table ${idx}`; });
    for (let i = 0; i < schema.length; i++) { const cols = []; document.querySelectorAll(`.fab-schema-col[data-ti="${i}"]`).forEach(input => { const v = input.value.trim(); if (v) cols.push(v); }); if (cols.length > 0) schema[i].columns = cols; }
    setSchema(schema); getTables(); saveTables(); injectPrompt(); updateExtSlot();
    alert("스키마 저장 완료."); refreshPanel(); bindSettingsEvents();
  });

  const resetBtn = document.getElementById("fab-reset-schema");
  if (resetBtn) resetBtn.addEventListener("click", () => { if (confirm("기본값으로 복원?")) { resetSchema(); refreshPanel(); bindSettingsEvents(); updateExtSlot(); } });

  document.querySelectorAll(".fab-schema-del-table").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.idx); const schema = getSchema();
      if (schema.length <= 1) { alert("최소 1개 필요."); return; }
      if (confirm(`"${schema[idx].name}" 삭제?`)) {
        schema.splice(idx, 1);
        const ni = {}; for (let i = 0; i < schema.length; i++) { const oi = i >= idx ? i + 1 : i; ni[i] = getSettings().injectTables[oi] !== undefined ? getSettings().injectTables[oi] : true; }
        getSettings().injectTables = ni; setSchema(schema); refreshPanel(); bindSettingsEvents(); updateExtSlot();
      }
    });
  });

  document.querySelectorAll(".fab-schema-add-col").forEach(btn => {
    btn.addEventListener("click", () => { const ti = parseInt(btn.dataset.ti); const schema = getSchema(); if (schema[ti]) { schema[ti].columns.push(`Column${schema[ti].columns.length + 1}`); setSchema(schema); refreshPanel(); bindSettingsEvents(); } });
  });

  document.querySelectorAll(".fab-schema-del-col").forEach(btn => {
    btn.addEventListener("click", () => { const ti = parseInt(btn.dataset.ti), ci = parseInt(btn.dataset.ci); const schema = getSchema(); if (schema[ti] && schema[ti].columns.length > 1) { schema[ti].columns.splice(ci, 1); setSchema(schema); refreshPanel(); bindSettingsEvents(); } });
  });

  // JSON
  const jsonApply = document.getElementById("fab-json-apply");
  if (jsonApply) jsonApply.addEventListener("click", () => {
    const input = document.getElementById("fab-json-input");
    const statusEl = document.getElementById("fab-json-status");
    const raw = (input?.value || "").trim();
    if (!raw) { statusEl.innerHTML = '<span class="fab-gen-err">JSON을 입력해주세요.</span>'; return; }
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error("최상위가 배열이어야 합니다.");
      for (let i = 0; i < parsed.length; i++) {
        if (!parsed[i].name || !Array.isArray(parsed[i].columns)) throw new Error(`항목 ${i}: name과 columns 필요.`);
        if (parsed[i].columns.length === 0) throw new Error(`항목 ${i}: 최소 1개 컬럼 필요.`);
      }
      if (!confirm(`${parsed.length}개 테이블로 스키마 교체?`)) return;
      const newSchema = parsed.map(t => ({ name: String(t.name), columns: t.columns.map(c => String(c)) }));
      const s = getSettings(); s.schema = newSchema; s.injectTables = {};
      for (let i = 0; i < newSchema.length; i++) s.injectTables[i] = true;
      saveSettings(); getTables(); saveTables(); injectPrompt(); updateExtSlot();
      statusEl.innerHTML = `<span class="fab-gen-ok">✅ ${newSchema.length}개 테이블로 교체 완료.</span>`;
      refreshPanel(); bindSettingsEvents();
    } catch (e) { statusEl.innerHTML = `<span class="fab-gen-err">오류: ${e.message}</span>`; }
  });

  const jsonExport = document.getElementById("fab-json-export");
  if (jsonExport) jsonExport.addEventListener("click", () => { const input = document.getElementById("fab-json-input"); if (input) input.value = JSON.stringify(getSchema(), null, 2); });
}

// ============================================================
// BIND OVERVIEW EVENTS
// ============================================================

function bindOverviewEvents() {
  document.querySelectorAll(".fab-table-header").forEach(header => {
    header.addEventListener("click", () => {
      const idx = header.dataset.idx;
      const body = document.querySelector(`.fab-table-body[data-idx="${idx}"]`);
      const arrow = header.querySelector(".fab-table-arrow");
      if (body) { const open = body.style.display !== "none"; body.style.display = open ? "none" : "block"; if (arrow) arrow.textContent = open ? "▸" : "▾"; }
    });
  });
}

// ============================================================
// EXTENSIONS PANEL SLOT
// ============================================================

function createExtSlot() {
  const container = document.getElementById("extensions_settings2");
  if (!container) { console.warn("[FAB] Extensions container not found."); return; }
  const wrapper = document.createElement("div");
  wrapper.id = "fab-ext-slot"; wrapper.classList.add("extension_container");
  wrapper.innerHTML = `
    <div class="inline-drawer">
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
    const content = wrapper.querySelector(".inline-drawer-content");
    const arrow = wrapper.querySelector(".inline-drawer-icon.down");
    const isOpen = content.style.display !== "none";
    content.style.display = isOpen ? "none" : "block";
    if (arrow) { arrow.classList.toggle("fa-circle-chevron-down", isOpen); arrow.classList.toggle("fa-circle-chevron-up", !isOpen); }
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
  const settings = getSettings(); const schema = settings.schema; const tables = getTables();
  const totalRows = Object.values(tables).reduce((sum, t) => sum + (t.rows?.length || 0), 0);
  const enabledCount = Object.values(settings.injectTables).filter(v => v).length;
  statusEl.innerHTML = `
    <div class="fab-ext-row"><span>테이블</span><span>${schema.length}개 (${totalRows}행)</span></div>
    <div class="fab-ext-row"><span>AI 참조</span><span style="color:${settings.injectEnabled ? "#27ae60" : "#e74c3c"}">${settings.injectEnabled ? `ON (${enabledCount}/${schema.length})` : "OFF"}</span></div>`;
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
  btn.addEventListener("click", () => {
    if (!panelOpen) togglePanel();
    const menu = btn.closest(".openDrawer, #extensionsMenu"); if (menu) menu.classList.remove("openDrawer");
  });
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
  const w = getSettings().panelWidth || 400;
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
    <div id="fab-content" class="fab-ct"></div>
  `;
  document.body.appendChild(panel);
  applyPanelWidth();

  btn.addEventListener("click", togglePanel);
  document.getElementById("fab-close").addEventListener("click", togglePanel);
  document.getElementById("fab-rescan").addEventListener("click", scanAll);

  // Raw toggle icon
  document.getElementById("fab-raw-btn").addEventListener("click", () => {
    rawMode = !rawMode;
    document.getElementById("fab-raw-btn").classList.toggle("active", rawMode);
    if (rawMode) {
      currentTab = "raw";
      panel.querySelectorAll(".fab-tab").forEach(t => t.classList.remove("active"));
    } else {
      currentTab = "overview";
      panel.querySelectorAll(".fab-tab").forEach(t => { t.classList.toggle("active", t.dataset.tab === "overview"); });
    }
    refreshPanel();
  });

  panel.querySelectorAll(".fab-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      rawMode = false;
      document.getElementById("fab-raw-btn").classList.remove("active");
      panel.querySelectorAll(".fab-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active"); currentTab = tab.dataset.tab;
      refreshPanel();
      if (currentTab === "settings") bindSettingsEvents();
      if (currentTab === "generate") bindGenerateEvents();
      if (currentTab === "overview") bindOverviewEvents();
    });
  });
}

function togglePanel() {
  panelOpen = !panelOpen;
  const w = getSettings().panelWidth || 400;
  const panel = document.getElementById("fab-panel");
  if (panel) panel.style.right = panelOpen ? "0" : `-${w + 20}px`;
  if (panelOpen) {
    refreshPanel();
    if (currentTab === "settings") bindSettingsEvents();
    if (currentTab === "generate") bindGenerateEvents();
    if (currentTab === "overview") bindOverviewEvents();
  }
}

function refreshPanel() {
  const el = document.getElementById("fab-content"); if (!el) return;
  switch (currentTab) {
    case "overview": el.innerHTML = renderOverview(); bindOverviewEvents(); break;
    case "raw": el.innerHTML = renderRaw(); break;
    case "generate": el.innerHTML = renderGenerate(); bindGenerateEvents(); break;
    case "settings": el.innerHTML = renderSettings(); bindSettingsEvents(); break;
  }
}

// ============================================================
// INIT
// ============================================================

jQuery(async () => {
  createUI();
  createExtSlot();
  registerWandAction();
  applyColors();

  eventSource.on(event_types.GENERATION_STARTED, () => { injectPrompt(); });
  eventSource.on(event_types.MESSAGE_RECEIVED, (idx) => { const ctx = getContext(); const msg = ctx.chat[idx]; if (msg && msg.mes) processMsg(msg.mes); setTimeout(hideBlocks, 300); });
  eventSource.on(event_types.MESSAGE_EDITED, () => { scanAll(); setTimeout(hideBlocks, 300); });
  eventSource.on(event_types.CHAT_CHANGED, () => { setTimeout(() => { scanAll(); hideBlocks(); }, 1000); });
  setTimeout(() => { scanAll(); hideBlocks(); }, 2000);
  console.log(`[FAB] ${EXT_DISPLAY} v2.1 loaded.`);
});
