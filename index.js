import { getContext, saveMetadataDebounced, extension_settings } from "../../../extensions.js";
import { eventSource, event_types, generateRaw } from "../../../../script.js";

const EXT = "flow-and-brand-sheet";
const EXT_DISPLAY = "Flow & Brand Sheet";
const META_KEY = "fabSheetData";
const SETTINGS_KEY = "fabSheet";

const DEFAULT_SCHEMA = [
  { name: "시공간", columns: ["날짜", "시간", "위치", "등장인물"] },
  { name: "캐릭터", columns: ["인물", "외형", "성격", "기타"] },
  { name: "능력치", columns: ["인물", "능력치명", "수치"] },
  { name: "관계", columns: ["인물", "대상", "관계", "상세"] },
  { name: "특성/마법", columns: ["인물", "분류", "계열", "유형", "이름", "상세"] },
  { name: "소지품", columns: ["인물", "아이템", "상세", "효과"] },
  { name: "스토리라인", columns: ["인물", "유형", "내용", "위치", "상태"] },
];

const DEFAULT_COLORS = { accent: "#b8860b" };

// ── SETTINGS ──

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
  for (const k of Object.keys(s.injectTables)) if (+k >= s.schema.length) delete s.injectTables[k];
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
  const c = getSettings().colors; const hex = c.accent || "#6c5ce7";
  document.documentElement.style.setProperty("--fab-accent", hex);
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  document.documentElement.style.setProperty("--fab-accent-rgb", `${r},${g},${b}`);
}

// ── DATA ──

function buildEmpty() {
  const schema = getSchema(); const tables = {};
  for (let i = 0; i < schema.length; i++) tables[i] = { name: schema[i].name, columns: [...schema[i].columns], rows: [] };
  return tables;
}
function isRowEmpty(row, n) { for (let i = 0; i < n; i++) if ((row[i]||"").trim()) return false; return true; }
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
          for (const key of Object.keys(row)) if (+key >= nc.length) delete row[key];
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
function execUpdate(ti, ri, data) { const t = getTables()[ti]; if (!t?.rows[ri]) return; for (const [ci, val] of Object.entries(data)) t.rows[ri][+ci] = String(val); }

// ── PARSER ──

function parseDataObj(str) { const d = {}; const re = /(\d+)\s*:\s*(?:"([^"]*?)"|'([^']*?)'|([^\s,}]+))/g; let m; while ((m = re.exec(str))) d[+m[1]] = m[2] ?? m[3] ?? m[4] ?? ""; return d; }
function parseEdits(text) {
  const ops = []; const re = /<tableEdit>([\s\S]*?)<\/tableEdit>|<!--\s*tableEdit\s*-->([\s\S]*?)<!--\s*\/tableEdit\s*-->/gi; let em;
  while ((em = re.exec(text))) {
    const block = (em[1]||em[2]||"").replace(/<!--/g,"").replace(/-->/g,"");
    for (const line of block.split("\n")) {
      const t = line.trim(); if (!t || t.startsWith("//")) continue; let m;
      if ((m = t.match(/insertRow\(\s*(\d+)\s*,\s*\{([^}]+)\}\s*\)/))) ops.push({ type:"insert", ti:+m[1], data:parseDataObj(m[2]) });
      else if ((m = t.match(/deleteRow\(\s*(\d+)\s*,\s*(\d+)\s*\)/))) ops.push({ type:"delete", ti:+m[1], ri:+m[2] });
      else if ((m = t.match(/updateRow\(\s*(\d+)\s*,\s*(\d+)\s*,\s*\{([^}]+)\}\s*\)/))) ops.push({ type:"update", ti:+m[1], ri:+m[2], data:parseDataObj(m[3]) });
    }
  }
  return ops;
}
function applyOps(ops) {
  const del = ops.filter(o => o.type === "delete").sort((a,b) => a.ti !== b.ti ? b.ti-a.ti : b.ri-a.ri);
  for (const o of del) execDelete(o.ti, o.ri);
  for (const o of ops.filter(o => o.type === "update")) execUpdate(o.ti, o.ri, o.data);
  for (const o of ops.filter(o => o.type === "insert")) execInsert(o.ti, o.data);
}

// ── MESSAGE PROCESSING ──

function processMsg(text) { if (!text) return false; const ops = parseEdits(text); if (ops.length) { applyOps(ops); saveTables(); refreshPanel(); updateExtSlot(); return true; } return false; }
function scanAll() {
  const ctx = getContext(); if (!ctx.chat?.length) return;
  resetTables();
  for (const msg of ctx.chat) if (msg.mes) { const ops = parseEdits(msg.mes); if (ops.length) applyOps(ops); }
  saveTables(); refreshPanel(); updateExtSlot();
}

// ── PROMPT INJECTION ──

