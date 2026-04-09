import { getContext, saveMetadataDebounced, extension_settings } from "../../../extensions.js";
import { eventSource, event_types, generateRaw } from "../../../../script.js";

const EXT = "flow-and-brand-sheet";
const EXT_DISPLAY = "Flow & Brand Sheet";
const META_KEY = "fabSheetData";
const SETTINGS_KEY = "fabSheet";

// ============================================================
// DISPLAY MODES
// ============================================================

const DISPLAY_MODES = ["timeline", "profile", "log", "grid", "table", "custom"];

// ============================================================
// DEFAULT SCHEMA — 재설계
// ============================================================

const DEFAULT_SCHEMA = [
  { name: "시공간", columns: ["날짜", "시간", "위치", "등장인물"], displayMode: "timeline", template: "" },
  { name: "캐릭터", columns: ["인물", "신체적특징", "성격", "기타"], displayMode: "profile", template: "" },
  { name: "관계", columns: ["인물", "대상", "관계유형", "상세"], displayMode: "profile", template: "" },
  { name: "특성", columns: ["인물", "특성명", "등급", "상세"], displayMode: "grid", template: "" },
  { name: "의식", columns: ["인물", "의식명", "날짜", "위치", "결과"], displayMode: "log", template: "" },
  { name: "소지품", columns: ["인물", "아이템", "상세", "효과"], displayMode: "grid", template: "" },
  { name: "임무", columns: ["인물", "임무", "위치", "기간", "상태"], displayMode: "log", template: "" },
];

// 크로스 테이블 프로필에서 참조할 테이블 이름 매핑
const PROFILE_CROSS_TABLES = ["관계", "특성", "의식", "소지품"];

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
      panelWidth: 440,
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
    if (!s.schema[i].displayMode) s.schema[i].displayMode = "table";
    if (s.schema[i].template === undefined) s.schema[i].template = "";
  }
  for (const k of Object.keys(s.injectTables)) {
    if (parseInt(k) >= s.schema.length) delete s.injectTables[k];
  }
  if (s.injectEnabled === undefined) s.injectEnabled = true;
  if (s.injectDepth === undefined) s.injectDepth = 4;
  if (!s.colors) s.colors = JSON.parse(JSON.stringify(DEFAULT_COLORS));
  return s;
}

function saveSettings() {
  getContext().saveSettingsDebounced();
}
function getSchema() {
  return getSettings().schema;
}
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
function applyColors() {
  const c = getSettings().colors;
  document.documentElement.style.setProperty("--fab-accent", c.accent || DEFAULT_COLORS.accent);
}

// ============================================================
// DATA
// ============================================================

function buildEmpty() {
  const schema = getSchema();
  const tables = {};
  for (let i = 0; i < schema.length; i++)
    tables[i] = { name: schema[i].name, columns: [...schema[i].columns], rows: [] };
  return tables;
}

function isRowEmpty(row, colCount) {
  for (let i = 0; i < colCount; i++) {
    if ((row[i] || "").trim()) return false;
  }
  return true;
}

function cleanRows(table) {
  if (!table?.rows) return;
  table.rows = table.rows.filter((row) => !isRowEmpty(row, table.columns.length));
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
      const oc = tables[i].columns,
        nc = schema[i].columns;
      if (JSON.stringify(oc) !== JSON.stringify(nc)) {
        for (const row of tables[i].rows) {
          for (let ci = 0; ci < nc.length; ci++) {
            if (row[ci] === undefined) row[ci] = "";
          }
          for (const key of Object.keys(row)) {
            if (parseInt(key) >= nc.length) delete row[key];
          }
        }
        tables[i].columns = [...nc];
      }
    }
    cleanRows(tables[i]);
  }
  for (const k of Object.keys(tables).map(Number)) {
    if (k >= schema.length) delete tables[k];
  }
  return tables;
}

function saveTables() {
  saveMetadataDebounced();
}
function resetTables() {
  getContext().chatMetadata[META_KEY] = buildEmpty();
}
function execInsert(ti, data) {
  const t = getTables()[ti];
  if (!t) return;
  const row = {};
  for (let i = 0; i < t.columns.length; i++) row[i] = data[i] !== undefined ? String(data[i]) : "";
  if (!isRowEmpty(row, t.columns.length)) t.rows.push(row);
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
  while ((m = re.exec(str)) !== null)
    d[parseInt(m[1])] = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] || "";
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
      if ((m = t.match(/insertRow\(\s*(\d+)\s*,\s*\{([^}]+)\}\s*\)/)))
        ops.push({ type: "insert", ti: parseInt(m[1]), data: parseDataObj(m[2]) });
      else if ((m = t.match(/deleteRow\(\s*(\d+)\s*,\s*(\d+)\s*\)/)))
        ops.push({ type: "delete", ti: parseInt(m[1]), ri: parseInt(m[2]) });
      else if ((m = t.match(/updateRow\(\s*(\d+)\s*,\s*(\d+)\s*,\s*\{([^}]+)\}\s*\)/)))
        ops.push({ type: "update", ti: parseInt(m[1]), ri: parseInt(m[2]), data: parseDataObj(m[3]) });
    }
  }
  return ops;
}

function applyOps(ops) {
  const del = ops
    .filter((o) => o.type === "delete")
    .sort((a, b) => (a.ti !== b.ti ? b.ti - a.ti : b.ri - a.ri));
  for (const o of del) execDelete(o.ti, o.ri);
  for (const o of ops.filter((o) => o.type === "update")) execUpdate(o.ti, o.ri, o.data);
  for (const o of ops.filter((o) => o.type === "insert")) execInsert(o.ti, o.data);
}

// ============================================================
// MESSAGE PROCESSING
// ============================================================

function processMsg(text) {
  if (!text) return false;
  const ops = parseEdits(text);
  if (ops.length > 0) {
    applyOps(ops);
    saveTables();
    refreshPanel();
    updateExtSlot();
    return true;
  }
  return false;
}

function scanAll() {
  const ctx = getContext();
  if (!ctx.chat || ctx.chat.length === 0) return;
  resetTables();
  for (const msg of ctx.chat) {
    if (msg.mes) {
      const ops = parseEdits(msg.mes);
      if (ops.length > 0) applyOps(ops);
    }
  }
  saveTables();
  refreshPanel();
  updateExtSlot();
}

// ============================================================
// PROMPT INJECTION
// ============================================================

