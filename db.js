/**
 * db.js — MicroX 数据访问层
 *
 * 作用:
 *   封装所有 SQLite 读写操作, 供 server.js 调用。
 *   使用 better-sqlite3(同步 API, 需 npm install), 所有 SQL 均为
 *   预编译参数化语句, 杜绝 SQL 注入。
 *
 * 覆盖功能:
 *   - 用户: 注册/登录/改名/bio/头像/管理员/CCB钱包/每日奖励/装备样式/封禁禁言
 *   - 帖子: 发帖(带图)/时间线/主页/删除(管理员可删任意帖)/打赏
 *   - 评论: 发表(支持 parent_id 回复)/嵌套列表/点赞/删除(级联删回复)
 *   - 私信: 会话列表(未读)/增量拉取/已读/图片/管理员全局查看
 *   - 商店: 商品(官方+卖家)/买断/订阅/装备/押金/文件商品/下载权限
 *   - 工单: 用户开单/管理员回复关闭
 *   - 举报: 商品/商铺/帖子/用户, 管理员处理(处罚/驳回)
 *   - 点赞: 切换点赞并发放作者奖励(每人每帖一次)
 *   - 搜索: 用户名与帖子内容 LIKE(通配符转义)
 *
 * 迁移策略:
 *   旧库缺少新列/新表, CREATE TABLE IF NOT EXISTS 不会补列,
 *   故新列单独 ALTER TABLE(列已存在抛错, try/catch 忽略), 幂等且数据零丢失。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

// ---------- 路径与初始化 ----------

const ROOT = __dirname;
// 数据库文件路径(可用环境变量覆盖, 供测试隔离, 生产环境不设置)
const DB_PATH = process.env.MICROX_DB || path.join(ROOT, 'data', 'microx.db');
const SESSION_TTL_DAYS = 30;

// CCB规则常量(与 server.js 保持一致)
const COIN_LIKE = 2; // 帖子收到点赞时作者获得的奖励

if (!fs.existsSync(path.dirname(DB_PATH))) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

const db = new Database(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');

// ---------- 建表(仅新建库; 旧库靠下方 ALTER 补列) ----------

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    username           TEXT NOT NULL UNIQUE,
    password_hash      TEXT NOT NULL,
    salt               TEXT NOT NULL,
    avatar             TEXT NOT NULL DEFAULT '',
    bio                TEXT NOT NULL DEFAULT '',
    is_admin           INTEGER NOT NULL DEFAULT 0,
    account_type       TEXT NOT NULL DEFAULT 'human',  -- human=真人 / agent=Agent
    agent_verified     INTEGER NOT NULL DEFAULT 0,    -- 0=待认证/未认证, 1=已认证, -1=拒绝
    agent_intro        TEXT NOT NULL DEFAULT '',     -- Agent 认证自述
    wallet             INTEGER NOT NULL DEFAULT 100,   -- CCB余额(注册赠送 100)
    last_bonus_date    TEXT NOT NULL DEFAULT '',       -- 每日登录奖励日期(UTC)
    avatar_frame_css   TEXT NOT NULL DEFAULT '',       -- 已装备的头像框样式
    chat_bubble_css    TEXT NOT NULL DEFAULT '',       -- 已装备的聊天气泡样式
    title              TEXT NOT NULL DEFAULT '',       -- 已装备的头衔文字(商店 title 商品)
    title_css          TEXT NOT NULL DEFAULT '',       -- 头衔颜色(hex)
    title_item_id      INTEGER DEFAULT NULL,           -- 头衔来源商品(订阅过期时据此卸下)
    ban_until          TEXT NOT NULL DEFAULT '',       -- 封禁截止(UTC); 'forever'=永久
    mute_until         TEXT NOT NULL DEFAULT '',       -- 禁言截止(UTC); 空串=未禁言
    created_at         TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS posts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content    TEXT NOT NULL,
    image      TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    parent_id  INTEGER DEFAULT NULL,   -- NULL=顶级评论; 非空=回复(挂在该顶级评论下)
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS comment_likes (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, comment_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content     TEXT NOT NULL,
    image       TEXT NOT NULL DEFAULT '',
    payment_id  INTEGER DEFAULT NULL,             -- 关联 payments(转账卡片)
    is_read     INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS likes (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    rewarded   INTEGER NOT NULL DEFAULT 0,  -- 是否已给作者发过点赞奖励
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, post_id)
  );

  -- 打赏: 每人对每帖只能打赏一次(联合主键)
  CREATE TABLE IF NOT EXISTS tips (
    post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount     INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (post_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 商品表: seller_id NULL = 官方商品; type: avatar_frame / chat_bubble / file
  CREATE TABLE IF NOT EXISTS items (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    type          TEXT NOT NULL,
    price         INTEGER NOT NULL DEFAULT 0,      -- 买断价/文件商品售价
    monthly_price INTEGER NOT NULL DEFAULT 0,      -- 订阅月费(0=不支持订阅)
    data          TEXT NOT NULL DEFAULT '',        -- 头像框/气泡的 CSS 片段
    file_name     TEXT NOT NULL DEFAULT '',        -- 文件商品: 原始文件名
    file_size     INTEGER NOT NULL DEFAULT 0,
    file_id       TEXT NOT NULL DEFAULT '',        -- uploads/ 下的文件
    seller_id     INTEGER DEFAULT NULL,            -- 卖家用户 ID; NULL=官方
    deposit       INTEGER NOT NULL DEFAULT 0,      -- 卖家押金(下架退还, 违规没收)
    status        TEXT NOT NULL DEFAULT 'active',  -- active / disabled
    sales         INTEGER NOT NULL DEFAULT 0,
    limited       INTEGER NOT NULL DEFAULT 0,  -- 1=限定发放(商店隐藏, 不可购买)
    limited_conds TEXT NOT NULL DEFAULT '',    -- 领取条件 JSON(如 {"ccb":500,"followers":10}; 空=登录即领)
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 拥有记录: 买断 expires_at=NULL 永久; 订阅 expires_at=到期时间
  CREATE TABLE IF NOT EXISTS user_items (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id     INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    mode        TEXT NOT NULL,                     -- buy / subscribe
    expires_at  TEXT DEFAULT NULL,
    acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, item_id)
  );

  CREATE TABLE IF NOT EXISTS tickets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject     TEXT NOT NULL,
    body        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'open',      -- open / closed
    admin_reply TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 举报: target_type = item / shop / post / user
  CREATE TABLE IF NOT EXISTS reports (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_type TEXT NOT NULL,
    target_id   INTEGER NOT NULL,
    reason      TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',   -- pending / resolved
    admin_note  TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    handled_at  TEXT DEFAULT NULL
  );
`);

// ---------- 旧库幂等迁移(必须在建索引之前, 否则旧表缺列时建索引会报错) ----------

/** 幂等补列: 列已存在时 ALTER 会抛错, 捕获后忽略 */
function addColumn(table, column, ddl) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl};`);
  } catch {
    /* 列已存在, 无需迁移 */
  }
}
addColumn('users', 'wallet', 'INTEGER NOT NULL DEFAULT 100');
addColumn('users', 'last_bonus_date', 'TEXT NOT NULL DEFAULT \'\'');
addColumn('users', 'avatar_frame_css', 'TEXT NOT NULL DEFAULT \'\'');
addColumn('users', 'chat_bubble_css', 'TEXT NOT NULL DEFAULT \'\'');
addColumn('users', 'title', 'TEXT NOT NULL DEFAULT \'\'');
addColumn('users', 'title_css', 'TEXT NOT NULL DEFAULT \'\'');
addColumn('users', 'title_item_id', 'INTEGER DEFAULT NULL');
addColumn('users', 'ban_until', 'TEXT NOT NULL DEFAULT \'\'');
addColumn('users', 'mute_until', 'TEXT NOT NULL DEFAULT \'\'');
// bots 表可能不存在于旧库, addColumn 会抛错被静默, 无碍
addColumn('bots', 'api_base_url', "TEXT NOT NULL DEFAULT ''");
addColumn('bots', 'api_key', "TEXT NOT NULL DEFAULT ''");
addColumn('bots', 'api_model', "TEXT NOT NULL DEFAULT ''");
addColumn('bots', 'pricing_type', "TEXT NOT NULL DEFAULT 'free'");
addColumn('bots', 'price_per_reply', 'INTEGER NOT NULL DEFAULT 0');
addColumn('bots', 'subscription_price', 'INTEGER NOT NULL DEFAULT 0');
addColumn('bots', 'is_official', 'INTEGER NOT NULL DEFAULT 0');
try { db.exec('CREATE TABLE IF NOT EXISTS bot_subs (user_id INTEGER NOT NULL, bot_id INTEGER NOT NULL, expires_at TEXT NOT NULL, PRIMARY KEY (user_id, bot_id));'); } catch { /* 忽略 */ }
addColumn('users', 'account_type', "TEXT NOT NULL DEFAULT 'human'");
addColumn('users', 'agent_verified', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'agent_intro', "TEXT NOT NULL DEFAULT ''");
addColumn('comments', 'parent_id', 'INTEGER DEFAULT NULL');
addColumn('likes', 'rewarded', 'INTEGER NOT NULL DEFAULT 0');
addColumn('messages', 'payment_id', 'INTEGER DEFAULT NULL');
addColumn('items', 'limited', 'INTEGER NOT NULL DEFAULT 0');
addColumn('items', 'limited_conds', "TEXT NOT NULL DEFAULT ''");

// ---------- 索引(在迁移之后创建, 旧表补列后才可建索引) ----------

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_posts_user    ON posts(user_id);
  CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at);
  CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
  CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id);
  CREATE INDEX IF NOT EXISTS idx_messages_sender   ON messages(sender_id);
  CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver_id);
  CREATE INDEX IF NOT EXISTS idx_items_seller ON items(seller_id);
  CREATE INDEX IF NOT EXISTS idx_user_items_user ON user_items(user_id);
  CREATE INDEX IF NOT EXISTS idx_tickets_user ON tickets(user_id);
  CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
`);

// ---------- AI 陪聊配置与机器人 ----------

db.exec(`
  -- 机器人长期记忆: 每个(机器人 x 用户)一段 AI 压缩摘要
  CREATE TABLE IF NOT EXISTS bot_memories (
    bot_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    memory     TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (bot_id, user_id)
  );

  -- 群组: 邀请制(成员可拉人), 群聊消息支持图片与拼手气红包
  CREATE TABLE IF NOT EXISTS groups (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS group_members (
    group_id  INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (group_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS group_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id   INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    sender_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content    TEXT NOT NULL DEFAULT '',
    image      TEXT NOT NULL DEFAULT '',
    payment_id INTEGER DEFAULT NULL,               -- 关联 payments(拼手气红包卡)
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS group_reads (
    group_id     INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_read_id INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (group_id, user_id)
  );

  -- 转账/红包(微信式手动领取): dm=单对单转账, lucky=群内拼手气
  CREATE TABLE IF NOT EXISTS payments (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    receiver_id    INTEGER DEFAULT NULL,           -- dm: 接收人; lucky: NULL
    group_id       INTEGER DEFAULT NULL,           -- lucky: 所在群; dm: NULL
    type           TEXT NOT NULL,                  -- 'dm' | 'lucky'
    amount         INTEGER NOT NULL,               -- 总额
    count          INTEGER NOT NULL DEFAULT 1,     -- lucky 份数
    claimed_amount INTEGER NOT NULL DEFAULT 0,
    claimed_count  INTEGER NOT NULL DEFAULT 0,
    note           TEXT NOT NULL DEFAULT '',
    status         TEXT NOT NULL DEFAULT 'pending',-- pending / done / expired
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at     TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS payment_claims (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount     INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 转账流水: 人类互转 / 用户转 AI / AI 打赏掉落 均记录(供 AI 上下文与审计)
  CREATE TABLE IF NOT EXISTS transfers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount      INTEGER NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_transfers_pair ON transfers(sender_id, receiver_id);
`);

// ---------- AI 陪聊配置与机器人 ----------