function buildPrompt() {
  const settings = getSettings(); if (!settings.injectEnabled) return "";
  const tables = getTables();
  const enabled = Object.entries(settings.injectTables).filter(([_,v]) => v).map(([k]) => +k).sort((a,b) => a-b);
  if (!enabled.length) return "";
  let p = "\n[FAB Sheet — Current Data]\n";
  for (const idx of enabled) {
    const t = tables[idx]; if (!t) continue;
    p += `\n### Table ${idx}: ${t.name}\nColumns: ${t.columns.join(" | ")}\n`;
    if (!t.rows.length) p += "(empty)\n";
    else for (let ri = 0; ri < t.rows.length; ri++) p += `[${ri}] ${t.columns.map((_,ci) => t.rows[ri][ci]||"").join(" | ")}\n`;
  }
  p += `\n[Table Edit Instructions]
When data changes, output <tableEdit> at END of response.
Commands: insertRow(tableIndex, {colIndex: "value"}) / updateRow(tableIndex, rowIndex, {colIndex: "newValue"}) / deleteRow(tableIndex, rowIndex)
Tables: ${enabled.join(", ")}

IMPORTANT — Character data is split across multiple tables linked by column 0 "인물" (exact character name).
T0=scene (시공간)
T1=basic profile (인물/외형/성격/기타)
T2=ability stats (one row per stat per character: 인물/능력치명/수치). e.g. "네이","COR","4"
T3=relationships (one row per directed pair: 인물/대상/관계/상세)
T4=traits+magic+abilities (one row per entry: 인물/분류/계열/유형/이름/상세). 분류=특성|마법|능력. 계열=school/lineage. 유형=기본|확장|etc.
T5=inventory (one row per item: 인물/아이템/상세/효과)
T6=storyline (one row per entry: 인물/유형/내용/위치/상태). 유형=임무|전투 or free text.

When adding a new character: insert into T1 + stat rows in T2 + relevant rows in T3/T4/T5.
Include <tableEdit> ONLY when data actually changes. Place AFTER narrative.\n`;
  return p;
}
function injectPrompt() {
  const ctx = getContext(); if (!ctx.extensionPrompts) ctx.extensionPrompts = {};
  const prompt = buildPrompt();
  if (!prompt) { delete ctx.extensionPrompts[EXT]; return; }
  ctx.extensionPrompts[EXT] = { value: prompt, position: 1, depth: getSettings().injectDepth, role: 0 };
}

// ── AI GENERATION ──

async function aiGenerate(instruction, mode) {
  const schema = getSchema(); const tables = getTables();
  let data = "";
  for (let i = 0; i < schema.length; i++) {
    const t = tables[i]; if (!t) continue;
    data += `Table ${i}: "${t.name}" — Cols: ${t.columns.map((c,ci) => `[${ci}]${c}`).join(", ")}\n`;
    if (t.rows.length) for (let ri = 0; ri < t.rows.length; ri++) data += `  [${ri}] ${t.columns.map((_,ci) => t.rows[ri][ci]||"").join(" | ")}\n`;
    else data += "  (empty)\n";
  }
  const ctx = getContext(); let chat = "";
  if (ctx.chat?.length) for (const msg of ctx.chat.slice(-15)) {
    const text = (msg.mes||"").replace(/<tableEdit>[\s\S]*?<\/tableEdit>/gi,"").trim();
    if (text) chat += `[${msg.is_user ? "User" : "Char"}]: ${text.substring(0,600)}\n`;
  }
  const sys = mode === "setup"
    ? `Data assistant. Analyze chat history and populate ALL tables with accurate data.\n\nSchema:\n${data}\nRecent Chat:\n${chat||"(none)"}\n\nRULES:\n- Output ONLY <tableEdit> block. Nothing else.\n- T0: scene info.\n- T1: one row per character (인물/외형/성격/기타). No 능력치 here.\n- T2: one row per stat per character. Col 0=인물, Col 1=능력치명, Col 2=수치 (e.g. "네이","COR","4").\n- T3: one row per DIRECTED relationship pair. Col 0=source character, Col 1=target character, Col 2=relationship label, Col 3=detail.\n- T4: one row per trait/spell/ability. Col 1 "분류"=특성|마법|능력. Col 2 "계열"=school/lineage. Col 3 "유형"=기본|확장|etc. Col 4 "이름". Col 5 "상세".\n- T5: one row per inventory item.\n- T6: one row per storyline entry. Col 1 "유형"=임무|전투.\n- Link ALL rows by Col 0 "인물" (exact name match).\n- NO empty rows. Be thorough — extract every character, relationship, trait, item, and plot point from the chat.`
    : `Data assistant. Generate table edit commands based on instruction.\n\nCurrent Schema+Data:\n${data}\n${chat ? `Recent Chat:\n${chat}` : ""}\n\nRULES:\n- Output ONLY <tableEdit> block.\n- T0=scene, T1=profile(인물/외형/성격/기타), T2=ability stats(one row per stat: 인물/능력치명/수치), T3=relationships(per directed pair), T4=traits/magic(분류→계열→유형→이름→상세), T5=inventory, T6=storyline(임무|전투).\n- Link by Col 0 "인물". NO empty rows.`;
  try { return await generateRaw(instruction,"",false,false,sys); }
  catch { try { return await generateRaw(sys+"\n\n"+instruction,""); } catch { return null; } }
}