function buildPrompt() {
  const settings = getSettings();
  if (!settings.injectEnabled) return "";
  const tables = getTables();
  const enabled = Object.entries(settings.injectTables)
    .filter(([_, v]) => v)
    .map(([k]) => parseInt(k))
    .sort((a, b) => a - b);
  if (enabled.length === 0) return "";
  let p = "\n[FAB Sheet — Current Data]\n(Injected tables: " + enabled.join(", ") + ")\n";
  for (const idx of enabled) {
    const table = tables[idx];
    if (!table) continue;
    p += `\n### Table ${idx}: ${table.name}\nColumns: ${table.columns.join(" | ")}\n`;
    if (table.rows.length === 0) p += "(empty)\n";
    else
      for (let ri = 0; ri < table.rows.length; ri++)
        p += `[${ri}] ${table.columns.map((_, ci) => table.rows[ri][ci] || "").join(" | ")}\n`;
  }
  p += `\n[Table Edit Instructions]\nWhen table data changes during the narrative, output modifications inside a <tableEdit> block at the END of your response.\nCommands:\n  insertRow(tableIndex, {colIndex: "value", ...})\n  updateRow(tableIndex, rowIndex, {colIndex: "newValue", ...})\n  deleteRow(tableIndex, rowIndex)\nAvailable table indices: ${enabled.join(", ")}\nRules:\n- Include <tableEdit> ONLY when data changes.\n- Use exact row indices from current state.\n- Place <tableEdit> AFTER narrative.\n- Do NOT include inside narrative prose.\n`;
  return p;
}

function injectPrompt() {
  const ctx = getContext();
  if (!ctx.extensionPrompts) ctx.extensionPrompts = {};
  const prompt = buildPrompt();
  if (!prompt) {
    delete ctx.extensionPrompts[EXT];
    return;
  }
  ctx.extensionPrompts[EXT] = { value: prompt, position: 1, depth: getSettings().injectDepth, role: 0 };
}

// ============================================================
// AI GENERATION
// ============================================================

async function aiGenerate(userInstruction, mode) {
  const schema = getSchema();
  const tables = getTables();
  let currentData = "";
  for (let i = 0; i < schema.length; i++) {
    const t = tables[i];
    if (!t) continue;
    currentData += `Table ${i}: "${t.name}" (mode:${schema[i].displayMode}) — Cols: ${t.columns.map((c, ci) => `[${ci}]${c}`).join(", ")}\n`;
    if (t.rows.length > 0)
      for (let ri = 0; ri < t.rows.length; ri++)
        currentData += `  [${ri}] ${t.columns.map((_, ci) => t.rows[ri][ci] || "").join(" | ")}\n`;
    else currentData += "  (empty)\n";
  }
  const ctx = getContext();
  let chatContext = "";
  if (ctx.chat?.length > 0) {
    for (const msg of ctx.chat.slice(-15)) {
      const text = (msg.mes || "").replace(/<tableEdit>[\s\S]*?<\/tableEdit>/gi, "").trim();
      if (text) chatContext += `[${msg.is_user ? "User" : "Char"}]: ${text.substring(0, 600)}\n`;
    }
  }
  const systemPrompt =
    mode === "setup"
      ? `You are a data assistant. Analyze the chat and populate ALL tables.\n\nSchema:\n${currentData}\nChat:\n${chatContext || "(none)"}\n\nRULES:\n- Output ONLY <tableEdit> block.\n- insertRow for every relevant entry.\n- NO empty rows. NO placeholder data.\n- Be thorough: all characters, locations, events, items from chat.`
      : `You are a data assistant. Generate table edits per user request.\n\nSchema+Data:\n${currentData}\n${chatContext ? `Chat:\n${chatContext}` : ""}\n\nRULES:\n- Output ONLY <tableEdit> block.\n- NO empty rows.`;

  try {
    return await generateRaw(userInstruction, "", false, false, systemPrompt);
  } catch (e) {
    try {
      return await generateRaw(systemPrompt + "\n\nRequest: " + userInstruction, "");
    } catch {
      return null;
    }
  }
}

// ============================================================
// HIDE <tableEdit>
// ============================================================

