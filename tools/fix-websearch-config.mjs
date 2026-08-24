#!/usr/bin/env node
/**
 * fix-websearch-config.mjs — 把 `cordis.patch.yml` 的网页搜索配置**确定性**地
 * 修正为「MiniMax 优先 + DeepSeek 停用」，并用 **DSH 自己的 patch 算法**做验证，
 * 只有验证通过才写盘。不依赖写的人 / AI 是否手滑。
 *
 * 解决的两个「写错也不会报错」的坑：
 *  1. `- disable: web-search-deepseek` 这种写法在 loader 里会被**静默忽略**
 *     （applyEntryPatches 只认 id 定位的覆盖项，无 id 的 patch 直接跳过），
 *     导致 DeepSeek 根本没关。正确写法是 id 定位覆盖项：
 *       - id: web                  → config.searchProvider: minimax-coding-plan
 *       - id: web-search-deepseek  → disabled: true
 *  2. 这两条非 insert 覆盖项必须放在所有 `- insert:` 块**之前**（插件市场 client
 *     的行级解析只按 `- insert:` 切块，放后面会被吞进上一个 insert 块，导致市场
 *     的「配置/卸载」误读误删）。
 *
 * 用法：
 *   node tools/fix-websearch-config.mjs                  # 只检查，不改文件
 *   node tools/fix-websearch-config.mjs --write          # 修正并验证后写盘
 *   node tools/fix-websearch-config.mjs --patch <path> [--write] [--version x.y.z]
 *
 * 退出码：
 *   0 = 最终状态正确（本来就对，或 --write 修正后验证通过）
 *   1 = 最终状态不正确（检查发现错误；或 --write 写盘后验证失败）
 *   2 = 运行错误（找不到 patch 文件 / 找不到 DSH 安装等）
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// 定位 DSH 安装（拿 js-yaml + dsh-base + dsh-app-boot）
// ---------------------------------------------------------------------------
function findDshInstall() {
  const candidates = [
    process.env.DSH_INSTALL,
    path.join(os.homedir(), "AppData", "Roaming", "npm", "node_modules", "@deepseek-ai", "dsh"),
    path.join(os.homedir(), ".npm-global", "lib", "node_modules", "@deepseek-ai", "dsh"),
    path.join(os.homedir(), ".dsh", "profiles", "web", "node_modules", "@deepseek-ai", "dsh"),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "node_modules", "js-yaml"))) return c;
  }
  return undefined;
}
const DSH_INSTALL = findDshInstall();
if (!DSH_INSTALL) {
  console.error("fix-websearch-config: 找不到 DSH 安装（需要其中的 js-yaml）。请设环境变量 DSH_INSTALL 或在本机运行。");
  process.exit(2);
}
const requireFromDsh = createRequire(path.join(DSH_INSTALL, "package.json"));
const yaml = requireFromDsh("js-yaml");

// ---------------------------------------------------------------------------
// 常量 / 期望值
// ---------------------------------------------------------------------------
const EXPECTED_SEARCH_PROVIDER = "minimax-coding-plan";
const WEB_OVERRIDE_ID = "web";
const DEEPSEEK_OVERRIDE_ID = "web-search-deepseek";
const PLUGIN_ID = "dsh-web-search-minimax";

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const write = args.includes("--write");
const versionArg = args.indexOf("--version") >= 0 ? args[args.indexOf("--version") + 1] : undefined;
const patchArg = args.indexOf("--patch") >= 0 ? args[args.indexOf("--patch") + 1] : undefined;
if (args.includes("--help") || args.includes("-h")) {
  console.log((fs.readFileSync(new URL(import.meta.url), "utf8").match(/\/\*\*([\s\S]*?)\*\//) || [])[1]);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 定位 patch 文件
// ---------------------------------------------------------------------------
function resolveDshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}
const patchPath = patchArg
  ? path.resolve(patchArg)
  : path.join(resolveDshHome(), "profiles", "web", "cordis.patch.yml");
if (!fs.existsSync(patchPath)) {
  console.error(`fix-websearch-config: patch file not found: ${patchPath}`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 解析工具：js-yaml + `!!js` 表达式（与 DSH profile patch 同一 schema）
// ---------------------------------------------------------------------------
const JsExpr = new yaml.Type("tag:yaml.org,2002:js", {
  kind: "scalar",
  resolve: (data) => typeof data === "string",
  construct: (data) => ({ __jsExpr: data }),
});
const schema = yaml.JSON_SCHEMA.extend(JsExpr);

function parseRows(text) {
  const data = yaml.load(text, { schema });
  if (!Array.isArray(data)) throw new Error("patch file must be a top-level array");
  return data;
}

// ---------------------------------------------------------------------------
// 行级工具（保留注释，与插件市场 client 相同的切块口径）
// ---------------------------------------------------------------------------
function splitLines(text) {
  return text.split(/\r?\n/);
}
function detectEol(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}
const isTopLevelEntry = (line) => /^-\s/.test(line);

/** 把所有「顶格 - 」条目切成块：{ start, end }，含起止行下标。 */
function topLevelBlocks(lines) {
  const blocks = [];
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isTopLevelEntry(lines[i])) {
      if (start >= 0) blocks.push({ start, end: i });
      start = i;
    }
  }
  if (start >= 0) blocks.push({ start, end: lines.length });
  return blocks;
}