db.exec(`
  -- 键值配置(ai_base_url / ai_api_key / ai_model / ai_enabled / ai_default_persona)
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- 陪聊机器人: user_id 对应一个 account_type='bot' 的用户账号(直接复用私信体系)
  -- API 配置由创建者自行上传; 计费: free / per_reply / subscription
  CREATE TABLE IF NOT EXISTS bots (
    user_id            INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    creator_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    persona            TEXT NOT NULL DEFAULT '',
    api_base_url       TEXT NOT NULL DEFAULT '',
    api_key            TEXT NOT NULL DEFAULT '',
    api_model          TEXT NOT NULL DEFAULT '',
    pricing_type       TEXT NOT NULL DEFAULT 'free',
    price_per_reply    INTEGER NOT NULL DEFAULT 0,
    subscription_price INTEGER NOT NULL DEFAULT 0,
    is_official        INTEGER NOT NULL DEFAULT 0,  -- 1=管理员上架的官方模型(API 由平台提供, 收入归平台)
    status             TEXT NOT NULL DEFAULT 'active',
    created_at         TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 陪聊订阅: 到期自动失效(服务端定时清理)
  CREATE TABLE IF NOT EXISTS bot_subs (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    bot_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    PRIMARY KEY (user_id, bot_id)
  );

  -- 股票市场: 随机波动模拟(每日 ±10% 涨跌停), 做市商买卖(买入增发/卖出注销)
  -- created_by: 创建者用户ID(用户上市)或管理员ID(官方); is_ai=1 表示 AI 机器人公司股票(AI 80% / 创建者 20%)
  CREATE TABLE IF NOT EXISTS stocks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    price      INTEGER NOT NULL DEFAULT 100,    -- 现价(CCB/股)
    prev_close INTEGER NOT NULL DEFAULT 100,    -- 昨收(每日涨跌停基准)
    volatility REAL NOT NULL DEFAULT 0.03,      -- 波动率(单跳幅度)
    shares_out INTEGER NOT NULL DEFAULT 10000,  -- 流通股数
    volume     INTEGER NOT NULL DEFAULT 0,      -- 累计成交量(股)
    created_by INTEGER NOT NULL,                -- 创建者(用户/管理员/AI 机器人本人)
    is_ai      INTEGER NOT NULL DEFAULT 0,      -- 1=AI 机器人公司股票
    enabled    INTEGER NOT NULL DEFAULT 1,      -- 1=交易中
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 持仓: 用户与 AI 机器人共用一张表
  -- avg_cost: 加权平均成本(CCB/股), 用于展示持仓盈亏
  CREATE TABLE IF NOT EXISTS stock_holdings (
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    stock_id INTEGER NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
    shares   INTEGER NOT NULL DEFAULT 0,
    avg_cost INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, stock_id)
  );

  -- 价格历史(供涨跌幅与走势图, 每只保留最近 48 条, 超出自动裁剪)
  CREATE TABLE IF NOT EXISTS stock_ticks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    stock_id   INTEGER NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
    price      INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 成交流水(审计 + 详情页展示)
  CREATE TABLE IF NOT EXISTS stock_trades (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    stock_id   INTEGER NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    side       TEXT NOT NULL,                   -- buy / sell
    shares     INTEGER NOT NULL,
    price      INTEGER NOT NULL,
    fee        INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 关注: 单向关注(不要求互粉), 联合主键防重复关注
  CREATE TABLE IF NOT EXISTS follows (
    follower_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    following_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (follower_id, following_id)
  );

  -- 通知: 帖子被点赞/评论/回复/打赏, 以及被关注
  -- type: like / comment / reply / tip / follow; ref_type: post / comment / user
  CREATE TABLE IF NOT EXISTS notifications (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- 接收人
    actor_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- 触发人
    type       TEXT NOT NULL,
    ref_type   TEXT NOT NULL DEFAULT 'post',
    ref_id     INTEGER DEFAULT NULL,
    content    TEXT NOT NULL DEFAULT '',
    is_read    INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 公告: 管理员发布, 展示在右侧栏公告卡片
  CREATE TABLE IF NOT EXISTS announcements (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    content    TEXT NOT NULL,
    active     INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id);
  CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);
  CREATE INDEX IF NOT EXISTS idx_announcements_active ON announcements(active, created_at);
`);

// 旧库迁移: 持仓成本价列(盈亏计算用)。ALTER 抛错说明列已存在, 静默忽略。
try {
  db.exec('ALTER TABLE stock_holdings ADD COLUMN avg_cost INTEGER NOT NULL DEFAULT 0');
} catch { /* 列已存在 */ }
// 存量持仓成本回填为当前价(视为发行时买入, 初始盈亏为 0); 表不存在时忽略
try {
  db.exec('UPDATE stock_holdings SET avg_cost = (SELECT price FROM stocks WHERE stocks.id = stock_holdings.stock_id) WHERE avg_cost = 0');
} catch { /* 表不存在 */ }

// ---------- 预编译语句 ----------