// ── HIDE BLOCKS ──

function hideBlocks() {
  if (!getSettings().hideTableEdit) return;
  document.querySelectorAll(".mes_text").forEach(el => {
    if (el.dataset.fabProcessed) return; el.dataset.fabProcessed = "true";
    const h = el.innerHTML;
    const c = h.replace(/<tableEdit>[\s\S]*?<\/tableEdit>/gi,"").replace(/<tableEdit>[\s\S]*?<\/tableEdit>/gi,"");
    if (c !== h) el.innerHTML = c;
  });
}

// ── RENDER HELPERS ──

function esc(s) { return (s||"").replace(/&/g,"&").replace(/</g,"<").replace(/>/g,">"); }

function findTableIdx(...keywords) {
  const schema = getSchema();
  for (const kw of keywords) {
    const idx = schema.findIndex(s => s.name.includes(kw));
    if (idx >= 0) return idx;
  }
  return -1;
}

function getTableByIdx(idx) {
  if (idx < 0) return null;
  return getTables()[idx] || null;
}

function filterByChar(table, charName) {
  if (!table?.rows) return [];
  const name = charName.trim();
  return table.rows.filter(r => {
    const rowName = (r[0]||"").trim();
    return rowName === name || rowName.toLowerCase() === name.toLowerCase();
  });
}

function parseStats(str) {
  if (!str) return null;
  const trimmed = str.trim();
  if (!trimmed.includes(":")) return null;
  const parts = trimmed.split(/[/;·|]/).map(s => s.trim()).filter(Boolean);
  const stats = [];
  for (const p of parts) {
    const m = p.match(/^(.+?)\s*:\s*(.+)$/);
    if (m) stats.push({ key: m[1].trim(), val: m[2].trim() });
  }
  return stats.length >= 1 ? stats : null;
}

// ============================================================
// RENDER — SCENE BANNER (T0)
// ============================================================

function renderSceneBanner() {
  const idx = findTableIdx("시공간");
  const t = getTableByIdx(idx);
  if (!t || !t.rows.length) return "";
  const last = t.rows[t.rows.length - 1];
  let h = `<div class="fab-scene"><div class="fab-scene-label">CURRENT SCENE</div><div class="fab-scene-row">`;
  if (last[0]) h += `<span class="fab-chip date">${esc(last[0])}</span>`;
  if (last[1]) h += `<span class="fab-chip">${esc(last[1])}</span>`;
  if (last[2]) h += `<span class="fab-chip loc">${esc(last[2])}</span>`;
  h += `</div>`;
  if (last[3]) h += `<div class="fab-scene-who">${esc(last[3])}</div>`;
  h += `</div>`;
  if (t.rows.length > 1) {
    h += `<div class="fab-fold"><div class="fab-fold-head" data-action="toggle-table" data-idx="scene-prev">
      <span class="fab-fold-label">이전 씬 (${t.rows.length-1})</span><span class="fab-fold-arrow" id="fab-arrow-scene-prev">▸</span>
    </div><div class="fab-fold-body" id="fab-tbody-scene-prev" style="display:none;">`;
    for (let ri = t.rows.length-2; ri >= 0; ri--) {
      const r = t.rows[ri];
      h += `<div class="fab-prev-row"><span class="fab-prev-date">${esc(r[0])}</span>`;
      if (r[1]) h += `<span>${esc(r[1])}</span>`;
      if (r[2]) h += `<span class="fab-prev-loc">${esc(r[2])}</span>`;
      if (r[3]) h += `<span class="fab-prev-who">${esc(r[3])}</span>`;
      h += `</div>`;
    }
    h += `</div></div>`;
  }
  return h;
}

// ============================================================
// RENDER — CHARACTER SHEETS
// ============================================================