const isInsertBlock = (lines, block) => /^-\s*insert:?\s*$/.test(lines[block.start].trim());
/** 匹配 `- disable:`、`- disable foo`（带不带目标都算，loader 一律跳过这种无效形式）。 */
const isDisableBlock = (lines, block) => /^-\s*disable\b/.test(lines[block.start].trim());
const overrideIdOf = (lines, block) => {
  const m = /^-\s*id:\s*(\S+)\s*$/.exec(lines[block.start].trim());
  return m ? m[1] : undefined;
};

/** 提取一个块里 `config:` 下的原始行（保留缩进）。 */
function blockConfigEntries(lines, block) {
  const entries = [];
  for (let i = block.start; i < block.end; i++) {
    const m = /^(\s*)config:\s*$/.exec(lines[i]);
    if (!m) continue;
    const cfgIndent = m[1].length;
    for (let j = i + 1; j < block.end; j++) {
      const t = lines[j];
      const indent = (/^\s*/.exec(t) || [""])[0].length;
      if (t.trim() === "" || indent <= cfgIndent) break;
      entries.push(t);
    }
  }
  return entries;
}

/** 插件市场 client 的 splitBlocks（只按 `- insert:` 切块）——用来验证隔离性。 */
function marketBlocks(lines) {
  const blocks = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === "- insert:" || t === "- insert") {
      if (cur) { cur.end = i; blocks.push(cur); }
      cur = { start: i, end: lines.length, id: null };
    } else if (cur && cur.id === null) {
      const m = /^-\s*id:\s*(.+?)\s*$/.exec(t);
      if (m) cur.id = m[1];
    }
  }
  if (cur) blocks.push(cur);
  return blocks;
}

// ---------------------------------------------------------------------------
// 转换
// ---------------------------------------------------------------------------
function buildWebOverride(existingConfigEntries) {
  const keep = (existingConfigEntries || []).filter((l) => !/^\s*searchProvider\s*:/.test(l));
  return [
    "- id: web",
    "  name: '@deepseek-ai/dsh-web'",
    "  config:",
    `    searchProvider: ${EXPECTED_SEARCH_PROVIDER}`,
    ...keep,
  ];
}
function buildDeepseekOverride(existingConfigEntries) {
  const keep = existingConfigEntries || [];
  return [
    "- id: web-search-deepseek",
    "  name: '@deepseek-ai/dsh-web-search-deepseek'",
    "  disabled: true",
    ...(keep.length ? ["  config:", ...keep] : []),
  ];
}

function hasPluginRow(lines) {
  return lines.some((l) => /^\s*-\s*id:\s*dsh-web-search-minimax\s*$/.test(l));
}
function installedPluginVersion() {
  const dir = path.join(resolveDshHome(), "profiles", "node_modules");
  if (!fs.existsSync(dir)) return undefined;
  let best;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const m = /^dsh-web-search-minimax-v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(ent.name);
    if (!m || !ent.isDirectory()) continue;
    if (!best || m[1] > best) best = m[1];
  }
  return best;
}