const stmts = {
  // 会话
  userBySession: db.prepare(`
    SELECT u.id, u.username, u.avatar, u.bio, u.is_admin, u.created_at,
           u.wallet, u.last_bonus_date, u.avatar_frame_css, u.chat_bubble_css,
           u.title, u.title_css, u.title_item_id,
           u.account_type, u.agent_verified, u.agent_intro,
           u.ban_until, u.mute_until
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.created_at > datetime('now', ?)
  `),
  insertSession: db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  pruneExpiredSessions: db.prepare('DELETE FROM sessions WHERE created_at <= datetime(\'now\', ?)'),

  // 用户
  userByUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
  allHumanUserIds: db.prepare("SELECT id FROM users WHERE account_type != 'bot'"),
  userById: db.prepare(`
    SELECT id, username, avatar, bio, is_admin, created_at, wallet,
           avatar_frame_css, chat_bubble_css, title, title_css, account_type, agent_verified,
           agent_intro, ban_until, mute_until
    FROM users WHERE id = ?
  `),
  insertUser: db.prepare(
    'INSERT INTO users (username, password_hash, salt, is_admin, account_type) VALUES (?, ?, ?, ?, ?)'
  ),
  updateUsername: db.prepare('UPDATE users SET username = ? WHERE id = ?'),
  updateBio: db.prepare('UPDATE users SET bio = ? WHERE id = ?'),
  updateAvatar: db.prepare('UPDATE users SET avatar = ? WHERE id = ?'),
  updatePassword: db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?'),
  updateIsAdmin: db.prepare('UPDATE users SET is_admin = ? WHERE id = ?'),
  userPostCount: db.prepare('SELECT COUNT(*) AS c FROM posts WHERE user_id = ?'),
  userCommentCount: db.prepare('SELECT COUNT(*) AS c FROM comments WHERE user_id = ?'),

  // CCB
  walletOf: db.prepare('SELECT wallet FROM users WHERE id = ?'),
  addWallet: db.prepare('UPDATE users SET wallet = wallet + ? WHERE id = ?'),
  setWallet: db.prepare('UPDATE users SET wallet = ? WHERE id = ?'),
  claimDailyBonus: db.prepare(
    'UPDATE users SET last_bonus_date = ?, wallet = wallet + ? WHERE id = ? AND last_bonus_date <> ?'
  ),

  // 处罚
  setBanUntil: db.prepare('UPDATE users SET ban_until = ? WHERE id = ?'),
  setMuteUntil: db.prepare('UPDATE users SET mute_until = ? WHERE id = ?'),
  clearExpiredBans: db.prepare(
    "UPDATE users SET ban_until = '' WHERE ban_until <> '' AND ban_until <> 'forever' AND ban_until <= datetime('now')"
  ),
  clearExpiredMutes: db.prepare(
    "UPDATE users SET mute_until = '' WHERE mute_until <> '' AND mute_until <= datetime('now')"
  ),

  // 装备样式
  updateFrameCss: db.prepare('UPDATE users SET avatar_frame_css = ? WHERE id = ?'),
  updateBubbleCss: db.prepare('UPDATE users SET chat_bubble_css = ? WHERE id = ?'),
  updateTitle: db.prepare('UPDATE users SET title = ?, title_css = ?, title_item_id = ? WHERE id = ?'),
  // Agent 认证
  setAgentVerified: db.prepare('UPDATE users SET agent_verified = ? WHERE id = ?'),
  setAgentIntro: db.prepare('UPDATE users SET agent_intro = ? WHERE id = ?'),
  listAgents: db.prepare(`
    SELECT id, username, avatar, account_type, agent_verified, agent_intro, created_at
    FROM users WHERE account_type = 'agent'
    ORDER BY CASE WHEN agent_verified = 0 THEN 0 WHEN agent_verified = -1 THEN 1 ELSE 2 END, id ASC
  `),

  // 订阅到期的头衔自动卸下(必须在删除过期 user_items 之前执行)
  clearExpiredTitles: db.prepare(`
    UPDATE users SET title = '', title_css = '', title_item_id = NULL
    WHERE title_item_id IS NOT NULL AND title_item_id IN (
      SELECT item_id FROM user_items
      WHERE expires_at IS NOT NULL AND expires_at <= datetime('now')
    )
  `),

  // 帖子
  insertPost: db.prepare('INSERT INTO posts (user_id, content, image) VALUES (?, ?, ?)'),
  postById: db.prepare('SELECT * FROM posts WHERE id = ?'),
  deletePost: db.prepare('DELETE FROM posts WHERE id = ? AND user_id = ?'),
  deletePostAdmin: db.prepare('DELETE FROM posts WHERE id = ?'),
  // 时间线: 附带作者头像框/点赞/评论/打赏信息(viewer 参数出现 2 次: liked_by_me 与 tipped_by_me)
  timeline: db.prepare(`
    SELECT p.id, p.content, p.image, p.created_at,
           u.id   AS author_id,
           u.username AS author,
           u.avatar   AS author_avatar,
           u.avatar_frame_css AS author_frame,
           u.account_type AS author_type,
           u.title  AS author_title,
           u.title_css AS author_title_css,
           COUNT(l.user_id) AS like_count,
           (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count,
           (SELECT COUNT(*) FROM tips t WHERE t.post_id = p.id) AS tip_count,
           EXISTS(SELECT 1 FROM likes l2 WHERE l2.post_id = p.id AND l2.user_id = ?) AS liked_by_me,
           EXISTS(SELECT 1 FROM tips t2 WHERE t2.post_id = p.id AND t2.user_id = ?) AS tipped_by_me
    FROM posts p
    JOIN users u ON u.id = p.user_id
    LEFT JOIN likes l ON l.post_id = p.id
    GROUP BY p.id
    ORDER BY p.id DESC
    LIMIT ? OFFSET ?
  `),
  timelineHot: db.prepare(`
    SELECT p.id, p.content, p.image, p.created_at,
           u.id   AS author_id,
           u.username AS author,
           u.avatar   AS author_avatar,
           u.avatar_frame_css AS author_frame,
           u.account_type AS author_type,
           u.title  AS author_title,
           u.title_css AS author_title_css,
           COUNT(l.user_id) AS like_count,
           (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count,
           (SELECT COUNT(*) FROM tips t WHERE t.post_id = p.id) AS tip_count,
           EXISTS(SELECT 1 FROM likes l2 WHERE l2.post_id = p.id AND l2.user_id = ?) AS liked_by_me,
           EXISTS(SELECT 1 FROM tips t2 WHERE t2.post_id = p.id AND t2.user_id = ?) AS tipped_by_me
    FROM posts p
    JOIN users u ON u.id = p.user_id
    LEFT JOIN likes l ON l.post_id = p.id
    GROUP BY p.id
    ORDER BY (COUNT(l.user_id)
               + 2 * (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id)
               + 5 * (SELECT COUNT(*) FROM tips t WHERE t.post_id = p.id))
             / (CAST((julianday('now') - julianday(p.created_at)) * 24 AS REAL) + 2) DESC,
             p.id DESC
    LIMIT ? OFFSET ?
  `),
  postsByUser: db.prepare(`
    SELECT p.id, p.content, p.image, p.created_at,
           u.id   AS author_id,
           u.username AS author,
           u.avatar   AS author_avatar,
           u.avatar_frame_css AS author_frame,
           u.account_type AS author_type,
           u.title  AS author_title,
           u.title_css AS author_title_css,
           COUNT(l.user_id) AS like_count,
           (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count,
           (SELECT COUNT(*) FROM tips t WHERE t.post_id = p.id) AS tip_count,
           EXISTS(SELECT 1 FROM likes l2 WHERE l2.post_id = p.id AND l2.user_id = ?) AS liked_by_me,
           EXISTS(SELECT 1 FROM tips t2 WHERE t2.post_id = p.id AND t2.user_id = ?) AS tipped_by_me
    FROM posts p
    JOIN users u ON u.id = p.user_id
    LEFT JOIN likes l ON l.post_id = p.id
    WHERE u.username = ?
    GROUP BY p.id
    ORDER BY p.id DESC
    LIMIT ? OFFSET ?
  `),

  // 评论(含回复树与点赞; parent_id 由 JS 组装)
  commentsByPost: db.prepare(`
    SELECT c.id, c.content, c.created_at, c.parent_id,
           u.id AS author_id, u.username AS author, u.avatar AS author_avatar,
           u.avatar_frame_css AS author_frame,
           u.account_type AS author_type,
           u.title  AS author_title,
           u.title_css AS author_title_css,
           COUNT(cl.user_id) AS like_count,
           EXISTS(SELECT 1 FROM comment_likes cl2 WHERE cl2.comment_id = c.id AND cl2.user_id = ?) AS liked_by_me
    FROM comments c
    JOIN users u ON u.id = c.user_id
    LEFT JOIN comment_likes cl ON cl.comment_id = c.id
    WHERE c.post_id = ?
    GROUP BY c.id
    ORDER BY c.id ASC
  `),
  insertComment: db.prepare(
    'INSERT INTO comments (post_id, user_id, content, parent_id) VALUES (?, ?, ?, ?)'
  ),
  commentById: db.prepare('SELECT * FROM comments WHERE id = ?'),
  deleteComment: db.prepare('DELETE FROM comments WHERE id = ? AND user_id = ?'),
  deleteCommentAdmin: db.prepare('DELETE FROM comments WHERE id = ?'),
  deleteReplies: db.prepare('DELETE FROM comments WHERE parent_id = ?'),
  hasCommentLike: db.prepare('SELECT 1 FROM comment_likes WHERE user_id = ? AND comment_id = ?'),
  insertCommentLike: db.prepare('INSERT OR IGNORE INTO comment_likes (user_id, comment_id) VALUES (?, ?)'),
  deleteCommentLike: db.prepare('DELETE FROM comment_likes WHERE user_id = ? AND comment_id = ?'),
  commentLikeCount: db.prepare('SELECT COUNT(*) AS c FROM comment_likes WHERE comment_id = ?'),

  // 点赞(带奖励领取)
  hasLiked: db.prepare('SELECT 1 FROM likes WHERE user_id = ? AND post_id = ?'),
  insertLike: db.prepare('INSERT OR IGNORE INTO likes (user_id, post_id) VALUES (?, ?)'),
  deleteLike: db.prepare('DELETE FROM likes WHERE user_id = ? AND post_id = ?'),
  likeCount: db.prepare('SELECT COUNT(*) AS c FROM likes WHERE post_id = ?'),
  claimLikeReward: db.prepare(
    'UPDATE likes SET rewarded = 1 WHERE post_id = ? AND user_id = ? AND rewarded = 0'
  ),

  // 打赏
  tipExists: db.prepare('SELECT 1 FROM tips WHERE post_id = ? AND user_id = ?'),
  insertTip: db.prepare('INSERT INTO tips (post_id, user_id, amount) VALUES (?, ?, ?)'),

  // 私信
  insertMessage: db.prepare(
    'INSERT INTO messages (sender_id, receiver_id, content, image, payment_id) VALUES (?, ?, ?, ?, ?)'
  ),
  conversations: db.prepare(`
    SELECT t.other_id,
           u.username AS other_username,
           u.avatar   AS other_avatar,
           u.avatar_frame_css AS other_frame,
           u.chat_bubble_css  AS other_bubble,
           u.title AS other_title, u.title_css AS other_title_css,
           u.account_type AS other_type, u.agent_verified AS other_verified,
           COALESCE(bo.is_official, 0) AS other_official,
           m.content  AS last_content,
           m.image    AS last_image,
           m.created_at AS last_at,
           m.sender_id  AS last_sender,
           COALESCE(un.unread, 0) AS unread
    FROM (
      SELECT CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END AS other_id,
             MAX(id) AS last_id
      FROM messages
      WHERE sender_id = ? OR receiver_id = ?
      GROUP BY other_id
    ) t
    JOIN messages m ON m.id = t.last_id
    JOIN users u ON u.id = t.other_id
    LEFT JOIN bots bo ON bo.user_id = u.id
    LEFT JOIN (
      SELECT sender_id AS other_id, COUNT(*) AS unread
      FROM messages
      WHERE receiver_id = ? AND is_read = 0
      GROUP BY sender_id
    ) un ON un.other_id = t.other_id
    ORDER BY m.id DESC
  `),
  messagesWith: db.prepare(`
    SELECT id, sender_id, receiver_id, content, image, payment_id, created_at
    FROM messages
    WHERE ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?))
      AND id > ?
    ORDER BY id ASC
  `),
  markRead: db.prepare(
    'UPDATE messages SET is_read = 1 WHERE sender_id = ? AND receiver_id = ? AND is_read = 0'
  ),
  unreadTotal: db.prepare('SELECT COUNT(*) AS c FROM messages WHERE receiver_id = ? AND is_read = 0'),
  adminConversations: db.prepare(`
    SELECT t.a, t.b, t.cnt,
           m.content AS last_content, m.image AS last_image,
           m.created_at AS last_at, m.sender_id AS last_sender,
           ua.username AS user_a, ub.username AS user_b
    FROM (
      SELECT MIN(sender_id, receiver_id) AS a, MAX(sender_id, receiver_id) AS b,
             MAX(id) AS last_id, COUNT(*) AS cnt
      FROM messages
      GROUP BY a, b
    ) t
    JOIN messages m ON m.id = t.last_id
    JOIN users ua ON ua.id = t.a
    JOIN users ub ON ub.id = t.b
    ORDER BY t.last_id DESC
  `),
  adminMessages: db.prepare(`
    SELECT m.id, m.sender_id, m.receiver_id, m.content, m.image, m.created_at,
           u.username AS sender_name
    FROM messages m JOIN users u ON u.id = m.sender_id
    WHERE (m.sender_id = ? AND m.receiver_id = ?) OR (m.sender_id = ? AND m.receiver_id = ?)
    ORDER BY m.id ASC
  `),

  // 商店
  itemById: db.prepare('SELECT * FROM items WHERE id = ?'),
  itemsActive: db.prepare(
    "SELECT * FROM items WHERE status = 'active' AND (type = ? OR ? = '') ORDER BY id DESC"
  ),
  itemsAll: db.prepare('SELECT * FROM items ORDER BY id DESC'),
  insertItem: db.prepare(`
    INSERT INTO items (name, type, price, monthly_price, data, file_name, file_size, file_id, seller_id, deposit)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  disableItem: db.prepare("UPDATE items SET status = 'disabled' WHERE id = ?"),
  enableItem: db.prepare("UPDATE items SET status = 'active' WHERE id = ?"),
  // 管理员快速调整商品字段: 传 null 的字段保持原值(COALESCE)
  updateItemFields: db.prepare(`
    UPDATE items SET name = COALESCE(?, name), price = COALESCE(?, price),
                      monthly_price = COALESCE(?, monthly_price)
    WHERE id = ?
  `),
  itemsBySeller: db.prepare('SELECT * FROM items WHERE seller_id = ? ORDER BY id DESC'),
  itemByFileId: db.prepare('SELECT 1 FROM items WHERE file_id = ?'),
  incrementSales: db.prepare('UPDATE items SET sales = sales + 1 WHERE id = ?'),
  userItemsOwned: db.prepare(`
    SELECT ui.item_id, ui.mode, ui.expires_at, ui.acquired_at,
           i.name, i.type, i.data, i.price, i.monthly_price, i.file_name, i.file_size,
           i.seller_id, i.status
    FROM user_items ui
    JOIN items i ON i.id = ui.item_id
    WHERE ui.user_id = ? AND (ui.expires_at IS NULL OR ui.expires_at > datetime('now'))
    ORDER BY ui.acquired_at DESC
  `),
  hasActiveItem: db.prepare(`
    SELECT 1 FROM user_items
    WHERE user_id = ? AND item_id = ? AND (expires_at IS NULL OR expires_at > datetime('now'))
  `),
  insertUserItem: db.prepare(
    'INSERT OR IGNORE INTO user_items (user_id, item_id, mode, expires_at) VALUES (?, ?, ?, ?)'
  ),
  setItemLimited: db.prepare('UPDATE items SET limited = ? WHERE id = ?'),
  setItemLimitedConds: db.prepare('UPDATE items SET limited_conds = ? WHERE id = ?'),
  limitedItemsNotOwned: db.prepare(`
    SELECT i.id, i.name, i.limited_conds FROM items i
    WHERE i.limited = 1 AND i.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM user_items ui WHERE ui.user_id = ? AND ui.item_id = i.id)
    ORDER BY i.id
  `),
  pruneExpiredItems: db.prepare(
    'DELETE FROM user_items WHERE expires_at IS NOT NULL AND expires_at <= datetime(\'now\')'
  ),

  // 工单
  insertTicket: db.prepare(
    'INSERT INTO tickets (user_id, subject, body) VALUES (?, ?, ?)'
  ),
  ticketsByUser: db.prepare(`
    SELECT t.id, t.subject, t.body, t.status, t.admin_reply, t.created_at, t.updated_at
    FROM tickets t WHERE t.user_id = ? ORDER BY t.id DESC
  `),
  ticketById: db.prepare('SELECT * FROM tickets WHERE id = ?'),
  allTickets: db.prepare(`
    SELECT t.id, t.user_id, t.subject, t.body, t.status, t.admin_reply, t.created_at, t.updated_at,
           u.username
    FROM tickets t JOIN users u ON u.id = t.user_id
    ORDER BY CASE WHEN t.status = 'open' THEN 0 ELSE 1 END, t.id DESC
  `),
  replyTicket: db.prepare(`
    UPDATE tickets SET admin_reply = ?, status = 'closed', updated_at = datetime('now') WHERE id = ?
  `),

  // 举报
  insertReport: db.prepare(
    'INSERT INTO reports (reporter_id, target_type, target_id, reason) VALUES (?, ?, ?, ?)'
  ),
  pendingReportExists: db.prepare(
    "SELECT 1 FROM reports WHERE reporter_id = ? AND target_type = ? AND target_id = ? AND status = 'pending'"
  ),
  reportById: db.prepare('SELECT * FROM reports WHERE id = ?'),
  reportsAll: db.prepare(`
    SELECT r.id, r.reporter_id, r.target_type, r.target_id, r.reason, r.status,
           r.admin_note, r.created_at, r.handled_at,
           u.username AS reporter_name
    FROM reports r JOIN users u ON u.id = r.reporter_id
    ORDER BY CASE WHEN r.status = 'pending' THEN 0 ELSE 1 END, r.id DESC
  `),
  resolveReport: db.prepare(`
    UPDATE reports SET status = 'resolved', admin_note = ?, handled_at = datetime('now') WHERE id = ?
  `),

  // 用户列表 / 搜索
  recentUsers: db.prepare(
    "SELECT id, username, avatar, avatar_frame_css, title, title_css FROM users WHERE account_type <> 'bot' ORDER BY id DESC LIMIT ?"
  ),
  listUsers: db.prepare(`
    SELECT id, username, avatar, bio, is_admin, created_at, wallet, ban_until, mute_until,
           account_type, agent_verified, title, title_css,
           (SELECT COUNT(*) FROM posts p WHERE p.user_id = users.id) AS post_count,
           (SELECT COUNT(*) FROM comments c WHERE c.user_id = users.id) AS comment_count
    FROM users
    WHERE username LIKE ? ESCAPE '\\'
    ORDER BY id ASC
  `),
  searchUsers: db.prepare(`
    SELECT id, username, avatar, avatar_frame_css, title, title_css, account_type, created_at
    FROM users WHERE username LIKE ? ESCAPE '\\'
    ORDER BY id LIMIT ?
  `),
  searchPosts: db.prepare(`
    SELECT p.id, p.content, p.image, p.created_at,
           u.id   AS author_id,
           u.username AS author,
           u.avatar   AS author_avatar,
           u.avatar_frame_css AS author_frame,
           u.account_type AS author_type,
           u.title  AS author_title,
           u.title_css AS author_title_css,
           COUNT(l.user_id) AS like_count,
           (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count,
           (SELECT COUNT(*) FROM tips t WHERE t.post_id = p.id) AS tip_count,
           EXISTS(SELECT 1 FROM likes l2 WHERE l2.post_id = p.id AND l2.user_id = ?) AS liked_by_me,
           EXISTS(SELECT 1 FROM tips t2 WHERE t2.post_id = p.id AND t2.user_id = ?) AS tipped_by_me
    FROM posts p
    JOIN users u ON u.id = p.user_id
    LEFT JOIN likes l ON l.post_id = p.id
    WHERE p.content LIKE ? ESCAPE '\\'
    GROUP BY p.id
    ORDER BY p.id DESC
    LIMIT ?
  `),
  // AI 陪聊
  getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  setSetting: db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'),
  botByUserId: db.prepare('SELECT * FROM bots WHERE user_id = ?'),
  insertBot: db.prepare('INSERT INTO bots (user_id, creator_id, persona) VALUES (?, ?, ?)'),
  updateBotConfig: db.prepare(`
    UPDATE bots SET api_base_url = ?, api_key = ?, api_model = ?,
                    pricing_type = ?, price_per_reply = ?, subscription_price = ?
    WHERE user_id = ?
  `),
  updateBotPersona: db.prepare('UPDATE bots SET persona = ? WHERE user_id = ?'),
  updateBotStatus: db.prepare('UPDATE bots SET status = ? WHERE user_id = ?'),
  updateBotOfficial: db.prepare('UPDATE bots SET is_official = ? WHERE user_id = ?'),
  botCountByCreator: db.prepare('SELECT COUNT(*) AS c FROM bots WHERE creator_id = ?'),
  botsAll: db.prepare(`
    SELECT b.*, u.username, u.avatar, u.avatar_frame_css, u.title, u.title_css,
           c.username AS creator_name
    FROM bots b
    JOIN users u ON u.id = b.user_id
    JOIN users c ON c.id = b.creator_id
    ORDER BY b.created_at DESC
  `),
  botsActive: db.prepare(`
    SELECT b.*, u.username, u.avatar, u.avatar_frame_css, u.title, u.title_css,
           c.username AS creator_name
    FROM bots b
    JOIN users u ON u.id = b.user_id
    JOIN users c ON c.id = b.creator_id
    WHERE b.status = 'active'
    ORDER BY b.created_at DESC
  `),
  // 机器人记忆与转账流水
  getBotMemory: db.prepare('SELECT memory FROM bot_memories WHERE bot_id = ? AND user_id = ?'),
  setBotMemory: db.prepare(`
    INSERT INTO bot_memories (bot_id, user_id, memory, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(bot_id, user_id) DO UPDATE SET memory = excluded.memory, updated_at = datetime('now')
  `),
  clearBotMemory: db.prepare('DELETE FROM bot_memories WHERE bot_id = ? AND user_id = ?'),
  insertTransfer: db.prepare('INSERT INTO transfers (sender_id, receiver_id, amount) VALUES (?, ?, ?)'),
  transfersBetween: db.prepare(`
    SELECT sender_id, receiver_id, amount, created_at FROM transfers
    WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
    ORDER BY id DESC LIMIT ?
  `),

  // 关注
  insertFollow: db.prepare('INSERT OR IGNORE INTO follows (follower_id, following_id) VALUES (?, ?)'),
  deleteFollow: db.prepare('DELETE FROM follows WHERE follower_id = ? AND following_id = ?'),
  isFollowing: db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?'),
  followerCountOf: db.prepare('SELECT COUNT(*) AS c FROM follows WHERE following_id = ?'),
  followingCountOf: db.prepare('SELECT COUNT(*) AS c FROM follows WHERE follower_id = ?'),
  listFollowing: db.prepare(`
    SELECT u.id, u.username, u.avatar, u.avatar_frame_css, u.title, u.title_css,
           u.account_type, u.agent_verified, f.created_at
    FROM follows f JOIN users u ON u.id = f.following_id
    WHERE f.follower_id = ? ORDER BY f.created_at DESC
  `),
  listFollowers: db.prepare(`
    SELECT u.id, u.username, u.avatar, u.avatar_frame_css, u.title, u.title_css,
           u.account_type, u.agent_verified, f.created_at
    FROM follows f JOIN users u ON u.id = f.follower_id
    WHERE f.following_id = ? ORDER BY f.created_at DESC
  `),

  // 通知
  insertNotification: db.prepare(
    'INSERT INTO notifications (user_id, actor_id, type, ref_type, ref_id, content) VALUES (?, ?, ?, ?, ?, ?)'
  ),
  notificationsByUser: db.prepare(`
    SELECT n.id, n.type, n.ref_type, n.ref_id, n.content, n.is_read, n.created_at,
           u.username AS actor_name, u.avatar AS actor_avatar, u.account_type AS actor_type,
           u.avatar_frame_css AS actor_frame
    FROM notifications n
    JOIN users u ON u.id = n.actor_id
    WHERE n.user_id = ?
    ORDER BY n.id DESC LIMIT ?
  `),
  unreadNotificationCount: db.prepare(
    'SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND is_read = 0'
  ),
  markAllNotificationsRead: db.prepare(
    'UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0'
  ),
  pruneNotifications: db.prepare(
    "DELETE FROM notifications WHERE id IN (SELECT id FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT -1 OFFSET 100)"
  ),

  // 公告
  insertAnnouncement: db.prepare('INSERT INTO announcements (content) VALUES (?)'),
  activeAnnouncements: db.prepare(`
    SELECT id, content, created_at FROM announcements
    WHERE active = 1 ORDER BY id DESC LIMIT ?
  `),
  allAnnouncements: db.prepare('SELECT id, content, active, created_at FROM announcements ORDER BY id DESC'),
  disableAnnouncement: db.prepare('UPDATE announcements SET active = 0 WHERE id = ?'),
  enableAnnouncement: db.prepare('UPDATE announcements SET active = 1 WHERE id = ?'),
  deleteAnnouncement: db.prepare('DELETE FROM announcements WHERE id = ?'),
  announcementById: db.prepare('SELECT * FROM announcements WHERE id = ?'),
  // 防刷屏: 统计某条评论所在线程中机器人的评论数(含根与直接回复)
  botCommentsInThread: db.prepare(`
    SELECT COUNT(*) AS c FROM comments
    WHERE user_id = ?
      AND (id = (SELECT COALESCE(parent_id, id) FROM comments WHERE id = ?)
           OR parent_id = (SELECT COALESCE(parent_id, id) FROM comments WHERE id = ?))
  `),
  // 自动互动: 评论了机器人帖子的评论/回复了机器人评论的评论(尚无机器人回复)
  commentsToReply: db.prepare(`
    SELECT c.id, c.post_id, c.user_id, c.content FROM comments c
    JOIN posts p ON p.id = c.post_id
    WHERE ((p.user_id = ? AND c.user_id <> ?)
           OR c.parent_id IN (SELECT id FROM comments WHERE user_id = ?))
      AND NOT EXISTS (SELECT 1 FROM comments b WHERE b.parent_id = c.id AND b.user_id = ?)
    ORDER BY c.id DESC LIMIT ?
  `),
  // 自动互动: 最近没有机器人评论的帖子(从中挑一些回复)
  postsToCommentOn: db.prepare(`
    SELECT p.id, p.content, p.user_id, p.image FROM posts p
    WHERE p.user_id <> ?
      AND NOT EXISTS (SELECT 1 FROM comments b WHERE b.post_id = p.id AND b.user_id = ?)
    ORDER BY p.id DESC LIMIT ?
  `),
  // 订阅
  hasActiveBotSub: db.prepare(`
    SELECT 1 FROM bot_subs
    WHERE user_id = ? AND bot_id = ? AND expires_at > datetime('now')
  `),
  setBotSub: db.prepare(
    'INSERT OR REPLACE INTO bot_subs (user_id, bot_id, expires_at) VALUES (?, ?, ?)'
  ),
  pruneExpiredSubs: db.prepare(
    'DELETE FROM bot_subs WHERE expires_at <= datetime(\'now\')'
  ),

  // 股票
  stocksActive: db.prepare('SELECT * FROM stocks WHERE enabled = 1 ORDER BY id'),
  stockById: db.prepare('SELECT * FROM stocks WHERE id = ?'),
  stockByName: db.prepare('SELECT * FROM stocks WHERE name = ?'),
  stockCountAll: db.prepare('SELECT COUNT(*) AS c FROM stocks'),
  aiStockOfBot: db.prepare('SELECT * FROM stocks WHERE created_by = ? AND is_ai = 1 LIMIT 1'),
  stocksByCreator: db.prepare('SELECT COUNT(*) AS c FROM stocks WHERE created_by = ? AND is_ai = 0'),
  insertStock: db.prepare(
    'INSERT INTO stocks (name, price, prev_close, volatility, created_by, is_ai) VALUES (?, ?, ?, ?, ?, ?)'
  ),
  updateStockPrice: db.prepare('UPDATE stocks SET price = ? WHERE id = ?'),
  setStockPrevClose: db.prepare('UPDATE stocks SET prev_close = ? WHERE id = ?'),
  setStockSharesOut: db.prepare('UPDATE stocks SET shares_out = ? WHERE id = ?'),
  addStockVolume: db.prepare('UPDATE stocks SET volume = volume + ? WHERE id = ?'),
  setStockEnabled: db.prepare('UPDATE stocks SET enabled = ? WHERE id = ?'),
  holdingOf: db.prepare('SELECT shares FROM stock_holdings WHERE user_id = ? AND stock_id = ?'),
  holdingAvg: db.prepare('SELECT avg_cost FROM stock_holdings WHERE user_id = ? AND stock_id = ?'),
  setHolding: db.prepare(
    'INSERT INTO stock_holdings (user_id, stock_id, shares, avg_cost) VALUES (?, ?, ?, ?) '
    + 'ON CONFLICT(user_id, stock_id) DO UPDATE SET shares = excluded.shares, avg_cost = excluded.avg_cost'
  ),
  deleteHolding: db.prepare('DELETE FROM stock_holdings WHERE user_id = ? AND stock_id = ?'),
  holdingsAllOfUser: db.prepare(`
    SELECT h.stock_id, h.shares, h.avg_cost, s.name, s.price
    FROM stock_holdings h JOIN stocks s ON s.id = h.stock_id
    WHERE h.user_id = ? AND h.shares > 0
    ORDER BY h.shares * s.price DESC
  `),
  insertTick: db.prepare('INSERT INTO stock_ticks (stock_id, price) VALUES (?, ?)'),
  ticksRecent: db.prepare(
    'SELECT price FROM stock_ticks WHERE stock_id = ? ORDER BY id DESC LIMIT ?'
  ),
  pruneTicks: db.prepare(`
    DELETE FROM stock_ticks WHERE stock_id = ? AND id <= (
      SELECT id FROM stock_ticks WHERE stock_id = ? ORDER BY id DESC LIMIT 1 OFFSET 48
    )
  `),
  insertTrade: db.prepare(
    'INSERT INTO stock_trades (stock_id, user_id, side, shares, price, fee) VALUES (?, ?, ?, ?, ?, ?)'
  ),
  tradesOfStock: db.prepare(`
    SELECT t.*, u.username FROM stock_trades t JOIN users u ON u.id = t.user_id
    WHERE t.stock_id = ? ORDER BY t.id DESC LIMIT ?
  `),

  // 群组
  insertGroup: db.prepare('INSERT INTO groups (name, owner_id) VALUES (?, ?)'),
  groupById: db.prepare('SELECT * FROM groups WHERE id = ?'),
  addGroupMember: db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)'),
  removeGroupMember: db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?'),
  isGroupMember: db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?'),
  groupMembers: db.prepare(`
    SELECT u.id, u.username, u.avatar, u.account_type, u.title, u.title_css, u.avatar_frame_css,
           gm.joined_at
    FROM group_members gm JOIN users u ON u.id = gm.user_id
    WHERE gm.group_id = ? ORDER BY gm.joined_at ASC
  `),
  myGroups: db.prepare(`
    SELECT g.id, g.name, g.owner_id, g.created_at,
           (SELECT COUNT(*) FROM group_members m2 WHERE m2.group_id = g.id) AS member_count,
           (SELECT COUNT(*) FROM group_messages m
              WHERE m.group_id = g.id
                AND m.id > COALESCE((SELECT last_read_id FROM group_reads
                                     WHERE group_id = g.id AND user_id = ?), 0)) AS unread,
           (SELECT content FROM group_messages m WHERE m.group_id = g.id ORDER BY m.id DESC LIMIT 1) AS last_content,
           (SELECT image FROM group_messages m WHERE m.group_id = g.id ORDER BY m.id DESC LIMIT 1) AS last_image,
           (SELECT MAX(id) FROM group_messages WHERE group_id = g.id) AS last_msg_id
    FROM groups g JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = ?
    ORDER BY g.id DESC
  `),
  insertGroupMessage: db.prepare(
    'INSERT INTO group_messages (group_id, sender_id, content, image, payment_id) VALUES (?, ?, ?, ?, ?)'
  ),
  groupMessagesAfter: db.prepare(`
    SELECT m.id, m.group_id, m.sender_id, m.content, m.image, m.payment_id, m.created_at,
           u.username AS sender_name, u.account_type AS sender_type,
           u.avatar_frame_css AS sender_frame, u.chat_bubble_css AS sender_bubble,
           u.title AS sender_title, u.title_css AS sender_title_css
    FROM group_messages m JOIN users u ON u.id = m.sender_id
    WHERE m.group_id = ? AND m.id > ?
    ORDER BY m.id ASC LIMIT ?
  `),
  groupMessageById: db.prepare('SELECT * FROM group_messages WHERE id = ?'),
  setGroupRead: db.prepare(`
    INSERT INTO group_reads (group_id, user_id, last_read_id) VALUES (?, ?, ?)
    ON CONFLICT(group_id, user_id) DO UPDATE SET last_read_id = excluded.last_read_id
  `),
  getGroupRead: db.prepare('SELECT last_read_id FROM group_reads WHERE group_id = ? AND user_id = ?'),
  deleteGroupMessages: db.prepare('DELETE FROM group_messages WHERE group_id = ?'),
  deleteGroupMembers: db.prepare('DELETE FROM group_members WHERE group_id = ?'),
  deleteGroupReads: db.prepare('DELETE FROM group_reads WHERE group_id = ?'),
  deleteGroupRow: db.prepare('DELETE FROM groups WHERE id = ?'),

  // 转账/红包(微信式手动领取)
  insertPayment: db.prepare(`
    INSERT INTO payments (sender_id, receiver_id, group_id, type, amount, count, note, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  paymentById: db.prepare('SELECT * FROM payments WHERE id = ?'),
  insertClaim: db.prepare('INSERT INTO payment_claims (payment_id, user_id, amount) VALUES (?, ?, ?)'),
  hasClaimed: db.prepare('SELECT 1 FROM payment_claims WHERE payment_id = ? AND user_id = ?'),
  claimsOfPayment: db.prepare(`
    SELECT c.amount, c.created_at, u.username
    FROM payment_claims c JOIN users u ON u.id = c.user_id
    WHERE c.payment_id = ? ORDER BY c.id ASC
  `),
  updatePaymentClaimed: db.prepare(
    'UPDATE payments SET claimed_amount = ?, claimed_count = ?, status = ? WHERE id = ?'
  ),
  expiredPendingPayments: db.prepare(
    "SELECT * FROM payments WHERE status = 'pending' AND expires_at <= datetime('now')"
  ),
  expirePayments: db.prepare(
    "UPDATE payments SET status = 'expired' WHERE status = 'pending' AND expires_at <= datetime('now')"
  ),

};
// ---------- 机器人记忆 / 转账流水 / 线程上下文 ----------

function getBotMemory(botId, userId) {
  const row = stmts.getBotMemory.get(botId, userId);
  return row ? row.memory : '';
}

function setBotMemory(botId, userId, memory) {
  stmts.setBotMemory.run(botId, userId, memory);
}

function clearBotMemory(botId, userId) {
  stmts.clearBotMemory.run(botId, userId);
}

/** 记录转账流水(人类转账与 AI 打赏共用) */
function recordTransfer(senderId, receiverId, amount) {
  stmts.insertTransfer.run(senderId, receiverId, amount);
}

/** 两人之间的转账记录(最近 N 条, 含双向) */
function getTransfersBetween(userId, otherId, limit) {
  return stmts.transfersBetween.all(userId, otherId, otherId, userId, limit);
}

// ---------- 关注 ----------

/** 关注用户(幂等); 返回是否新增 */
function followUser(followerId, followingId) {
  if (followerId === followingId) return false;
  return stmts.insertFollow.run(followerId, followingId).changes > 0;
}

/** 取消关注; 返回是否取消成功 */
function unfollowUser(followerId, followingId) {
  return stmts.deleteFollow.run(followerId, followingId).changes > 0;
}

/** 是否已关注 */
function isFollowing(followerId, followingId) {
  return !!stmts.isFollowing.get(followerId, followingId);
}

/** 关注数(我关注了谁) */
function getFollowingCount(userId) {
  return Number(stmts.followingCountOf.get(userId).c);
}

/** 粉丝数(谁关注了我) */
function getFollowerCount(userId) {
  return Number(stmts.followerCountOf.get(userId).c);
}

/** 我关注的人列表 */
function getFollowingList(userId) {
  return stmts.listFollowing.all(userId);
}

/** 我的粉丝列表 */
function getFollowersList(userId) {
  return stmts.listFollowers.all(userId);
}

// ---------- 通知 ----------

/** 创建通知(不通知自己) */
function createNotification(userId, actorId, type, refType, refId, content) {
  if (userId === actorId) return;
  stmts.insertNotification.run(userId, actorId, type, refType, refId, content);
  // 每个用户只保留最近 100 条, 超出裁剪
  try { stmts.pruneNotifications.run(userId); } catch { /* 忽略 */ }
}

/** 获取用户最近 N 条通知 */
function getNotifications(userId, limit = 50) {
  return stmts.notificationsByUser.all(userId, limit);
}

/** 未读通知数 */
function getUnreadNotificationCount(userId) {
  return Number(stmts.unreadNotificationCount.get(userId).c);
}

/** 全部标记已读 */
function markAllNotificationsRead(userId) {
  stmts.markAllNotificationsRead.run(userId);
}

// ---------- 公告 ----------

/** 发布公告(管理员) */
function createAnnouncement(content) {
  return Number(stmts.insertAnnouncement.run(content).lastInsertRowid);
}

/** 在售公告(最新 N 条) */
function getActiveAnnouncements(limit = 5) {
  return stmts.activeAnnouncements.all(limit);
}

/** 全部公告(管理页) */
function getAllAnnouncements() {
  return stmts.allAnnouncements.all();
}

/** 上/下架公告(active 1/0) */
function setAnnouncementActive(id, active) {
  if (!stmts.announcementById.get(id)) return false;
  if (active) stmts.enableAnnouncement.run(id);
  else stmts.disableAnnouncement.run(id);
  return true;
}

/** 删除公告 */
function deleteAnnouncement(id) {
  return stmts.deleteAnnouncement.run(id).changes > 0;
}

// ---------- AI 陪聊 ----------

function getSetting(key) {
  const row = stmts.getSetting.get(key);
  return row ? row.value : '';
}

function setSetting(key, value) {
  stmts.setSetting.run(key, value);
}

/**
 * 创建陪聊机器人: 先建 bot 用户账号, 再写入人设。
 * @param {string} name 机器人名称(即用户名)
 * @param {number} creatorId 创建者 ID
 * @param {string} persona 人设 prompt
 * @returns {number} 机器人用户 ID
 */
function createBot(name, creatorId, persona, apiBaseUrl, apiKey, apiModel, pricingType, pricePerReply, subscriptionPrice) {
  const botId = Number(stmts.insertUser.run(name, '', '', 0, 'bot').lastInsertRowid);
  stmts.insertBot.run(botId, creatorId, persona);
  stmts.updateBotConfig.run(
    apiBaseUrl, apiKey, apiModel, pricingType, pricePerReply, subscriptionPrice, botId
  );
  return botId;
}

function getBotByUserId(botId) {
  return stmts.botByUserId.get(botId) || null;
}

function updateBotPersona(botId, persona) {
  stmts.updateBotPersona.run(persona, botId);
}

function updateBotStatus(botId, status) {
  stmts.updateBotStatus.run(status, botId);
}

/**
 * 设置/取消官方模型标记(管理员上架的官方陪聊)。
 * @param {number} botId 机器人用户 ID
 * @param {number} val 0 或 1
 */
function updateBotOfficial(botId, val) {
  stmts.updateBotOfficial.run(val, botId);
}

function getBotCountByCreator(creatorId) {
  return Number(stmts.botCountByCreator.get(creatorId).c);
}

/**
 * 更新机器人的 API 配置与计费模式(空串字段表示保留原值, 用 COALESCE 语义处理)。
 */
function updateBotConfig(botId, cfg) {
  const cur = stmts.botByUserId.get(botId);
  stmts.updateBotConfig.run(
    cfg.api_base_url !== undefined ? cfg.api_base_url : cur.api_base_url,
    cfg.api_key !== undefined ? cfg.api_key : cur.api_key,
    cfg.api_model !== undefined ? cfg.api_model : cur.api_model,
    cfg.pricing_type !== undefined ? cfg.pricing_type : cur.pricing_type,
    cfg.price_per_reply !== undefined ? cfg.price_per_reply : cur.price_per_reply,
    cfg.subscription_price !== undefined ? cfg.subscription_price : cur.subscription_price,
    botId
  );
}

function hasActiveBotSub(userId, botId) {
  return !!stmts.hasActiveBotSub.get(userId, botId);
}

function setBotSub(userId, botId, expiresAt) {
  stmts.setBotSub.run(userId, botId, expiresAt);
}

function pruneExpiredSubs() {
  stmts.pruneExpiredSubs.run();
}

/**
 * 统计某条评论所在线程中机器人的评论数(线程根 = 最顶层评论)。
 * 用于限制机器人互相回复的深度, 防止无限对话链刷屏。
 * @param {number} botId 机器人 ID
 * @param {number} commentId 目标评论 ID
 * @returns {number} 机器人评论数
 */
function countBotCommentsInThread(botId, commentId) {
  return Number(stmts.botCommentsInThread.get(botId, commentId, commentId).c);
}

/** 自动互动: 待回复的评论(评论了机器人帖子 / 回复了机器人评论) */
function getCommentsToReply(botId, limit) {
  return stmts.commentsToReply.all(botId, botId, botId, botId, limit);
}

/** 自动互动: 最近没有机器人评论的帖子 */
function getPostsToCommentOn(botId, limit) {
  return stmts.postsToCommentOn.all(botId, botId, limit);
}

/** 全部陪聊(管理员用) */
function getBots() {
  return stmts.botsAll.all();
}

/** 在售/启用的陪聊(普通用户可见) */
function getActiveBots() {
  return stmts.botsActive.all();
}



// ---------- 会话 ----------

/**
 * 根据会话 token 查询用户(不含密码字段)。
 * @param {string} token 会话 token
 * @returns {object|null} 用户信息或 null
 */
/** 会话 token 哈希存储: DB 中只存 SHA-256(token), 泄露数据库也无法直接重放 cookie */
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function getUserBySession(token) {
  return stmts.userBySession.get(hashToken(token), `-${SESSION_TTL_DAYS} days`) || null;
}

function createSession(token, userId) {
  stmts.insertSession.run(hashToken(token), userId);
}

function deleteSession(token) {
  stmts.deleteSession.run(hashToken(token));
}

/** 物理清理已过期的会话(SESSION_TTL_DAYS 天前创建) */
function pruneExpiredSessions() {
  stmts.pruneExpiredSessions.run(`-${SESSION_TTL_DAYS} days`);
}

// ---------- 用户 ----------

function findUserByUsername(username) {
  return stmts.userByUsername.get(username) || null;
}

function getUserById(userId) {
  return stmts.userById.get(userId) || null;
}

/** 全部非 bot 用户 id(官方广播/群发私信用) */
function getAllHumanUserIds() {
  return stmts.allHumanUserIds.all().map((r) => r.id);
}

function createUser(username, passwordHash, salt, isAdmin = 0, accountType = 'human') {
  return Number(stmts.insertUser.run(username, passwordHash, salt, isAdmin, accountType).lastInsertRowid);
}

function updateUsername(userId, username) {
  stmts.updateUsername.run(username, userId);
}

function updateBio(userId, bio) {
  stmts.updateBio.run(bio, userId);
}

function updateAvatar(userId, filename) {
  stmts.updateAvatar.run(filename, userId);
}

function updatePassword(userId, passwordHash, salt) {
  stmts.updatePassword.run(passwordHash, salt, userId);
}

function updateIsAdmin(userId, isAdmin) {
  stmts.updateIsAdmin.run(isAdmin, userId);
}

// ---------- 用户删除(管理界面) ----------

/**
 * 事务内按依赖顺序级联删除一个用户及其全部关联数据。
 * 覆盖: 该用户创建的陪聊机器人(及其内容/股票)、自己的公司股票、帖子/评论/点赞/打赏、
 *       私信/转账/支付、群成员/群消息、关注/通知/会话、商店商品/工单/举报。
 * 注: 本库未开外键级联, 故逐表显式删除。
 * @param {number} userId 目标用户 ID
 */
const deleteUserTx = db.transaction((userId) => {
  const ids = [userId];
  // 该用户创建的陪聊机器人账号(user_id)并入删除集合
  const botRows = db.prepare('SELECT user_id FROM bots WHERE creator_id = ?').all(userId);
  for (const r of botRows) if (!ids.includes(r.user_id)) ids.push(r.user_id);
  const inQ = ids.map(() => '?').join(',');

  // 股票(用户自己 + 其机器人创建的): 先删行情/成交/持仓, 再删股票本体
  const stockIds = db.prepare(`SELECT id FROM stocks WHERE created_by IN (${inQ})`).all(...ids).map((r) => r.id);
  if (stockIds.length > 0) {
    const inS = stockIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM stock_trades WHERE stock_id IN (${inS})`).run(...stockIds);
    db.prepare(`DELETE FROM stock_ticks WHERE stock_id IN (${inS})`).run(...stockIds);
    db.prepare(`DELETE FROM stock_holdings WHERE stock_id IN (${inS})`).run(...stockIds);
    db.prepare(`DELETE FROM stocks WHERE id IN (${inS})`).run(...stockIds);
  }

  // 帖子及其互动(先删对帖子的打赏/点赞/评论, 再删帖子)
  const postIds = db.prepare(`SELECT id FROM posts WHERE user_id IN (${inQ})`).all(...ids).map((r) => r.id);
  if (postIds.length > 0) {
    const inP = postIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM tips WHERE post_id IN (${inP})`).run(...postIds);
    db.prepare(`DELETE FROM likes WHERE post_id IN (${inP})`).run(...postIds);
    db.prepare(`DELETE FROM comments WHERE post_id IN (${inP})`).run(...postIds);
    db.prepare(`DELETE FROM posts WHERE id IN (${inP})`).run(...postIds);
  }

  // 评论及其点赞
  const commentIds = db.prepare(`SELECT id FROM comments WHERE user_id IN (${inQ})`).all(...ids).map((r) => r.id);
  if (commentIds.length > 0) {
    const inC = commentIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM comment_likes WHERE comment_id IN (${inC})`).run(...commentIds);
  }
  db.prepare(`DELETE FROM comment_likes WHERE user_id IN (${inQ})`).run(...ids);
  db.prepare(`DELETE FROM likes WHERE user_id IN (${inQ})`).run(...ids);
  db.prepare(`DELETE FROM tips WHERE user_id IN (${inQ})`).run(...ids);
  db.prepare(`DELETE FROM comments WHERE user_id IN (${inQ})`).run(...ids);

  // 私信 / 转账 / 支付
  db.prepare(`DELETE FROM messages WHERE sender_id IN (${inQ}) OR receiver_id IN (${inQ})`).run(...ids, ...ids);
  db.prepare(`DELETE FROM transfers WHERE sender_id IN (${inQ}) OR receiver_id IN (${inQ})`).run(...ids, ...ids);
  const payIds = db.prepare(`SELECT id FROM payments WHERE sender_id IN (${inQ}) OR receiver_id IN (${inQ})`).all(...ids, ...ids).map((r) => r.id);
  if (payIds.length > 0) {
    const inPay = payIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM payment_claims WHERE payment_id IN (${inPay})`).run(...payIds);
    db.prepare(`DELETE FROM payments WHERE id IN (${inPay})`).run(...payIds);
  }

  // 群: 该用户创建的群整个删除(含成员/消息/已读); 作为成员的记录删除
  const groupIds = db.prepare(`SELECT id FROM groups WHERE owner_id IN (${inQ})`).all(...ids).map((r) => r.id);
  if (groupIds.length > 0) {
    const inG = groupIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM group_messages WHERE group_id IN (${inG})`).run(...groupIds);
    db.prepare(`DELETE FROM group_reads WHERE group_id IN (${inG})`).run(...groupIds);
    db.prepare(`DELETE FROM group_members WHERE group_id IN (${inG})`).run(...groupIds);
    db.prepare(`DELETE FROM groups WHERE id IN (${inG})`).run(...groupIds);
  }
  db.prepare(`DELETE FROM group_members WHERE user_id IN (${inQ})`).run(...ids);
  db.prepare(`DELETE FROM group_reads WHERE user_id IN (${inQ})`).run(...ids);
  db.prepare(`DELETE FROM group_messages WHERE sender_id IN (${inQ})`).run(...ids);

  // 关注 / 通知 / 会话
  db.prepare(`DELETE FROM follows WHERE follower_id IN (${inQ}) OR following_id IN (${inQ})`).run(...ids, ...ids);
  db.prepare(`DELETE FROM notifications WHERE user_id IN (${inQ}) OR actor_id IN (${inQ})`).run(...ids, ...ids);
  db.prepare(`DELETE FROM sessions WHERE user_id IN (${inQ})`).run(...ids);

  // 商店 / 工单 / 举报
  const itemIds = db.prepare(`SELECT id FROM items WHERE seller_id IN (${inQ})`).all(...ids).map((r) => r.id);
  if (itemIds.length > 0) {
    const inI = itemIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM user_items WHERE item_id IN (${inI})`).run(...itemIds);
    db.prepare(`DELETE FROM items WHERE id IN (${inI})`).run(...itemIds);
  }
  db.prepare(`DELETE FROM user_items WHERE user_id IN (${inQ})`).run(...ids);
  db.prepare(`DELETE FROM tickets WHERE user_id IN (${inQ})`).run(...ids);
  db.prepare(`DELETE FROM reports WHERE reporter_id IN (${inQ}) OR (target_type IN ('user','shop') AND target_id IN (${inQ}))`).run(...ids, ...ids);

  // 陪聊机器人行 + 其订阅/记忆
  db.prepare(`DELETE FROM bot_subs WHERE user_id IN (${inQ}) OR bot_id IN (${inQ})`).run(...ids, ...ids);
  db.prepare(`DELETE FROM bot_memories WHERE user_id IN (${inQ}) OR bot_id IN (${inQ})`).run(...ids, ...ids);
  db.prepare(`DELETE FROM bots WHERE user_id IN (${inQ}) OR creator_id IN (${inQ})`).run(...ids, ...ids);

  // 本人
  db.prepare(`DELETE FROM users WHERE id IN (${inQ})`).run(...ids);
});

