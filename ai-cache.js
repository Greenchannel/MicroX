/**
 * ai-cache.js — 语义缓存(私信回复场景)
 *
 * 背景: MicroX 项目 HTTP 服务仅用 Node 内置模块, 但需要提高 AI 陪聊的缓存命中率。
 * 已有的"前缀缓存"(OpenAI 自动 / Anthropic cache_control)只对跨调用字节一致的内容生效,
 * 无法覆盖"用户用不同措辞问同一问题"的情况。本模块补充一层应用级语义缓存:
 *   - 纯文本归一化: 全半角/大小写/空白/标点/语气词/emoji 统一后做 SHA-256,
 *     "你  是谁?" 与 "你是谁" 命中同一缓存;
 *   - 可选 LLM canonical 深度归一化(AI_SEMANTIC_DEEP=1): 未命中时用一次 max_tokens=16
 *     的轻量调用把用户消息改写成标准问句, "介绍一下你自己" 与 "你是谁" 命中同一缓存;
 *   - 存储使用项目已有的 better-sqlite3 主库(数据随主库持久化, 重启不丢)。
 *
 * 安全设计:
 *   - 命中消息包含动态敏感词(钱包/CCB/持仓/股票/打赏/转账等)时自动绕过缓存,
 *     避免返回过时的余额/行情等数据;
 *   - 命中回复会剥离 [TRANSFER]/[BUY]/[STOCKBUY] 等动作标记(见 stripActionMarkers),
 *     防止重复执行打赏/购物/交易造成副作用;
 *   - 仅新会话(history 只含当前一条用户消息)启用, 多轮对话不进缓存, 避免上下文过期。
 *
 * 本模块仅使用 crypto 与调用方传入的 better-sqlite3 数据库实例, 无其他第三方依赖。
 */
'use strict';

const crypto = require('crypto');

/** 缓存有效期(毫秒), 默认 30 分钟 */
const CACHE_TTL = 30 * 60 * 1000;
/** 参与缓存的消息最大长度(超过视为复杂指令/长文, 不进缓存) */
const MAX_MSG_LEN = 60;
/** 动态敏感词: 命中这些关键词的消息绕过缓存, 防止返回过时数据 */
const DYNAMIC_WORDS = [
  '钱包', 'ccb', '余额', '持仓', '股票', '股价', '行情', '涨', '跌', '买入', '卖出',
  '打赏', '转账', '红包', '签到', '每日', '记忆', '上次', '多少', '价格',
];
/** 动作标记正则: 缓存命中时剥离, 防止副作用重复执行 */
const ACTION_RE = /\[(?:TRANSFER|BUY|EQUIP|STOCKBUY|STOCKSELL)[^\]]*\]/gi;

/** better-sqlite3 数据库实例(由 initSemanticCache 注入) */
let db = null;

/**
 * 初始化语义缓存(建表), 幂等; 服务启动时调用一次。
 * @param {object} database db.js 导出的 better-sqlite3 Database 实例
 */
function initSemanticCache(database) {
  db = database;
  db.exec(`
    CREATE TABLE IF NOT EXISTS semantic_cache (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id     INTEGER NOT NULL,             -- 机器人 user_id, 缓存按机器人隔离
      msg_key    TEXT    NOT NULL,             -- SHA-256(bot_id|归一化文本)
      reply      TEXT    NOT NULL,             -- 缓存回复(含动作标记原文, 命中时剥离)
      hits       INTEGER NOT NULL DEFAULT 0,   -- 累计命中次数(统计用)
      created_at INTEGER NOT NULL,             -- 写入时间戳(毫秒), 用于 TTL 过滤
      canonical  TEXT    NOT NULL DEFAULT '',  -- 该消息的 LLM 归一化结果(复用, 避免重复归一化调用)
      UNIQUE(bot_id, msg_key)                  -- 同一机器人的同一问句唯一, upsert 依赖此约束
    );
    CREATE INDEX IF NOT EXISTS idx_semantic_cache ON semantic_cache(bot_id, msg_key);
  `);
  // 旧库迁移: 补充 canonical 列(幂等, 已有列则跳过)
  const cols = db.prepare('PRAGMA table_info(semantic_cache)').all();
  if (!cols.some((c) => c.name === 'canonical')) {
    db.exec(`ALTER TABLE semantic_cache ADD COLUMN canonical TEXT NOT NULL DEFAULT ''`);
  }
}

/**
 * 文本归一化: 全角转半角 → 小写 → 去空白/标点/语气词/emoji。
 * 目的: 让"你  是谁?" 与 "你是谁" 归一化后字节一致, 从而命中同一缓存。
 * @param {string} msg 原始消息
 * @returns {string} 归一化后的紧凑文本
 */