/**
 * 生成修正后的文件文本。返回 { text, changed, removedDisables }。
 *  - 删掉所有无效的 `- disable:` 块；
 *  - 摘掉已存在的 `web` / `web-search-deepseek` 覆盖块（保留其 config 其它键）；
 *  - 把规范化后的两条覆盖块放到「第一个 insert 块之前」；
 *  - 确保 `dsh-web-search-minimax` insert 行存在（缺才加）。
 */
function transform(text) {
  const eol = detectEol(text);
  let lines = splitLines(text);
  const blocks = topLevelBlocks(lines);

  const removedDisables = [];
  const seenOverride = new Map(); // id -> existing config entries
  for (const block of blocks) {
    if (isDisableBlock(lines, block)) {
      removedDisables.push(lines[block.start].trim());
      continue;
    }
    const oid = overrideIdOf(lines, block);
    if (oid === WEB_OVERRIDE_ID || oid === DEEPSEEK_OVERRIDE_ID) {
      if (!seenOverride.has(oid)) seenOverride.set(oid, blockConfigEntries(lines, block));
    }
  }

  // 摘除 disable 块 + 已存在覆盖块（从后往前删，下标才稳定）
  const toRemove = blocks.filter((block) => {
    if (isDisableBlock(lines, block)) return true;
    const oid = overrideIdOf(lines, block);
    return oid === WEB_OVERRIDE_ID || oid === DEEPSEEK_OVERRIDE_ID;
  });
  toRemove.sort((a, b) => b.start - a.start);
  for (const block of toRemove) lines.splice(block.start, block.end - block.start);

  // 构造规范化覆盖块
  const overrideText = [
    "# ── 网页搜索：切到 MiniMax，停用 DeepSeek ────────────────────────────────",
    "# 这两条是 id 定位覆盖项，必须放在所有 insert 块之前（见 tools/fix-websearch-config.mjs）。",
    ...buildWebOverride(seenOverride.get(WEB_OVERRIDE_ID)),
    ...buildDeepseekOverride(seenOverride.get(DEEPSEEK_OVERRIDE_ID)),
  ];

  // 插入点：第一个 insert 块之前；没有 insert 就追加到末尾
  const insertIdx = lines.findIndex((l) => /^-\s*insert:?\s*$/.test(l.trim()));
  const anchor = insertIdx >= 0 ? insertIdx : lines.length;
  lines.splice(anchor, 0, "", ...overrideText);

  // 确保插件 insert 行存在（缺才加；存在则不动）
  if (!hasPluginRow(lines)) {
    const pluginVersion = versionArg || installedPluginVersion() || "1.1.0";
    lines.push("", `# ── 市场安装: ${PLUGIN_ID} ──`, "- insert:", `    - id: ${PLUGIN_ID}`, `      name: ${PLUGIN_ID}-${pluginVersion}`);
  }

  const result = lines.join(eol);
  return { text: result, changed: result !== text, removedDisables };
}