/** 删除用户及全部关联数据(事务); 返回受影响的行数(>0 表示删除成功) */
function deleteUser(userId) {
  if (!Number.isInteger(userId) || userId <= 0) return 0;
  const before = db.prepare('SELECT COUNT(*) c FROM users WHERE id = ?').get(userId).c;
  if (before === 0) return 0;
  deleteUserTx(userId);
  return db.prepare('SELECT COUNT(*) c FROM users WHERE id = ?').get(userId).c === 0 ? 1 : 0;
}

// ---------- CCB ----------

/**
 * 查询用户CCB余额。
 * @param {number} userId 用户 ID
 * @returns {number} 余额
 */
function getWallet(userId) {
  const row = stmts.walletOf.get(userId);
  return row ? Number(row.wallet) : 0;
}

/**
 * 增减CCB(增量可为负)。
 * @param {number} userId 用户 ID
 * @param {number} delta 变化量(正=收入, 负=支出)
 * @returns {number} 操作后余额
 */
function addWallet(userId, delta) {
  stmts.addWallet.run(delta, userId);
  return getWallet(userId);
}

/**
 * 直接设置余额(管理员调整)。
 * @param {number} userId 用户 ID
 * @param {number} amount 新余额
 */
function setWallet(userId, amount) {
  stmts.setWallet.run(amount, userId);
}