function normalizeText(msg) {
  let s = String(msg || '').toLowerCase();
  // 全角 → 半角(ASCII 与常用全角标点)
  s = s.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  s = s.replace(/\u3000/g, ' ');
  // 常见语气词/口头禅(中文社交高频), 删除后不影响语义
  s = s.replace(/啊|呀|哈|呢|吧|嘛|哦|哦哦|嗯嗯|欸|哎|喂/g, '');
  // 去 emoji(代理对与杂项符号)
  s = s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '');
  // 去空白与标点
  s = s.replace(/[\s\p{P}\p{S}]/gu, '');
  return s;
}

/**
 * 生成缓存 key: SHA-256(bot_id|归一化文本)。
 * 归一化结果为空或超过 MAX_MSG_LEN 时返回 null(不参与缓存)。
 * @param {number} botId 机器人 user_id
 * @param {string} text  用户消息(或 LLM 归一化后的 canonical 短句)
 * @returns {string|null} 缓存 key
 */
function semanticCacheKey(botId, text) {
  const norm = normalizeText(text);
  if (!norm || norm.length > MAX_MSG_LEN) return null;
  return crypto.createHash('sha256').update(`${botId}|${norm}`).digest('hex');
}

/**
 * 检查消息是否含动态敏感词(命中则绕过缓存, 避免返回过时数据)。
 * @param {string} msg 原始用户消息
 * @returns {boolean} true = 应绕过缓存
 */
function isDynamic(msg) {
  const lower = String(msg || '').toLowerCase();
  return DYNAMIC_WORDS.some((w) => lower.includes(w));
}

/**
 * 查询缓存: 命中返回 { reply, hits }, 未命中返回 null。
 * @param {number} botId 机器人 user_id
 * @param {string} key   由 semanticCacheKey 生成
 * @returns {object|null}
 */
function semanticLookup(botId, key) {
  if (!db || !key) return null;
  const row = db.prepare(
    'SELECT reply, hits FROM semantic_cache WHERE bot_id = ? AND msg_key = ? AND created_at > ?'
  ).get(botId, key, Date.now() - CACHE_TTL);
  if (!row) return null;
  // 命中计数(仅统计, 不阻塞)
  db.prepare('UPDATE semantic_cache SET hits = hits + 1 WHERE bot_id = ? AND msg_key = ?').run(botId, key);
  return { reply: row.reply, hits: row.hits + 1 };
}

/**
 * 写入缓存(upsert): 相同 key 刷新回复与时间戳; canonical 非空时同时记录归一化结果。
 * @param {number} botId 机器人 user_id
 * @param {string} key   由 semanticCacheKey 生成
 * @param {string} msg   原始用户消息(用于敏感词检查)
 * @param {string} reply AI 生成的回复(含动作标记原文)
 * @param {string} [canonical=''] 该消息的 LLM 归一化短句(为空则保留已有值)
 * @returns {boolean} 是否成功写入
 */
function semanticStore(botId, key, msg, reply, canonical = '') {
  if (!db || !key || isDynamic(msg)) return false;
  db.prepare(`
    INSERT INTO semantic_cache (bot_id, msg_key, reply, hits, created_at, canonical)
    VALUES (?, ?, ?, 0, ?, ?)
    ON CONFLICT(bot_id, msg_key)
    DO UPDATE SET reply = excluded.reply, created_at = excluded.created_at,
      canonical = CASE WHEN excluded.canonical <> '' THEN excluded.canonical ELSE semantic_cache.canonical END
  `).run(botId, key, String(reply).slice(0, 2000), Date.now(), canonical);
  return true;
}

/**
 * 读取已缓存的归一化结果(消息 → canonical 短句)。
 * 不过期过滤: canonical 是"消息如何标准化"的映射, 与回复无关, 长期复用可避免重复 LLM 归一化。
 * @param {number} botId 机器人 user_id
 * @param {string} key   由 semanticCacheKey 生成
 * @returns {string|null} 已存的 canonical, 无则 null
 */
function semanticGetCanonical(botId, key) {
  if (!db || !key) return null;
  const row = db.prepare('SELECT canonical FROM semantic_cache WHERE bot_id = ? AND msg_key = ?').get(botId, key);
  return row && row.canonical ? row.canonical : null;
}

/**
 * 剥离回复中的动作标记, 只保留纯文本。
 * 语义缓存命中时回复会原样返回, 若其中含 [TRANSFER:n]/[BUY:n] 等标记,
 * 直接发送会让用户看到标记, 重新解析又会导致打赏/购物副作用重复执行。
 * @param {string} text AI 回复原文
 * @returns {string} 剥离标记后的文本
 */
function stripActionMarkers(text) {
  return String(text || '')
    .replace(ACTION_RE, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

module.exports = {
  initSemanticCache,
  normalizeText,
  semanticCacheKey,
  isDynamic,
  semanticLookup,
  semanticStore,
  semanticGetCanonical,
  stripActionMarkers,
};