// ---------------------------------------------------------------------------
// 验证
// ---------------------------------------------------------------------------
function verifyBasic(text) {
  const problems = [];
  const lines = splitLines(text);

  let rows;
  try {
    rows = parseRows(text);
  } catch (e) {
    return { ok: false, problems: [`YAML 解析失败: ${e.message}`] };
  }
  for (const line of lines) if (/^-\s*disable\b/.test(line.trim())) problems.push(`仍存在无效写法: ${line.trim()}`);

  const web = rows.find((r) => r && r.id === WEB_OVERRIDE_ID);
  if (!web) problems.push("缺少 `- id: web` 覆盖项");
  else if (!web.config || web.config.searchProvider !== EXPECTED_SEARCH_PROVIDER)
    problems.push(`web.config.searchProvider 应为 ${EXPECTED_SEARCH_PROVIDER}，实际 ${JSON.stringify(web.config && web.config.searchProvider)}`);

  const ds = rows.find((r) => r && r.id === DEEPSEEK_OVERRIDE_ID);
  if (!ds) problems.push("缺少 `- id: web-search-deepseek` 覆盖项");
  else if (ds.disabled !== true) problems.push(`web-search-deepseek.disabled 应为 true，实际 ${JSON.stringify(ds.disabled)}`);

  if (!rows.some((r) => r && Array.isArray(r.insert) && r.insert.some((e) => e.id === PLUGIN_ID)))
    problems.push(`缺少 ${PLUGIN_ID} insert 行`);

  // 市场 client 隔离性：覆盖项不得落在任何 insert 块内
  for (const b of marketBlocks(lines)) {
    for (let i = b.start; i < b.end; i++) {
      const m = /^-\s*id:\s*(web|web-search-deepseek)\s*$/.exec(lines[i].trim());
      if (m) problems.push(`覆盖项 "${m[1]}" 被吞进 insert 块（第 ${i + 1} 行），必须在所有 insert 块之前`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/** 第二层：用真实 loader 算法（dsh-app-boot.composeEntries + dsh-base）组合后断言。 */
async function verifyComposed(rows) {
  const basePatch = path.join(DSH_INSTALL, "node_modules", "@deepseek-ai", "dsh-base", "cordis.patch.yml");
  const appBoot = path.join(DSH_INSTALL, "node_modules", "@deepseek-ai", "dsh-app-boot", "lib", "index.js");
  if (!fs.existsSync(basePatch) || !fs.existsSync(appBoot)) return [];
  const problems = [];
  try {
    const mod = await import(pathToFileURL(appBoot).href);
    const baseRows = parseRows(fs.readFileSync(basePatch, "utf8"));
    const composed = mod.composeEntries([baseRows, rows], () => {});
    const cweb = composed.find((r) => r.id === WEB_OVERRIDE_ID);
    if (!cweb || !cweb.config || cweb.config.searchProvider !== EXPECTED_SEARCH_PROVIDER)
      problems.push("组合后 web.searchProvider 仍不是 minimax-coding-plan");
    const cds = composed.find((r) => r.id === DEEPSEEK_OVERRIDE_ID);
    if (!cds || cds.disabled !== true) problems.push("组合后 web-search-deepseek 仍未禁用");
    if (!composed.some((r) => r.id === PLUGIN_ID)) problems.push("组合后缺少 dsh-web-search-minimax 行");
  } catch (e) {
    problems.push(`第二层组合验证未能运行: ${e && e.message ? e.message : String(e)}`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const original = fs.readFileSync(patchPath, "utf8");
const { text: fixed, changed, removedDisables } = transform(original);

if (!write) {
  const check = verifyBasic(original);
  if (check.ok) {
    console.log(`[check] OK — ${patchPath}`);
    console.log(`  已符合「MiniMax 优先 + DeepSeek 停用」（web.searchProvider=${EXPECTED_SEARCH_PROVIDER}，web-search-deepseek.disabled=true）`);
    process.exit(0);
  }
  console.log(`[check] FAIL — ${patchPath} 需要修正：`);
  for (const p of check.problems) console.log(`  - ${p}`);
  console.log("\n修正预览（未写盘，加 --write 生效）：");
  const o = splitLines(original);
  const f = splitLines(fixed);
  const min = Math.min(o.length, f.length);
  let shown = 0;
  for (let i = 0; i < min && shown < 30; i++) {
    if (o[i] !== f[i]) { console.log(`  L${i + 1}: ${o[i]}  →  ${f[i]}`); shown++; }
  }
  if (o.length !== f.length) console.log(`  行数: ${o.length} → ${f.length}`);
  process.exit(1);
}

// 写盘模式：先在修正后的文本上做全部验证
const basic = verifyBasic(fixed);
const composedProblems = await verifyComposed(parseRows(fixed));
const allProblems = [...basic.problems, ...composedProblems];
if (allProblems.length > 0) {
  console.log("[write] ABORT — 修正后验证未通过，未写盘：");
  for (const p of allProblems) console.log(`  - ${p}`);
  process.exit(1);
}
if (!changed) {
  console.log(`[write] OK — ${patchPath} 本来就正确，无需改动`);
  process.exit(0);
}
const tmp = `${patchPath}.fix-tmp`;
fs.writeFileSync(tmp, fixed, "utf8");
fs.renameSync(tmp, patchPath);
console.log(`[write] OK — 已修正并验证通过：${patchPath}`);
if (removedDisables.length) console.log(`  - 移除无效 \`- disable:\` 行: ${removedDisables.join(", ")}`);
console.log(`  - web.config.searchProvider = ${EXPECTED_SEARCH_PROVIDER}；web-search-deepseek.disabled = true`);
console.log("  - 两条覆盖项已置于所有 insert 块之前；第二层组合验证已通过");
process.exit(0);