/**
 * 领取每日登录奖励(仅当今天未领过)。
 * @param {number} userId 用户 ID
 * @param {string} today UTC 日期(YYYY-MM-DD)
 * @param {number} amount 奖励金额
 * @returns {number|null} 新余额或 null(今天已领过)
 */
function claimDailyBonus(userId, today, amount) {
  const res = stmts.claimDailyBonus.run(today, amount, userId, today);
  return res.changes > 0 ? getWallet(userId) : null;
}

// ---------- 处罚 ----------

function setBanUntil(userId, until) {
  stmts.setBanUntil.run(until, userId);
}

function setMuteUntil(userId, until) {
  stmts.setMuteUntil.run(until, userId);
}

/** 清除已到期的封禁/禁言(幂等) */
function pruneExpiredPenalties() {
  stmts.clearExpiredBans.run();
  stmts.clearExpiredMutes.run();
}

// ---------- 装备 ----------

function updateFrameCss(userId, css) {
  stmts.updateFrameCss.run(css, userId);
}

function updateBubbleCss(userId, css) {
  stmts.updateBubbleCss.run(css, userId);
}

// ---------- Agent 认证 ----------

/**
 * 设置 Agent 认证状态。
 * @param {number} userId 用户 ID
 * @param {number} status 0=待认证 1=已认证 -1=拒绝
 */
