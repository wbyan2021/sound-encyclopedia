/**
 * ai-generate-fun-fact.js
 * 批量调用 MiniMax LLM 为声音条目生成儿童科普文案（fun_fact）
 *
 * 用法：
 *   node scripts/ai-generate-fun-fact.js                    # 为缺失 fun_fact 的条目生成
 *   node scripts/ai-generate-fun-fact.js --force            # 重新生成所有条目
 *   node scripts/ai-generate-fun-fact.js --id animals.dog   # 只生成指定条目
 *   node scripts/ai-generate-fun-fact.js --category animals # 只生成指定分类
 *   node scripts/ai-generate-fun-fact.js --dry-run          # 预览模式，不写文件
 */

const fs = require('fs');
const path = require('path');
const { loadEnv, generateFunFact, getLLMConfig } = require('./lib/minimax');

const DATA_DIR = path.join(__dirname, '..', 'data', 'sounds');
const DELAY_MS = 500;

function scanSounds() {
  const results = [];
  if (!fs.existsSync(DATA_DIR)) return results;
  for (const cat of fs.readdirSync(DATA_DIR)) {
    const catDir = path.join(DATA_DIR, cat);
    if (!fs.statSync(catDir).isDirectory()) continue;
    for (const snd of fs.readdirSync(catDir)) {
      const metaPath = path.join(catDir, snd, 'meta.json');
      if (fs.existsSync(metaPath)) results.push(metaPath);
    }
  }
  return results;
}

function readMeta(metaPath) {
  try { return JSON.parse(fs.readFileSync(metaPath, 'utf-8')); }
  catch (e) { throw new Error(`解析 ${metaPath}: ${e.message}`); }
}

function writeMeta(metaPath, data) {
  fs.writeFileSync(metaPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const args = process.argv.slice(2);
  const isForce = args.includes('--force');
  const isDryRun = args.includes('--dry-run');
  const targetId = (() => { const i = args.indexOf('--id'); return i !== -1 ? args[i + 1] : null; })();
  const targetCat = (() => { const i = args.indexOf('--category'); return i !== -1 ? args[i + 1] : null; })();

  loadEnv();

  const { apiKey } = getLLMConfig();
  if (!apiKey) {
    console.error('❌ 未设置 LLM_API_KEY。请在 .env 中配置。');
    process.exit(1);
  }

  const metaPaths = scanSounds();
  console.log(`📂 扫描到 ${metaPaths.length} 个 meta.json`);
  if (targetCat) console.log(`🏷️  筛选分类: ${targetCat}`);
  if (targetId) console.log(`🎯 指定条目: ${targetId}`);
  console.log();

  let generated = 0, skipped = 0, errors = 0;

  for (const metaPath of metaPaths) {
    let meta;
    try { meta = readMeta(metaPath); }
    catch (e) { console.error(`❌ ${e.message}`); errors++; continue; }

    if (targetId && meta.id !== targetId) continue;
    if (targetCat && meta.category !== targetCat) continue;
    if (!isForce && meta.fun_fact && meta.fun_fact.trim()) { skipped++; continue; }

    console.log(`🤖 ${meta.id}（${meta.name_zh}）...`);

    try {
      const result = await generateFunFact(meta);
      console.log(`   → ${result.text}`);

      if (!isDryRun) {
        meta.fun_fact = result.text;
        meta.fun_fact_ai_generated = true;
        meta.ai = result.ai;
        writeMeta(metaPath, meta);
        console.log(`   ✅ 已写入`);
      } else {
        console.log(`   📝 [dry-run]`);
      }
      generated++;
    } catch (err) {
      console.error(`   ❌ ${meta.id}: ${err.message}`);
      errors++;
    }

    await sleep(DELAY_MS);
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`  生成: ${generated}  跳过: ${skipped}  失败: ${errors}`);
  if (isDryRun) console.log('📝 dry-run 模式，未写入文件');
}

main().catch(err => { console.error('致命错误:', err); process.exit(1); });