function renderCharacterSheets() {
  const charIdx = findTableIdx("캐릭터");
  const charTable = getTableByIdx(charIdx);
  if (!charTable || !charTable.rows.length) return '<div class="fab-empty">캐릭터 없음</div>';

  const relIdx = findTableIdx("관계");
  const relTable = getTableByIdx(relIdx);

  const traitIdx = findTableIdx("특성/마법", "특성", "마법");
  const traitTable = getTableByIdx(traitIdx);

  const invIdx = findTableIdx("소지품");
  const invTable = getTableByIdx(invIdx);

  const statIdx = findTableIdx("능력치");
  const statTable = getTableByIdx(statIdx);

  let h = "";
  for (let ri = 0; ri < charTable.rows.length; ri++) {
    const row = charTable.rows[ri];
    const name = (row[0]||"???").trim();
    const initial = name.charAt(0).toUpperCase();

    h += `<div class="fab-cs"><div class="fab-cs-strip"></div>
      <div class="fab-cs-head" data-action="toggle-table" data-idx="char-${ri}">
        <div class="fab-cs-avatar">${esc(initial)}</div>
        <div class="fab-cs-name">${esc(name)}</div>
        <span class="fab-cs-arrow" id="fab-arrow-char-${ri}">▸</span>
      </div>
      <div class="fab-cs-body" id="fab-tbody-char-${ri}" style="display:none;">`;

    // ── STATS (from 능력치 table) ──
    if (statTable) {
      const statRows = filterByChar(statTable, name);
      if (statRows.length) {
        h += `<div class="fab-cs-sec"><div class="fab-cs-sec-t"><span class="fab-cs-sec-i">⬡</span>능력치</div><div class="fab-stat-grid">`;
        for (const sr of statRows) {
          const sKey = (sr[1]||"").trim();
          const sVal = (sr[2]||"").trim();
          if (sKey || sVal) {
            h += `<div class="fab-stat-cell"><div class="fab-stat-key">${esc(sKey)}</div><div class="fab-stat-val">${esc(sVal)}</div></div>`;
          }
        }
        h += `</div></div>`;
      }
    }

    // ── BASIC FIELDS (skip 인물 col 0) ──
    let hasBasic = false;
    let basicH = `<div class="fab-cs-sec"><div class="fab-cs-sec-t"><span class="fab-cs-sec-i">📋</span>기본 정보</div>`;
    for (let ci = 1; ci < charTable.columns.length; ci++) {
      const val = (row[ci]||"").trim();
      if (!val) continue;
      hasBasic = true;
      basicH += `<div class="fab-cs-field"><span class="fab-cs-lbl">${esc(charTable.columns[ci])}</span><span class="fab-cs-val">${esc(val)}</span></div>`;
    }
    basicH += `</div>`;
    if (hasBasic) h += basicH;

    // ── RELATIONSHIPS (T3) ──
    if (relTable) {
      const rels = filterByChar(relTable, name);
      if (rels.length) {
        h += `<div class="fab-cs-sec"><div class="fab-cs-sec-t"><span class="fab-cs-sec-i">🔗</span>관계</div><div class="fab-rel-list">`;
        for (const r of rels) {
          h += `<div class="fab-rel-row">
            <span class="fab-rel-target">${esc(r[1])}</span>
            <span class="fab-rel-type">${esc(r[2])}</span>
            ${(r[3]||"").trim() ? `<span class="fab-rel-detail">${esc(r[3])}</span>` : ""}
          </div>`;
        }
        h += `</div></div>`;
      }
    }

    // ── TRAITS / MAGIC (T4) — 분류 → 계열 → 유형 hierarchy, skip 의식 ──
    if (traitTable) {
      const traits = filterByChar(traitTable, name);
      if (traits.length) {
        const classMap = {};
        for (const t of traits) {
          const cls = (t[1]||"기타").trim();
          if (cls.toLowerCase().includes("의식")) continue;
          const lineage = (t[2]||"미분류").trim();
          if (!classMap[cls]) classMap[cls] = {};
          if (!classMap[cls][lineage]) classMap[cls][lineage] = [];
          classMap[cls][lineage].push(t);
        }

        if (Object.keys(classMap).length) {
          h += `<div class="fab-cs-sec"><div class="fab-cs-sec-t"><span class="fab-cs-sec-i">✦</span>특성 / 마법</div>`;

          for (const [cls, lineages] of Object.entries(classMap)) {
            h += `<div class="fab-trait-cls"><div class="fab-trait-cls-hd">${esc(cls)}</div>`;

            for (const [lineage, entries] of Object.entries(lineages)) {
              h += `<div class="fab-trait-line"><div class="fab-trait-line-hd">${esc(lineage)}</div><div class="fab-trait-entries">`;

              for (const e of entries) {
                const typeBadge = (e[3]||"").trim();
                const tName = (e[4]||"").trim();
                const tDesc = (e[5]||"").trim();
                h += `<div class="fab-trait-entry">`;
                if (typeBadge) h += `<span class="fab-trait-badge">${esc(typeBadge)}</span>`;
                if (tName) h += `<span class="fab-trait-name">${esc(tName)}</span>`;
                if (tDesc) h += `<span class="fab-trait-desc">${esc(tDesc)}</span>`;
                h += `</div>`;
              }

              h += `</div></div>`;
            }

            h += `</div>`;
          }

          h += `</div>`;
        }
      }
    }

    // ── INVENTORY (T5) ──
    if (invTable) {
      const items = filterByChar(invTable, name);
      if (items.length) {
        h += `<div class="fab-cs-sec"><div class="fab-cs-sec-t"><span class="fab-cs-sec-i">🎒</span>소지품</div><div class="fab-inv-grid">`;
        for (const item of items) {
          h += `<div class="fab-inv-card">
            <div class="fab-inv-name">${esc(item[1])}</div>
            ${(item[2]||"").trim() ? `<div class="fab-inv-desc">${esc(item[2])}</div>` : ""}
            ${(item[3]||"").trim() ? `<div class="fab-inv-fx">${esc(item[3])}</div>` : ""}
          </div>`;
        }
        h += `</div></div>`;
      }
    }

    h += `</div></div>`;
  }
  return h;
}