function setAgentVerified(userId, status) {
  stmts.setAgentVerified.run(status, userId);
}

/**
 * 设置 Agent 认证自述。
 * @param {number} userId 用户 ID
 * @param {string} intro 自述文本
 */
function setAgentIntro(userId, intro) {
  stmts.setAgentIntro.run(intro, userId);
}

/**
 * 获取全部 Agent 账号(待认证排最前)。
 * @returns {object[]} Agent 列表
 */
function listAgents() {
  return stmts.listAgents.all();
}

/**
 * 装备/卸下头衔(卸下传空串与 null)。
 * @param {number} userId 用户 ID
 * @param {string} title 头衔文字
 * @param {string} css 头衔颜色(hex)
 * @param {number|null} itemId 来源商品 ID(订阅到期时据此卸下)
 */
function updateTitle(userId, title, css, itemId) {
  stmts.updateTitle.run(title, css, itemId, userId);
}

// ---------- 帖子 ----------

function createPost(userId, content, image = '') {
  return Number(stmts.insertPost.run(userId, content, image).lastInsertRowid);
}

/**
 * 官方 AI 批量广播: 每个 bot 发一条帖子 + 给每个收件人发一条私信(内容相同, 不调用 AI API)。
 * 事务保证全部成功或全部回滚。
 * @param {number[]} botIds 官方 AI 的 user_id 列表
 * @param {number[]} userIds 收件人(非 bot 用户) id 列表
 * @param {string} content 内容
 * @returns {{posts:number, messages:number}}
 */
const broadcastTx = db.transaction((botIds, userIds, content) => {
  let posts = 0, messages = 0;
  for (const botId of botIds) {
    createPost(botId, content, '');
    posts++;
    for (const uid of userIds) {
      if (uid === botId) continue;
      sendMessage(botId, uid, content, '');
      messages++;
    }
  }
  return { posts, messages };
});

function broadcastFromBots(botIds, userIds, content) {
  return broadcastTx(botIds, userIds, content);
}

function getPostById(postId) {
  return stmts.postById.get(postId) || null;
}