function hideBlocks() {
  if (!getSettings().hideTableEdit) return;
  document.querySelectorAll(".mes_text").forEach((el) => {
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
// UTILITY
// ============================================================

function esc(s) {
  return (s || "")
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/"/g, """);
}

// 테이블 이름으로 인덱스 찾기
function findTableIndexByName(name) {
  const schema = getSchema();
  for (let i = 0; i < schema.length; i++) {
    if (schema[i].name === name) return i;
  }
  return -1;
}

// 특정 테이블에서 column 0 값이 name과 일치하는 rows 반환
function getRowsByCharName(tableIndex, name) {
  const tables = getTables();
  const t = tables[tableIndex];
  if (!t || !t.rows) return [];
  const normalized = (name || "").trim().toLowerCase();
  return t.rows.filter((row) => (row[0] || "").trim().toLowerCase() === normalized);
}

// ============================================================
// DESIGNED RENDERERS
// ============================================================

function renderDesigned(tableIndex) {
  const tables = getTables();
  const schema = getSchema();
  const table = tables[tableIndex];
  if (!table) return '<div class="fab-empty">없음</div>';
  if (!table.rows.length) return '<div class="fab-empty">비어 있음</div>';

  const schemaEntry = schema[tableIndex];
  const mode = schemaEntry?.displayMode || "table";
  const customTpl = (schemaEntry?.template || "").trim();

  // Custom template
  if (mode === "custom" && customTpl) return renderCustomTemplate(table, customTpl);
  if (customTpl) return renderCustomTemplate(table, customTpl);

  switch (mode) {
    case "timeline":
      return renderTimeline(table);
    case "profile":
      return renderProfile(table, tableIndex);
    case "log":
      return renderLog(table, schemaEntry);
    case "grid":
      return renderGrid(table);
    default:
      return renderPlainTable(table);
  }
}

function renderCustomTemplate(table, tpl) {
  let h = '<div class="fab-custom-rendered">';
  for (const row of table.rows) {
    let html = tpl;
    for (let ci = 0; ci < table.columns.length; ci++) {
      html = html.replaceAll(`{{${ci}}}`, esc(row[ci]));
      html = html.replaceAll(`{{col:${table.columns[ci]}}}`, esc(row[ci]));
    }
    html = html.replaceAll("{{initial}}", esc((row[0] || "?").charAt(0).toUpperCase()));
    html = html.replace(/\{\{\d+\}\}/g, "").replace(/\{\{col:[^}]*\}\}/g, "");
    h += html;
  }
  return h + "</div>";
}

// ---------- TIMELINE ----------
function renderTimeline(table) {
  let h = '<div class="fab-tl">';
  for (const row of table.rows) {
    h += `<div class="fab-tl-item">
      <div class="fab-tl-row1"><span class="fab-tl-date">${esc(row[0])}</span><span class="fab-tl-time">${esc(row[1])}</span></div>
      <div class="fab-tl-row2"><span class="fab-tl-loc">${esc(row[2])}</span></div>
      ${row[3] ? `<div class="fab-tl-chars">${esc(row[3])}</div>` : ""}
    </div>`;
  }
  return h + "</div>";
}

// ---------- PROFILE (크로스 테이블 통합) ----------
function renderProfile(table, tableIndex) {
  const schema = getSchema();
  const tableName = schema[tableIndex]?.name || "";

  // "캐릭터" 테이블이 아닌 profile 모드 테이블은 단순 프로필 렌더링
  if (tableName !== "캐릭터") {
    return renderSimpleProfile(table);
  }

  // 캐릭터 테이블: 크로스 테이블 통합 렌더링
  const tables = getTables();

  // 크로스 참조 테이블 인덱스들 찾기
  const crossIndices = {};
  for (const crossName of PROFILE_CROSS_TABLES) {
    const idx = findTableIndexByName(crossName);
    if (idx >= 0) crossIndices[crossName] = idx;
  }

  let h = '<div class="fab-profiles">';

  for (const row of table.rows) {
    const name = (row[0] || "???").trim();
    const initial = name.charAt(0).toUpperCase();

    h += `<div class="fab-pf"><div class="fab-pf-banner"></div><div class="fab-pf-inner">`;
    h += `<div class="fab-pf-header"><div class="fab-pf-avatar">${esc(initial)}</div><div class="fab-pf-name">${esc(name)}</div></div>`;
    h += `<div class="fab-pf-body">`;

    // === 기본 필드 (캐릭터 테이블 컬럼 1+) ===
    for (let ci = 1; ci < table.columns.length; ci++) {
      const val = (row[ci] || "").trim();
      if (!val) continue;
      const colName = table.columns[ci];
      h += `<div class="fab-pf-field"><span class="fab-pf-label">${esc(colName)}</span><span class="fab-pf-val">${esc(val)}</span></div>`;
    }

    // === 관계 섹션 ===
    if (crossIndices["관계"] !== undefined) {
      const relRows = getRowsByCharName(crossIndices["관계"], name);
      if (relRows.length > 0) {
        h += `<div class="fab-pf-divider">관계</div><div class="fab-pf-tags">`;
        for (const rr of relRows) {
          const target = (rr[1] || "").trim();
          const relType = (rr[2] || "").trim();
          const detail = (rr[3] || "").trim();
          let label = target;
          if (relType) label += ` · ${relType}`;
          if (detail) label += ` · ${detail}`;
          h += `<span class="fab-pf-tag">${esc(label)}</span>`;
        }
        h += "</div>";
      }
    }

    // === 특성 섹션 ===
    if (crossIndices["특성"] !== undefined) {
      const traitRows = getRowsByCharName(crossIndices["특성"], name);
      if (traitRows.length > 0) {
        h += `<div class="fab-pf-divider">특성</div><div class="fab-pf-cross-grid">`;
        for (const tr of traitRows) {
          const traitName = (tr[1] || "").trim();
          const grade = (tr[2] || "").trim();
          const detail = (tr[3] || "").trim();
          h += `<div class="fab-pf-cross-item">`;
          h += `<span class="fab-pf-cross-name">${esc(traitName)}</span>`;
          if (grade) h += `<span class="fab-pf-cross-grade">${esc(grade)}</span>`;
          if (detail) h += `<span class="fab-pf-cross-detail">${esc(detail)}</span>`;
          h += `</div>`;
        }
        h += "</div>";
      }
    }

    // === 의식 섹션 ===
    if (crossIndices["의식"] !== undefined) {
      const ritRows = getRowsByCharName(crossIndices["의식"], name);
      if (ritRows.length > 0) {
        h += `<div class="fab-pf-divider">의식</div><div class="fab-pf-cross-logs">`;
        for (const rr of ritRows) {
          const ritName = (rr[1] || "").trim();
          const date = (rr[2] || "").trim();
          const loc = (rr[3] || "").trim();
          const result = (rr[4] || "").trim();
          let statusClass = "done";
          const rl = result.toLowerCase();
          if (rl.includes("진행") || rl.includes("active") || rl.includes("성공")) statusClass = "active";
          else if (rl.includes("실패") || rl.includes("fail")) statusClass = "fail";
          h += `<div class="fab-pf-cross-log">`;
          h += `<span class="fab-pf-cross-log-title">${esc(ritName)}</span>`;
          const meta = [date, loc].filter(Boolean).join(" · ");
          if (meta) h += `<span class="fab-pf-cross-log-meta">${esc(meta)}</span>`;
          if (result) h += `<span class="fab-log-status ${statusClass}">${esc(result)}</span>`;
          h += `</div>`;
        }
        h += "</div>";
      }
    }

    // === 소지품 섹션 ===
    if (crossIndices["소지품"] !== undefined) {
      const itemRows = getRowsByCharName(crossIndices["소지품"], name);
      if (itemRows.length > 0) {
        h += `<div class="fab-pf-divider">소지품</div><div class="fab-pf-cross-grid">`;
        for (const ir of itemRows) {
          const itemName = (ir[1] || "").trim();
          const detail = (ir[2] || "").trim();
          const effect = (ir[3] || "").trim();
          h += `<div class="fab-pf-cross-item">`;
          h += `<span class="fab-pf-cross-name">${esc(itemName)}</span>`;
          if (detail) h += `<span class="fab-pf-cross-detail">${esc(detail)}</span>`;
          if (effect) h += `<span class="fab-pf-cross-effect">${esc(effect)}</span>`;
          h += `</div>`;
        }
        h += "</div>";
      }
    }

    h += "</div></div></div>"; // fab-pf-body, fab-pf-inner, fab-pf
  }

  return h + "</div>"; // fab-profiles
}

// profile 모드이지만 캐릭터 테이블이 아닌 경우의 단순 렌더링
function renderSimpleProfile(table) {
  let h = '<div class="fab-profiles">';
  const tagColumns = new Set();
  for (const colName of table.columns) {
    const lower = colName.toLowerCase();
    if (["관계", "특성", "태그", "trait", "relation", "tag", "tags"].some((k) => lower.includes(k)))
      tagColumns.add(table.columns.indexOf(colName));
  }
  const statRegex = /^([A-Z가-힣]+)\s*:\s*(.+)$/;

  for (const row of table.rows) {
    const name = row[0] || "???";
    const initial = name.charAt(0).toUpperCase();

    h += `<div class="fab-pf"><div class="fab-pf-banner"></div><div class="fab-pf-inner">
      <div class="fab-pf-header"><div class="fab-pf-avatar">${esc(initial)}</div><div class="fab-pf-name">${esc(name)}</div></div>
      <div class="fab-pf-body">`;

    for (let ci = 1; ci < table.columns.length; ci++) {
      const val = (row[ci] || "").trim();
      if (!val) continue;
      const colName = table.columns[ci];

      const statParts = val
        .split("/")
        .map((s) => s.trim())
        .filter(Boolean);
      const isStats = statParts.length >= 2 && statParts.every((p) => statRegex.test(p));

      if (isStats) {
        h += `<div class="fab-pf-divider">${esc(colName)}</div><div class="fab-pf-stats">`;
        for (const part of statParts) {
          const sm = part.match(statRegex);
          if (sm)
            h += `<div class="fab-pf-stat"><span class="fab-pf-stat-key">${esc(sm[1])}</span><span class="fab-pf-stat-val">${esc(sm[2])}</span></div>`;
        }
        h += "</div>";
      } else if (tagColumns.has(ci)) {
        h += `<div class="fab-pf-divider">${esc(colName)}</div><div class="fab-pf-tags">`;
        const parts = val
          .split(/[,/;·→]/)
          .map((s) => s.trim())
          .filter(Boolean);
        for (const part of parts) h += `<span class="fab-pf-tag">${esc(part)}</span>`;
        h += "</div>";
      } else {
        h += `<div class="fab-pf-field"><span class="fab-pf-label">${esc(colName)}</span><span class="fab-pf-val">${esc(val)}</span></div>`;
      }
    }

    h += "</div></div></div>";
  }
  return h + "</div>";
}

// ---------- LOG ----------
function renderLog(table, schemaEntry) {
  const tableName = (schemaEntry?.name || "").toLowerCase();
  let iconClass = "default",
    iconLetter = "?";
  if (tableName.includes("임무") || tableName.includes("mission")) {
    iconClass = "mission";
    iconLetter = "M";
  } else if (tableName.includes("이벤트") || tableName.includes("event") || tableName.includes("의식")) {
    iconClass = "event";
    iconLetter = "E";
  } else if (tableName.includes("전투") || tableName.includes("combat")) {
    iconClass = "combat";
    iconLetter = "⚔";
  }

  let h = '<div class="fab-logs">';
  for (const row of table.rows) {
    const lastIdx = table.columns.length - 1;
    const statusVal = (row[lastIdx] || "").trim().toLowerCase();
    let statusClass = "done";
    if (statusVal.includes("active") || statusVal.includes("진행") || statusVal.includes("성공"))
      statusClass = "active";
    else if (statusVal.includes("fail") || statusVal.includes("실패")) statusClass = "fail";

    let detail = [];
    for (let ci = 2; ci < lastIdx; ci++) {
      const v = (row[ci] || "").trim();
      if (v) detail.push(v);
    }

    h += `<div class="fab-log">
      <div class="fab-log-icon ${iconClass}">${iconLetter}</div>
      <div class="fab-log-content">
        <div class="fab-log-title">${esc(row[0])}${row[1] ? " — " + esc(row[1]) : ""}</div>
        ${detail.length ? `<div class="fab-log-detail">${detail.map((d) => esc(d)).join(" · ")}</div>` : ""}
        <div class="fab-log-meta">
          ${(row[lastIdx] || "").trim() ? `<span class="fab-log-status ${statusClass}">${esc(row[lastIdx])}</span>` : ""}
        </div>
      </div>
    </div>`;
  }
  return h + "</div>";
}

// ---------- GRID ----------
function renderGrid(table) {
  let h = '<div class="fab-grid">';
  for (const row of table.rows) {
    h += `<div class="fab-grid-item">`;
    if (row[0]) h += `<div class="fab-grid-owner">${esc(row[0])}</div>`;
    if (row[1]) h += `<div class="fab-grid-name">${esc(row[1])}</div>`;
    if (row[2]) h += `<div class="fab-grid-detail">${esc(row[2])}</div>`;
    if (row[3]) h += `<div class="fab-grid-effect">${esc(row[3])}</div>`;
    for (let ci = 4; ci < table.columns.length; ci++) {
      if ((row[ci] || "").trim())
        h += `<div class="fab-grid-detail">${esc(table.columns[ci])}: ${esc(row[ci])}</div>`;
    }
    h += "</div>";
  }
  return h + "</div>";
}

// ---------- PLAIN TABLE ----------
function renderPlainTable(table) {
  if (!table.rows.length) return '<div class="fab-empty">비어 있음</div>';
  let h = `<table class="fab-rt"><thead><tr><th class="fab-rth">#</th>`;
  for (const col of table.columns) h += `<th class="fab-rth">${esc(col)}</th>`;
  h += "</tr></thead><tbody>";
  for (let ri = 0; ri < table.rows.length; ri++) {
    h += `<tr><td class="fab-rtd fab-ri">${ri}</td>`;
    for (let ci = 0; ci < table.columns.length; ci++) h += `<td class="fab-rtd">${esc(table.rows[ri][ci])}</td>`;
    h += "</tr>";
  }
  return h + "</tbody></table>";
}

// ============================================================
// RENDER — OVERVIEW
// ============================================================

function renderOverview() {
  const tables = getTables();
  const schema = getSchema();
  const modeLabels = {
    timeline: "⏱ 타임라인",
    profile: "👤 프로필",
    log: "📋 로그",
    grid: "⊞ 그리드",
    table: "▦ 테이블",
    custom: "✎ 커스텀",
  };
  let h = "";
  for (let i = 0; i < schema.length; i++) {
    const t = tables[i];
    if (!t) continue;
    const rc = t.rows?.length || 0;
    const mode = schema[i].displayMode || "table";
    h += `<div class="fab-section">
      <div class="fab-section-header" data-action="toggle-table" data-idx="${i}">
        <span class="fab-section-left"><span class="fab-section-idx">${i}</span><span class="fab-section-name">${esc(t.name)}</span><span class="fab-section-count">${rc}건</span></span>
        <span class="fab-section-right"><span class="fab-section-mode">${modeLabels[mode] || mode}</span><span class="fab-section-arrow" id="fab-arrow-${i}">▸</span></span>
      </div>
      <div class="fab-section-body" id="fab-tbody-${i}" style="display:none;">${renderDesigned(i)}</div>
    </div>`;
  }
  return h || '<div class="fab-empty">테이블이 없습니다.</div>';
}

function renderRaw() {
  const tables = getTables();
  let h = "";
  for (const [idx, table] of Object.entries(tables))
    h += `<div class="fab-card"><div class="fab-ch">테이블 ${idx}: ${table.name}</div>${renderPlainTable(table)}</div>`;
  return h;
}

// ============================================================
// RENDER — GENERATE
// ============================================================

function renderGenerate() {
  const tables = getTables();
  const hasData = Object.values(tables).some((t) => t.rows.length > 0);
  let h = "";
  if (!hasData) {
    h += `<div class="fab-card fab-setup-card"><div class="fab-ch">✨ AI 초기 셋업</div>
      <div class="fab-setup-info">채팅 내용을 분석하여 <strong>시트 전체를 자동으로 채워넣습니다.</strong></div>
      <textarea id="fab-setup-input" class="fab-gen-textarea" placeholder="예: 현재 채팅 내용을 바탕으로 시트를 전부 채워줘" rows="3"></textarea>
      <div class="fab-gen-actions"><button class="fab-set-btn primary" data-action="ai-setup">✨ 초기 생성</button></div>
      <div id="fab-setup-status" class="fab-gen-status"></div><div id="fab-setup-preview" class="fab-gen-preview"></div></div>`;
  }
  h += `<div class="fab-card"><div class="fab-ch">🤖 AI 데이터 생성</div>
    <div class="fab-gen-desc">특정 테이블에 데이터를 추가하거나 수정합니다.</div>
    <textarea id="fab-gen-input" class="fab-gen-textarea" placeholder="예: 키안의 소지품을 추가해줘" rows="4"></textarea>
    <div class="fab-gen-actions"><button class="fab-set-btn primary" data-action="ai-generate">생성 요청</button></div>
    <div id="fab-gen-status" class="fab-gen-status"></div><div id="fab-gen-preview" class="fab-gen-preview"></div></div>`;
  return h;
}

// ============================================================
// RENDER — SETTINGS
// ============================================================

function renderSettings() {
  const settings = getSettings();
  const schema = settings.schema;
  const colors = settings.colors;
  const modeLabels = {
    timeline: "타임라인",
    profile: "프로필",
    log: "로그",
    grid: "그리드",
    table: "테이블",
    custom: "커스텀",
  };

  let h = `<div class="fab-card"><div class="fab-ch">⚙ 일반</div>
    <div class="fab-set-section"><label class="fab-set-chk"><input type="checkbox" id="fab-opt-hide" ${settings.hideTableEdit ? "checked" : ""}><span>채팅에서 <tableEdit> 숨기기</span></label></div>
    <div class="fab-set-section"><div class="fab-set-label">패널 너비 (px)</div><input type="number" id="fab-opt-width" class="fab-set-input" value="${settings.panelWidth}" min="300" max="800" step="50"></div></div>`;

  h += `<div class="fab-card"><div class="fab-ch">🎨 색상</div>`;
  for (const [key, label] of [
    ["accent", "액센트"],
    ["insert", "Insert"],
    ["update", "Update"],
    ["delete", "Delete"],
  ]) {
    h += `<div class="fab-color-row"><span class="fab-color-label">${label}</span><input type="color" class="fab-color-picker" data-color-key="${key}" value="${colors[key] || DEFAULT_COLORS[key]}"><span class="fab-color-hex">${colors[key] || DEFAULT_COLORS[key]}</span></div>`;
  }
  h += `<div style="margin-top:10px"><button class="fab-set-btn danger" data-action="reset-colors">색상 초기화</button></div></div>`;

  h += `<div class="fab-card"><div class="fab-ch">🧠 AI 참조</div>
    <div class="fab-set-section"><label class="fab-set-chk"><input type="checkbox" id="fab-opt-inject" ${settings.injectEnabled ? "checked" : ""}><span>테이블 데이터를 AI에 전달</span></label></div>
    <div id="fab-inject-tables" class="${settings.injectEnabled ? "" : "fab-disabled"}"><div class="fab-set-label">테이블별 주입</div>
    ${schema
      .map(
        (s, i) =>
          `<label class="fab-set-chk fab-inject-row"><input type="checkbox" data-inject-idx="${i}" ${settings.injectTables[i] ? "checked" : ""}><span><span class="fab-inject-idx">${i}</span> ${esc(s.name)}</span><span class="fab-inject-info">${s.columns.length}컬럼·${(getTables()[i]?.rows?.length || 0)}행</span></label>`
      )
      .join("")}
    </div>
    <div class="fab-set-section" style="margin-top:12px"><div class="fab-set-label">삽입 깊이</div><input type="number" id="fab-opt-depth" class="fab-set-input" value="${settings.injectDepth}" min="0" max="999"></div></div>`;

  h += `<div class="fab-card"><div class="fab-ch">📐 스키마 편집</div>`;
  for (let i = 0; i < schema.length; i++) {
    const s = schema[i];
    h += `<div class="fab-schema-block">
      <div class="fab-schema-toggle" data-action="toggle-schema" data-idx="${i}">
        <span class="fab-schema-arrow" id="fab-sarrow-${i}">▸</span><span class="fab-schema-idx">${i}</span>
        <span class="fab-schema-preview-name">${esc(s.name)}</span>
        <span class="fab-schema-preview-cols">${s.columns.length}컬럼 · ${modeLabels[s.displayMode] || s.displayMode}</span>
      </div>
      <div class="fab-schema-detail" id="fab-sdetail-${i}" style="display:none;">
        <div class="fab-schema-head"><input type="text" class="fab-schema-name" value="${esc(s.name)}" data-schema-name-idx="${i}" placeholder="테이블 이름"><button class="fab-ab2" data-action="del-table" data-idx="${i}">✕</button></div>
        <div class="fab-schema-mode-row"><span class="fab-set-label" style="margin:0">표시 모드</span><select class="fab-set-select" data-mode-idx="${i}">${DISPLAY_MODES.map((m) => `<option value="${m}" ${s.displayMode === m ? "selected" : ""}>${modeLabels[m]}</option>`).join("")}</select></div>
        <div class="fab-schema-tpl-row">
          <div class="fab-schema-tpl-label">행 템플릿 (비워두면 기본 디자인 사용)</div>
          <textarea class="fab-schema-tpl-input" data-tpl-idx="${i}" rows="4" placeholder="<div>{{0}} — {{1}}</div>">${esc(s.template || "")}</textarea>
          <div class="fab-schema-tpl-hint">사용 가능: {{0}}, {{1}}... (컬럼 인덱스) 또는 {{col:컬럼명}} · {{initial}} (첫 글자)</div>
        </div>
        <div class="fab-schema-cols" id="fab-scols-${i}">
          ${s.columns
            .map(
              (col, ci) =>
                `<div class="fab-schema-col-row"><input type="text" class="fab-schema-col" value="${esc(col)}" data-col-ti="${i}" data-col-ci="${ci}"><button class="fab-col-btn" data-action="del-col" data-ti="${i}" data-ci="${ci}">−</button></div>`
            )
            .join("")}
          <button class="fab-col-btn add" data-action="add-col" data-ti="${i}">+ 컬럼</button>
        </div>
      </div>
    </div>`;
  }
  h += `<div class="fab-schema-actions"><button class="fab-set-btn" data-action="add-table">+ 테이블</button><button class="fab-set-btn primary" data-action="save-schema">저장</button><button class="fab-set-btn danger" data-action="reset-schema">기본값 복원</button></div></div>`;

  h += `<div class="fab-card"><div class="fab-ch">📋 JSON</div>
    <div class="fab-set-hint">형식: [{"name":"이름","columns":["컬럼"],"displayMode":"profile","template":""}]</div>
    <textarea id="fab-json-input" class="fab-json-textarea" rows="6"></textarea>
    <div class="fab-json-actions"><button class="fab-set-btn primary" data-action="json-apply">적용</button><button class="fab-set-btn" data-action="json-export">내보내기</button></div>
    <div id="fab-json-status" class="fab-gen-status"></div></div>`;

  return h;
}

// ============================================================
// AI HANDLER
// ============================================================

async function handleAiAction(mode) {
  const isSetup = mode === "setup";
  const inputEl = document.getElementById(isSetup ? "fab-setup-input" : "fab-gen-input");
  const statusEl = document.getElementById(isSetup ? "fab-setup-status" : "fab-gen-status");
  const previewEl = document.getElementById(isSetup ? "fab-setup-preview" : "fab-gen-preview");
  const btnSelector = isSetup ? "[data-action='ai-setup']" : "[data-action='ai-generate']";
  const runBtn = document.querySelector(btnSelector);
  const instruction =
    (inputEl?.value || "").trim() || (isSetup ? "채팅 내용을 분석해서 모든 테이블을 채워줘" : "");
  if (!instruction && !isSetup) {
    if (statusEl) statusEl.innerHTML = '<span class="fab-gen-err">요청 내용을 입력해주세요.</span>';
    return;
  }
  if (runBtn) {
    runBtn.disabled = true;
    runBtn.textContent = "생성 중...";
  }
  if (statusEl) statusEl.innerHTML = '<span class="fab-gen-loading">⏳ AI에 요청 중...</span>';
  if (previewEl) previewEl.innerHTML = "";
  try {
    const response = await aiGenerate(instruction, mode);
    if (!response) {
      if (statusEl) statusEl.innerHTML = '<span class="fab-gen-err">AI 응답 실패.</span>';
      return;
    }
    const ops = parseEdits(response);
    if (!ops.length) {
      if (statusEl) statusEl.innerHTML = '<span class="fab-gen-err">유효한 명령 없음.</span>';
      if (previewEl)
        previewEl.innerHTML = `<div class="fab-gen-raw"><div class="fab-gen-raw-label">원본:</div><pre>${esc(response.substring(0, 2000))}</pre></div>`;
      return;
    }
    let ph = `<div class="fab-gen-ops-label">${ops.length}개 명령:</div>`;
    for (const op of ops) {
      if (op.type === "insert") ph += `<div class="fab-gen-op insert">+ insert → T${op.ti}</div>`;
      else if (op.type === "update")
        ph += `<div class="fab-gen-op update">~ update → T${op.ti}[${op.ri}]</div>`;
      else if (op.type === "delete")
        ph += `<div class="fab-gen-op delete">- delete → T${op.ti}[${op.ri}]</div>`;
    }
    ph += `<div class="fab-gen-confirm-actions"><button class="fab-set-btn primary" data-action="ai-apply" data-source="${mode}">적용</button><button class="fab-set-btn" data-action="ai-cancel" data-source="${mode}">취소</button></div>`;
    if (statusEl) statusEl.innerHTML = '<span class="fab-gen-ok">✅ 완료. 확인 후 적용.</span>';
    if (previewEl) {
      previewEl.innerHTML = ph;
      previewEl.dataset.pendingOps = JSON.stringify(ops);
    }
  } catch (err) {
    if (statusEl) statusEl.innerHTML = `<span class="fab-gen-err">${err.message || err}</span>`;
  } finally {
    if (runBtn) {
      runBtn.disabled = false;
      runBtn.textContent = isSetup ? "✨ 초기 생성" : "생성 요청";
    }
  }
}

// ============================================================
// EVENT DELEGATION
// ============================================================

function setupDelegation() {
  const content = document.getElementById("fab-content");
  if (!content) return;

  content.addEventListener("click", (e) => {
    const action = e.target.closest("[data-action]");
    if (!action) return;
    const act = action.dataset.action;

    switch (act) {
      case "toggle-table": {
        const idx = action.dataset.idx;
        const body = document.getElementById(`fab-tbody-${idx}`);
        const arrow = document.getElementById(`fab-arrow-${idx}`);
        if (body) {
          const o = body.style.display !== "none";
          body.style.display = o ? "none" : "block";
          if (arrow) arrow.textContent = o ? "▸" : "▾";
        }
        break;
      }
      case "toggle-schema": {
        const idx = action.dataset.idx;
        const detail = document.getElementById(`fab-sdetail-${idx}`);
        const arrow = document.getElementById(`fab-sarrow-${idx}`);
        if (detail) {
          const o = detail.style.display !== "none";
          detail.style.display = o ? "none" : "block";
          if (arrow) arrow.textContent = o ? "▸" : "▾";
        }
        break;
      }
      case "del-table": {
        const idx = parseInt(action.dataset.idx);
        const schema = getSchema();
        if (schema.length <= 1) {
          alert("최소 1개.");
          break;
        }
        if (confirm(`"${schema[idx].name}" 삭제?`)) {
          schema.splice(idx, 1);
          const ni = {};
          for (let i = 0; i < schema.length; i++) {
            const oi = i >= idx ? i + 1 : i;
            ni[i] = getSettings().injectTables[oi] !== undefined ? getSettings().injectTables[oi] : true;
          }
          getSettings().injectTables = ni;
          setSchema(schema);
          refreshPanel();
          updateExtSlot();
        }
        break;
      }
      case "add-col": {
        const ti = parseInt(action.dataset.ti);
        const schema = getSchema();
        if (schema[ti]) {
          schema[ti].columns.push(`Col${schema[ti].columns.length + 1}`);
          setSchema(schema);
          refreshPanel();
        }
        break;
      }
      case "del-col": {
        const ti = parseInt(action.dataset.ti),
          ci = parseInt(action.dataset.ci);
        const schema = getSchema();
        if (schema[ti]?.columns.length > 1) {
          schema[ti].columns.splice(ci, 1);
          setSchema(schema);
          refreshPanel();
        }
        break;
      }
      case "add-table": {
        const schema = getSchema();
        schema.push({ name: `Table ${schema.length}`, columns: ["Column1"], displayMode: "table", template: "" });
        getSettings().injectTables[schema.length - 1] = true;
        setSchema(schema);
        refreshPanel();
        break;
      }
      case "save-schema": {
        const schema = getSchema();
        document.querySelectorAll("[data-schema-name-idx]").forEach((input) => {
          const idx = parseInt(input.dataset.schemaNameIdx);
          if (schema[idx]) schema[idx].name = input.value.trim() || `Table ${idx}`;
        });
        document.querySelectorAll("[data-mode-idx]").forEach((sel) => {
          const idx = parseInt(sel.dataset.modeIdx);
          if (schema[idx]) schema[idx].displayMode = sel.value;
        });
        document.querySelectorAll("[data-tpl-idx]").forEach((ta) => {
          const idx = parseInt(ta.dataset.tplIdx);
          if (schema[idx]) schema[idx].template = ta.value;
        });
        for (let i = 0; i < schema.length; i++) {
          const cols = [];
          document.querySelectorAll(`[data-col-ti="${i}"]`).forEach((input) => {
            const v = input.value.trim();
            if (v) cols.push(v);
          });
          if (cols.length) schema[i].columns = cols;
        }
        setSchema(schema);
        getTables();
        saveTables();
        injectPrompt();
        updateExtSlot();
        alert("저장 완료.");
        refreshPanel();
        break;
      }
      case "reset-schema": {
        if (confirm("기본값 복원?")) {
          resetSchema();
          refreshPanel();
          updateExtSlot();
        }
        break;
      }
      case "reset-colors": {
        getSettings().colors = JSON.parse(JSON.stringify(DEFAULT_COLORS));
        saveSettings();
        applyColors();
        refreshPanel();
        break;
      }
      case "json-apply": {
        const input = document.getElementById("fab-json-input");
        const statusEl = document.getElementById("fab-json-status");
        const raw = (input?.value || "").trim();
        if (!raw) {
          statusEl.innerHTML = '<span class="fab-gen-err">JSON 입력 필요.</span>';
          break;
        }
        try {
          const parsed = JSON.parse(raw);
          if (!Array.isArray(parsed)) throw new Error("배열 필요");
          for (let i = 0; i < parsed.length; i++)
            if (!parsed[i].name || !parsed[i].columns?.length) throw new Error(`항목 ${i} 오류`);
          if (!confirm(`${parsed.length}개 테이블로 교체?`)) break;
          const ns = parsed.map((t) => ({
            name: String(t.name),
            columns: t.columns.map((c) => String(c)),
            displayMode: DISPLAY_MODES.includes(t.displayMode) ? t.displayMode : "table",
            template: t.template || "",
          }));
          const s = getSettings();
          s.schema = ns;
          s.injectTables = {};
          for (let i = 0; i < ns.length; i++) s.injectTables[i] = true;
          saveSettings();
          getTables();
          saveTables();
          injectPrompt();
          updateExtSlot();
          statusEl.innerHTML = `<span class="fab-gen-ok">✅ ${ns.length}개 교체 완료.</span>`;
          refreshPanel();
        } catch (err) {
          statusEl.innerHTML = `<span class="fab-gen-err">${err.message}</span>`;
        }
        break;
      }
      case "json-export": {
        const input = document.getElementById("fab-json-input");
        if (input) input.value = JSON.stringify(getSchema(), null, 2);
        break;
      }
      case "ai-generate": {
        handleAiAction("generate");
        break;
      }
      case "ai-setup": {
        handleAiAction("setup");
        break;
      }
      case "ai-apply": {
        const source = action.dataset.source || "generate";
        const previewEl = document.getElementById(
          source === "setup" ? "fab-setup-preview" : "fab-gen-preview"
        );
        if (previewEl?.dataset.pendingOps) {
          const pending = JSON.parse(previewEl.dataset.pendingOps);
          applyOps(pending);
          saveTables();
          refreshPanel();
          updateExtSlot();
        }
        break;
      }
      case "ai-cancel": {
        const source = action.dataset.source || "generate";
        const p = document.getElementById(source === "setup" ? "fab-setup-preview" : "fab-gen-preview");
        const s = document.getElementById(source === "setup" ? "fab-setup-status" : "fab-gen-status");
        if (p) p.innerHTML = "";
        if (s) s.innerHTML = '<span class="fab-gen-info">취소됨.</span>';
        break;
      }
    }
  });

  content.addEventListener("change", (e) => {
    const t = e.target;
    if (t.id === "fab-opt-hide") {
      getSettings().hideTableEdit = t.checked;
      saveSettings();
    } else if (t.id === "fab-opt-width") {
      getSettings().panelWidth = parseInt(t.value) || 440;
      saveSettings();
      applyPanelWidth();
    } else if (t.id === "fab-opt-inject") {
      getSettings().injectEnabled = t.checked;
      saveSettings();
      const ts = document.getElementById("fab-inject-tables");
      if (ts) ts.classList.toggle("fab-disabled", !t.checked);
      updateExtSlot();
    } else if (t.dataset.injectIdx !== undefined) {
      getSettings().injectTables[parseInt(t.dataset.injectIdx)] = t.checked;
      saveSettings();
      updateExtSlot();
    } else if (t.id === "fab-opt-depth") {
      getSettings().injectDepth = parseInt(t.value) || 4;
      saveSettings();
    }
  });

  content.addEventListener("input", (e) => {
    const t = e.target;
    if (t.classList.contains("fab-color-picker") && t.dataset.colorKey) {
      getSettings().colors[t.dataset.colorKey] = t.value;
      const hex = t.parentElement?.querySelector(".fab-color-hex");
      if (hex) hex.textContent = t.value;
      saveSettings();
      applyColors();
    }
  });
}

// ============================================================
// EXT SLOT
// ============================================================

function createExtSlot() {
  const container = document.getElementById("extensions_settings2");
  if (!container) return;
  const wrapper = document.createElement("div");
  wrapper.id = "fab-ext-slot";
  wrapper.classList.add("extension_container");
  wrapper.innerHTML = `<div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <div class="inline-drawer-icon fa-solid fa-diamond" style="color:var(--fab-accent)"></div>
      <span class="inline-drawer-title">${EXT_DISPLAY}</span>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content" style="display:none">
      <div id="fab-ext-status" class="fab-ext-info"></div>
      <div class="fab-ext-actions">
        <input id="fab-ext-btn-open" class="menu_button" type="button" value="📋 시트">
        <input id="fab-ext-btn-scan" class="menu_button" type="button" value="↻ 재스캔">
      </div><hr>
      <div class="fab-ext-quick">
        <label class="checkbox_label"><input type="checkbox" id="fab-ext-chk-hide"><span><tableEdit> 숨기기</span></label>
        <label class="checkbox_label"><input type="checkbox" id="fab-ext-chk-inject"><span>AI에 데이터 전달</span></label>
      </div>
    </div>
  </div>`;
  container.appendChild(wrapper);
  wrapper.querySelector(".inline-drawer-toggle").addEventListener("click", function () {
    const c = wrapper.querySelector(".inline-drawer-content");
    const a = wrapper.querySelector(".inline-drawer-icon.down");
    const o = c.style.display !== "none";
    c.style.display = o ? "none" : "block";
    if (a) {
      a.classList.toggle("fa-circle-chevron-down", o);
      a.classList.toggle("fa-circle-chevron-up", !o);
    }
  });
  document.getElementById("fab-ext-btn-open").addEventListener("click", () => {
    if (!panelOpen) togglePanel();
  });
  document.getElementById("fab-ext-btn-scan").addEventListener("click", scanAll);
  const hideChk = document.getElementById("fab-ext-chk-hide");
  hideChk.checked = getSettings().hideTableEdit;
  hideChk.addEventListener("change", () => {
    getSettings().hideTableEdit = hideChk.checked;
    saveSettings();
  });
  const injectChk = document.getElementById("fab-ext-chk-inject");
  injectChk.checked = getSettings().injectEnabled;
  injectChk.addEventListener("change", () => {
    getSettings().injectEnabled = injectChk.checked;
    saveSettings();
    updateExtSlot();
  });
  updateExtSlot();
}

function updateExtSlot() {
  const s = document.getElementById("fab-ext-status");
  if (!s) return;
  const settings = getSettings();
  const tables = getTables();
  const totalRows = Object.values(tables).reduce((sum, t) => sum + (t.rows?.length || 0), 0);
  const ec = Object.values(settings.injectTables).filter((v) => v).length;
  s.innerHTML = `<div class="fab-ext-row"><span>테이블</span><span>${settings.schema.length}개 (${totalRows}행)</span></div>
    <div class="fab-ext-row"><span>AI 참조</span><span style="color:${settings.injectEnabled ? "#27ae60" : "#e74c3c"}">${settings.injectEnabled ? `ON (${ec}/${settings.schema.length})` : "OFF"}</span></div>`;
  const h = document.getElementById("fab-ext-chk-hide");
  if (h) h.checked = settings.hideTableEdit;
  const i = document.getElementById("fab-ext-chk-inject");
  if (i) i.checked = settings.injectEnabled;
}

// ============================================================
// WAND MENU
// ============================================================

function registerWandAction() {
  // 즉시 시도
  const wand = document.getElementById("extensionsMenu");
  if (wand) {
    addWandButton(wand);
    return;
  }

  // DOM 감시 — disconnect 하지 않음
  // SillyTavern의 요술봉은 팝오버로 매번 새로 생성될 수 있음
  const observer = new MutationObserver(() => {
    const w = document.getElementById("extensionsMenu");
    if (w && !document.getElementById("fab-wand-btn")) {
      addWandButton(w);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function addWandButton(container) {
  if (document.getElementById("fab-wand-btn")) return;
  const btn = document.createElement("div");
  btn.id = "fab-wand-btn";
  btn.classList.add("list-group-item", "flex-container", "flexGap5");
  btn.innerHTML = `<span class="fa-solid fa-diamond" style="color:var(--fab-accent, #6c5ce7)"></span> FAB 시트 열기`;
  btn.addEventListener("click", () => {
    if (!panelOpen) togglePanel();
  });
  container.appendChild(btn);
}

// ============================================================
// EXT SLOT
// ============================================================

function createExtSlot() {
  // 다중 셀렉터로 컨테이너 탐색
  const selectors = ["#extensions_settings2", "#extensions_settings"];
  let container = null;
  for (const sel of selectors) {
    container = document.querySelector(sel);
    if (container) break;
  }

  if (!container) {
    // 못 찾으면 2초 후 한 번 더 시도
    setTimeout(() => {
      for (const sel of selectors) {
        container = document.querySelector(sel);
        if (container) break;
      }
      if (container && !document.getElementById("fab-ext-slot")) {
        buildExtSlot(container);
      }
    }, 2000);
    return;
  }

  if (document.getElementById("fab-ext-slot")) {
    updateExtSlot();
    return;
  }

  buildExtSlot(container);
}

function buildExtSlot(container) {
  const wrapper = document.createElement("div");
  wrapper.id = "fab-ext-slot";
  wrapper.classList.add("extension_container");
  wrapper.innerHTML = `<div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <div class="inline-drawer-icon fa-solid fa-diamond" style="color:var(--fab-accent)"></div>
      <span class="inline-drawer-title">${EXT_DISPLAY}</span>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content" style="display:none">
      <div id="fab-ext-status" class="fab-ext-info"></div>
      <div class="fab-ext-actions">
        <input id="fab-ext-btn-open" class="menu_button" type="button" value="📋 시트">
        <input id="fab-ext-btn-scan" class="menu_button" type="button" value="↻ 재스캔">
      </div><hr>
      <div class="fab-ext-quick">
        <label class="checkbox_label"><input type="checkbox" id="fab-ext-chk-hide"><span><tableEdit> 숨기기</span></label>
        <label class="checkbox_label"><input type="checkbox" id="fab-ext-chk-inject"><span>AI에 데이터 전달</span></label>
      </div>
    </div>
  </div>`;
  container.appendChild(wrapper);

  wrapper.querySelector(".inline-drawer-toggle").addEventListener("click", function () {
    const c = wrapper.querySelector(".inline-drawer-content");
    const a = wrapper.querySelector(".inline-drawer-icon.down");
    const o = c.style.display !== "none";
    c.style.display = o ? "none" : "block";
    if (a) {
      a.classList.toggle("fa-circle-chevron-down", o);
      a.classList.toggle("fa-circle-chevron-up", !o);
    }
  });

  document.getElementById("fab-ext-btn-open").addEventListener("click", () => {
    if (!panelOpen) togglePanel();
  });
  document.getElementById("fab-ext-btn-scan").addEventListener("click", scanAll);

  const hideChk = document.getElementById("fab-ext-chk-hide");
  hideChk.checked = getSettings().hideTableEdit;
  hideChk.addEventListener("change", () => {
    getSettings().hideTableEdit = hideChk.checked;
    saveSettings();
  });

  const injectChk = document.getElementById("fab-ext-chk-inject");
  injectChk.checked = getSettings().injectEnabled;
  injectChk.addEventListener("change", () => {
    getSettings().injectEnabled = injectChk.checked;
    saveSettings();
    updateExtSlot();
  });

  updateExtSlot();
}
// ============================================================
// FLOATING BUTTON — 가시성 보장
// ============================================================

function createUI() {
  // 플로팅 버튼
  const btn = document.createElement("div");
  btn.id = "fab-btn";
  btn.innerHTML = "⟐";
  btn.title = "FAB Sheet";
  document.body.appendChild(btn);

  // 패널
  const panel = document.createElement("div");
  panel.id = "fab-panel";
  panel.innerHTML = `<div class="fab-ph"><div class="fab-pt">⟐ Flow & Brand ⟐</div><div class="fab-pa">
    <button id="fab-raw-btn" class="fab-raw-toggle" title="원본">{ }</button>
    <button id="fab-rescan" class="fab-ab2" title="재스캔">↻</button>
    <button id="fab-close" class="fab-ab2" title="닫기">✕</button></div></div>
    <div class="fab-tabs"><button class="fab-tab active" data-tab="overview">개요</button><button class="fab-tab" data-tab="generate">AI</button><button class="fab-tab" data-tab="settings">⚙</button></div>
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
    if (rawMode) {
      currentTab = "raw";
      panel.querySelectorAll(".fab-tab").forEach((t) => t.classList.remove("active"));
    } else {
      currentTab = "overview";
      panel.querySelectorAll(".fab-tab").forEach((t) =>
        t.classList.toggle("active", t.dataset.tab === "overview")
      );
    }
    refreshPanel();
  });

  panel.querySelectorAll(".fab-tab").forEach((tab) =>
    tab.addEventListener("click", () => {
      rawMode = false;
      document.getElementById("fab-raw-btn").classList.remove("active");
      panel.querySelectorAll(".fab-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      currentTab = tab.dataset.tab;
      refreshPanel();
    })
  );

  // 플로팅 버튼 가시성 재확인 (다른 확장이 z-index를 덮을 수 있으므로)
  ensureFloatingButtonVisible();
}

function ensureFloatingButtonVisible() {
  const btn = document.getElementById("fab-btn");
  if (!btn) return;

  // 다른 고정 요소와 겹치는지 확인하고 위치 조정
  const checkOverlap = () => {
    const rect = btn.getBoundingClientRect();
    const elemAtPoint = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (elemAtPoint && elemAtPoint !== btn && !btn.contains(elemAtPoint)) {
      // 위로 이동
      const currentBottom = parseInt(getComputedStyle(btn).bottom) || 80;
      btn.style.bottom = (currentBottom + 50) + "px";
    }
  };
  setTimeout(checkOverlap, 3000);
}

// ============================================================
// INIT
// ============================================================

jQuery(async () => {
  createUI();
  createExtSlot();
  registerWandAction();
  applyColors();

  eventSource.on(event_types.GENERATION_STARTED, () => injectPrompt());
  eventSource.on(event_types.MESSAGE_RECEIVED, (idx) => {
    const ctx = getContext();
    const msg = ctx.chat[idx];
    if (msg?.mes) processMsg(msg.mes);
    setTimeout(hideBlocks, 300);
  });
  eventSource.on(event_types.MESSAGE_EDITED, () => {
    scanAll();
    setTimeout(hideBlocks, 300);
  });
  eventSource.on(event_types.CHAT_CHANGED, () =>
    setTimeout(() => {
      scanAll();
      hideBlocks();
    }, 1000)
  );

  setTimeout(() => {
    scanAll();
    hideBlocks();
  }, 2000);

  console.log(`[FAB] ${EXT_DISPLAY} v5.1 loaded.`);
});