// ============================================================
// RENDER — STORYLINE (T6)
// ============================================================

function renderStoryline() {
  const idx = findTableIdx("스토리라인", "스토리");
  const t = getTableByIdx(idx);
  if (!t || !t.rows.length) return '<div class="fab-empty">기록 없음</div>';

  let h = '<div class="fab-logs">';
  let hasRows = false;
  for (const row of t.rows) {
    const type = (row[1]||"").trim().toLowerCase();
    if (type.includes("이벤트") || type.includes("event")) continue;
    hasRows = true;
    let badge = "etc";
    if (type.includes("임무") || type.includes("mission") || type.includes("quest")) badge = "mission";
    else if (type.includes("전투") || type.includes("combat") || type.includes("battle")) badge = "combat";

    const status = (row[4]||"").trim().toLowerCase();
    let sc = "none";
    if (status.includes("진행") || status.includes("active")) sc = "active";
    else if (status.includes("완료") || status.includes("done") || status.includes("성공")) sc = "done";
    else if (status.includes("실패") || status.includes("fail")) sc = "fail";

    h += `<div class="fab-log">
      <span class="fab-log-badge ${badge}">${esc(row[1]||"기타")}</span>
      <div class="fab-log-body">
        <div class="fab-log-who">${esc(row[0])}</div>
        <div class="fab-log-title">${esc(row[2])}</div>
        <div class="fab-log-meta">`;
    if ((row[3]||"").trim()) h += `<span class="fab-log-loc">${esc(row[3])}</span>`;
    if ((row[4]||"").trim()) h += `<span class="fab-log-status ${sc}">${esc(row[4])}</span>`;
    h += `</div></div></div>`;
  }
  if (!hasRows) return '<div class="fab-empty">기록 없음</div>';
  return h+'</div>';
}

// ── PLAIN TABLE ──

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
  return h+'</tbody></table>';
}

// ============================================================
// RENDER — OVERVIEW (main view)
// ============================================================

function renderOverview() {
  const schema = getSchema();
  let h = "";

  // Scene banner
  h += renderSceneBanner();

  // Characters
  h += `<div class="fab-section-title">CHARACTERS</div>`;
  h += renderCharacterSheets();

  // Storyline
  h += `<div class="fab-section-title">STORYLINE</div>`;
  h += renderStoryline();

  // Any remaining tables not covered above
  const rendered = new Set();
  const knownNames = ["시공간","캐릭터","능력치","관계","특성/마법","특성","마법","소지품","스토리라인","스토리"];
  for (let i = 0; i < schema.length; i++) {
    if (knownNames.some(kw => schema[i].name.includes(kw))) { rendered.add(i); continue; }
  }
  const tables = getTables();
  for (let i = 0; i < schema.length; i++) {
    if (rendered.has(i)) continue;
    const t = tables[i]; if (!t?.rows.length) continue;
    h += `<div class="fab-section-title">${esc(t.name)}</div>${renderPlainTable(t)}`;
  }

  return h || '<div class="fab-empty">데이터 없음</div>';
}

function renderRaw() {
  const tables = getTables(); let h = "";
  for (const [idx, t] of Object.entries(tables)) h += `<div class="fab-card"><div class="fab-ch">T${idx}: ${t.name}</div>${renderPlainTable(t)}</div>`;
  return h;
}

// ── GENERATE TAB ──

function renderGenerate() {
  const tables = getTables();
  const hasData = Object.values(tables).some(t => t.rows.length > 0);
  let h = "";
  if (!hasData) {
    h += `<div class="fab-card fab-setup-card"><div class="fab-ch">✨ 초기 셋업</div>
      <div class="fab-setup-info">채팅 분석 → <strong>능력치 · 외형 · 성격 · 관계 · 특성/마법 · 소지품 · 스토리라인</strong> 자동 생성</div>
      <textarea id="fab-setup-input" class="fab-gen-textarea" placeholder="채팅을 분석해서 시트를 채워줘" rows="3"></textarea>
      <div class="fab-gen-actions"><button class="fab-set-btn primary" data-action="ai-setup">✨ 초기 생성</button></div>
      <div id="fab-setup-status" class="fab-gen-status"></div><div id="fab-setup-preview" class="fab-gen-preview"></div></div>`;
  }
  h += `<div class="fab-card"><div class="fab-ch">🤖 데이터 편집</div>
    <textarea id="fab-gen-input" class="fab-gen-textarea" placeholder="예: 키안에게 단검 추가 / 새 이벤트 기록" rows="4"></textarea>
    <div class="fab-gen-actions"><button class="fab-set-btn primary" data-action="ai-generate">생성</button></div>
    <div id="fab-gen-status" class="fab-gen-status"></div><div id="fab-gen-preview" class="fab-gen-preview"></div></div>`;
  return h;
}