function deletePost(postId, userId, isAdmin = false) {
  if (isAdmin) return stmts.deletePostAdmin.run(postId).changes > 0;
  return stmts.deletePost.run(postId, userId).changes > 0;
}

function getTimeline(viewerId, sort, page, pageSize) {
  const offset = (page - 1) * pageSize;
  const stmt = sort === 'hot' ? stmts.timelineHot : stmts.timeline;
  return stmt.all(viewerId, viewerId, pageSize, offset);
}

/**
 * 获取用户主页(含钱包与头像框样式)。
 * @returns {object|null} { user, postCount, commentCount, posts } 或 null
 */
function getUserProfile(viewerId, username, page, pageSize) {
  const user = stmts.userByUsername.get(username);
  if (!user) return null;
  const offset = (page - 1) * pageSize;
  return {
    user: {
      id: user.id, username: user.username, avatar: user.avatar, bio: user.bio,
      wallet: user.wallet, avatar_frame_css: user.avatar_frame_css,
      chat_bubble_css: user.chat_bubble_css, title: user.title, title_css: user.title_css,
      account_type: user.account_type, agent_verified: user.agent_verified,
      created_at: user.created_at,
      following_count: getFollowingCount(user.id),
      follower_count: getFollowerCount(user.id),
      is_following: viewerId !== user.id && isFollowing(viewerId, user.id),
    },
    postCount: Number(stmts.userPostCount.get(user.id).c),
    commentCount: Number(stmts.userCommentCount.get(user.id).c),
    posts: stmts.postsByUser.all(viewerId, viewerId, username, pageSize, offset),
  };
}

// ---------- 评论 ----------

/**
 * 取某帖全部评论(含回复), 由 server.js 组装成树。
 * @param {number} postId 帖子 ID
 * @param {number} viewerId 浏览者 ID(计算 liked_by_me)
 * @returns {object[]} 评论行(含 parent_id / like_count / liked_by_me)
 */
function getComments(postId, viewerId) {
  return stmts.commentsByPost.all(viewerId, postId);
}

/**
 * 发表评论(可带 parent_id 回复)。
 * @param {number} postId 帖子 ID
 * @param {number} userId 评论者 ID
 * @param {string} content 内容
 * @param {number|null} parentId 父评论 ID(顶级传 null)
 * @returns {number} 新评论 ID
 */
function addComment(postId, userId, content, parentId = null) {
  return Number(stmts.insertComment.run(postId, userId, content, parentId).lastInsertRowid);
}

function getCommentById(commentId) {
  return stmts.commentById.get(commentId) || null;
}

/**
 * 删除评论(作者或管理员): 先删其下回复, 再删本体。
 * 评论点赞由 comment_likes 的外键 ON DELETE CASCADE 自动清理。
 * @returns {boolean} 是否删除成功
 */
function deleteComment(commentId, userId, isAdmin = false) {
  stmts.deleteReplies.run(commentId);
  if (isAdmin) return stmts.deleteCommentAdmin.run(commentId).changes > 0;
  return stmts.deleteComment.run(commentId, userId).changes > 0;
}

/**
 * 切换评论点赞。
 * @returns {object|null} { liked, likeCount } 或 null(评论不存在)
 */
function toggleCommentLike(userId, commentId) {
  if (!stmts.commentById.get(commentId)) return null;
  if (stmts.hasCommentLike.get(userId, commentId)) {
    stmts.deleteCommentLike.run(userId, commentId);
    return { liked: false, likeCount: Number(stmts.commentLikeCount.get(commentId).c) };
  }
  stmts.insertCommentLike.run(userId, commentId);
  return { liked: true, likeCount: Number(stmts.commentLikeCount.get(commentId).c) };
}

// ---------- 点赞(带作者奖励) ----------

/**
 * 切换帖子点赞。取消点赞无操作; 新增点赞时若作者非本人且未领过奖励,
 * 给作者发放 COIN_LIKE CCB(同一用户对同一帖只奖励一次)。
 * @returns {object|null} { liked, likeCount, reward } 或 null(帖子不存在)
 */
function toggleLike(userId, postId) {
  const post = stmts.postById.get(postId);
  if (!post) return null;
  if (stmts.hasLiked.get(userId, postId)) {
    stmts.deleteLike.run(userId, postId);
    return { liked: false, likeCount: Number(stmts.likeCount.get(postId).c), reward: 0 };
  }
  stmts.insertLike.run(userId, postId);
  let reward = 0;
  if (post.user_id !== userId) {
    const claimed = stmts.claimLikeReward.run(postId, userId);
    if (claimed.changes > 0) {
      reward = COIN_LIKE;
      addWallet(post.user_id, COIN_LIKE);
    }
  }
  return { liked: true, likeCount: Number(stmts.likeCount.get(postId).c), reward };
}

// ---------- 打赏 ----------

/**
 * 打赏帖子(每人对每帖一次, 由调用方保证CCB与去重)。
 * @param {number} postId 帖子 ID
 * @param {number} userId 打赏者 ID
 * @param {number} amount 金额
 * @returns {boolean} 是否成功(重复打赏返回 false)
 */
function tipPost(postId, userId, amount) {
  if (stmts.tipExists.get(postId, userId)) return false;
  stmts.insertTip.run(postId, userId, amount);
  return true;
}

// ---------- 私信 ----------

function sendMessage(senderId, receiverId, content, image = '', paymentId = null) {
  return Number(stmts.insertMessage.run(senderId, receiverId, content, image, paymentId).lastInsertRowid);
}

function getConversations(userId) {
  return stmts.conversations.all(userId, userId, userId, userId);
}

function getMessagesWith(userId, otherId, afterId) {
  return stmts.messagesWith.all(userId, otherId, otherId, userId, afterId);
}

function markMessagesRead(userId, otherId) {
  stmts.markRead.run(otherId, userId);
}

function getUnreadTotal(userId) {
  return Number(stmts.unreadTotal.get(userId).c);
}

function getAdminConversations() {
  return stmts.adminConversations.all();
}

function getAdminMessages(userAId, userBId) {
  return stmts.adminMessages.all(userAId, userBId, userBId, userAId);
}

// ---------- 商店 ----------

/**
 * 查询在售商品(可按类型过滤, 卖家过滤由 server.js 做, 数据量小)。
 * @param {string} type 类型(空串=全部)
 * @returns {object[]} 商品数组
 */
function getActiveItems(type) {
  return stmts.itemsActive.all(type, type || '');
}

function getAllItems() {
  return stmts.itemsAll.all();
}

function getItemById(itemId) {
  return stmts.itemById.get(itemId) || null;
}

/**
 * 创建商品。
 * @param {object} fields { name, type, price, monthly_price, data, file_name, file_size, file_id, seller_id, deposit }
 * @returns {number} 商品 ID
 */
function createItem(fields) {
  return Number(stmts.insertItem.run(
    fields.name, fields.type, fields.price, fields.monthly_price,
    fields.data, fields.file_name, fields.file_size, fields.file_id,
    fields.seller_id, fields.deposit
  ).lastInsertRowid);
}

function disableItem(itemId) {
  stmts.disableItem.run(itemId);
}

function enableItem(itemId) {
  stmts.enableItem.run(itemId);
}

/**
 * 管理员快速调整商品字段(名称/买断价/月订阅价), 未提供的字段保持不变。
 * @param {number} itemId 商品 ID
 * @param {object} fields { name?, price?, monthly_price? }
 */
function updateItem(itemId, fields) {
  stmts.updateItemFields.run(
    fields.name ?? null,
    fields.price ?? null,
    fields.monthly_price ?? null,
    itemId
  );
}

function getItemsBySeller(sellerId) {
  return stmts.itemsBySeller.all(sellerId);
}

function isFileIdUsed(fileId) {
  return !!stmts.itemByFileId.get(fileId);
}

function incrementSales(itemId) {
  stmts.incrementSales.run(itemId);
}

/**
 * 用户当前拥有的物品(买断永久 + 未过期订阅)。
 * @param {number} userId 用户 ID
 * @returns {object[]} 拥有记录(含商品信息)
 */
function getUserItems(userId) {
  return stmts.userItemsOwned.all(userId);
}

function hasActiveItem(userId, itemId) {
  return !!stmts.hasActiveItem.get(userId, itemId);
}

function insertUserItem(userId, itemId, mode, expiresAt) {
  stmts.insertUserItem.run(userId, itemId, mode, expiresAt);
}

/** 清理已过期的订阅物品(幂等, 在 /api/me 与登录时调用); 订阅头衔同步卸下 */
function pruneExpiredItems() {
  stmts.clearExpiredTitles.run();
  stmts.pruneExpiredItems.run();
}

/** 设置商品"限定发放"开关(1=登录自动领取, 商店隐藏, 不可购买) */
function setItemLimited(itemId, limited) {
  stmts.setItemLimited.run(limited ? 1 : 0, itemId);
}

/** 设置商品限定领取条件(JSON 字符串, 空=登录即领) */
function setItemLimitedConds(itemId, condsStr) {
  stmts.setItemLimitedConds.run(String(condsStr || ''), itemId);
}

/** 授予单个物品(任意商品, 含普通/限定/文件)。返回是否新发放(INSERT OR IGNORE, 已拥有返回 false) */
function grantItemToUser(userId, itemId) {
  return stmts.insertUserItem.run(userId, itemId, 'grant', null).changes > 0;
}

/**
 * 检查用户是否满足某限定物品的领取条件(列出的条件需全部满足)。
 * conds 为空串/空对象 = 无条件(登录即领)。条件: ccb / followers / posts / comments。
 */
function checkLimitedConditions(userId, condsStr) {
  if (!condsStr) return true;
  let conds;
  try { conds = JSON.parse(condsStr); } catch { return false; }
  if (!conds || typeof conds !== 'object' || Array.isArray(conds)) return true;
  if (Number(conds.ccb) > 0 && getWallet(userId) < Number(conds.ccb)) return false;
  if (Number(conds.followers) > 0 && getFollowerCount(userId) < Number(conds.followers)) return false;
  if (Number(conds.posts) > 0 && Number(stmts.userPostCount.get(userId).c) < Number(conds.posts)) return false;
  if (Number(conds.comments) > 0 && Number(stmts.userCommentCount.get(userId).c) < Number(conds.comments)) return false;
  return true;
}

/** 登录/注册时自动领取全部满足领取条件的 active 限定物品。返回本次新发放 [{itemId, name, conds}] */
function grantLimitedToUser(userId) {
  const rows = stmts.limitedItemsNotOwned.all(userId);
  const granted = [];
  for (const r of rows) {
    if (!checkLimitedConditions(userId, r.limited_conds)) continue;
    if (stmts.insertUserItem.run(userId, r.id, 'grant', null).changes > 0) {
      granted.push({ itemId: r.id, name: r.name, conds: r.limited_conds || '' });
    }
  }
  return granted;
}

// ---------- 工单 ----------

function createTicket(userId, subject, body) {
  return Number(stmts.insertTicket.run(userId, subject, body).lastInsertRowid);
}

function getTicketsByUser(userId) {
  return stmts.ticketsByUser.all(userId);
}

function getTicketById(ticketId) {
  return stmts.ticketById.get(ticketId) || null;
}

function getAllTickets() {
  return stmts.allTickets.all();
}

function replyTicket(ticketId, reply) {
  stmts.replyTicket.run(reply, ticketId);
}

// ---------- 举报 ----------

/**
 * 创建举报(同一举报人对同一对象只能有一条待处理举报)。
 * @returns {boolean} 是否成功(已有待处理举报返回 false)
 */
function createReport(reporterId, targetType, targetId, reason) {
  if (stmts.pendingReportExists.get(reporterId, targetType, targetId)) return false;
  stmts.insertReport.run(reporterId, targetType, targetId, reason);
  return true;
}

function getReportById(reportId) {
  return stmts.reportById.get(reportId) || null;
}

function getAllReports() {
  return stmts.reportsAll.all();
}

function resolveReport(reportId, note) {
  stmts.resolveReport.run(note, reportId);
}

// ---------- 列表 / 搜索 ----------

function listUsers(query) {
  return stmts.listUsers.all(`%${query}%`);
}

function search(viewerId, query, limit) {
  return {
    users: stmts.searchUsers.all(`%${query}%`, limit),
    posts: stmts.searchPosts.all(viewerId, viewerId, `%${query}%`, limit),
  };
}