// ── SETTINGS TAB ──

function renderSettings() {
  const settings = getSettings(); const schema = settings.schema; const colors = settings.colors;
  let h = `<div class="fab-card"><div class="fab-ch">⚙ 일반</div>
    <div class="fab-set-section"><label class="fab-set-chk"><input type="checkbox" id="fab-opt-hide" ${settings.hideTableEdit?"checked":""}><span><tableEdit> 숨기기</span></label></div>
    <div class="fab-set-section"><div class="fab-set-label">패널 너비</div><input type="number" id="fab-opt-width" class="fab-set-input" value="${settings.panelWidth}" min="300" max="800" step="50"></div></div>`;

  h += `<div class="fab-card"><div class="fab-ch">🎨 색상</div>
    <div class="fab-color-row"><span class="fab-color-label">액센트</span><input type="color" class="fab-color-picker" data-color-key="accent" value="${colors.accent||"#6c5ce7"}"><span class="fab-color-hex">${colors.accent||"#6c5ce7"}</span></div>
    <button class="fab-set-btn danger" data-action="reset-colors" style="margin-top:8px">초기화</button></div>`;

  h += `<div class="fab-card"><div class="fab-ch">🧠 AI 참조</div>
    <label class="fab-set-chk"><input type="checkbox" id="fab-opt-inject" ${settings.injectEnabled?"checked":""}><span>AI에 시트 전달</span></label>
    <div id="fab-inject-tables" class="${settings.injectEnabled?"":"fab-disabled"}" style="margin-top:8px;">
    ${schema.map((s,i) => `<label class="fab-set-chk fab-inject-row"><input type="checkbox" data-inject-idx="${i}" ${settings.injectTables[i]?"checked":""}><span><span class="fab-inject-idx">${i}</span>${esc(s.name)}</span><span class="fab-inject-info">${s.columns.length}컬럼·${(getTables()[i]?.rows?.length||0)}행</span></label>`).join("")}
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
        ${s.columns.map((col,ci) => `<div class="fab-schema-col-row"><input type="text" class="fab-schema-col" value="${esc(col)}" data-col-ti="${i}" data-col-ci="${ci}"><button class="fab-col-btn" data-action="del-col" data-ti="${i}" data-ci="${ci}">−</button></div>`).join("")}
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

// ── AI HANDLER ──

async function handleAiAction(mode) {
  const isSetup = mode === "setup";
  const inputEl = document.getElementById(isSetup ? "fab-setup-input" : "fab-gen-input");
  const statusEl = document.getElementById(isSetup ? "fab-setup-status" : "fab-gen-status");
  const previewEl = document.getElementById(isSetup ? "fab-setup-preview" : "fab-gen-preview");
  const btn = document.querySelector(isSetup ? "[data-action='ai-setup']" : "[data-action='ai-generate']");
  const instruction = (inputEl?.value||"").trim() || (isSetup ? "채팅 분석해서 모든 테이블 채워줘" : "");
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
      if (previewEl) previewEl.innerHTML = `<div class="fab-gen-raw"><pre>${esc(resp.substring(0,2000))}</pre></div>`;
      return;
    }
    let ph = `<div class="fab-gen-ops-label">${ops.length}개 명령:</div>`;
    for (const op of ops) {
      const label = op.type==="insert" ? `+ T${op.ti} insert` : op.type==="update" ? `~ T${op.ti}[${op.ri}] update` : `- T${op.ti}[${op.ri}] delete`;
      ph += `<div class="fab-gen-op ${op.type}">${label}</div>`;
    }
    ph += `<div class="fab-gen-confirm-actions"><button class="fab-set-btn primary" data-action="ai-apply" data-source="${mode}">적용</button><button class="fab-set-btn" data-action="ai-cancel" data-source="${mode}">취소</button></div>`;
    if (statusEl) statusEl.innerHTML = '<span class="fab-gen-ok">✅ 확인 후 적용.</span>';
    if (previewEl) { previewEl.innerHTML = ph; previewEl.dataset.pendingOps = JSON.stringify(ops); }
  } catch (err) { if (statusEl) statusEl.innerHTML = `<span class="fab-gen-err">${err.message}</span>`; }
  finally { if (btn) { btn.disabled = false; btn.textContent = isSetup ? "✨ 초기 생성" : "생성"; } }
}

// ── EVENT DELEGATION ──

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
        if (body) { const o = body.style.display!=="none"; body.style.display = o?"none":"block"; if (arrow) arrow.textContent = o?"▸":"▾"; }
        break;
      }
      case "toggle-schema": {
        const idx = el.dataset.idx;
        const d = document.getElementById(`fab-sdetail-${idx}`);
        const a = document.getElementById(`fab-sarrow-${idx}`);
        if (d) { const o = d.style.display!=="none"; d.style.display = o?"none":"block"; if (a) a.textContent = o?"▸":"▾"; }
        break;
      }
      case "del-table": {
        const idx = +el.dataset.idx; const schema = getSchema();
        if (schema.length <= 1) break;
        if (confirm(`"${schema[idx].name}" 삭제?`)) {
          schema.splice(idx, 1);
          const ni = {}; for (let i = 0; i < schema.length; i++) ni[i] = getSettings().injectTables[i>=idx?i+1:i] ?? true;
          getSettings().injectTables = ni; setSchema(schema); refreshPanel(); updateExtSlot();
        }
        break;
      }
      case "add-col": { const ti = +el.dataset.ti; const s = getSchema(); if (s[ti]) { s[ti].columns.push(`Col${s[ti].columns.length+1}`); setSchema(s); refreshPanel(); } break; }
      case "del-col": { const ti = +el.dataset.ti, ci = +el.dataset.ci; const s = getSchema(); if (s[ti]?.columns.length > 1) { s[ti].columns.splice(ci,1); setSchema(s); refreshPanel(); } break; }
      case "add-table": { const s = getSchema(); s.push({ name:`Table ${s.length}`, columns:["Col1"] }); getSettings().injectTables[s.length-1] = true; setSchema(s); refreshPanel(); break; }
      case "save-schema": {
        const schema = getSchema();
        document.querySelectorAll("[data-schema-name-idx]").forEach(input => { const i = +input.dataset.schemaNameIdx; if (schema[i]) schema[i].name = input.value.trim()||`Table ${i}`; });
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
          const parsed = JSON.parse((input?.value||"").trim());
          if (!Array.isArray(parsed)) throw new Error("배열 필요");
          if (!confirm(`${parsed.length}개 교체?`)) break;
          const ns = parsed.map(t => ({ name:String(t.name), columns:t.columns.map(c => String(c)) }));
          const s = getSettings(); s.schema = ns; s.injectTables = {};
          for (let i = 0; i < ns.length; i++) s.injectTables[i] = true;
          saveSettings(); getTables(); saveTables(); refreshPanel(); updateExtSlot();
          st.innerHTML = '<span class="fab-gen-ok">✅</span>';
        } catch (err) { st.innerHTML = `<span class="fab-gen-err">${err.message}</span>`; }
        break;
      }
      case "json-export": { const inp = document.getElementById("fab-json-input"); if (inp) inp.value = JSON.stringify(getSchema(),null,2); break; }
      case "ai-generate": handleAiAction("generate"); break;
      case "ai-setup": handleAiAction("setup"); break;
      case "ai-apply": {
        const src = el.dataset.source||"generate";
        const p = document.getElementById(src==="setup"?"fab-setup-preview":"fab-gen-preview");
        if (p?.dataset.pendingOps) { applyOps(JSON.parse(p.dataset.pendingOps)); saveTables(); refreshPanel(); updateExtSlot(); }
        break;
      }
      case "ai-cancel": {
        const src = el.dataset.source||"generate";
        const p = document.getElementById(src==="setup"?"fab-setup-preview":"fab-gen-preview");
        const s = document.getElementById(src==="setup"?"fab-setup-status":"fab-gen-status");
        if (p) p.innerHTML = ""; if (s) s.innerHTML = '<span class="fab-gen-info">취소.</span>';
        break;
      }
    }
  });
  content.addEventListener("change", (e) => {
    const t = e.target;
    if (t.id === "fab-opt-hide") { getSettings().hideTableEdit = t.checked; saveSettings(); }
    else if (t.id === "fab-opt-width") { getSettings().panelWidth = +t.value||440; saveSettings(); applyPanelWidth(); }
    else if (t.id === "fab-opt-inject") { getSettings().injectEnabled = t.checked; saveSettings(); document.getElementById("fab-inject-tables")?.classList.toggle("fab-disabled",!t.checked); updateExtSlot(); }
    else if (t.dataset.injectIdx !== undefined) { getSettings().injectTables[+t.dataset.injectIdx] = t.checked; saveSettings(); updateExtSlot(); }
    else if (t.id === "fab-opt-depth") { getSettings().injectDepth = +t.value||4; saveSettings(); }
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

// ── EXT SLOT ──

function createExtSlot() {
  const c = document.getElementById("extensions_settings2"); if (!c) return;
  const w = document.createElement("div"); w.id = "fab-ext-slot"; w.classList.add("extension_container");
  w.innerHTML = `<div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header"><div class="inline-drawer-icon fa-solid fa-diamond" style="color:var(--fab-accent)"></div><span class="inline-drawer-title">${EXT_DISPLAY}</span><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
    <div class="inline-drawer-content" style="display:none"><div id="fab-ext-status" class="fab-ext-info"></div>
    <div class="fab-ext-actions"><input id="fab-ext-btn-open" class="menu_button" type="button" value="📋 시트"><input id="fab-ext-btn-scan" class="menu_button" type="button" value="↻ 재스캔"></div><hr>
    <div class="fab-ext-quick"><label class="checkbox_label"><input type="checkbox" id="fab-ext-chk-hide"><span><tableEdit> 숨기기</span></label><label class="checkbox_label"><input type="checkbox" id="fab-ext-chk-inject"><span>AI에 데이터 전달</span></label></div></div></div>`;
  c.appendChild(w);
  w.querySelector(".inline-drawer-toggle").addEventListener("click", function() {
    const ct = w.querySelector(".inline-drawer-content"); const a = w.querySelector(".inline-drawer-icon.down");
    const o = ct.style.display!=="none"; ct.style.display = o?"none":"block";
    if (a) { a.classList.toggle("fa-circle-chevron-down",o); a.classList.toggle("fa-circle-chevron-up",!o); }
  });
  document.getElementById("fab-ext-btn-open").addEventListener("click", () => { if (!panelOpen) togglePanel(); });
  document.getElementById("fab-ext-btn-scan").addEventListener("click", scanAll);
  const hc = document.getElementById("fab-ext-chk-hide"); hc.checked = getSettings().hideTableEdit;
  hc.addEventListener("change", () => { getSettings().hideTableEdit = hc.checked; saveSettings(); });
  const ic = document.getElementById("fab-ext-chk-inject"); ic.checked = getSettings().injectEnabled;
  ic.addEventListener("change", () => { getSettings().injectEnabled = ic.checked; saveSettings(); updateExtSlot(); });
  updateExtSlot();
}
function updateExtSlot() {
  const s = document.getElementById("fab-ext-status"); if (!s) return;
  const st = getSettings(); const t = getTables();
  const total = Object.values(t).reduce((n,t) => n+(t.rows?.length||0), 0);
  const ec = Object.values(st.injectTables).filter(v => v).length;
  s.innerHTML = `<div class="fab-ext-row"><span>테이블</span><span>${st.schema.length}개 (${total}행)</span></div>
    <div class="fab-ext-row"><span>AI</span><span style="color:${st.injectEnabled?"var(--fab-success)":"var(--fab-danger)"}">${st.injectEnabled?`ON (${ec}/${st.schema.length})`:"OFF"}</span></div>`;
}

// ── WAND + PANEL ──

function registerWandAction() {
  const w = document.getElementById("extensionsMenu");
  if (w) { addWand(w); return; }
  new MutationObserver((_,o) => { const w = document.getElementById("extensionsMenu"); if (w) { o.disconnect(); addWand(w); } }).observe(document.body, { childList:true, subtree:true });
}
function addWand(c) {
  if (document.getElementById("fab-wand-btn")) return;
  const b = document.createElement("div"); b.id = "fab-wand-btn"; b.classList.add("list-group-item","flex-container","flexGap5");
  b.innerHTML = `<span class="fa-solid fa-diamond" style="color:var(--fab-accent)"></span> FAB 시트`;
  b.addEventListener("click", () => { if (!panelOpen) togglePanel(); }); c.appendChild(b);
}

let currentTab = "overview", panelOpen = false, rawMode = false;

function applyPanelWidth() {
  const p = document.getElementById("fab-panel"); if (!p) return;
  const w = getSettings().panelWidth||440;
  p.style.width = w+"px"; p.style.right = panelOpen?"0":`-${w+20}px`;
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
    rawMode = !rawMode; document.getElementById("fab-raw-btn").classList.toggle("active",rawMode);
    if (rawMode) { currentTab = "raw"; panel.querySelectorAll(".fab-tab").forEach(t => t.classList.remove("active")); }
    else { currentTab = "overview"; panel.querySelectorAll(".fab-tab").forEach(t => t.classList.toggle("active",t.dataset.tab==="overview")); }
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

// ── INIT ──

jQuery(async () => {
  createUI(); createExtSlot(); registerWandAction(); applyColors();
  eventSource.on(event_types.GENERATION_STARTED, () => injectPrompt());
  eventSource.on(event_types.MESSAGE_RECEIVED, (idx) => { const msg = getContext().chat[idx]; if (msg?.mes) processMsg(msg.mes); setTimeout(hideBlocks,300); });
  eventSource.on(event_types.MESSAGE_EDITED, () => { scanAll(); setTimeout(hideBlocks,300); });
  eventSource.on(event_types.CHAT_CHANGED, () => setTimeout(() => { scanAll(); hideBlocks(); }, 1000));
  setTimeout(() => { scanAll(); hideBlocks(); }, 2000);
  console.log(`[FAB] ${EXT_DISPLAY} v8.0`);
});