function getRecentUsers(limit) {
  return stmts.recentUsers.all(limit);
}

// ---------- 股票 ----------

/** 全部在交易中的股票 */
function getActiveStocks() {
  return stmts.stocksActive.all();
}

function getStockById(stockId) {
  return stmts.stockById.get(stockId) || null;
}

function getStockByName(name) {
  return stmts.stockByName.get(name) || null;
}

/** 数据库中是否已有任何股票(用于首次启动预置官方股票) */
function hasAnyStock() {
  return Number(stmts.stockCountAll.get().c) > 0;
}

/** 某 AI 机器人的公司股票(没有返回 null) */
function getAiStockOfBot(botUserId) {
  return stmts.aiStockOfBot.get(botUserId) || null;
}

/** 某用户创建的非 AI 股票数量(用户上市上限用) */
function countStocksByCreator(creatorId) {
  return Number(stmts.stocksByCreator.get(creatorId).c);
}

/**
 * 创建股票(官方/用户上市/AI 公司共用)。
 * @param {object} fields { name, price, volatility, createdBy, isAi }
 * @returns {number} 股票 ID
 */
function createStock(fields) {
  return Number(stmts.insertStock.run(
    fields.name, fields.price, fields.price, fields.volatility,
    fields.createdBy, fields.isAi ? 1 : 0
  ).lastInsertRowid);
}

/** 更新现价(行情跳动) */
function updateStockPrice(stockId, price) {
  stmts.updateStockPrice.run(price, stockId);
}

/** 设置昨收(每日开盘时以昨收重置涨跌停基准) */
function setStockPrevClose(stockId, price) {
  stmts.setStockPrevClose.run(price, stockId);
}

/** 设置流通股数(买入增发/卖出注销时更新) */
function setStockSharesOut(stockId, sharesOut) {
  stmts.setStockSharesOut.run(sharesOut, stockId);
}

/** 成交量累加(买卖成交时) */
function addStockVolume(stockId, shares) {
  stmts.addStockVolume.run(shares, stockId);
}

/** 停牌/复牌 */
function setStockEnabled(stockId, enabled) {
  stmts.setStockEnabled.run(enabled ? 1 : 0, stockId);
}

/** 某用户对某股票的持仓股数(0 = 无持仓) */
function getHolding(userId, stockId) {
  const row = stmts.holdingOf.get(userId, stockId);
  return row ? Number(row.shares) : 0;
}

/** 某用户对某股票的加权平均成本(CCB/股, 无持仓返回 0) */
function getHoldingAvg(userId, stockId) {
  const row = stmts.holdingAvg.get(userId, stockId);
  return row ? Number(row.avg_cost) : 0;
}

/**
 * 直接设置持仓股数与成本(买入增发/卖出注销/初始分配共用)。
 * 卖出时 avgCost 传原值(成本不变); 买入时传加权平均新成本; 初始分配传发行价。
 */
function setHolding(userId, stockId, shares, avgCost = 0) {
  stmts.setHolding.run(userId, stockId, shares, avgCost);
}

/** 用户全部持仓(附股票名/现价/市值排序) */
function getUserHoldings(userId) {
  return stmts.holdingsAllOfUser.all(userId);
}

/** 记录一条价格历史(现价更新后调用) */
function insertTick(stockId, price) {
  stmts.insertTick.run(stockId, price);
  stmts.pruneTicks.run(stockId, stockId);
}

/** 最近 N 条价格历史(升序, 走势图/涨跌幅用) */
function getTicks(stockId, limit) {
  return stmts.ticksRecent.all(stockId, limit).reverse();
}

/** 记录一笔成交(买卖共用) */
function recordTrade(stockId, userId, side, shares, price, fee) {
  stmts.insertTrade.run(stockId, userId, side, shares, price, fee);
}

/**
 * 管理员转让自己已持有的股票给目标用户(事务)。
 * 管理员减仓成本不变(对齐 sellStock), 减到 0 删行;
 * 目标加权平均加仓(对齐 buyStock)。不写 stock_trades(该表按 buy/sell 渲染)。
 */
const transferStockTx = db.transaction((fromUserId, toUserId, stockId, shares) => {
  const cur = stmts.holdingOf.get(fromUserId, stockId);
  const curShares = cur ? Number(cur.shares) : 0;
  if (curShares < shares) return { ok: false, error: '你的持仓不足' };
  const adminAvg = curShares > 0 ? Number(stmts.holdingAvg.get(fromUserId, stockId).avg_cost) : 0;
  const remain = curShares - shares;
  if (remain === 0) stmts.deleteHolding.run(fromUserId, stockId);
  else stmts.setHolding.run(fromUserId, stockId, remain, adminAvg);
  const tgt = stmts.holdingOf.get(toUserId, stockId);
  const tgtShares = tgt ? Number(tgt.shares) : 0;
  const tgtAvg = tgtShares > 0 ? Number(stmts.holdingAvg.get(toUserId, stockId).avg_cost) : 0;
  const newShares = tgtShares + shares;
  const newAvg = tgtShares > 0
    ? Math.round((tgtShares * tgtAvg + shares * adminAvg) / newShares)
    : adminAvg;
  stmts.setHolding.run(toUserId, stockId, newShares, newAvg);
  return { ok: true, shares };
});

function transferStock(fromUserId, toUserId, stockId, shares) {
  return transferStockTx(fromUserId, toUserId, stockId, shares);
}

/** 某股票最近的成交流水(详情页展示) */
function getStockTrades(stockId, limit) {
  return stmts.tradesOfStock.all(stockId, limit);
}

// ---------- 群组 ----------

function createGroup(name, ownerId) {
  return Number(stmts.insertGroup.run(name, ownerId).lastInsertRowid);
}

function getGroupById(groupId) {
  return stmts.groupById.get(groupId) || null;
}

function addGroupMember(groupId, userId) {
  stmts.addGroupMember.run(groupId, userId);
}

function removeGroupMember(groupId, userId) {
  stmts.removeGroupMember.run(groupId, userId);
}

function isGroupMember(groupId, userId) {
  return !!stmts.isGroupMember.get(groupId, userId);
}

function getGroupMembers(groupId) {
  return stmts.groupMembers.all(groupId);
}

/** 我的群(含成员数/未读数/最后一条消息预览) */
function getMyGroups(userId) {
  return stmts.myGroups.all(userId, userId);
}

function sendGroupMessage(groupId, senderId, content, image = '', paymentId = null) {
  return Number(stmts.insertGroupMessage.run(groupId, senderId, content, image, paymentId).lastInsertRowid);
}

/** 群消息(增量拉取, 升序) */
function getGroupMessages(groupId, afterId, limit = 50) {
  return stmts.groupMessagesAfter.all(groupId, afterId, limit);
}

function getGroupMessageById(messageId) {
  return stmts.groupMessageById.get(messageId) || null;
}

/** 设置群已读游标 */
function setGroupRead(groupId, userId, lastReadId) {
  stmts.setGroupRead.run(groupId, userId, lastReadId);
}

/** 删除群(连同成员/消息/已读记录; 显式删除防外键未开启时的孤儿数据) */
function deleteGroup(groupId) {
  stmts.deleteGroupMessages.run(groupId);
  stmts.deleteGroupMembers.run(groupId);
  stmts.deleteGroupReads.run(groupId);
  stmts.deleteGroupRow.run(groupId);
}

// ---------- 转账/红包 ----------

/** 创建支付(dm 手动领取 / lucky 拼手气) */
function createPayment(fields) {
  return Number(stmts.insertPayment.run(
    fields.senderId, fields.receiverId || null, fields.groupId || null,
    fields.type, fields.amount, fields.count, fields.note, fields.expiresAt
  ).lastInsertRowid);
}

function getPaymentById(paymentId) {
  return stmts.paymentById.get(paymentId) || null;
}

function getPaymentClaims(paymentId) {
  return stmts.claimsOfPayment.all(paymentId);
}

function hasClaimedPayment(paymentId, userId) {
  return !!stmts.hasClaimed.get(paymentId, userId);
}

function addPaymentClaim(paymentId, userId, amount) {
  stmts.insertClaim.run(paymentId, userId, amount);
}

function updatePaymentClaimed(paymentId, claimedAmount, claimedCount, status) {
  stmts.updatePaymentClaimed.run(claimedAmount, claimedCount, status, paymentId);
}

/** 已过期未领取的支付(供服务端退款) */
function getExpiredPendingPayments() {
  return stmts.expiredPendingPayments.all();
}

/** 标记到期支付为已过期(退款由调用方执行) */
function expirePendingPayments() {
  stmts.expirePayments.run();
}

module.exports = {
  db,
  getSetting,
  setSetting,
  createBot,
  getBotByUserId,
  updateBotPersona,
  updateBotConfig,
  hasActiveBotSub,
  setBotSub,
  pruneExpiredSubs,
  getCommentsToReply,
  getPostsToCommentOn,
  getBotMemory,
  setBotMemory,
  clearBotMemory,
  recordTransfer,
  getTransfersBetween,
  countBotCommentsInThread,
  updateBotStatus,
  updateBotOfficial,
  getBotCountByCreator,
  getBots,
  getActiveBots,
  getUserBySession,
  createSession,
  deleteSession,
  pruneExpiredSessions,
  findUserByUsername,
  getUserById,
  getAllHumanUserIds,
  broadcastFromBots,
  createUser,
  updateUsername,
  updateBio,
  updateAvatar,
  updatePassword,
  updateIsAdmin,
  deleteUser,
  getWallet,
  addWallet,
  setWallet,
  claimDailyBonus,
  setBanUntil,
  setMuteUntil,
  pruneExpiredPenalties,
  updateFrameCss,
  updateBubbleCss,
  updateTitle,
  setAgentVerified,
  setAgentIntro,
  listAgents,
  createPost,
  getPostById,
  deletePost,
  getTimeline,
  getUserProfile,
  getComments,
  addComment,
  getCommentById,
  deleteComment,
  toggleCommentLike,
  toggleLike,
  tipPost,
  sendMessage,
  getConversations,
  getMessagesWith,
  markMessagesRead,
  getUnreadTotal,
  getAdminConversations,
  getAdminMessages,
  getActiveItems,
  getAllItems,
  getItemById,
  createItem,
  disableItem,
  enableItem,
  updateItem,
  getItemsBySeller,
  isFileIdUsed,
  incrementSales,
  getUserItems,
  hasActiveItem,
  insertUserItem,
  pruneExpiredItems,
  setItemLimited,
  setItemLimitedConds,
  checkLimitedConditions,
  grantItemToUser,
  grantLimitedToUser,
  createTicket,
  getTicketsByUser,
  getTicketById,
  getAllTickets,
  replyTicket,
  createReport,
  getReportById,
  getAllReports,
  resolveReport,
  listUsers,
  search,
  getRecentUsers,
  getActiveStocks,
  getStockById,
  getStockByName,
  hasAnyStock,
  getAiStockOfBot,
  countStocksByCreator,
  createStock,
  updateStockPrice,
  setStockPrevClose,
  setStockSharesOut,
  addStockVolume,
  setStockEnabled,
  getHolding,
  getHoldingAvg,
  setHolding,
  getUserHoldings,
  insertTick,
  getTicks,
  recordTrade,
  getStockTrades,
  transferStock,
  createGroup,
  getGroupById,
  addGroupMember,
  removeGroupMember,
  isGroupMember,
  getGroupMembers,
  getMyGroups,
  sendGroupMessage,
  getGroupMessages,
  getGroupMessageById,
  setGroupRead,
  deleteGroup,
  createPayment,
  getPaymentById,
  getPaymentClaims,
  hasClaimedPayment,
  addPaymentClaim,
  updatePaymentClaimed,
  getExpiredPendingPayments,
  expirePendingPayments,
  followUser,
  unfollowUser,
  isFollowing,
  getFollowingCount,
  getFollowerCount,
  getFollowingList,
  getFollowersList,
  createNotification,
  getNotifications,
  getUnreadNotificationCount,
  markAllNotificationsRead,
  createAnnouncement,
  getActiveAnnouncements,
  getAllAnnouncements,
  setAnnouncementActive,
  deleteAnnouncement,
};
