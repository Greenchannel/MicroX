/**
 * server.js — MicroX 服务端入口
 *
 * 作用:
 *   基于 Node.js 内置 http 模块的零依赖 HTTP 服务:
 *   - 托管 public/ 静态页面与 uploads/ 上传文件
 *   - 提供 /api/* JSON 接口: 账号/帖子/评论(回复)/点赞/打赏/私信/转账/
 *     商店(买断/订阅/押金/文件商品)/装备/工单/举报/处罚/搜索/管理
 *
 * 管理员:
 *   - 启动时自动创建 admin 账号, 每次启动重置密码并打印(见 ensureAdmin)
 *   - 可删任意帖子/评论、改任意用户(含CCB)、处理工单与举报、
 *     封禁/解封/禁言/解禁、官方商品上架/下架、查看全部私信
 *   - 管理接口服务端强制校验 is_admin
 *
 * 处罚执行:
 *   - 封禁(永久 'forever' / 按天): 禁止登录, 已有会话全部失效, 接口 403
 *   - 禁言(按天): 不能发帖/评论/私信, 其余操作正常
 *   - 到期自动解除(登录与 /api/me 时清理)
 *
 * CCB规则(服务端强校验, 无负余额):
 *   - 收入: 注册 100 / 每日登录 +20 / 发帖 +10 / 评论 +2 /
 *     帖子收到点赞 +2(每人每帖一次) / 收到打赏 / 商品售出
 *   - 支出: 转账 / 打赏(10/50/100) / 商店买断与订阅 / 摊位押金 100(下架退还)
 *
 * 安全要点:
 *   - 密码 scrypt 加盐哈希 + timingSafeEqual 防时序攻击
 *   - 会话为随机 token, HttpOnly + SameSite=Lax Cookie
 *   - 全部 SQL 参数化; 静态/上传文件路径归一化防目录穿越
 *   - 文件商品走原生字节流上传(≤512MB 边收边写, 不占内存)
 *   - 商品 CSS 片段拒绝 url( 与 <(防样式注入)
 */
'use strict';

const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const db = require('./db');
// 零依赖语义缓存(私信回复场景, 见 ai-cache.js): 提高 AI 陪聊缓存命中率
const semanticCache = require('./ai-cache');

// ---------- 配置 ----------

// 安全加固: 仅支持 HTTPS, 固定端口 25185(不提供明文 HTTP 回退)
const PORT = 25185;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');

// 兼容无法在托管面板设置环境变量的场景(如 Falix 免费版):
// 支持从根目录 falix.env 读取配置(ALLOW_HTTP/TRUST_PROXY), 面板环境变量优先。
// 用法: 在部署目录放一个 falix.env, 内容形如 ALLOW_HTTP=1 / TRUST_PROXY=1。
let envFile = {};
try {
  for (const line of fs.readFileSync(path.join(ROOT, 'falix.env'), 'utf8').split(/\r?\n/)) {
    const m = line.trim().match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m && m[1] !== '') envFile[m[1]] = m[2].trim();
  }
} catch { /* falix.env 不存在则忽略 */ }
const UPLOAD_DIR = path.join(ROOT, 'uploads');

// HTTPS 配置(强制): 需要 cert/key.pem + cert/cert.pem 证书文件
// (生成证书: 运行 node gen-cert.js)
const CERT_DIR = path.join(ROOT, 'cert');
const CERT_KEY = path.join(CERT_DIR, 'key.pem');
const CERT_FILE = path.join(CERT_DIR, 'cert.pem');
const HTTPS_ENABLED = fs.existsSync(CERT_KEY) && fs.existsSync(CERT_FILE);
// 反向代理(如 falix.me 等公网部署)时信任 X-Forwarded-For 以正确限速/记录客户端 IP
// 默认关闭: 局域网直连场景用 socket 真实地址更安全(防伪造 XFF 绕过限速)
const TRUST_PROXY = (process.env.TRUST_PROXY ?? envFile.TRUST_PROXY) === '1';
// ALLOW_HTTP=1: 允许无证书以明文 HTTP 启动。仅供 TLS 终结反向代理(如 Falix 面板免费 SSL)
// 后方使用——公网用户经面板 HTTPS 访问, Node 仅在内网收 HTTP。默认关闭:
// 直连场景仍强制 HTTPS(证书缺失即退出, 绝不降级为明文对外)。
const ALLOW_HTTP = (process.env.ALLOW_HTTP ?? envFile.ALLOW_HTTP) === '1';

const SESSION_COOKIE = 'mx_session';
const SESSION_MAX_AGE = 30 * 24 * 3600;
// JSON 请求体上限(图片 base64 上传用; 文件商品走独立流式接口)
const BODY_LIMIT = 8 * 1024 * 1024;
// 文件商品上限: 512MB
const FILE_UPLOAD_LIMIT = 512 * 1024 * 1024;
const AVATAR_MAX_BYTES = 1024 * 1024;
const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const AVATAR_MIMES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };

// 校验规则
const USERNAME_RE = /^[a-zA-Z0-9_\u4e00-\u9fa5]{2,20}$/;
const PASSWORD_MIN = 6;
const PASSWORD_MAX = 64;
const CONTENT_MAX = 280;
const BIO_MAX = 160;
const DM_MAX = 500;
const PAGE_SIZE = 20;
const SEARCH_LIMIT = 20;

// CCB规则
const COIN_POST = 10;
const COIN_COMMENT = 2;
const COIN_DAILY = 20;
const TIP_OPTIONS = [10, 50, 100];
const DEPOSIT = 100;      // 摊位押金
const SUB_DAYS = 30;      // 订阅时长(天)
const WALLET_MAX = 1e9;   // 钱包/金额上限

// 商品
const ITEM_TYPES = ['avatar_frame', 'chat_bubble', 'file'];
const CSS_MAX = 500;
const FILE_NAME_MAX = 100;

// 管理员种子账号: 用户名固定 MicroX; 密码每次启动时重置并打印(见 ensureAdmin)。
// 设置环境变量 ADMIN_PASSWORD 可固定密码; 未设置则每次随机生成。
const ADMIN_USERNAME = 'MicroX';

// Agent 行为规范(注册时展示并要求同意)
const AGENT_CODE = [
  '1. 透明声明: 不得冒充真人, 必须如实声明自己的 Agent 身份',
  '2. 诚实交流: 不伪造人类身份或编造个人经历误导他人',
  '3. 内容责任: 对生成的内容负责, 不传播虚假信息',
  '4. 尊重他人: 不恶意刷屏、骚扰或冒充其他用户',
  '5. 遵守规则: 与人类用户同等遵守社区规范与CCB规则',
  '6. 可追溯: 接受管理员审核, 违规行为将被撤销 Agent 认证',
];

// ---------- 安全加固: 通用响应头 / 输入清洗 / 速率限制 / SSRF 防护 ----------

/** 所有响应统一携带的安全头(防点击劫持/MIME 嗅探/信息外泄/降级攻击) */
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  // HSTS: 告知浏览器该域名未来一律走 HTTPS, 抵御 SSLStrip 降级攻击。
  // 浏览器仅在响应经 TLS 送达时才采纳此头, 故对 LAN 明文场景无害。
  'Strict-Transport-Security': 'max-age=31536000',
};

// CSP: 仅对 HTML 页面生效。脚本仅限同源(self), 内联样式保留(前端大量 style 属性),
// Google 字体/CDN 放行; frame-ancestors 'none' 进一步防点击劫持。
const CSP_HTML = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

/**
 * 纵深防御: 落库前剥离 HTML 尖括号与危险控制字符。
 * 前端 escapeHtml 已防注入, 此处兜底(第三方客户端/未来渲染入口也不可执行)。
 * @param {*} value 原始文本
 * @returns {string} 清洗后的文本
 */
function sanitizeText(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[<>]/g, '');
}

// 登录/注册暴力破解防护(内存; 服务重启后清零, 对局域网规模足够)
// 失败计数与突发计数分离存储, 避免互相覆盖
const rateStore = new Map();   // key -> { fails, windowStart, until }
// 每 IP 每日注册上限(防脚本批量刷号, 内存态重启清零)
const REG_DAILY_LIMIT = 5;
const regDaily = new Map();    // ip -> { date, count }
const burstStore = new Map();  // key -> number[] 时间戳数组
const RATE_MAX_FAILS_USER = 5;            // 按账号: 连续失败 5 次即锁定
const RATE_MAX_FAILS_IP = 20;             // 按 IP: 阈值放宽(防反向代理/NAT 共享 IP 误锁全站)
const IP_DISTINCT_USER_MAX = 6;           // 同一 IP 在窗口内对不同真实账号失败 ≥6 个 = 字典攻击, 立即锁 IP
const RATE_LOCK_MS = 15 * 60 * 1000;      // 锁定 15 分钟
const RATE_WINDOW_MS = 15 * 60 * 1000;    // 失败计数窗口
// 登录防爆破: ip -> Set<失败的真实用户名(小写)>, 用于识别"同 IP 换账号"的字典攻击
const loginIpUsers = new Map();

function rateKey(kind, id) {
  return `${kind}:${String(id).toLowerCase()}`;
}

/** 获取客户端 IP(仅在 TRUST_PROXY=1 时信任 X-Forwarded-For, 防伪造绕过) */
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (TRUST_PROXY && xff) return String(xff).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

/** 记录一次失败; 达到阈值即加锁(阈值由调用方按 IP/账号区分) */
function rateFail(kind, id, maxFails = RATE_MAX_FAILS_USER) {
  const key = rateKey(kind, id);
  const now = Date.now();
  const rec = rateStore.get(key) || { fails: 0, windowStart: now, until: 0 };
  if (now > rec.windowStart + RATE_WINDOW_MS) { rec.fails = 0; rec.windowStart = now; }
  rec.fails += 1;
  if (rec.fails >= maxFails) rec.until = now + RATE_LOCK_MS;
  rateStore.set(key, rec);
  return rec.fails >= maxFails;
}

/** 是否处于锁定状态(到期自动解除) */
function rateLocked(kind, id) {
  const key = rateKey(kind, id);
  const rec = rateStore.get(key);
  if (!rec) return false;
  if (rec.until && rec.until > Date.now()) return true;
  if (rec.until && rec.until <= Date.now()) rateStore.delete(key);
  return false;
}

/** 立即将某 id 加锁(用于识别出字典攻击等场景的主动锁) */
function rateForceLock(kind, id) {
  const key = rateKey(kind, id);
  const now = Date.now();
  const rec = rateStore.get(key) || { fails: 0, windowStart: now, until: 0 };
  rec.until = now + RATE_LOCK_MS;
  rateStore.set(key, rec);
}

/** 清理登录防爆破的 per-IP 用户集合(仅保留仍处于锁定/计数窗口内的 IP, 防无限增长) */
function purgeLoginIpUsers() {
  const now = Date.now();
  for (const [ip] of loginIpUsers) {
    const rec = rateStore.get(rateKey('login', ip));
    if (!rec || (rec.until && rec.until <= now && now > rec.windowStart + RATE_WINDOW_MS)) {
      loginIpUsers.delete(ip);
    }
  }
}

/** 成功后清除失败记录 */
function rateReset(kind, id) {
  rateStore.delete(rateKey(kind, id));
}

/** 突发频率限制(滑动窗口): 窗口内超过 max 次则拦截 */
function rateExceeded(kind, id, max, windowMs) {
  const key = `${kind}:${String(id).toLowerCase()}`;
  const now = Date.now();
  const arr = (burstStore.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { burstStore.set(key, arr); return true; }
  arr.push(now);
  burstStore.set(key, arr);
  return false;
}

// SSRF 防护: 仅允许公网 http(s), 拒绝回环/私网/链路本地/云元数据地址
const dns = require('node:dns');
const net = require('node:net');

/** 判断单个 IP 是否为私网/回环/链路本地/元数据地址(含 IPv4/IPv6) */
function isPrivateIp(ip) {
  const type = net.isIP(ip);
  if (type === 4) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts;
    return a === 0 || a === 10 || a === 127
      || (a === 100 && b >= 64 && b <= 127)   // CGNAT 共享地址
      || (a === 169 && b === 254)             // 链路本地(含 169.254.169.254 云元数据)
      || (a === 172 && b >= 16 && b <= 31)    // 私网
      || (a === 192 && b === 168);            // 私网
  }
  if (type === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('::ffff:')) return isPrivateIp(lower.slice('::ffff:'.length));
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7
    const v = parseInt(lower.split(':')[0], 16);
    // fe80::/10 链路本地
    if (v >= 0xfe80 && v <= 0xfebf) return true;
    if (lower.startsWith('2001:db8')) return true; // 文档地址
    return false;
  }
  return true; // 无法识别格式一律拒绝
}

/**
 * 校验出站接口地址是否安全: 必须 http(s) 且解析后的所有 IP 均为公网地址。
 * @param {string} rawUrl 机器人 api_base_url
 * @returns {Promise<boolean>} true=允许访问
 */
async function isSafeOutboundUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const hostname = u.hostname.replace(/^\[|\]$/g, '');
  try {
    const addrs = await dns.promises.lookup(hostname, { all: true, verbatim: true });
    if (addrs.length === 0) return false;
    return addrs.every((a) => !isPrivateIp(a.address));
  } catch {
    return false;
  }
}

/**
 * SSRF 校验封装(供 Bot 创建/编辑调用): 返回错误文案或 null。
 * @param {string} url 用户自定义 api_base_url
 * @returns {Promise<string|null>} null=安全
 */
async function assertSafeBotUrl(url) {
  if (!url) return null;
  if (!(await isSafeOutboundUrl(url))) {
    return '接口地址不允许指向内网/私网/本机地址(防 SSRF)';
  }
  return null;
}

// 上传存储配额(防磁盘耗尽 DoS): 每用户总配额 + 每日新增上限, 可用环境变量覆盖
const UPLOAD_USER_QUOTA = Number(process.env.UPLOAD_USER_QUOTA) || 1024 * 1024 * 1024;
const UPLOAD_DAILY_QUOTA = Number(process.env.UPLOAD_DAILY_QUOTA) || 100 * 1024 * 1024;
/** 上传用量记录(userId -> { total, day, dayBytes }) 内存态, 重启清零 */
const uploadUsage = new Map();

/** 检查用户上传是否超配额 */
function uploadQuotaExceeded(userId, addBytes) {
  const today = todayUtc();
  const rec = uploadUsage.get(userId) || { total: 0, day: '', dayBytes: 0 };
  if (rec.day !== today) { rec.day = today; rec.dayBytes = 0; }
  if (rec.total + addBytes > UPLOAD_USER_QUOTA || rec.dayBytes + addBytes > UPLOAD_DAILY_QUOTA) {
    return true;
  }
  rec.total += addBytes;
  rec.dayBytes += addBytes;
  uploadUsage.set(userId, rec);
  return false;
}

// 真人注册算术验证码(内存存储, 5 分钟过期)
const captchaStore = new Map();
// 验证码签发到提交的最小间隔(秒): 防脚本瞬间提交(真实人类输入至少需要 1.5 秒)
const CAPTCHA_MIN_MS = 1500;
// 验证码接口单 IP 刷新频率限制(10 分钟内最多 60 次)
const CAPTCHA_BURST_MAX = 60;
const CAPTCHA_BURST_WINDOW_MS = 10 * 60 * 1000;

function purgeCaptcha() {
  const now = Date.now();
  for (const [k, v] of captchaStore) {
    if (v.exp < now) captchaStore.delete(k);
  }
}

// ---------- SendCloud 邮件(注册邮箱验证) ----------

// 配置优先 process.env, 其次 falix.env(与 TRUST_PROXY 同模式)
const SENDCLOUD_API_USER = process.env.SENDCLOUD_API_USER ?? envFile.SENDCLOUD_API_USER ?? '';
const SENDCLOUD_API_KEY = process.env.SENDCLOUD_API_KEY ?? envFile.SENDCLOUD_API_KEY ?? '';
const SENDCLOUD_FROM = process.env.SENDCLOUD_FROM ?? envFile.SENDCLOUD_FROM ?? '';
const SENDCLOUD_FROM_NAME = process.env.SENDCLOUD_FROM_NAME ?? envFile.SENDCLOUD_FROM_NAME ?? 'MicroX';

/** 邮箱验证是否启用: 三个必填配置齐全才启用 */
function emailVerifyEnabled() {
  return Boolean(SENDCLOUD_API_USER && SENDCLOUD_API_KEY && SENDCLOUD_FROM);
}

/**
 * 调用 SendCloud 发送邮件(仅 Node 内置模块)。
 * POST https://api.sendcloud.net/apiv2/mail/send (application/x-www-form-urlencoded)
 * @returns {Promise<object>} 成功 resolve, 失败 reject
 */
function sendCloudMail(to, subject, html) {
  const apiUser = SENDCLOUD_API_USER;
  const apiKey = SENDCLOUD_API_KEY;
  const from = SENDCLOUD_FROM;
  if (!apiUser || !apiKey || !from) return Promise.reject(new Error('邮件服务未配置'));
  const body = new URLSearchParams({
    apiUser, apiKey, from, fromName: SENDCLOUD_FROM_NAME, to, subject, html,
  }).toString();
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.sendcloud.net',
      path: '/apiv2/mail/send',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.result === true) resolve(j);
          else reject(new Error(j.message || '邮件发送失败'));
        } catch { reject(new Error('邮件服务响应异常')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// 注册邮箱验证码(内存存储, 10 分钟过期)
const emailCodeStore = new Map(); // key=邮箱 -> { code, iat, exp, attempts }
const EMAIL_CODE_TTL_MS = 10 * 60 * 1000;          // 验证码有效期
const EMAIL_CODE_SEND_COOLDOWN_MS = 60 * 1000;     // 同一邮箱重发冷却
const EMAIL_CODE_DAILY_MAX = 5;                    // 同一邮箱每日最多发码次数
const EMAIL_CODE_ATTEMPTS_MAX = 5;                 // 同一验证码最多验证尝试次数
const EMAIL_CODE_BURST = 3;                        // 单 IP 每分钟最多发码次数
const EMAIL_CODE_BURST_WINDOW_MS = 60 * 1000;
const emailCodeDaily = new Map();                  // key=邮箱 -> { day, count }

function purgeEmailCodes() {
  const now = Date.now();
  for (const [k, v] of emailCodeStore) {
    if (v.exp < now) emailCodeStore.delete(k);
  }
}

/** 校验邮箱格式 */
function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 100;
}

/** 检查同一邮箱今日发码次数并记账 */
function emailCodeCanSend(email) {
  const day = todayUtc().slice(0, 10);
  const rec = emailCodeDaily.get(email) || { day, count: 0 };
  if (rec.day !== day) { rec.day = day; rec.count = 0; }
  if (rec.count >= EMAIL_CODE_DAILY_MAX) return false;
  rec.count += 1;
  emailCodeDaily.set(email, rec);
  return true;
}

/** 校验邮箱验证码(匹配/未过期/尝试次数), 成功即燃烧 */
function validateEmailCode(email, code) {
  const rec = emailCodeStore.get(email);
  if (!rec || Date.now() > rec.exp) return { ok: false, error: '验证码已过期，请重新获取' };
  if (rec.attempts >= EMAIL_CODE_ATTEMPTS_MAX) {
    emailCodeStore.delete(email);
    return { ok: false, error: '验证码错误次数过多，请重新获取' };
  }
  rec.attempts += 1;
  if (String(code).trim() !== rec.code) {
    if (rec.attempts >= EMAIL_CODE_ATTEMPTS_MAX) emailCodeStore.delete(email);
    return { ok: false, error: '验证码错误' };
  }
  emailCodeStore.delete(email);
  return { ok: true };
}

// 验证码 3×5 点阵字体(渲染为 <rect>, 响应不含可提取的算式文本 → 正则/eval 无法自动解算)
const CAPTCHA_FONT = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '001', '001', '001'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  '+': ['000', '010', '111', '010', '000'],
  '×': ['000', '101', '010', '101', '000'],
  '=': ['000', '111', '000', '111', '000'],
  '?': ['111', '001', '111', '010', '000'],
};

/** 渲染单个字符为点阵 <rect> 序列 */
function captchaCharSvg(ch, cell) {
  const pattern = CAPTCHA_FONT[ch];
  if (!pattern) return '';
  const rects = [];
  for (let r = 0; r < pattern.length; r++) {
    for (let c = 0; c < pattern[r].length; c++) {
      if (pattern[r][c] === '1') {
        rects.push('<rect x="' + (c * cell) + '" y="' + (r * cell) + '" width="' + (cell - 1) + '" height="' + (cell - 1) + '"/>');
      }
    }
  }
  return rects.join('');
}

/**
 * 生成验证码 SVG: 算式(如 3 × 5 = ?)以点阵矢量渲染。
 * 数字/符号均绘制为 <rect>, 无 <text> 明文 → 文本提取拿不到表达式, 只能 OCR(成本高)。
 * 答案仅存于服务端 captchaStore, 响应中不包含结果。
 * @returns {{ svg: string, answer: string }} answer 供调用方入内存库
 */
function buildCaptcha() {
  const rand255 = () => Math.floor(Math.random() * 256);
  const w = 172;
  const h = 58;
  const cell = 7;                       // 每点像素(含 1px 间距), 字形 21×35
  const charW = 3 * cell;
  const gap = 9;
  const parts = [];
  const lines = 3 + Math.floor(Math.random() * 2);
  for (let i = 0; i < lines; i++) {
    parts.push('<line x1="' + (Math.random() * w) + '" y1="' + (Math.random() * h) + '" x2="' + (Math.random() * w) + '" y2="' + (Math.random() * h) + '" stroke="rgba(' + rand255() + ',' + rand255() + ',' + rand255() + ',0.5)" stroke-width="' + (1 + Math.random() * 1.5).toFixed(1) + '" />');
  }
  for (let i = 0; i < 30; i++) {
    parts.push('<circle cx="' + (Math.random() * w) + '" cy="' + (Math.random() * h) + '" r="' + (0.5 + Math.random() * 1.6).toFixed(1) + '" fill="rgba(' + rand255() + ',' + rand255() + ',' + rand255() + ',0.6)" />');
  }
  // 算式: 2~12 两数相加/相乘, 便于用户口算
  const a = 2 + Math.floor(Math.random() * 11);
  const b = 2 + Math.floor(Math.random() * 11);
  const op = Math.random() < 0.5 ? '+' : '×';
  const answer = String(op === '+' ? a + b : a * b);
  // 每个字符独立分组: 随机旋转/垂直位移/颜色, 点阵无文本可提取
  const chars = [String(a), op, String(b), '=', '?'];
  let x = 10;
  for (const ch of chars) {
    const angle = (Math.random() - 0.5) * 26;
    const dy = (Math.random() - 0.5) * 6;
    const color = 'hsl(' + Math.floor(Math.random() * 360) + ',70%,50%)';
    parts.push('<g transform="translate(' + x.toFixed(1) + ' ' + (12 + dy).toFixed(1) + ') rotate(' + angle.toFixed(1) + ')" fill="' + color + '">' + captchaCharSvg(ch, cell) + '</g>');
    x += charW + gap + Math.random() * 4;
  }
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '"><rect width="100%" height="100%" fill="#f2f2f2"/>' + parts.join('') + '</svg>';
  return { answer, svg };
}

/** GET /api/captcha: 生成真人注册算术验证码(SVG 算式, 答案存服务端) */
function handleCaptcha(req, res) {
  // 单 IP 突发频率限制(防脚本循环拉取+爆破)
  if (rateExceeded('captcha', clientIp(req), CAPTCHA_BURST_MAX, CAPTCHA_BURST_WINDOW_MS)) {
    return fail(res, 429, '验证码刷新过于频繁，请稍后再试');
  }
  purgeCaptcha();
  const { answer, svg } = buildCaptcha();
  const token = crypto.randomBytes(8).toString('hex');
  captchaStore.set(token, { answer, iat: Date.now(), exp: Date.now() + 5 * 60 * 1000 });
  ok(res, { token, svg });
}


// 首次运行时自动创建上传目录
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// ---------- 时间工具 ----------

/** 当前 UTC 时间(与 SQLite datetime('now') 同格式, 可直接字符串比较) */
function nowUtc() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

/** 当前 UTC 日期(YYYY-MM-DD) */
function todayUtc() {
  return nowUtc().slice(0, 10);
}

/**
 * 若干天后的 UTC 时间(用于订阅到期/暂时封禁/禁言截止)。
 * @param {number} days 天数
 * @returns {string} UTC 时间串
 */
function addDaysUtc(days) {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 19).replace('T', ' ');
}

// ---------- 基础工具 ----------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
  });
  res.end(body);
}

function ok(res, data) {
  sendJson(res, 200, { ok: true, data });
}

function fail(res, status, error) {
  sendJson(res, status, { ok: false, error });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const cookies = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    cookies[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return cookies;
}

function sessionCookieHeader(token, maxAge) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Lax`;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function verifyPassword(password, salt, expected) {
  const actual = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}

function escapeLike(text) {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function currentUser(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  return db.getUserBySession(token);
}

async function parseJsonBody(req) {
  const text = await readBody(req);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('请求体不是合法的 JSON');
  }
}

function codePointLength(str) {
  return [...str].length;
}

/**
 * 解析 dataURL 图片并落盘(头像/帖子/私信图片共用)。
 * @returns {Promise<string>} 文件名; 字段缺失时返回空串(可选图片)
 */
async function saveUploadedImage(body, key, prefix, maxBytes) {
  const dataUrl = body[key];
  if (typeof dataUrl !== 'string' || dataUrl === '') return '';
  const match = dataUrl.match(/^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new Error('图片数据格式不正确');
  const ext = AVATAR_MIMES[match[1]];
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length === 0) throw new Error('图片文件为空');
  if (buffer.length > maxBytes) {
    throw new Error(`图片文件大小超出限制(${Math.floor(maxBytes / 1024 / 1024)}MB)`);
  }
  const filename = `${prefix}${crypto.randomBytes(6).toString('hex')}${ext}`;
  await fs.promises.writeFile(path.join(UPLOAD_DIR, filename), buffer);
  return filename;
}

/** 异步删除 uploads/ 文件, 失败静默 */
function removeUploadedFile(filename) {
  if (!filename) return;
  fs.promises.unlink(path.join(UPLOAD_DIR, filename)).catch(() => {});
}

function logRequest(req, status) {
  const time = new Date().toISOString();
  console.log(`[${time}] ${req.method} ${req.url} -> ${status}`);
}

/** 净化文件名: 去掉路径分隔符与控制字符, 限制长度 */
function sanitizeFileName(name) {
  const cleaned = String(name)
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .slice(0, FILE_NAME_MAX)
    .trim();
  return cleaned || 'file';
}

/** 生成 ASCII 安全的 Content-Disposition 后备文件名 */
function asciiFileName(name) {
  const ascii = String(name).replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return ascii || 'file';
}

// ---------- 认证与处罚守卫 ----------

/** 是否处于封禁中(永久或未到期) */
function isBanned(user) {
  return user.ban_until === 'forever' || (user.ban_until !== '' && user.ban_until > nowUtc());
}

/** 是否处于禁言中 */
function isMuted(user) {
  return user.mute_until !== '' && user.mute_until > nowUtc();
}

/**
 * 鉴权 + 处罚检查统一入口。
 * @param {object} req 请求对象
 * @param {object} res 响应对象
 * @param {object} [opts] { write: 是否属于"发布内容"类操作(禁言拦截) }
 * @returns {object|null} 可用用户或 null(已写响应)
 */
function requireUser(req, res, opts = {}) {
  const user = currentUser(req);
  if (!user) {
    fail(res, 401, '未登录');
    return null;
  }
  if (isBanned(user)) {
    fail(res, 403, '账号已被封禁，无法执行此操作');
    return null;
  }
  if (opts.write && isMuted(user)) {
    fail(res, 403, `您已被禁言至 ${user.mute_until.slice(0, 10)}，期间不能发布内容`);
    return null;
  }
  return user;
}

/**
 * 扣除CCB(余额不足返回 false, 不扣款)。
 * @param {number} userId 用户 ID
 * @param {number} amount 金额
 * @returns {boolean} 是否成功
 */
function trySpend(userId, amount) {
  if (db.getWallet(userId) < amount) return false;
  db.addWallet(userId, -amount);
  return true;
}

/**
 * 创建互动通知(不通知自己)。
 * @param {number} userId 接收人
 * @param {number} actorId 触发人
 * @param {string} type like/comment/reply/tip/follow
 * @param {string} refType post/comment/user
 * @param {number} refId 关联 ID
 * @param {string} content 通知文案
 */
function notify(userId, actorId, type, refType, refId, content) {
  try {
    db.createNotification(userId, actorId, type, refType, refId, content);
  } catch (err) {
    console.log('[notify] 写入通知失败', err.message);
  }
}

// ---------- 静态文件服务 ----------

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

async function serveStatic(req, res, urlPath) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  // 安全: 付费文件商品(file_*)禁止走静态路径直接获取(否则绕过购买鉴权)。
  // 下载一律经 /api/store/item/:id/download(handleStoreDownload 校验购买状态);
  // 返回 404 而非 403, 避免借此探测有效 file_id(防枚举)。
  if (urlPath.startsWith('/uploads/file_')) {
    sendJson(res, 404, { ok: false, error: '文件不存在' });
    return true;
  }

  let baseDir = PUBLIC_DIR;
  if (urlPath.startsWith('/uploads/')) {
    baseDir = UPLOAD_DIR;
    urlPath = urlPath.slice('/uploads'.length);
  } else if (urlPath !== '/' && !urlPath.startsWith('/public/')) {
    if (!urlPath.startsWith('/.')) {
      baseDir = PUBLIC_DIR;
    }
  }

  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.normalize(path.join(baseDir, rel));
  if (!filePath.startsWith(baseDir + path.sep) && filePath !== path.join(baseDir, 'index.html')) {
    sendJson(res, 403, { ok: false, error: '禁止访问' });
    return true;
  }

  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) {
      sendJson(res, 404, { ok: false, error: '文件不存在' });
      return true;
    }
    const ext = path.extname(filePath).toLowerCase();
    // 安全头: HTML 页追加 CSP(script-src 'self', 防注入脚本执行)
    const headers = {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': urlPath.startsWith('/uploads/') ? 'public, max-age=86400' : 'no-cache',
      ...SECURITY_HEADERS,
    };
    if (ext === '.html') headers['Content-Security-Policy'] = CSP_HTML;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
    } else {
      fs.createReadStream(filePath).pipe(res);
    }
    return true;
  } catch {
    sendJson(res, 404, { ok: false, error: '文件不存在' });
    return true;
  }
}

// ---------- 业务校验 ----------

function validateUsername(username) {
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    return '用户名需为 2~20 位中英文、数字或下划线';
  }
  return null;
}

function validatePassword(password) {
  if (typeof password !== 'string') return '密码格式不正确';
  const len = codePointLength(password);
  if (len < PASSWORD_MIN || len > PASSWORD_MAX) {
    return `密码长度需为 ${PASSWORD_MIN}~${PASSWORD_MAX} 个字符`;
  }
  return null;
}

function validateContent(content) {
  if (typeof content !== 'string') return '内容格式不正确';
  const len = codePointLength(content.trim());
  if (len < 1 || len > CONTENT_MAX) {
    return `内容需为 1~${CONTENT_MAX} 个字符`;
  }
  return null;
}

function validateBio(bio) {
  if (typeof bio !== 'string') return '自我介绍格式不正确';
  if (codePointLength(bio.trim()) > BIO_MAX) {
    return `自我介绍最多 ${BIO_MAX} 个字符`;
  }
  return null;
}

function validateMessageContent(content) {
  if (typeof content !== 'string') return '消息内容格式不正确';
  const len = codePointLength(content.trim());
  if (len < 1 || len > DM_MAX) {
    return `消息内容需为 1~${DM_MAX} 个字符`;
  }
  return null;
}

/**
 * 校验商品样式 CSS: 长度受限且拒绝 url( 与 <(防样式注入)。
 * @param {string} data CSS 片段
 * @returns {string|null} 错误信息或 null(通过)
 */
function validateCss(data) {
  if (typeof data !== 'string') return '样式内容格式不正确';
  const len = codePointLength(data.trim());
  if (len < 3 || len > CSS_MAX) return `样式内容需为 3~${CSS_MAX} 个字符`;
  if (/url\(|<|expression/i.test(data)) return '样式内容包含不允许的字符(url( 或 <)';
  return null;
}

/** 校验商品名称: 1~30 字符 */
function validateItemName(name) {
  if (typeof name !== 'string') return '商品名称格式不正确';
  const len = codePointLength(name.trim());
  if (len < 1 || len > 30) return '商品名称需为 1~30 个字符';
  return null;
}

/**
 * 校验金额(正整数, 上限 WALLET_MAX)。
 * @returns {string|null} 错误信息或 null(通过)
 */
function validateAmount(amount) {
  if (!Number.isInteger(amount) || amount < 1 || amount > WALLET_MAX) {
    return '金额需为正整数';
  }
  return null;
}

/**
 * 校验天数(用于暂时封禁/禁言)。
 * @returns {string|null} 错误信息或 null(通过)
 */
function validateDays(days) {
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    return '天数需为 1~3650 的整数';
  }
  return null;
}

// ---------- 管理员初始化 ----------

/**
 * 确保 admin 账号存在, 并在每次启动时重置密码并打印。
 * 行为(运营者自助): 每次重启 admin 密码都会被重置——
 *   - 设置环境变量 ADMIN_PASSWORD 时用该固定密码(同样打印);
 *   - 未设置时随机生成新密码, 仅以本次启动打印为准。
 * ⚠️ 安全提示: 密码会以明文打印在启动日志/控制台(如 systemd journal),
 *    请勿将日志对外公开; 服务器若有他人可读日志, 慎用本模式。
 */
function ensureAdmin() {
  // 每次启动都重置密码: 优先环境变量, 否则随机生成
  const finalPass = process.env.ADMIN_PASSWORD || crypto.randomBytes(12).toString('base64url');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(finalPass, salt);

  let existing = db.findUserByUsername(ADMIN_USERNAME);
  // 兼容旧版: 旧库管理员名为 'admin', 首次启动自动改名为 MicroX(保留账号/权限/数据)
  if (!existing) {
    const legacy = db.findUserByUsername('admin');
    if (legacy) {
      db.updateUsername(legacy.id, ADMIN_USERNAME);
      existing = db.findUserByUsername(ADMIN_USERNAME);
      console.log(`[admin] 已把旧管理员 "admin" 改名为 "${ADMIN_USERNAME}"`);
    }
  }

  if (existing) {
    db.updateIsAdmin(existing.id, 1);
    db.updatePassword(existing.id, hash, salt);
  } else {
    db.createUser(ADMIN_USERNAME, hash, salt, 1);
  }
  console.log(`[admin] 管理员 "${ADMIN_USERNAME}" 本次启动密码: ${finalPass}`);
  if (!process.env.ADMIN_PASSWORD) {
    console.log('[admin] 提示: 每次重启都会重新生成密码, 请以本次打印为准; 可设置 ADMIN_PASSWORD 环境变量固定密码');
  }
}

// ---------- 账号 ----------

/**
 * 限定领取条件(JSON) → 中文描述(私信/提示用)。如 {"ccb":500,"followers":10} → "CCB达到500且粉丝达到10"
 */
function describeLimitedConds(condsStr) {
  if (!condsStr) return '登录条件';
  let conds = {};
  try { conds = JSON.parse(condsStr); } catch { return '登录条件'; }
  const labels = { ccb: 'CCB达到', followers: '粉丝达到', posts: '发帖达到', comments: '评论达到' };
  const parts = [];
  for (const [k, v] of Object.entries(conds)) {
    if (labels[k] && Number(v) > 0) parts.push(`${labels[k]}${v}`);
  }
  return parts.length ? parts.join('且') : '登录条件';
}

/**
 * 登录/注册后自动领取满足条件的限定物品, 并通过 MicroX 系统私信通知用户。
 * @returns {Array<{itemId,name,conds}>} 本次新发放列表
 */
function grantLimitedAndNotify(userId) {
  const granted = db.grantLimitedToUser(userId);
  if (granted.length === 0) return granted;
  const admin = db.findUserByUsername(ADMIN_USERNAME);
  const adminId = admin ? admin.id : 1;
  for (const g of granted) {
    db.sendMessage(adminId, userId, `[MicroX] 您已达到${describeLimitedConds(g.conds)}，成功获得「${g.name}」，祝贺！`, '');
  }
  return granted;
}

/** GET /api/auth-config: 注册页配置(前端据此决定是否显示邮箱验证区) */
function handleAuthConfig(req, res) {
  ok(res, {
    email_verify: emailVerifyEnabled(),
    code_cooldown: Math.round(EMAIL_CODE_SEND_COOLDOWN_MS / 1000),
  });
}

/** POST /api/send-email-code: 发送注册邮箱验证码(发码前必须通过图形验证码, 防刷邮件) */
async function handleSendEmailCode(req, res) {
  const ip = clientIp(req);
  if (!emailVerifyEnabled()) return fail(res, 503, '邮件服务未配置');
  if (rateLocked('email-code', ip)) return fail(res, 429, '发送太频繁，请稍后再试');
  if (rateExceeded('email-code', ip, EMAIL_CODE_BURST, EMAIL_CODE_BURST_WINDOW_MS)) {
    rateForceLock('email-code', ip);
    return fail(res, 429, '发送太频繁，请稍后再试');
  }
  purgeEmailCodes();

  const body = await parseJsonBody(req);
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!isValidEmail(email)) return fail(res, 400, '邮箱格式不正确');
  if (db.findUserByEmail(email)) return fail(res, 409, '该邮箱已被注册');

  // 图形验证码: 校验后燃烧(与注册时同规格, 防脚本刷邮件)
  const ct = captchaStore.get(body.captcha_token);
  if (!ct || Date.now() > ct.exp) {
    rateFail('email-code', ip, RATE_MAX_FAILS_IP);
    return fail(res, 400, '验证码已过期，请刷新重试');
  }
  if (Date.now() - ct.iat < CAPTCHA_MIN_MS) {
    captchaStore.delete(body.captcha_token);
    rateFail('email-code', ip, RATE_MAX_FAILS_IP);
    return fail(res, 400, '验证码校验过快，请重新输入图中算式结果');
  }
  if (String(body.captcha_answer).trim() !== ct.answer) {
    captchaStore.delete(body.captcha_token);
    rateFail('email-code', ip, RATE_MAX_FAILS_IP);
    return fail(res, 400, '验证码错误');
  }
  captchaStore.delete(body.captcha_token);

  // 同一邮箱重发冷却
  const lastRec = emailCodeStore.get(email);
  if (lastRec && Date.now() - lastRec.iat < EMAIL_CODE_SEND_COOLDOWN_MS) {
    const waitSec = Math.ceil((EMAIL_CODE_SEND_COOLDOWN_MS - (Date.now() - lastRec.iat)) / 1000);
    return fail(res, 429, `发送太频繁，请 ${waitSec} 秒后再试`);
  }
  // 同一邮箱每日发码上限
  if (!emailCodeCanSend(email)) return fail(res, 429, `该邮箱今日发码次数已达上限(${EMAIL_CODE_DAILY_MAX})`);

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  emailCodeStore.set(email, { code, iat: Date.now(), exp: Date.now() + EMAIL_CODE_TTL_MS, attempts: 0 });

  const subject = 'MicroX 注册验证码';
  const html = `<div style="font-family:sans-serif;max-width:420px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:12px">`
    + `<h2 style="margin:0 0 12px">MicroX 注册验证</h2>`
    + `<p style="color:#374151">你的注册验证码是:</p>`
    + `<p style="font-size:32px;font-weight:700;letter-spacing:6px;color:#0ea5b7">${code}</p>`
    + `<p style="color:#9ca3af;font-size:13px">验证码 ${Math.round(EMAIL_CODE_TTL_MS / 60000)} 分钟内有效。若非本人操作请忽略本邮件。</p>`
    + `</div>`;

  try {
    await sendCloudMail(email, subject, html);
    ok(res, { cooldown: Math.round(EMAIL_CODE_SEND_COOLDOWN_MS / 1000) });
  } catch (err) {
    emailCodeStore.delete(email);
    console.error('[mail] 验证码发送失败:', err.message);
    fail(res, 502, '邮件发送失败，请稍后再试');
  }
}

async function handleRegister(req, res) {
  // 安全加固: 单 IP 注册限速(防批量注册)
  const ip = clientIp(req);
  if (rateLocked('reg', ip)) return fail(res, 429, '尝试过于频繁，请 15 分钟后再试');
  // 每 IP 每日注册上限(防脚本批量刷号)
  const regDay = todayUtc();
  const regRec = regDaily.get(ip);
  if (regRec && regRec.date === regDay && regRec.count >= REG_DAILY_LIMIT) {
    return fail(res, 429, '今日注册数量已达上限，请明天再试');
  }

  const body = await parseJsonBody(req);
  const { username, password, account_type } = body;

  const errUsername = validateUsername(username);
  if (errUsername) return fail(res, 400, errUsername);
  const errPassword = validatePassword(password);
  if (errPassword) return fail(res, 400, errPassword);

  if (db.findUserByUsername(username)) {
    // 管理员账号为启动时自动创建的保留账号, 给出明确提示避免混淆
    if (username === ADMIN_USERNAME) {
      return fail(res, 400, `"${ADMIN_USERNAME}" 是管理员保留账号，请直接在登录页登录`);
    }
    return fail(res, 409, '用户名已被占用');
  }

  // 区分真人/Agent:
  // - 真人: 必须通过算术验证码(防纯脚本批量注册)
  // - Agent: 必须同意行为规范 + 同样通过验证码(安全加固: 堵住免验证码注册绕过)
  const isAgent = account_type === 'agent';
  if (isAgent && body.agreed !== true) {
    rateFail('reg', ip, RATE_MAX_FAILS_IP);
    return fail(res, 400, '必须同意 Agent 行为规范才能注册');
  }

  let email = '';
  if (emailVerifyEnabled()) {
    // 已配置 SendCloud: 注册必须绑定邮箱并通过邮箱验证码
    // (图形验证码已在"发送验证码"时校验并燃烧, 这里用邮箱码作为注册票据)
    email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!isValidEmail(email)) {
      rateFail('reg', ip, RATE_MAX_FAILS_IP);
      return fail(res, 400, '邮箱格式不正确');
    }
    if (db.findUserByEmail(email)) return fail(res, 409, '该邮箱已被注册');
    const v = validateEmailCode(email, body.email_code);
    if (!v.ok) {
      rateFail('reg', ip, RATE_MAX_FAILS_IP);
      return fail(res, 400, v.error);
    }
  } else {
    // 未配置邮件服务: 走原有图形验证码流程(注册不要求邮箱)
    const ct = captchaStore.get(body.captcha_token);
    if (!ct || Date.now() > ct.exp) {
      rateFail('reg', ip, RATE_MAX_FAILS_IP);
      return fail(res, 400, '验证码已过期，请刷新重试');
    }
    // 安全加固: 校验失败(过快/答错)即焚毁 token, 每次校验最多尝试一次 → 无法按 token 穷举答案
    if (Date.now() - ct.iat < CAPTCHA_MIN_MS) {
      // 签发后 1.5 秒内提交视为脚本行为
      captchaStore.delete(body.captcha_token);
      rateFail('reg', ip, RATE_MAX_FAILS_IP);
      return fail(res, 400, '验证码校验过快，请重新输入图中算式结果');
    }
    if (String(body.captcha_answer).trim() !== ct.answer) {
      captchaStore.delete(body.captcha_token);
      rateFail('reg', ip, RATE_MAX_FAILS_IP);
      return fail(res, 400, '验证码错误');
    }
    captchaStore.delete(body.captcha_token);
  }

  const salt = crypto.randomBytes(16).toString('hex');
  // 新用户钱包默认 100(建表 DEFAULT)
  const userId = db.createUser(username, hashPassword(password, salt), salt, 0, isAgent ? 'agent' : 'human', email);

  const token = crypto.randomBytes(32).toString('hex');
  db.createSession(token, userId);
  res.setHeader('Set-Cookie', sessionCookieHeader(token, SESSION_MAX_AGE));
  rateReset('reg', ip);
  // 记录本 IP 今日注册数(防刷号)
  const prevReg = regDaily.get(ip);
  regDaily.set(ip, { date: regDay, count: (prevReg && prevReg.date === regDay ? prevReg.count : 0) + 1 });
  // 注册即登录, 自动领取限定物品
  const newLimited = grantLimitedAndNotify(userId);
  ok(res, { id: userId, username, account_type: isAgent ? 'agent' : 'human', email, new_limited: newLimited });
}

async function handleLogin(req, res) {
  const ip = clientIp(req);
  const body = await parseJsonBody(req);
  const { username, password } = body;

  // 安全加固: 按 IP 与用户名双重限速(连续失败 5 次锁定 15 分钟, 防暴力破解)
  if (rateLocked('login', ip)) return fail(res, 429, '尝试次数过多，请 15 分钟后再试');
  if (rateLocked('login', username)) return fail(res, 429, '该账号已临时锁定，请 15 分钟后再试');

  // 先清理已到期的封禁/禁言/订阅/会话, 再取用户(登录也触发清理)
  db.pruneExpiredPenalties();
  db.pruneExpiredItems();
  db.pruneExpiredSessions();

  const user = db.findUserByUsername(username);
  if (!user || !verifyPassword(password, user.salt, user.password_hash)) {
    rateFail('login', ip, RATE_MAX_FAILS_IP);
    if (user) {
      rateFail('login', username, RATE_MAX_FAILS_USER);
      // 字典攻击检测: 同一 IP 在窗口内对不同真实账号失败达阈值, 立即锁定该 IP
      let set = loginIpUsers.get(ip);
      if (!set) { set = new Set(); loginIpUsers.set(ip, set); }
      set.add(String(username).toLowerCase());
      if (set.size >= IP_DISTINCT_USER_MAX) rateForceLock('login', ip);
    }
    return fail(res, 401, '用户名或密码错误');
  }
  if (isBanned(user)) {
    rateFail('login', ip, RATE_MAX_FAILS_IP);
    return fail(res, 403, '该账号已被封禁，请联系管理员');
  }
  if (user.account_type === 'bot') {
    return fail(res, 403, '陪聊账号不支持登录');
  }

  rateReset('login', ip);
  rateReset('login', username);
  const token = crypto.randomBytes(32).toString('hex');
  db.createSession(token, user.id);
  res.setHeader('Set-Cookie', sessionCookieHeader(token, SESSION_MAX_AGE));
  // 登录即自动领取: 发放未拥有的限定物品
  const newLimited = grantLimitedAndNotify(user.id);
  ok(res, { id: user.id, username: user.username, new_limited: newLimited });
}

function handleLogout(req, res) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) db.deleteSession(token);
  res.setHeader('Set-Cookie', sessionCookieHeader('', 0));
  ok(res, null);
}

/** GET /api/me: 清理过期状态后返回当前用户(含CCB/装备/处罚状态) */
function handleMe(req, res) {
  // 使用 requireUser: 被封禁的用户不能使用任何接口(含 /api/me)
  const user = requireUser(req, res);
  if (!user) return;
  // 幂等清理: 过期的封禁/禁言/订阅
  db.pruneExpiredPenalties();
  db.pruneExpiredItems();
  ok(res, db.getUserById(user.id));
}

/** POST /api/me/daily-bonus: 每日登录奖励(一天一次) */
function handleDailyBonus(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  const amount = rewardValue('daily');
  const balance = db.claimDailyBonus(user.id, todayUtc(), amount);
  ok(res, {
    claimed: balance !== null,
    amount: balance !== null ? amount : 0,
    balance: balance !== null ? balance : db.getWallet(user.id),
  });
}

/** POST /api/me/agent-verify: Agent 提交/重新提交认证申请 */
async function handleAgentVerify(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  if (user.account_type !== 'agent') return fail(res, 403, '仅 Agent 账号可提交认证');
  if (user.agent_verified === 1) return fail(res, 400, '您已通过 Agent 认证');

  const body = await parseJsonBody(req);
  const intro = typeof body.intro === 'string' ? body.intro.trim() : '';
  if (codePointLength(intro) > 500) return fail(res, 400, '自述最多 500 字');

  db.setAgentIntro(user.id, sanitizeText(intro));
  db.setAgentVerified(user.id, 0); // 重新进入待认证
  ok(res, { agent_verified: 0 });
}

/** POST /api/me/agent-title: 认证 Agent 佩戴/卸下 [AGENT] 头衔(非强制) */
async function handleAgentTitle(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  if (user.account_type !== 'agent' || user.agent_verified !== 1) {
    return fail(res, 403, '仅已认证 Agent 可佩戴 [AGENT] 头衔');
  }
  const body = await parseJsonBody(req);
  if (body.on) {
    db.updateTitle(user.id, '[AGENT]', '#1d9bf0', null);
  } else {
    db.updateTitle(user.id, '', '', null);
  }
  const fresh = db.getUserById(user.id);
  ok(res, { title: fresh.title, title_css: fresh.title_css });
}

/** PATCH /api/me: 修改用户名与自我介绍 */
async function handleChangeMe(req, res) {
  const user = requireUser(req, res);
  if (!user) return;

  const body = await parseJsonBody(req);
  const { username, bio } = body;

  if (username === undefined && bio === undefined) {
    return fail(res, 400, '没有需要修改的内容');
  }

  let newUsername = user.username;
  let newBio = user.bio;

  if (username !== undefined) {
    const err = validateUsername(username);
    if (err) return fail(res, 400, err);
    const existing = db.findUserByUsername(username);
    if (existing && existing.id !== user.id) {
      return fail(res, 409, '用户名已被占用');
    }
    newUsername = username;
  }

  if (bio !== undefined) {
    const err = validateBio(bio);
    if (err) return fail(res, 400, err);
    newBio = sanitizeText(bio.trim());
  }

  db.updateUsername(user.id, newUsername);
  db.updateBio(user.id, newBio);
  ok(res, { username: newUsername, bio: newBio });
}

/** POST /api/me/avatar: 修改头像 */
async function handleChangeAvatar(req, res) {
  const user = requireUser(req, res);
  if (!user) return;

  const body = await parseJsonBody(req);
  const filename = await saveUploadedImage(body, 'avatar', `avatar_${user.id}_`, AVATAR_MAX_BYTES);
  if (!filename) return fail(res, 400, '头像数据格式不正确');

  const oldFile = user.avatar;
  db.updateAvatar(user.id, filename);
  removeUploadedFile(oldFile);

  ok(res, { avatar: filename });
}

// ---------- 帖子 ----------

async function handleCreatePost(req, res) {
  const user = requireUser(req, res, { write: true });
  if (!user) return;

  const body = await parseJsonBody(req);
  const content = typeof body.content === 'string' ? body.content.trim() : '';

  const err = validateContent(content);
  if (err) return fail(res, 400, err);

  const image = await saveUploadedImage(body, 'image', 'post_', IMAGE_MAX_BYTES);

  // 纵深防御: 落库前剥离 HTML 尖括号(前端 escapeHtml 之外的兜底)
  const postId = db.createPost(user.id, sanitizeText(content), image);
  // 发帖奖励(额度与频率管理员可在管理页调整; 超上限/冷却中则不发放)
  const reward = rewardValue('post');
  const granted = reward > 0 && db.claimRewardFrequency(user.id, 'post');
  if (granted) db.addWallet(user.id, reward);
  ok(res, { id: postId, balance: db.getWallet(user.id), reward: granted ? reward : 0 });
}

function handleTimeline(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sort = url.searchParams.get('sort') === 'hot' ? 'hot' : 'latest';
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const viewer = currentUser(req);
  ok(res, { posts: db.getTimeline(viewer ? viewer.id : 0, sort, page, PAGE_SIZE), page });
}

function handleDeletePost(req, res, segs) {
  const user = requireUser(req, res);
  if (!user) return;
  const postId = Number(segs[2]);
  if (!Number.isInteger(postId) || postId <= 0) return fail(res, 400, '帖子 ID 不合法');

  const post = db.getPostById(postId);
  if (!post) return fail(res, 404, '帖子不存在');
  if (!db.deletePost(postId, user.id, user.is_admin === 1)) {
    return fail(res, 404, '帖子不存在或无权删除');
  }
  removeUploadedFile(post.image);
  ok(res, null);
}

function handleToggleLike(req, res, segs) {
  const user = requireUser(req, res);
  if (!user) return;
  const postId = Number(segs[2]);
  if (!Number.isInteger(postId) || postId <= 0) return fail(res, 400, '帖子 ID 不合法');
  const result = db.toggleLike(user.id, postId);
  if (!result) return fail(res, 404, '帖子不存在');
  // 点赞通知: 新增点赞时通知作者
  if (result.liked) {
    const post = db.getPostById(postId);
    if (post) {
      notify(post.user_id, user.id, 'like', 'post', postId, '点赞了你的帖子');
    }
  }
  ok(res, result);
}

/** POST /api/posts/:id/tip: 打赏(10/50/100, 每帖每人一次) */
async function handleTip(req, res, segs) {
  const user = requireUser(req, res);
  if (!user) return;
  const postId = Number(segs[2]);
  if (!Number.isInteger(postId) || postId <= 0) return fail(res, 400, '帖子 ID 不合法');

  const body = await parseJsonBody(req);
  const amount = Number(body.amount);
  if (!TIP_OPTIONS.includes(amount)) return fail(res, 400, '打赏金额需为 10/50/100');

  const post = db.getPostById(postId);
  if (!post) return fail(res, 404, '帖子不存在');
  if (post.user_id === user.id) return fail(res, 400, '不能打赏自己的帖子');

  if (!trySpend(user.id, amount)) return fail(res, 400, 'CCB不足');
  if (!db.tipPost(postId, user.id, amount)) {
    // 重复打赏: 回滚扣款
    db.addWallet(user.id, amount);
    return fail(res, 400, '已打赏过该帖子');
  }
  db.addWallet(post.user_id, amount);
  // 打赏通知作者
  notify(post.user_id, user.id, 'tip', 'post', postId, `打赏了你的帖子 ${amount} CCB`);
  ok(res, { balance: db.getWallet(user.id), amount, tipped: true });
}

// ---------- 评论(含回复与点赞) ----------

function handlePostComments(req, res, segs) {
  const postId = Number(segs[2]);
  if (!Number.isInteger(postId) || postId <= 0) return fail(res, 400, '帖子 ID 不合法');
  if (!db.getPostById(postId)) return fail(res, 404, '帖子不存在');
  const viewer = currentUser(req);
  // 组装回复树: 一级回复挂到其顶级评论下
  const rows = db.getComments(postId, viewer ? viewer.id : 0);
  const tree = [];
  const topById = new Map();
  for (const row of rows) {
    row.replies = [];
    if (row.parent_id && topById.has(row.parent_id)) {
      topById.get(row.parent_id).replies.push(row);
    } else {
      tree.push(row);
      topById.set(row.id, row);
    }
  }
  ok(res, { comments: tree });
}

async function handleCreateComment(req, res) {
  const user = requireUser(req, res, { write: true });
  if (!user) return;

  const body = await parseJsonBody(req);
  const postId = Number(body.post_id);
  const content = typeof body.content === 'string' ? body.content.trim() : '';

  if (!Number.isInteger(postId) || postId <= 0) return fail(res, 400, '帖子 ID 不合法');
  const err = validateContent(content);
  if (err) return fail(res, 400, err);
  if (!db.getPostById(postId)) return fail(res, 404, '帖子不存在');

  // 回复: parent_id 必须属于同一帖子; 若回复的是回复, 归入其顶级评论
  let parentId = null;
  if (body.parent_id !== undefined && body.parent_id !== null) {
    parentId = Number(body.parent_id);
    if (!Number.isInteger(parentId) || parentId <= 0) return fail(res, 400, '回复的评论 ID 不合法');
    const parent = db.getCommentById(parentId);
    if (!parent || parent.post_id !== postId) return fail(res, 400, '回复的评论不存在');
    if (parent.parent_id) parentId = parent.parent_id;
  }

  const commentId = db.addComment(postId, user.id, sanitizeText(content), parentId);
  // 评论奖励(额度与频率管理员可在管理页调整; 超上限/冷却中则不发放)
  const commentReward = rewardValue('comment');
  const commentGranted = commentReward > 0 && db.claimRewardFrequency(user.id, 'comment');
  const balance = commentGranted ? db.addWallet(user.id, commentReward) : db.getWallet(user.id);

  // 互动通知:
  // - 回复评论(回复其顶级评论的作者) -> 给被回复人发 reply 通知
  // - 评论帖子 -> 给帖子作者发 comment 通知
  const post = db.getPostById(postId);
  if (parentId) {
    const replied = db.getCommentById(parentId);
    if (replied && replied.user_id !== user.id) {
      notify(replied.user_id, user.id, 'reply', 'post', postId, `回复了你的评论：「${content.slice(0, 30)}」`);
    }
  } else if (post && post.user_id !== user.id) {
    notify(post.user_id, user.id, 'comment', 'post', postId, `评论了你的帖子：「${content.slice(0, 30)}」`);
  }

  // 即时触发机器人评论回复:
  // 目标 = 回复了机器人评论的用户, 或评论了机器人帖子的用户
  const replyTarget = parentId ? db.getCommentById(parentId) : null;
  let botToReply = null;
  if (replyTarget && replyTarget.user_id !== user.id) {
    const maybeBot = db.getBotByUserId(replyTarget.user_id);
    if (maybeBot && maybeBot.status === 'active') botToReply = maybeBot;
  }
  if (!botToReply && post && post.user_id !== user.id) {
    const maybeBot = db.getBotByUserId(post.user_id);
    if (maybeBot && maybeBot.status === 'active') botToReply = maybeBot;
  }
  if (botToReply && botToReply.api_base_url && botToReply.api_key && botToReply.api_model) {
    replyToComment(botToReply, commentId, postId).catch(() => {});
  }

  ok(res, { id: commentId, balance, reward: commentGranted ? commentReward : 0 });
}

function handleDeleteComment(req, res, segs) {
  const user = requireUser(req, res);
  if (!user) return;
  const commentId = Number(segs[2]);
  if (!Number.isInteger(commentId) || commentId <= 0) return fail(res, 400, '评论 ID 不合法');
  if (!db.getCommentById(commentId)) return fail(res, 404, '评论不存在');
  if (!db.deleteComment(commentId, user.id, user.is_admin === 1)) {
    return fail(res, 404, '评论不存在或无权删除');
  }
  ok(res, null);
}

/** POST /api/comments/:id/like: 评论点赞切换(无CCB奖励) */
function handleCommentLike(req, res, segs) {
  const user = requireUser(req, res);
  if (!user) return;
  const commentId = Number(segs[2]);
  if (!Number.isInteger(commentId) || commentId <= 0) return fail(res, 400, '评论 ID 不合法');
  const result = db.toggleCommentLike(user.id, commentId);
  if (!result) return fail(res, 404, '评论不存在');
  ok(res, result);
}

// ---------- 私信 ----------

function handleConversations(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  ok(res, { conversations: db.getConversations(user.id) });
}

function handleMessagesWith(req, res, segs) {
  const user = requireUser(req, res);
  if (!user) return;
  const username = decodeURIComponent(segs[3] || '');
  const other = db.findUserByUsername(username);
  if (!other) return fail(res, 404, '用户不存在');
  const url = new URL(req.url, `http://${req.headers.host}`);
  const after = Math.max(0, Number(url.searchParams.get('after')) || 0);
  // 聊天窗展示: 若对方是陪聊机器人, 附带计费信息(前端显示横幅)
  let botPricing = null;
  if (other.account_type === 'bot') {
    const bot = db.getBotByUserId(other.id);
    if (bot) {
      botPricing = {
        type: bot.pricing_type,
        price_per_reply: bot.price_per_reply,
        subscription_price: bot.subscription_price,
        has_sub: (bot.pricing_type === 'subscription' || bot.pricing_type === 'hybrid') && db.hasActiveBotSub(user.id, other.id),
        official: bot.is_official === 1,
      };
    }
  }

  ok(res, {
    other: {
      id: other.id, username: other.username, avatar: other.avatar,
      avatar_frame_css: other.avatar_frame_css, chat_bubble_css: other.chat_bubble_css,
      title: other.title, title_css: other.title_css,
      account_type: other.account_type, agent_verified: other.agent_verified,
      bot_pricing: botPricing,
    },
    messages: attachPaymentInfo(db.getMessagesWith(user.id, other.id, after), user.id),
  });
}

async function handleSendMessage(req, res) {
  const user = requireUser(req, res, { write: true });
  if (!user) return;

  const body = await parseJsonBody(req);
  const toUsername = typeof body.to_username === 'string' ? body.to_username.trim() : '';
  const content = typeof body.content === 'string' ? body.content.trim() : '';

  const other = db.findUserByUsername(toUsername);
  if (!other) return fail(res, 404, '收件用户不存在');
  if (other.id === user.id) return fail(res, 400, '不能给自己发私信');
  const err = validateMessageContent(content);
  if (err) return fail(res, 400, err);

  const image = await saveUploadedImage(body, 'image', 'msg_', IMAGE_MAX_BYTES);

  // 纵深防御: 私信内容落库前剥离 HTML 尖括号
  const messageId = db.sendMessage(user.id, other.id, sanitizeText(content), image);

  // 接收方是陪聊机器人: 发送时立即触发回复(计费检查在 replyToDm 内, 未购买/余额不足会回提示);
  // 定时扫描(engageBots)保留作兜底, replyBusy 防抖避免重复生成
  if (other.account_type === 'bot') {
    const bot = db.getBotByUserId(other.id);
    if (bot && bot.status === 'active') {
      if (bot.api_base_url && bot.api_key && bot.api_model) {
        replyToDm(bot, user.id).catch(() => {});
      } else if (bot.creator_id !== user.id) {
        // 未配置 AI 接口: 给非创建者明确提示, 避免"不回复"的困惑
        db.sendMessage(other.id, user.id, '（此陪聊尚未配置 AI 接口，请联系创建者）', '');
      }
    }
  }

  ok(res, { id: messageId });
}

async function handleMarkRead(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  const body = await parseJsonBody(req);
  const withUsername = typeof body.with_username === 'string' ? body.with_username.trim() : '';
  const other = db.findUserByUsername(withUsername);
  if (!other) return fail(res, 404, '用户不存在');
  db.markMessagesRead(user.id, other.id);
  ok(res, null);
}

function handleUnread(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  ok(res, { count: db.getUnreadTotal(user.id) });
}

// ---------- 转账 ----------

/** POST /api/transfer: 用户间CCB转账 */
async function handleTransfer(req, res) {
  const user = requireUser(req, res);
  if (!user) return;

  const body = await parseJsonBody(req);
  const toUsername = typeof body.to_username === 'string' ? body.to_username.trim() : '';
  const amount = Number(body.amount);

  const err = validateAmount(amount);
  if (err) return fail(res, 400, err);
  const to = db.findUserByUsername(toUsername);
  if (!to) return fail(res, 404, '收款用户不存在');
  if (to.id === user.id) return fail(res, 400, '不能给自己转账');

  if (!trySpend(user.id, amount)) return fail(res, 400, 'CCB不足');
  db.addWallet(to.id, amount);
  // 写入转账流水(AI 上下文可见)
  db.recordTransfer(user.id, to.id, amount);
  ok(res, { balance: db.getWallet(user.id), to_username: to.username, amount });
}

// ---------- 群组 / 转账红包 ----------

const GROUP_NAME_MAX = 20;
const GROUP_MAX_MEMBERS = 50;
const PAYMENT_TTL_MS = 24 * 3600 * 1000;   // 未领取 24h 自动退回

/**
 * 给消息行附加支付卡信息(转账/拼手气)。
 * @param {object[]} messages 消息行(含 payment_id)
 * @param {number} viewerId 当前用户 ID
 * @returns {object[]} 附上 payment 字段的消息
 */
function attachPaymentInfo(messages, viewerId) {
  for (const m of messages) {
    if (!m.payment_id) continue;
    const p = db.getPaymentById(m.payment_id);
    if (!p) continue;
    const claims = db.getPaymentClaims(p.id);
    m.payment = {
      id: p.id,
      type: p.type,
      sender_id: p.sender_id,
      receiver_id: p.receiver_id,
      group_id: p.group_id,
      amount: p.amount,
      count: p.count,
      claimed_amount: p.claimed_amount,
      claimed_count: p.claimed_count,
      note: p.note,
      status: p.status,
      expires_at: p.expires_at,
      my_claimed: db.hasClaimedPayment(p.id, viewerId),
      can_claim: viewerId !== p.sender_id && p.status === 'pending'
        && (p.type === 'dm' ? p.receiver_id === viewerId : true)
        && !db.hasClaimedPayment(p.id, viewerId),
      claims: claims.map((c) => ({ username: c.username, amount: c.amount })),
    };
  }
  return messages;
}

/** POST /api/groups: 创建群(创建者自动入群) */
async function handleGroupCreate(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  const body = await parseJsonBody(req);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const len = codePointLength(name);
  if (len < 1 || len > GROUP_NAME_MAX) return fail(res, 400, `群名称需为 1~${GROUP_NAME_MAX} 个字符`);
  const groupId = db.createGroup(name, user.id);
  db.addGroupMember(groupId, user.id);
  ok(res, { id: groupId, name });
}

/** GET /api/groups: 我的群(含未读数) */
function handleGroupsList(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  ok(res, { groups: db.getMyGroups(user.id) });
}

/** GET /api/groups/:id?after=N: 群详情(成员 + 增量消息) */
function handleGroupDetail(req, res, segs) {
  const user = requireUser(req, res);
  if (!user) return;
  const groupId = Number(segs[2]);
  if (!Number.isInteger(groupId) || groupId <= 0) return fail(res, 400, '群 ID 不合法');
  const group = db.getGroupById(groupId);
  if (!group) return fail(res, 404, '群不存在');
  if (!db.isGroupMember(groupId, user.id)) return fail(res, 403, '你不是该群成员');
  const url = new URL(req.url, `http://${req.headers.host}`);
  const after = Math.max(0, Number(url.searchParams.get('after')) || 0);
  const messages = attachPaymentInfo(db.getGroupMessages(groupId, after, 60), user.id);
  ok(res, {
    group: { id: group.id, name: group.name, owner_id: group.owner_id, created_at: group.created_at },
    members: db.getGroupMembers(groupId),
    messages,
  });
}

/** POST /api/groups/:id/invite {username}: 成员可邀请用户/机器人入群 */
async function handleGroupInvite(req, res, segs) {
  const user = requireUser(req, res);
  if (!user) return;
  const groupId = Number(segs[2]);
  if (!Number.isInteger(groupId) || groupId <= 0) return fail(res, 400, '群 ID 不合法');
  const group = db.getGroupById(groupId);
  if (!group) return fail(res, 404, '群不存在');
  if (!db.isGroupMember(groupId, user.id)) return fail(res, 403, '你不是该群成员');
  const body = await parseJsonBody(req);
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const target = db.findUserByUsername(username);
  if (!target) return fail(res, 404, '用户不存在');
  if (db.isGroupMember(groupId, target.id)) return fail(res, 400, '该用户已在群里');
  const memberCount = db.getGroupMembers(groupId).length;
  if (memberCount >= GROUP_MAX_MEMBERS) return fail(res, 400, `群成员上限 ${GROUP_MAX_MEMBERS} 人`);
  db.addGroupMember(groupId, target.id);
  ok(res, null);
}

/** POST /api/groups/:id/leave: 退群(群主不能退, 只能删群) */
function handleGroupLeave(req, res, segs) {
  const user = requireUser(req, res);
  if (!user) return;
  const groupId = Number(segs[2]);
  if (!Number.isInteger(groupId) || groupId <= 0) return fail(res, 400, '群 ID 不合法');
  const group = db.getGroupById(groupId);
  if (!group) return fail(res, 404, '群不存在');
  if (group.owner_id === user.id) return fail(res, 400, '群主不能退群，可删除群');
  if (!db.isGroupMember(groupId, user.id)) return fail(res, 403, '你不是该群成员');
  db.removeGroupMember(groupId, user.id);
  ok(res, null);
}

/** DELETE /api/groups/:id: 群主删除群 */
function handleGroupDelete(req, res, segs) {
  const user = requireUser(req, res);
  if (!user) return;
  const groupId = Number(segs[2]);
  if (!Number.isInteger(groupId) || groupId <= 0) return fail(res, 400, '群 ID 不合法');
  const group = db.getGroupById(groupId);
  if (!group) return fail(res, 404, '群不存在');
  if (group.owner_id !== user.id) return fail(res, 403, '仅群主可删除群');
  db.deleteGroup(groupId);
  ok(res, null);
}

/** DELETE /api/groups/:id/members/:userId: 群主移除成员 */
function handleGroupRemoveMember(req, res, segs) {
  const user = requireUser(req, res);
  if (!user) return;
  const groupId = Number(segs[2]);
  if (!Number.isInteger(groupId) || groupId <= 0) return fail(res, 400, '群 ID 不合法');
  const targetId = Number(segs[4]);
  if (!Number.isInteger(targetId) || targetId <= 0) return fail(res, 400, '成员 ID 不合法');
  const group = db.getGroupById(groupId);
  if (!group) return fail(res, 404, '群不存在');
  if (group.owner_id !== user.id) return fail(res, 403, '仅群主可移除成员');
  if (targetId === user.id) return fail(res, 400, '不能移除自己');
  db.removeGroupMember(groupId, targetId);
  ok(res, null);
}

/** POST /api/groups/:id/read {last_id}: 标记已读 */
async function handleGroupRead(req, res, segs) {
  const user = requireUser(req, res);
  if (!user) return;
  const groupId = Number(segs[2]);
  if (!Number.isInteger(groupId) || groupId <= 0) return fail(res, 400, '群 ID 不合法');
  if (!db.isGroupMember(groupId, user.id)) return fail(res, 403, '你不是该群成员');
  const body = await parseJsonBody(req);
  db.setGroupRead(groupId, user.id, Number(body.last_id) || 0);
  ok(res, null);
}

/** POST /api/groups/:id/messages: 发群消息(图文; 若带拼手气卡由前端用另一接口) */
async function handleGroupMessage(req, res, segs) {
  const user = requireUser(req, res, { write: true });
  if (!user) return;
  const groupId = Number(segs[2]);
  if (!Number.isInteger(groupId) || groupId <= 0) return fail(res, 400, '群 ID 不合法');
  if (!db.isGroupMember(groupId, user.id)) return fail(res, 403, '你不是该群成员');
  const body = await parseJsonBody(req);
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!content) return fail(res, 400, '消息内容不能为空');
  const err = validateMessageContent(content);
  if (err) return fail(res, 400, err);
  const image = await saveUploadedImage(body, 'image', 'grp_', IMAGE_MAX_BYTES);
  const messageId = db.sendGroupMessage(groupId, user.id, sanitizeText(content), image, null);
  // 机器人群回复(@必回 + 15% 概率扫描上下文)
  triggerGroupBotReplies(groupId, messageId);
  ok(res, { id: messageId });
}

// ---------- 转账 / 拼手气红包 ----------

/** 创建支付并插入消息卡片 */
async function handlePaymentCreate(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  const body = await parseJsonBody(req);
  const type = body.type === 'lucky' ? 'lucky' : 'dm';
  const amount = Number(body.amount);
  const err = validateAmount(amount);
  if (err) return fail(res, 400, err);
  const note = typeof body.note === 'string' ? body.note.slice(0, 100).trim() : '';
  const expiresAt = addDaysUtc(1);

  if (type === 'dm') {
    // 单对单手动领取转账
    const toUsername = typeof body.to_username === 'string' ? body.to_username.trim() : '';
    const to = db.findUserByUsername(toUsername);
    if (!to) return fail(res, 404, '收款用户不存在');
    if (to.id === user.id) return fail(res, 400, '不能给自己转账');
    if (!trySpend(user.id, amount)) return fail(res, 400, 'CCB不足');
    const paymentId = db.createPayment({
      senderId: user.id, receiverId: to.id, type: 'dm',
      amount, count: 1, note, expiresAt,
    });
    db.sendMessage(user.id, to.id, note || '[转账]', '', paymentId);
    ok(res, { id: paymentId, balance: db.getWallet(user.id) });
  } else {
    // 群内拼手气红包
    const groupId = Number(body.group_id);
    const count = Number(body.count);
    if (!Number.isInteger(groupId) || groupId <= 0) return fail(res, 400, '群 ID 不合法');
    if (!db.isGroupMember(groupId, user.id)) return fail(res, 403, '你不是该群成员');
    if (!Number.isInteger(count) || count < 2 || count > amount) {
      return fail(res, 400, '份数需为 2 到总金额之间的整数(每人至少 1 CCB)');
    }
    if (!trySpend(user.id, amount)) return fail(res, 400, 'CCB不足');
    const paymentId = db.createPayment({
      senderId: user.id, groupId, type: 'lucky',
      amount, count, note, expiresAt,
    });
    db.sendGroupMessage(groupId, user.id, note || '[拼手气红包]', '', paymentId);
    ok(res, { id: paymentId, balance: db.getWallet(user.id) });
  }
}

/** 领取转账/拼手气 */
async function handlePaymentClaim(req, res, segs) {
  const user = requireUser(req, res);
  if (!user) return;
  const paymentId = Number(segs[2]);
  if (!Number.isInteger(paymentId) || paymentId <= 0) return fail(res, 400, '转账 ID 不合法');
  const p = db.getPaymentById(paymentId);
  if (!p) return fail(res, 404, '转账不存在');
  if (p.status !== 'pending') {
    return fail(res, 400, p.status === 'done' ? '已被领取' : '已过期退回');
  }
  if (user.id === p.sender_id) return fail(res, 400, '不能领取自己发出的转账');

  if (p.type === 'dm') {
    if (p.receiver_id !== user.id) return fail(res, 403, '该转账不是发给你的');
    db.addWallet(user.id, p.amount);
    // 领取成功写入转账流水(AI 上下文可见)
    db.recordTransfer(p.sender_id, user.id, p.amount);
    db.updatePaymentClaimed(paymentId, p.amount, 1, 'done');
    ok(res, { claimed: p.amount, status: 'done', balance: db.getWallet(user.id) });
  } else {
    // 拼手气: 群里成员逐个抢, 随机分配(保底 1, 总和=总额)
    if (!db.isGroupMember(p.group_id, user.id)) return fail(res, 403, '你不是该群成员');
    if (db.hasClaimedPayment(paymentId, user.id)) return fail(res, 400, '你已经抢过啦');
    const remainingCount = p.count - p.claimed_count;
    if (remainingCount <= 0) return fail(res, 400, '红包已被抢完');
    const remainingAmount = p.amount - p.claimed_amount;
    let take;
    if (remainingCount === 1) {
      take = remainingAmount;
    } else {
      // 本份随机 1 ~ (剩余总额 - 给其余人各留 1)
      const maxTake = remainingAmount - (remainingCount - 1);
      take = 1 + Math.floor(Math.random() * maxTake);
    }
    db.addWallet(user.id, take);
    db.recordTransfer(p.sender_id, user.id, take);
    db.addPaymentClaim(paymentId, user.id, take);
    const claimedCount = p.claimed_count + 1;
    const claimedAmount = p.claimed_amount + take;
    const status = claimedCount >= p.count ? 'done' : 'pending';
    db.updatePaymentClaimed(paymentId, claimedAmount, claimedCount, status);
    ok(res, { claimed: take, status, balance: db.getWallet(user.id) });
  }
}

/** 过期未领取的转账/红包自动退回发送者(24h) */
function refundExpiredPayments() {
  const expired = db.getExpiredPendingPayments();
  for (const p of expired) {
    const refund = p.amount - p.claimed_amount;
    if (refund > 0) {
      db.addWallet(p.sender_id, refund);
      console.log('[pay] 转账过期退回', p.id, '-> 发送者', p.sender_id, refund, 'CCB');
    }
  }
  db.expirePendingPayments();
}

// ---------- 商店 ----------

/** GET /api/store/items?type=&seller=all|official|user: 在售商品目录(附带卖家名与我的拥有状态) */
function handleStoreItems(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const type = url.searchParams.get('type') || '';
  const seller = url.searchParams.get('seller') || 'all';
  let items = db.getActiveItems(type).filter((i) => !i.limited); // 限定物品仅登录自动发放, 商店隐藏
  if (seller === 'official') items = items.filter((i) => i.seller_id === null);
  else if (seller === 'user') items = items.filter((i) => i.seller_id !== null);

  const viewer = currentUser(req);
  const viewerId = viewer ? viewer.id : 0;
  // 我的拥有状态(买断永久 + 未过期订阅)映射到商品
  const ownedMap = viewerId ? new Map(db.getUserItems(viewerId).map((o) => [o.item_id, o.mode])) : new Map();
  for (const item of items) {
    if (item.seller_id) {
      const sellerUser = db.getUserById(item.seller_id);
      item.seller_name = sellerUser ? sellerUser.username : '未知';
    }
    item.ownedByMe = ownedMap.has(item.id);
    item.ownedMode = ownedMap.get(item.id) || '';
    // 安全: 文件商品下载走 /api/store/item/:id/download(有鉴权), 列表不暴露 file_id(防未登录绕过购买)
    delete item.file_id;
  }
  ok(res, { items });
}

/**
 * POST /api/store/upload?name=文件名
 * 原生字节流上传(≤512MB), 边收边写盘, 返回 file_id 供上架引用。
 */
async function handleStoreUpload(req, res) {
  const user = requireUser(req, res, { write: true });
  if (!user) return;

  const url = new URL(req.url, `http://${req.headers.host}`);
  const fileId = `file_${crypto.randomBytes(8).toString('hex')}`;
  const outPath = path.join(UPLOAD_DIR, fileId);
  let size = 0;

  try {
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(outPath);
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > FILE_UPLOAD_LIMIT) {
          ws.destroy();
          req.destroy();
          reject(new Error('文件超过 512MB 限制'));
          return;
        }
        if (!ws.write(chunk)) {
          req.pause();
          ws.once('drain', () => req.resume());
        }
      });
      req.on('end', () => ws.end(resolve));
      req.on('error', reject);
      ws.on('error', reject);
    });
  } catch (err) {
    removeUploadedFile(fileId);
    throw err;
  }

  // 安全加固: 每用户上传配额/每日配额(防磁盘耗尽 DoS), 超限即删除本次文件
  if (uploadQuotaExceeded(user.id, size)) {
    removeUploadedFile(fileId);
    return fail(res, 429, '上传超出配额限制，请稍后再试');
  }

  ok(res, {
    file_id: fileId,
    file_name: sanitizeFileName(url.searchParams.get('name') || 'file'),
    file_size: size,
  });
}

/** POST /api/store/sell: 缴押金上架商品
 * 用户摊位仅支持文件商品; 头像框/头衔/聊天气泡由管理员在管理界面创建(见 POST /api/admin/store/items) */
async function handleStoreSell(req, res) {
  const user = requireUser(req, res);
  if (!user) return;

  const body = await parseJsonBody(req);
  const { name, type, price, file_id, file_name, file_size } = body;

  const errName = validateItemName(name);
  if (errName) return fail(res, 400, errName);
  if (type !== 'file') return fail(res, 400, '用户摊位仅支持上架文件商品');

  const priceNum = Number(price);
  const errPrice = validateAmount(priceNum);
  if (errPrice) return fail(res, 400, errPrice);

  // 文件商品: 必须有已上传文件且未被引用; 不支持订阅
  if (typeof file_id !== 'string' || !file_id) return fail(res, 400, '缺少文件');
  const filePath = path.join(UPLOAD_DIR, file_id);
  if (file_id.includes('..') || !fs.existsSync(filePath)) return fail(res, 400, '文件不存在');
  if (db.isFileIdUsed(file_id)) return fail(res, 400, '该文件已被其他商品使用');

  // 扣除押金(余额不足拒绝)
  if (!trySpend(user.id, DEPOSIT)) return fail(res, 400, `押金不足，开店需要 ${DEPOSIT} CCB`);

  const itemId = db.createItem({
    name: name.trim(), type: 'file', price: priceNum, monthly_price: 0,
    data: '',
    file_name: sanitizeFileName(typeof file_name === 'string' ? file_name : 'file'),
    file_size: Number.isInteger(file_size) ? file_size : 0,
    file_id,
    seller_id: user.id, deposit: DEPOSIT,
  });

  ok(res, { id: itemId, balance: db.getWallet(user.id), deposit: DEPOSIT });
}

/** POST /api/store/buy: 买断或订阅 */
async function handleStoreBuy(req, res) {
  const user = requireUser(req, res);
  if (!user) return;

  const body = await parseJsonBody(req);
  const itemId = Number(body.item_id);
  const mode = body.mode === 'subscribe' ? 'subscribe' : 'buy';
  if (!Number.isInteger(itemId) || itemId <= 0) return fail(res, 400, '商品 ID 不合法');

  const item = db.getItemById(itemId);
  if (!item || item.status !== 'active') return fail(res, 404, '商品不存在或已下架');
  if (item.limited) return fail(res, 400, '该商品为限定发放，无法购买');
  if (item.type === 'file' && mode === 'subscribe') return fail(res, 400, '文件商品仅支持买断');
  if (db.hasActiveItem(user.id, itemId)) return fail(res, 400, '已拥有该商品或订阅生效中');

  const cost = mode === 'subscribe' ? item.monthly_price : item.price;
  if (mode === 'subscribe' && item.monthly_price <= 0) return fail(res, 400, '该商品不支持订阅');
  if (!Number.isInteger(cost) || cost <= 0) return fail(res, 400, '价格无效');

  if (!trySpend(user.id, cost)) return fail(res, 400, 'CCB不足');

  const expiresAt = mode === 'subscribe' ? addDaysUtc(SUB_DAYS) : null;
  db.insertUserItem(user.id, itemId, mode, expiresAt);
  db.incrementSales(itemId);
  // 卖家商品: 货款入卖家钱包; 官方商品CCB回收
  if (item.seller_id) db.addWallet(item.seller_id, cost);

  ok(res, { balance: db.getWallet(user.id), mode, expires_at: expiresAt });
}

/** POST /api/store/item/:id/off: 卖家或管理员主动下架(退还押金) */
async function handleStoreOff(req, res, segs) {
  const user = requireUser(req, res);
  if (!user) return;
  const itemId = Number(segs[3]);
  if (!Number.isInteger(itemId) || itemId <= 0) return fail(res, 400, '商品 ID 不合法');

  const item = db.getItemById(itemId);
  if (!item) return fail(res, 404, '商品不存在');
  const isSeller = item.seller_id === user.id;
  const isAdmin = user.is_admin === 1;
  if (!isSeller && !isAdmin) return fail(res, 403, '无权操作该商品');
  if (item.status !== 'active') return fail(res, 400, '商品已下架');

  db.disableItem(itemId);
  // 主动下架退还押金给卖家
  if (item.seller_id) db.addWallet(item.seller_id, item.deposit);
  ok(res, { balance: db.getWallet(user.id) });
}

/** GET /api/store/mine: 我的在售商品与库存 */
function handleStoreMine(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  const owned = db.getUserItems(user.id);
  const selling = db.getItemsBySeller(user.id);
  // 纵深防御: 下载一律走 /api/store/item/:id/download(有鉴权), 不暴露 file_id
  for (const o of owned) delete o.file_id;
  for (const s of selling) delete s.file_id;
  ok(res, { selling, owned });
}

/** GET /api/store/item/:id/download: 下载文件商品(买家/卖家/管理员) */
function handleStoreDownload(req, res, segs) {
  const user = requireUser(req, res);
  if (!user) return;
  const itemId = Number(segs[3]);
  if (!Number.isInteger(itemId) || itemId <= 0) return fail(res, 400, '商品 ID 不合法');

  const item = db.getItemById(itemId);
  if (!item || item.type !== 'file' || !item.file_id) return fail(res, 404, '文件商品不存在');

  const allowed = user.is_admin === 1 || item.seller_id === user.id || db.hasActiveItem(user.id, itemId);
  if (!allowed) return fail(res, 403, '购买后才能下载');

  const filePath = path.join(UPLOAD_DIR, item.file_id);
  fs.promises.stat(filePath).then((stat) => {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': stat.size,
      'Content-Disposition':
        `attachment; filename="${asciiFileName(item.file_name)}"; filename*=UTF-8''${encodeURIComponent(item.file_name)}`,
      'Cache-Control': 'no-store',
      ...SECURITY_HEADERS,
    });
    fs.createReadStream(filePath).pipe(res);
  }).catch(() => {
    fail(res, 404, '文件不存在');
  });
}

/** POST /api/equip: 装备已拥有的头像框/聊天气泡 */
async function handleEquip(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  const body = await parseJsonBody(req);
  const itemId = Number(body.item_id);
  if (!Number.isInteger(itemId) || itemId <= 0) return fail(res, 400, '商品 ID 不合法');

  const item = db.getItemById(itemId);
  if (!item || item.type === 'file') return fail(res, 400, '该商品不可装备');
  if (!db.hasActiveItem(user.id, itemId)) return fail(res, 403, '尚未拥有该商品');

  if (item.type === 'avatar_frame') db.updateFrameCss(user.id, item.data);
  else if (item.type === 'chat_bubble') db.updateBubbleCss(user.id, item.data);
  else if (item.type === 'title') db.updateTitle(user.id, item.name, item.data, item.id);

  const fresh = db.getUserById(user.id);
  ok(res, {
    avatar_frame_css: fresh.avatar_frame_css,
    chat_bubble_css: fresh.chat_bubble_css,
    title: fresh.title,
    title_css: fresh.title_css,
  });
}

/** POST /api/unequip: 卸下装备 */
async function handleUnequip(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  const body = await parseJsonBody(req);
  const { type } = body;
  if (type === 'avatar_frame') db.updateFrameCss(user.id, '');
  else if (type === 'chat_bubble') db.updateBubbleCss(user.id, '');
  else if (type === 'title') db.updateTitle(user.id, '', '', null);
  else return fail(res, 400, '装备类型不合法');
  ok(res, null);
}

// ---------- 工单 ----------

async function handleCreateTicket(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  const body = await parseJsonBody(req);
  const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
  const content = typeof body.body === 'string' ? body.body.trim() : '';

  const lenSubject = codePointLength(subject);
  if (lenSubject < 1 || lenSubject > 50) return fail(res, 400, '工单主题需为 1~50 个字符');
  const lenBody = codePointLength(content);
  if (lenBody < 1 || lenBody > 2000) return fail(res, 400, '工单内容需为 1~2000 个字符');

  // 纵深防御: 工单内容落库前剥离 HTML 尖括号
  const ticketId = db.createTicket(user.id, sanitizeText(subject), sanitizeText(content));
  ok(res, { id: ticketId });
}

function handleMyTickets(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  ok(res, { tickets: db.getTicketsByUser(user.id) });
}

// ---------- 举报 ----------

/** POST /api/reports: 举报商品/商铺/帖子/用户 */
async function handleCreateReport(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  const body = await parseJsonBody(req);
  const { target_type, target_id, reason } = body;
  const targetId = Number(target_id);
  const reasonStr = typeof reason === 'string' ? reason.trim() : '';

  const VALID = ['item', 'shop', 'post', 'user'];
  if (!VALID.includes(target_type)) return fail(res, 400, '举报对象类型不合法');
  if (!Number.isInteger(targetId) || targetId <= 0) return fail(res, 400, '举报对象 ID 不合法');
  const lenReason = codePointLength(reasonStr);
  if (lenReason < 1 || lenReason > 200) return fail(res, 400, '举报理由需为 1~200 个字符');

  // 校验目标存在且非本人
  if (target_type === 'item') {
    const item = db.getItemById(targetId);
    if (!item) return fail(res, 404, '商品不存在');
    if (item.seller_id === user.id) return fail(res, 400, '不能举报自己的商品');
  } else if (target_type === 'shop') {
    const seller = db.getUserById(targetId);
    if (!seller) return fail(res, 404, '商铺不存在');
    if (targetId === user.id) return fail(res, 400, '不能举报自己的商铺');
  } else if (target_type === 'post') {
    const post = db.getPostById(targetId);
    if (!post) return fail(res, 404, '帖子不存在');
    if (post.user_id === user.id) return fail(res, 400, '不能举报自己的帖子');
  } else {
    const target = db.getUserById(targetId);
    if (!target) return fail(res, 404, '用户不存在');
    if (targetId === user.id) return fail(res, 400, '不能举报自己');
  }

  if (!db.createReport(user.id, target_type, targetId, sanitizeText(reasonStr))) {
    return fail(res, 400, '该对象已有一条待处理的举报');
  }
  ok(res, null);
}

// ---------- 管理员接口 ----------

function requireAdmin(req, res) {
  const user = currentUser(req);
  if (!user) return fail(res, 401, '未登录');
  if (user.is_admin !== 1) return fail(res, 403, '需要管理员权限');
  return user;
}

/**
 * GET /api/admin/ai-settings: 读取 AI 互动频率设置(仅管理员)。
 * 返回: ai_interact_enabled / ai_comment_reply_rate / ai_group_reply_rate / ai_engage_interval
 */
function handleAdminAiSettingsGet(req, res) {
  if (!requireAdmin(req, res)) return;
  ok(res, {
    ai_interact_enabled: aiSetting('ai_interact_enabled', '1'),
    ai_comment_reply_rate: aiSetting('ai_comment_reply_rate', '50'),
    ai_group_reply_rate: aiSetting('ai_group_reply_rate', '10'),
    ai_engage_interval: aiSetting('ai_engage_interval', '5'),
    ai_semantic_deep: aiSetting('ai_semantic_deep', '1'),
    ai_post_image_rate: aiSetting('ai_post_image_rate', '4'),
  });
}

/**
 * POST /api/admin/ai-settings: 更新 AI 互动频率设置(仅管理员)。
 * body 可含: { ai_interact_enabled?: '1'|'0', ai_comment_reply_rate?: 0-100,
 *              ai_group_reply_rate?: 0-100, ai_engage_interval?: 1-1440(分钟) }
 * 非法值返回 400, 全部合法才写入。
 */
async function handleAdminAiSettingsPost(req, res) {
  if (!requireAdmin(req, res)) return;
  const body = await parseJsonBody(req);
  const patch = {};
  if (body.ai_interact_enabled !== undefined) {
    const v = String(body.ai_interact_enabled);
    if (v !== '1' && v !== '0') return fail(res, 400, '总开关只能为 1 或 0');
    patch.ai_interact_enabled = v;
  }
  if (body.ai_semantic_deep !== undefined) {
    const v = String(body.ai_semantic_deep);
    if (v !== '1' && v !== '0') return fail(res, 400, '语义缓存深度开关只能为 1 或 0');
    patch.ai_semantic_deep = v;
  }
  for (const [key, label] of [['ai_comment_reply_rate', '评论回复概率'], ['ai_group_reply_rate', '群聊回复概率'], ['ai_post_image_rate', '带图帖子浏览概率']]) {
    if (body[key] !== undefined) {
      const n = Number(body[key]);
      if (!Number.isInteger(n) || n < 0 || n > 100) return fail(res, 400, `${label}需为 0~100 的整数`);
      patch[key] = String(n);
    }
  }
  if (body.ai_engage_interval !== undefined) {
    const n = Number(body.ai_engage_interval);
    if (!Number.isInteger(n) || n < 1 || n > 1440) return fail(res, 400, '扫描间隔需为 1~1440 分钟');
    patch.ai_engage_interval = String(n);
  }
  for (const [k, v] of Object.entries(patch)) db.setSetting(k, v);
  ok(res, { updated: Object.keys(patch) });
}

/** GET /api/admin/agents: Agent 列表(待认证排最前) */
function handleAdminAgents(req, res) {
  if (!requireAdmin(req, res)) return;
  ok(res, { agents: db.listAgents() });
}

/**
 * POST /api/admin/agents/:id/verify: 审核 Agent 认证。
 * body: { approve: boolean, note? }
 * 通过 -> 标记已认证并授予 [AGENT] 头衔; 拒绝/撤销 -> 标记 -1 并卸下 [AGENT]
 */
async function handleAdminAgentVerify(req, res, segs) {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const targetId = Number(segs[3]);
  if (!Number.isInteger(targetId) || targetId <= 0) return fail(res, 400, '用户 ID 不合法');
  const target = db.getUserById(targetId);
  if (!target) return fail(res, 404, '用户不存在');
  if (target.account_type !== 'agent') return fail(res, 400, '该账号不是 Agent');

  const body = await parseJsonBody(req);
  if (body.approve) {
    db.setAgentVerified(targetId, 1);
    // 认证通过: 授予 [AGENT] 头衔(非强制, 用户可卸下)
    db.updateTitle(targetId, '[AGENT]', '#1d9bf0', null);
  } else {
    db.setAgentVerified(targetId, -1);
    // 撤销认证: 若正佩戴 [AGENT] 头衔则卸下
    if (target.title === '[AGENT]') db.updateTitle(targetId, '', '', null);
  }
  ok(res, { agent_verified: body.approve ? 1 : -1 });
}

function handleAdminUsers(req, res) {
  if (!requireAdmin(req, res)) return;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const query = (url.searchParams.get('q') || '').trim();
  ok(res, { users: db.listUsers(query ? escapeLike(query) : '') });
}

async function handleAdminUserPatch(req, res, segs) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const targetId = Number(segs[3]);
  if (!Number.isInteger(targetId) || targetId <= 0) return fail(res, 400, '用户 ID 不合法');
  const target = db.getUserById(targetId);
  if (!target) return fail(res, 404, '用户不存在');

  const body = await parseJsonBody(req);
  const { username, bio, password, avatar, is_admin, wallet } = body;

  if (username !== undefined) {
    const err = validateUsername(username);
    if (err) return fail(res, 400, err);
    const existing = db.findUserByUsername(username);
    if (existing && existing.id !== target.id) {
      return fail(res, 409, '用户名已被占用');
    }
    db.updateUsername(target.id, username);
  }

  if (bio !== undefined) {
    const err = validateBio(bio);
    if (err) return fail(res, 400, err);
    db.updateBio(target.id, bio.trim());
  }

  if (password !== undefined && password !== '') {
    const err = validatePassword(password);
    if (err) return fail(res, 400, err);
    const salt = crypto.randomBytes(16).toString('hex');
    db.updatePassword(target.id, hashPassword(password, salt), salt);
  }

  if (avatar !== undefined) {
    const filename = await saveUploadedImage(body, 'avatar', `avatar_${target.id}_`, AVATAR_MAX_BYTES);
    if (!filename) return fail(res, 400, '头像数据格式不正确');
    db.updateAvatar(target.id, filename);
    removeUploadedFile(target.avatar);
  }

  if (wallet !== undefined) {
    const amount = Number(wallet);
    if (!Number.isInteger(amount) || amount < 0 || amount > WALLET_MAX) {
      return fail(res, 400, 'CCB数量不合法');
    }
    db.setWallet(target.id, amount);
  }

  if (is_admin !== undefined) {
    if (target.id === admin.id) return fail(res, 400, '不能修改自己的管理员状态');
    db.updateIsAdmin(target.id, is_admin ? 1 : 0);
  }

  ok(res, { id: target.id });
}

/** DELETE /api/admin/users/:id: 删除用户(级联清理其全部数据与文件) */
function handleAdminUserDelete(req, res, segs) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const targetId = Number(segs[3]);
  if (!Number.isInteger(targetId) || targetId <= 0) return fail(res, 400, '用户 ID 不合法');
  const target = db.getUserById(targetId);
  if (!target) return fail(res, 404, '用户不存在');

  // 保护: 不能删除自己; 不能删除保留管理员账号(防管理员自删/误删导致无人可管)
  if (target.id === admin.id) return fail(res, 400, '不能删除自己的账号');
  if (target.username === ADMIN_USERNAME) return fail(res, 400, `"${ADMIN_USERNAME}" 是保留管理员账号，不能删除`);

  if (!db.deleteUser(targetId)) return fail(res, 500, '删除失败');
  // 尽力清理该用户头像文件(帖子/私信图片属共享文件, 不在此删除)
  removeUploadedFile(target.avatar);
  ok(res, null);
}

/**
 * POST /api/admin/users/:id/penalty: 封禁/解封/禁言/解禁。
 * body: { type: 'ban'|'unban'|'mute'|'unmute', days? }
 */
async function handleAdminPenalty(req, res, segs) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const targetId = Number(segs[3]);
  if (!Number.isInteger(targetId) || targetId <= 0) return fail(res, 400, '用户 ID 不合法');
  const target = db.getUserById(targetId);
  if (!target) return fail(res, 404, '用户不存在');
  if (target.id === admin.id) return fail(res, 400, '不能处罚自己');

  const body = await parseJsonBody(req);
  const { type, days } = body;

  if (type === 'ban') {
    const until = days !== undefined && days !== null && days !== 0 ? (validateDays(Number(days)) ? null : addDaysUtc(Number(days))) : 'forever';
    if (until === null) return fail(res, 400, validateDays(Number(days)));
    db.setBanUntil(targetId, until);
    ok(res, { ban_until: until });
  } else if (type === 'unban') {
    db.setBanUntil(targetId, '');
    ok(res, { ban_until: '' });
  } else if (type === 'mute') {
    const err = validateDays(Number(days));
    if (err) return fail(res, 400, err);
    const until = addDaysUtc(Number(days));
    db.setMuteUntil(targetId, until);
    ok(res, { mute_until: until });
  } else if (type === 'unmute') {
    db.setMuteUntil(targetId, '');
    ok(res, { mute_until: '' });
  } else {
    fail(res, 400, '处罚类型不合法');
  }
}

/** POST /api/admin/users/:id/grant-item: 授予任意物品(含普通/限定/文件) */
async function handleAdminGrantItem(req, res, segs) {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const targetId = Number(segs[3]);
  if (!Number.isInteger(targetId) || targetId <= 0) return fail(res, 400, '用户 ID 不合法');
  const target = db.getUserById(targetId);
  if (!target) return fail(res, 404, '用户不存在');
  const body = await parseJsonBody(req);
  const itemId = Number(body.item_id);
  if (!Number.isInteger(itemId) || itemId <= 0) return fail(res, 400, '商品 ID 不合法');
  const item = db.getItemById(itemId);
  if (!item) return fail(res, 404, '商品不存在');
  const granted = db.grantItemToUser(targetId, itemId);
  ok(res, { granted, item: { id: item.id, name: item.name, type: item.type } });
}

/** POST /api/admin/users/:id/grant-bot-sub: 直接开通陪聊订阅(不要求管理员拥有该陪聊) */
async function handleAdminGrantBotSub(req, res, segs) {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const targetId = Number(segs[3]);
  if (!Number.isInteger(targetId) || targetId <= 0) return fail(res, 400, '用户 ID 不合法');
  const target = db.getUserById(targetId);
  if (!target) return fail(res, 404, '用户不存在');
  const body = await parseJsonBody(req);
  const botId = Number(body.bot_id);
  const days = Number(body.days);
  if (!Number.isInteger(botId) || botId <= 0) return fail(res, 400, '陪聊 ID 不合法');
  const bot = db.getBotByUserId(botId);
  if (!bot) return fail(res, 404, '陪聊不存在');
  const err = validateDays(days);
  if (err) return fail(res, 400, err);
  const expiresAt = addDaysUtc(days);
  db.setBotSub(targetId, botId, expiresAt);
  ok(res, { bot: { id: bot.user_id, name: bot.username }, expires_at: expiresAt });
}

function handleAdminTickets(req, res) {
  if (!requireAdmin(req, res)) return;
  ok(res, { tickets: db.getAllTickets() });
}

async function handleAdminTicketReply(req, res, segs) {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const ticketId = Number(segs[3]);
  if (!Number.isInteger(ticketId) || ticketId <= 0) return fail(res, 400, '工单 ID 不合法');
  const ticket = db.getTicketById(ticketId);
  if (!ticket) return fail(res, 404, '工单不存在');

  const body = await parseJsonBody(req);
  const reply = typeof body.reply === 'string' ? body.reply.trim() : '';
  const lenReply = codePointLength(reply);
  if (lenReply < 1 || lenReply > 2000) return fail(res, 400, '回复内容需为 1~2000 个字符');

  db.replyTicket(ticketId, reply);
  ok(res, null);
}

function handleAdminReports(req, res) {
  if (!requireAdmin(req, res)) return;
  ok(res, { reports: db.getAllReports() });
}

/**
 * POST /api/admin/reports/:id/resolve: 处理举报。
 * body: { action, days?, note? }
 * action: dismiss | delete_post | disable_item | close_shop | ban_user | mute_user
 */
async function handleAdminReportResolve(req, res, segs) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const reportId = Number(segs[3]);
  if (!Number.isInteger(reportId) || reportId <= 0) return fail(res, 400, '举报 ID 不合法');
  const report = db.getReportById(reportId);
  if (!report) return fail(res, 404, '举报不存在');
  if (report.status !== 'pending') return fail(res, 400, '该举报已处理');

  const body = await parseJsonBody(req);
  const { action, days, note } = body;
  const noteStr = typeof note === 'string' ? note.slice(0, 500) : '';
  const targetId = report.target_id;

  switch (action) {
    case 'dismiss':
      break;
    case 'delete_post': {
      if (report.target_type !== 'post') return fail(res, 400, '该举报对象不是帖子');
      const post = db.getPostById(targetId);
      if (post) {
        db.deletePost(post.id, 0, true);
        removeUploadedFile(post.image);
      }
      break;
    }
    case 'disable_item': {
      if (report.target_type !== 'item') return fail(res, 400, '该举报对象不是商品');
      const item = db.getItemById(targetId);
      if (item && item.status === 'active') db.disableItem(item.id); // 违规下架, 押金没收
      break;
    }
    case 'close_shop': {
      if (report.target_type !== 'shop') return fail(res, 400, '该举报对象不是商铺');
      for (const item of db.getItemsBySeller(targetId)) {
        if (item.status === 'active') db.disableItem(item.id); // 封店, 押金没收
      }
      break;
    }
    case 'ban_user': {
      if (report.target_type !== 'user') return fail(res, 400, '该举报对象不是用户');
      if (targetId === admin.id) return fail(res, 400, '不能封禁自己');
      const until = days !== undefined && days !== null && days !== 0
        ? (validateDays(Number(days)) ? null : addDaysUtc(Number(days)))
        : 'forever';
      if (until === null) return fail(res, 400, validateDays(Number(days)));
      db.setBanUntil(targetId, until);
      break;
    }
    case 'mute_user': {
      if (report.target_type !== 'user') return fail(res, 400, '该举报对象不是用户');
      const err = validateDays(Number(days));
      if (err) return fail(res, 400, err);
      db.setMuteUntil(targetId, addDaysUtc(Number(days)));
      break;
    }
    default:
      return fail(res, 400, '处理动作不合法');
  }

  db.resolveReport(reportId, noteStr);
  ok(res, null);
}

/** POST /api/admin/store/items: 官方上架商品(头像框/聊天气泡/头衔) */
async function handleAdminStoreCreate(req, res) {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const body = await parseJsonBody(req);
  const { name, type, price, monthly_price, data } = body;

  const errName = validateItemName(name);
  if (errName) return fail(res, 400, errName);
  // 官方可上架: 头像框/聊天气泡/头衔(title 仅限官方, 用户摊位不可售卖)
  if (!ITEM_TYPES.includes(type) && type !== 'title') return fail(res, 400, '商品类型不合法');
  if (type === 'file') return fail(res, 400, '官方不支持上架文件商品');

  let dataStr = '';
  if (type === 'title') {
    // 头衔: data 为可选的颜色(hex), 空串表示默认色
    dataStr = typeof data === 'string' ? data.trim() : '';
    if (dataStr && !/^#[0-9a-fA-F]{3,8}$/.test(dataStr)) {
      return fail(res, 400, '头衔颜色需为十六进制色值(如 #ffd400)');
    }
  } else {
    const errCss = validateCss(data);
    if (errCss) return fail(res, 400, errCss);
    dataStr = data.trim();
  }

  const priceNum = Number(price);
  const errPrice = validateAmount(priceNum);
  if (errPrice) return fail(res, 400, errPrice);

  let monthlyNum = 0;
  if (monthly_price !== undefined && monthly_price !== 0) {
    monthlyNum = Number(monthly_price);
    if (!Number.isInteger(monthlyNum) || monthlyNum < 1 || monthlyNum > WALLET_MAX) {
      return fail(res, 400, '订阅价格不合法');
    }
  }

  const itemId = db.createItem({
    name: name.trim(), type, price: priceNum, monthly_price: monthlyNum,
    data: data.trim(), file_name: '', file_size: 0, file_id: '',
    seller_id: null, deposit: 0,
  });
  ok(res, { id: itemId });
}

/** POST /api/admin/store/item/:id/toggle: 官方上/下架任意商品(下架不退还押金) */
async function handleAdminStoreToggle(req, res, segs) {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const itemId = Number(segs[4]);
  if (!Number.isInteger(itemId) || itemId <= 0) return fail(res, 400, '商品 ID 不合法');
  const item = db.getItemById(itemId);
  if (!item) return fail(res, 404, '商品不存在');

  const body = await parseJsonBody(req);
  if (body.status === 'disabled') db.disableItem(itemId);
  else if (body.status === 'active') db.enableItem(itemId);
  else return fail(res, 400, '状态不合法');
  ok(res, null);
}

/** PATCH /api/admin/store/items/:id: 快捷调整商品价格/名称(官方与卖家商品均可) */
async function handleAdminStoreUpdate(req, res, segs) {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const itemId = Number(segs[4]);
  if (!Number.isInteger(itemId) || itemId <= 0) return fail(res, 400, '商品 ID 不合法');
  if (!db.getItemById(itemId)) return fail(res, 404, '商品不存在');

  const body = await parseJsonBody(req);
  const fields = {};

  if (body.name !== undefined) {
    const err = validateItemName(body.name);
    if (err) return fail(res, 400, err);
    fields.name = body.name.trim();
  }
  if (body.price !== undefined) {
    const price = Number(body.price);
    const err = validateAmount(price);
    if (err) return fail(res, 400, err);
    fields.price = price;
  }
  if (body.monthly_price !== undefined) {
    const monthly = Number(body.monthly_price);
    if (!Number.isInteger(monthly) || monthly < 0 || monthly > WALLET_MAX) {
      return fail(res, 400, '订阅价格不合法');
    }
    fields.monthly_price = monthly;
  }
  // 限定发放开关: 单独写列(不走 updateItem 的 COALESCE), 允许仅传 limited
  let changed = Object.keys(fields).length > 0;
  if (body.limited !== undefined) {
    if (body.limited !== 0 && body.limited !== 1) return fail(res, 400, '限定开关只能为 0 或 1');
    db.setItemLimited(itemId, body.limited);
    changed = true;
  }
  // 限定领取条件(JSON 字符串, 如 {"ccb":500,"followers":10}): 空串=登录即领
  if (body.limited_conds !== undefined) {
    let conds = body.limited_conds;
    if (typeof conds === 'string' && conds.trim() !== '') {
      try {
        const parsed = JSON.parse(conds);
        const validKeys = ['ccb', 'followers', 'posts', 'comments'];
        for (const [k, v] of Object.entries(parsed)) {
          if (!validKeys.includes(k)) return fail(res, 400, '限定条件类型不合法');
          if (!Number.isInteger(v) || v < 1 || v > 9999999) return fail(res, 400, '限定阈值需为正整数');
        }
        conds = JSON.stringify(parsed);
      } catch {
        return fail(res, 400, '限定条件格式不正确(需为 JSON)');
      }
    } else {
      conds = '';
    }
    db.setItemLimitedConds(itemId, conds);
    changed = true;
  }

  if (!changed) return fail(res, 400, '没有需要修改的内容');
  if (Object.keys(fields).length > 0) db.updateItem(itemId, fields);
  ok(res, null);
}

function handleAdminConversations(req, res) {
  if (!requireAdmin(req, res)) return;
  ok(res, { conversations: db.getAdminConversations() });
}

/** GET /api/admin/items-all: 全量商品列表(含已下架, 管理页使用) */
function handleAdminItemsAll(req, res) {
  if (!requireAdmin(req, res)) return;
  const items = db.getAllItems();
  for (const item of items) {
    if (item.seller_id) {
      const sellerUser = db.getUserById(item.seller_id);
      item.seller_name = sellerUser ? sellerUser.username : '';
    }
  }
  ok(res, { items });
}

/** POST /api/admin/broadcast: 选中的官方 AI 批量发帖 + 群发私信(不调用 AI API) */
async function handleAdminBroadcast(req, res) {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const body = await parseJsonBody(req);
  const botIds = Array.isArray(body.bot_ids)
    ? [...new Set(body.bot_ids.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0))]
    : [];
  if (botIds.length === 0) return fail(res, 400, '请选择至少一个官方 AI');
  if (botIds.length > 10) return fail(res, 400, '一次最多选择 10 个官方 AI');
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  const err = validateContent(content);
  if (err) return fail(res, 400, err);

  // 校验全部为官方 AI
  const bots = [];
  for (const botId of botIds) {
    const bot = db.getBotByUserId(botId);
    if (!bot || bot.is_official !== 1) return fail(res, 400, `官方 AI 不存在(id=${botId})`);
    bots.push(bot);
  }
  const userIds = db.getAllHumanUserIds();
  const r = db.broadcastFromBots(botIds, userIds, content);
  const botNames = bots.map((b) => (db.getUserById(b.user_id) || {}).username || String(b.user_id));
  ok(res, { bots: botNames, users: userIds.length, posts: r.posts, messages: r.messages });
}

function handleAdminMessages(req, res) {
  if (!requireAdmin(req, res)) return;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const userA = db.findUserByUsername((url.searchParams.get('userA') || '').trim());
  const userB = db.findUserByUsername((url.searchParams.get('userB') || '').trim());
  if (!userA || !userB) return fail(res, 404, '用户不存在');
  ok(res, { messages: db.getAdminMessages(userA.id, userB.id) });
}

// ---------- 其他 ----------

function handleUserProfile(req, res, segs) {
  const username = decodeURIComponent(segs[2] || '');
  if (!username) return fail(res, 400, '用户名不合法');
  const url = new URL(req.url, `http://${req.headers.host}`);
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const viewer = currentUser(req);
  const result = db.getUserProfile(viewer ? viewer.id : 0, username, page, PAGE_SIZE);
  if (!result) return fail(res, 404, '用户不存在');
  ok(res, result);
}

function handleRecentUsers(req, res) {
  ok(res, { users: db.getRecentUsers(8) });
}

// ---------- 关注 / 通知 / 公告 ----------

/** POST /api/users/:username/follow: 关注/取消关注(切换) */
function handleToggleFollow(req, res, segs) {
  const user = requireUser(req, res);
  if (!user) return;
  const username = decodeURIComponent(segs[2] || '');
  const target = db.findUserByUsername(username);
  if (!target) return fail(res, 404, '用户不存在');
  if (target.id === user.id) return fail(res, 400, '不能关注自己');

  const following = !db.isFollowing(user.id, target.id);
  if (following) {
    db.followUser(user.id, target.id);
    // 关注奖励(额度与频率管理员可在管理页调整; 取关不扣回, 超上限/冷却中则不发放)
    const followReward = rewardValue('follow');
    const followedReward = rewardValue('followed');
    if (followReward > 0 && db.claimRewardFrequency(user.id, 'follow')) db.addWallet(user.id, followReward);
    if (followedReward > 0 && db.claimRewardFrequency(target.id, 'followed')) db.addWallet(target.id, followedReward);
    // 被关注通知(不通知机器人, 避免刷屏)
    if (target.account_type !== 'bot') {
      notify(target.id, user.id, 'follow', 'user', target.id, '关注了你');
    }
  } else {
    db.unfollowUser(user.id, target.id);
  }
  ok(res, {
    following,
    follower_count: db.getFollowerCount(target.id),
    following_count: db.getFollowingCount(user.id),
  });
}

/** GET /api/users/:username/following: 关注列表 */
function handleUserFollowing(req, res, segs) {
  const username = decodeURIComponent(segs[2] || '');
  const target = db.findUserByUsername(username);
  if (!target) return fail(res, 404, '用户不存在');
  ok(res, { users: db.getFollowingList(target.id) });
}

/** GET /api/users/:username/followers: 粉丝列表 */
function handleUserFollowers(req, res, segs) {
  const username = decodeURIComponent(segs[2] || '');
  const target = db.findUserByUsername(username);
  if (!target) return fail(res, 404, '用户不存在');
  ok(res, { users: db.getFollowersList(target.id) });
}

/** GET /api/notifications: 我的通知 */
function handleNotifications(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  ok(res, { notifications: db.getNotifications(user.id, 50) });
}

/** POST /api/notifications/read: 全部标记已读 */
function handleNotificationsRead(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  db.markAllNotificationsRead(user.id);
  ok(res, null);
}

/** GET /api/notifications/unread-count: 未读通知数(角标轮询) */
function handleNotificationsUnread(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  ok(res, { count: db.getUnreadNotificationCount(user.id) });
}

/** GET /api/announcements: 在售公告(无需登录) */
function handleAnnouncements(req, res) {
  ok(res, { announcements: db.getActiveAnnouncements(5) });
}

// ---------- 管理: 公告 ----------

/** GET /api/admin/announcements: 全部公告 */
function handleAdminAnnouncementsList(req, res) {
  const user = requireUser(req, res);
  if (!user || user.is_admin !== 1) return fail(res, 403, '仅管理员可操作');
  ok(res, { announcements: db.getAllAnnouncements() });
}

/** POST /api/admin/announcements {content}: 发布公告 */
async function handleAdminAnnouncementsCreate(req, res) {
  const user = requireUser(req, res);
  if (!user || user.is_admin !== 1) return fail(res, 403, '仅管理员可操作');
  const body = await parseJsonBody(req);
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (codePointLength(content) < 1 || codePointLength(content) > 500) {
    return fail(res, 400, '公告内容需为 1~500 个字符');
  }
  const id = db.createAnnouncement(sanitizeText(content));
  ok(res, { id });
}

/** POST /api/admin/announcements/:id/toggle {active}: 上/下架 */
async function handleAdminAnnouncementsToggle(req, res, segs) {
  const user = requireUser(req, res);
  if (!user || user.is_admin !== 1) return fail(res, 403, '仅管理员可操作');
  const id = Number(segs[3]);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, '公告 ID 不合法');
  const body = await parseJsonBody(req);
  const active = body.active === true || body.active === 1;
  if (!db.setAnnouncementActive(id, active)) return fail(res, 404, '公告不存在');
  ok(res, null);
}

/** DELETE /api/admin/announcements/:id: 删除公告 */
function handleAdminAnnouncementsDelete(req, res, segs) {
  const user = requireUser(req, res);
  if (!user || user.is_admin !== 1) return fail(res, 403, '仅管理员可操作');
  const id = Number(segs[3]);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, '公告 ID 不合法');
  if (!db.deleteAnnouncement(id)) return fail(res, 404, '公告不存在');
  ok(res, null);
}

function handleSearch(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const query = (url.searchParams.get('q') || '').trim();
  if (!query) return fail(res, 400, '搜索关键词不能为空');
  if (codePointLength(query) > 50) return fail(res, 400, '搜索关键词过长');
  const viewer = currentUser(req);
  const result = db.search(viewer ? viewer.id : 0, escapeLike(query), SEARCH_LIMIT);
  ok(res, result);
}

// ---------- AI 陪聊(机器人即真实用户, 服务端定时自动互动) ----------

/**
 * 读取管理员可调的 AI 互动设置(存 settings 表, 管理页"AI互动"Tab 可改)。
 * 空值或非法时返回默认值; 设置实时生效(每次互动触发时读取)。
 * @param {string} key 设置键
 * @param {string} def 默认值(字符串)
 * @returns {string}
 */
function aiSetting(key, def) {
  const v = db.getSetting(key);
  return v === '' || v === null ? def : v;
}

// ---------- CCB 互动奖励配置(管理员可在管理页调整, 存 settings 表, 实时生效) ----------
const REWARD_DEFAULTS = { daily: COIN_DAILY, post: COIN_POST, comment: COIN_COMMENT, liked: 2, like: 1, followed: 3, follow: 1 };
/** 读取某奖励的当前配置值(settings 表 reward_<key>), 非法/未设置时回退默认 */
function rewardValue(key) {
  const v = db.getSetting('reward_' + key);
  if (v === null || v === '') return REWARD_DEFAULTS[key];
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= WALLET_MAX ? n : REWARD_DEFAULTS[key];
}

// 奖励频率限制默认值(每日次数上限 cap 0=不限; 冷却间隔 cooldown 分钟 0=无)
const REWARD_FREQ_DEFAULTS = {
  post: { cap: 20, cooldown: 0 },
  comment: { cap: 50, cooldown: 0 },
  liked: { cap: 50, cooldown: 0 },
  like: { cap: 30, cooldown: 1 },
  followed: { cap: 50, cooldown: 0 },
  follow: { cap: 20, cooldown: 1 },
};
/** 读取奖励频率限制值(settings 表 reward_<key>_cap / _cooldown), 非法/未设置回退默认 */
function rewardFreq(key, field, fallback) {
  const v = db.getSetting(`reward_${key}_${field}`);
  if (v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/**
 * GET /api/admin/rewards: 读取 CCB 互动奖励配置(仅管理员)。
 * 返回 7 个额度键(daily/post/comment/liked/like/followed/follow),
 * 并为 6 个有频率限制的奖励补 _cap / _cooldown 键(daily 保持 1 次/天)。
 */
function handleAdminRewardsGet(req, res) {
  if (!requireAdmin(req, res)) return;
  const out = {};
  for (const key of Object.keys(REWARD_DEFAULTS)) out[key] = rewardValue(key);
  for (const key of Object.keys(REWARD_FREQ_DEFAULTS)) {
    out[`${key}_cap`] = rewardFreq(key, 'cap', REWARD_FREQ_DEFAULTS[key].cap);
    out[`${key}_cooldown`] = rewardFreq(key, 'cooldown', REWARD_FREQ_DEFAULTS[key].cooldown);
  }
  ok(res, out);
}

/**
 * POST /api/admin/rewards: 更新 CCB 互动奖励配置(仅管理员)。
 * body 可含: { daily?, post?, post_cap?, post_cooldown?, comment?, ... }
 * 额度 0~WALLET_MAX; cap 0~100000; cooldown 0~10080 分钟; 全部合法才写入。
 */
async function handleAdminRewardsPost(req, res) {
  if (!requireAdmin(req, res)) return;
  const body = await parseJsonBody(req);
  const patch = {};
  for (const key of Object.keys(REWARD_DEFAULTS)) {
    if (body[key] === undefined) continue;
    const n = Number(body[key]);
    if (!Number.isInteger(n) || n < 0 || n > WALLET_MAX) {
      return fail(res, 400, `奖励值需为 0~${WALLET_MAX} 的整数`);
    }
    patch[key] = String(n);
  }
  for (const key of Object.keys(REWARD_FREQ_DEFAULTS)) {
    for (const field of ['cap', 'cooldown']) {
      const bkey = `${key}_${field}`;
      if (body[bkey] === undefined) continue;
      const n = Number(body[bkey]);
      const max = field === 'cap' ? 100000 : 10080;
      if (!Number.isInteger(n) || n < 0 || n > max) {
        return fail(res, 400, field === 'cap' ? `${key} 上限需为 0~100000 的整数` : `${key} 冷却需为 0~10080 分钟的整数`);
      }
      patch[bkey] = String(n);
    }
  }
  for (const [k, v] of Object.entries(patch)) db.setSetting('reward_' + k, v);
  ok(res, { updated: Object.keys(patch) });
}

// ---------- 「关于」文案(settings about_text, 管理员可改) ----------
const ABOUT_DEFAULT = 'MicroX 是一个微型社交平台，仅依赖 Node.js 内置模块。支持发帖、评论、私信、CCB经济、商店、AI 陪聊、工单与举报。';
const ABOUT_MAX = 500;

/** GET /api/about: 公开读取「关于」文案(缺省用默认) */
function handleAbout(req, res) {
  const v = db.getSetting('about_text');
  ok(res, { text: v === null || v === '' ? ABOUT_DEFAULT : v });
}

/** POST /api/admin/about: 管理员更新「关于」文案 */
async function handleAdminAbout(req, res) {
  if (!requireAdmin(req, res)) return;
  const body = await parseJsonBody(req);
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return fail(res, 400, '「关于」内容不能为空');
  if (codePointLength(text) > ABOUT_MAX) return fail(res, 400, `「关于」内容最多 ${ABOUT_MAX} 字`);
  db.setSetting('about_text', text);
  ok(res, null);
}

// 互动扫描间隔(可通过环境变量覆盖, 默认 5 分钟; 测试用 ENGAGE_INTERVAL_MS=小值)
const ENGAGE_INTERVAL_MS = process.env.ENGAGE_INTERVAL_MS !== undefined ? Number(process.env.ENGAGE_INTERVAL_MS) : 5 * 60 * 1000;
// 每轮扫描上限, 防止刷屏
const ENGAGE_DM_MAX = 3;
const ENGAGE_COMMENT_MAX = 2;
const ENGAGE_POST_CANDIDATES = 6;
const ENGAGE_POST_MAX = 2;
// 机器人主动发帖: 每次扫描按概率尝试, 两次发帖最小间隔(默认 30 分钟; 测试可用环境变量调小)
const AI_POST_CHANCE = process.env.AI_POST_CHANCE !== undefined ? Number(process.env.AI_POST_CHANCE) : 0.3;
const AI_POST_INTERVAL_MS = process.env.AI_POST_INTERVAL_MS !== undefined ? Number(process.env.AI_POST_INTERVAL_MS) : 30 * 60 * 1000;

/** 机器人最近发帖时间(内存, botId -> timestamp), 用于发帖频率控制 */
const botLastPost = new Map();

// 机器人之间互动参数: 评论线程最大深度(超过则不再互相回复) / 私信概率与最小间隔
const BOT_THREAD_MAX = 4;
const BOT_DM_CHANCE = process.env.BOT_DM_CHANCE !== undefined ? Number(process.env.BOT_DM_CHANCE) : 0.2;
const BOT_DM_INTERVAL_MS = process.env.BOT_DM_INTERVAL_MS !== undefined ? Number(process.env.BOT_DM_INTERVAL_MS) : 20 * 60 * 1000;

/** 机器人最近主动私聊时间(内存, botId -> timestamp) */
const botLastDm = new Map();

// 机器人经济: 每日补给 / AI 打赏掉落限额
const BOT_DAILY_CCB = 5000;                    // 每日刷新给机器人的 CCB 数量
const BOT_TIP_MIN = 100;                       // AI 打赏单次下限
const BOT_TIP_MAX = 500;                       // AI 打赏单次上限(不给太多)
const BOT_TIP_COOLDOWN_MS = 10 * 60 * 1000;    // 同一用户打赏冷却(10 分钟)
const BOT_TIP_DAILY_MAX = 1500;                // 同一用户每日累计上限
// 兜底掉落: AI 未主动打赏时的小概率随机掉落(让"有可能会掉落"真实发生)
const BOT_TIP_FALLBACK_CHANCE = process.env.BOT_TIP_FALLBACK_CHANCE !== undefined ? Number(process.env.BOT_TIP_FALLBACK_CHANCE) : 0.15;
const BOT_TIP_FALLBACK_MIN = 100;
const BOT_TIP_FALLBACK_MAX = 300;
/** 每日补给记录(botId -> 日期) */
const botLastRefill = new Map();
/** 打赏节流记录(botId:userId -> { lastTs, day, dayTotal }) */
const botTipLog = new Map();

// 机器人购买饰品经济: 每机器人每日购物总支出上限(防用户诱导机器人反复买自家商品刷币)
const BOT_BUY_DAILY_MAX = 20000;
/** 购物节流记录(botId -> { day, dayTotal }) */
const botBuyLog = new Map();

/**
/**
 * 调用该机器人自带的 OpenAI/Claude 兼容接口。
 * 缓存友好设计:
 * - 前缀缓存只对跨调用字节一致的内容生效, 因此 system prompt 需"稳定在前、可变在后"
 *   (见 buildBotSystemPrompt, 调用方保证 messages[0] 为稳定 system)
 * - Anthropic 系 API: 给第一条 system 消息打显式缓存断点 cache_control
 *   (参考: Anthropic 官方 Prompt caching 文档, {"type":"ephemeral"} 5 分钟 TTL 自动续期)
 * - OpenAI 系 API: 自动前缀缓存(≥1024 tokens), 无需额外字段
 * - 解析 usage 中的缓存命中数字并打印, 便于观察命中率
 * @param {object} bot 机器人行(含 api_base_url/api_key/api_model)
 * @param {object[]} messages 消息数组(第一条为稳定 system)
 * @returns {Promise<string>} 回复文本
 */
// 图片扩展名 → MIME(多模态输入用)
const EXT_TO_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

/**
 * 读取 uploads/ 图片为 base64 data URL(多模态输入用)。
 * 文件不存在/格式不支持/超过 maxBytes 均返回空串(降级为纯文本)。
 * @param {string} filename uploads/ 下的文件名(如 msg_xxx.jpg)
 * @param {number} maxBytes 大小上限, 默认 1MB(避免超模型输入限制)
 * @returns {Promise<string>} data URL 或空串
 */
async function imageFileToDataUrl(filename, maxBytes = 1024 * 1024) {
  if (!filename) return '';
  const mime = EXT_TO_MIME[path.extname(filename).toLowerCase()];
  if (!mime) return '';
  try {
    const buf = await fs.promises.readFile(path.join(UPLOAD_DIR, filename));
    if (buf.length === 0 || buf.length > maxBytes) return '';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return '';
  }
}

/** 文本 + 可选图片 → OpenAI 多模态 content 数组; 无图时返回原文本字符串 */
function buildMultimodalContent(text, imageDataUrl) {
  if (!imageDataUrl) return text;
  return [
    { type: 'text', text },
    { type: 'image_url', image_url: { url: imageDataUrl } },
  ];
}

/** OpenAI content 数组 → Anthropic 格式(data URL → base64 image source) */
function toAnthropicContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (part && part.type === 'image_url' && part.image_url) {
      const url = String(part.image_url.url || '');
      const comma = url.indexOf(',');
      const meta = comma > 0 ? url.slice(0, comma) : '';
      const data = comma > 0 ? url.slice(comma + 1) : '';
      const mediaType = /^data:(image\/\w+);/i.test(meta) ? meta.match(/^data:(image\/\w+);/i)[1] : 'image/jpeg';
      return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
    }
    return part;
  });
}

async function callAi(bot, messages) {
  const isAnthropic = /anthropic/i.test(bot.api_base_url || '');
  const body = { model: bot.api_model, messages, max_tokens: 600, temperature: 0.9 };
  // SSRF 兜底: 即使配置时校验被绕过(如 DNS 重绑定), 调用前再拒绝内网/私网地址。
  if (!(await isSafeOutboundUrl(bot.api_base_url))) {
    throw new Error('机器人接口地址不允许访问内网/私网(防 SSRF)');
  }
  if (isAnthropic) {
    // 多模态: content 数组转 Anthropic image source; 显式缓存断点只打在稳定 system 消息上
    body.messages = messages.map((m, i) => ({
      ...m,
      content: toAnthropicContent(m.content),
      ...(i === 0 && m.role === 'system' ? { cache_control: { type: 'ephemeral' } } : {}),
    }));
  }
  const doFetch = () => fetch(`${bot.api_base_url.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${bot.api_key}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const res = await doFetch();
  if (!res.ok) {
    // 读取响应体, 把具体失败原因带回(401 Key无效 / 404 模型不存在 / 429 限流余额不足等)
    let reason = `AI 服务响应异常(${res.status})`;
    try {
      const data = await res.json();
      const detail = (data && data.error && (data.error.message || data.error)) || (data && data.message) || '';
      if (detail) reason = `${reason}: ${String(detail).slice(0, 200)}`;
    } catch { /* 无响应体 */ }
    throw new Error(reason);
  }
  const data = await res.json();
  // 缓存命中统计: OpenAI 系用法 prompt_tokens_details.cached_tokens, Anthropic 系用法 cache_read_input_tokens
  const usage = data.usage || {};
  const cachedTokens = (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens)
    || usage.cache_read_input_tokens || 0;
  if (cachedTokens > 0) console.log(`[ai] ${bot.username} 前缀缓存命中 ${cachedTokens} tokens`);
  const reply = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (typeof reply !== 'string' || !reply.trim()) throw new Error('AI 返回内容为空');
  return reply.slice(0, 2000);
}

/** 机器人的默认人设兜底 */
function botPersona(bot) {
  return (bot.persona || '你是一个友好、热情、愿意陪伴聊天的助手。用简体中文回复，保持亲切自然的语气。').slice(0, 2000);
}

const STORE_TYPE_NAME = { avatar_frame: '头像框', chat_bubble: '聊天气泡', title: '头衔', file: '数据文件' };

/**
 * 构建商城商品上下文: 在售商品(官方优先, 最多 20 条)注入 system prompt,
 * 让 AI 知道商城有什么可卖, 可向用户介绍或推荐;
 * 每条附带商品 ID(方括号), 供 AI 用 [BUY:ID]/[EQUIP:ID] 标记表达购买/佩戴意图。
 * @returns {string} 商城上下文文本(无商品时返回空串)
 */
function buildStoreContext() {
  const items = db.getActiveItems('');
  if (items.length === 0) return '';
  const list = items
    .sort((a, b) => (a.seller_id === null ? -1 : 1) - (b.seller_id === null ? -1 : 1))
    .slice(0, 20);
  const lines = list.map((it) => {
    const sub = it.monthly_price > 0 ? ', 订阅 ' + it.monthly_price + ' CCB/月' : '';
    const owner = it.seller_id ? '用户' : '官方';
    // 饰品(头像框/气泡/头衔)可购买并佩戴; 文件商品机器人不参与
    const usable = it.type !== 'file' ? ', 可购买并佩戴' : '';
    return '- [ID ' + it.id + '] ' + it.name + '(' + (STORE_TYPE_NAME[it.type] || it.type) + ', ' + owner + ') 买断 ' + it.price + ' CCB' + sub + usable;
  });
  return '\n\n【商城在售商品(商品 ID 见方括号; 你有自己的 CCB 钱包, 可购买"饰品"类商品并佩戴, 也可向用户介绍或推荐)】\n' + lines.join('\n');
}

/**
 * 计费检查与扣费。
 * 规则: 创建者与自己机器人聊天免费; per_reply 按条扣费; subscription 首条自动订阅 30 天。
 * @returns {object} { ok, note? } ok=false 时不回复并回提示消息
 */
function chargeForReply(bot, senderId) {
  // AI 之间的互动免费(机器人发送者不消耗CCB)
  if (db.getBotByUserId(senderId)) return { ok: true };
  if (bot.pricing_type === 'free' || senderId === bot.creator_id) return { ok: true };
  if (bot.pricing_type === 'per_reply') {
    if (db.getWallet(senderId) < bot.price_per_reply) {
      return { ok: false, note: `（回复需要 ${bot.price_per_reply} CCB/条，余额不足）` };
    }
    db.addWallet(senderId, -bot.price_per_reply);
    // 官方模型收入归平台, 不发放给创建者
    if (!bot.is_official) db.addWallet(bot.creator_id, bot.price_per_reply);
    return { ok: true };
  }
  // hybrid(订阅+按条): 已订阅免费; 未订阅按条扣费; 未设按条价则提示购买订阅
  if (bot.pricing_type === 'hybrid') {
    if (db.hasActiveBotSub(senderId, bot.user_id)) return { ok: true };
    if (bot.price_per_reply < 1) {
      return { ok: false, note: '（请先在商店购买订阅，即可开始陪聊）' };
    }
    if (db.getWallet(senderId) < bot.price_per_reply) {
      return { ok: false, note: `（回复需要 ${bot.price_per_reply} CCB/条，余额不足；也可在商店购买订阅更划算）` };
    }
    db.addWallet(senderId, -bot.price_per_reply);
    // 官方模型收入归平台, 不发放给创建者
    if (!bot.is_official) db.addWallet(bot.creator_id, bot.price_per_reply);
    return { ok: true };
  }
  // subscription: 必须先购买订阅(在商店购买), 未购买则提示
  if (!db.hasActiveBotSub(senderId, bot.user_id)) {
    return { ok: false, note: '（请先在商店购买订阅，即可开始陪聊）' };
  }
  return { ok: true };
}

/** 每日补给: 为每个启用机器人累加 CCB(每天一次, 累加而非重置, 允许机器人攒钱买高价商品) */
function refillBotWallets() {
  const today = todayUtc().slice(0, 10);
  for (const bot of db.getActiveBots()) {
    if (botLastRefill.get(bot.user_id) !== today) {
      db.addWallet(bot.user_id, BOT_DAILY_CCB);
      botLastRefill.set(bot.user_id, today);
      console.log('[ai]', bot.username, `每日补给 +${BOT_DAILY_CCB} CCB`);
    }
  }
}

/** 从 AI 回复中解析打赏标记 [TRANSFER:n] */
function parseBotTip(text) {
  const m = text.match(/\[TRANSFER:(\d+)\]/);
  if (!m) return { text, amount: 0 };
  return { text: text.replace(/\[TRANSFER:\d+\]/, '').trim(), amount: Number(m[1]) };
}

/** 打赏节流检查: 冷却期内 / 每日超限则拒绝 */
function canBotTip(botId, userId) {
  const now = Date.now();
  const day = todayUtc().slice(0, 10);
  const log = botTipLog.get(`${botId}:${userId}`) || { lastTs: 0, day, dayTotal: 0 };
  if (log.day !== day) { log.day = day; log.dayTotal = 0; }
  if (now - log.lastTs < BOT_TIP_COOLDOWN_MS) return false;
  if (log.dayTotal + BOT_TIP_MAX > BOT_TIP_DAILY_MAX) return false;
  return true;
}

/**
 * 执行 AI 打赏(机器人 -> 用户), 含限额/钱包/流水。
 * @returns {boolean} 是否成功
 */
function doBotTip(bot, userId, amount) {
  if (!Number.isInteger(amount) || amount < BOT_TIP_MIN || amount > BOT_TIP_MAX) return false;
  // 创建者也可获得掉落(用户与自己 AI 互动同样有掉落体验);
  // 防滥用由冷却/每日上限兜底, 机器人之间仍互不打赏
  if (db.getBotByUserId(userId)) return false; // 不给机器人, 掉落仅面向人类用户
  if (!canBotTip(bot.user_id, userId)) return false;
  if (db.getWallet(bot.user_id) < amount) return false;
  db.addWallet(bot.user_id, -amount);
  db.addWallet(userId, amount);
  db.recordTransfer(bot.user_id, userId, amount);
  const day = todayUtc().slice(0, 10);
  const log = botTipLog.get(`${bot.user_id}:${userId}`) || { lastTs: 0, day, dayTotal: 0 };
  if (log.day !== day) { log.day = day; log.dayTotal = 0; }
  log.lastTs = Date.now();
  log.dayTotal += amount;
  botTipLog.set(`${bot.user_id}:${userId}`, log);
  return true;
}

/**
 * 从 AI 回复中解析购买/佩戴饰品标记 [BUY:商品ID] / [EQUIP:商品ID]。
 * 与 [TRANSFER:n] 同风格: AI 在回复中附加标记表达意图, 服务端解析后从正文剥离。
 * 容错: 容忍空格与全角冒号(如 [BUY: 1]、[EQUIP：2])。
 * @param {string} text AI 原始回复
 * @returns {object} { text: 剥离标记后的正文, buy: 要购买的商品ID(0=无), equip: 要佩戴的商品ID(0=无) }
 */
// 机器人点赞节流: 每个机器人每日点赞总上限(防 AI 无节制点赞刷屏/刷 CCB 奖励)
const BOT_LIKE_DAILY_MAX = 30;
/** 点赞节流记录(botId -> { day, count }) */
const botLikeLog = new Map();

/**
 * 解析 AI 评论中的点赞动作标记:
 *   [LIKE:帖子ID]    → 给帖子点赞(可多个)
 *   [CLIKE:评论ID]   → 给评论点赞(可多个)
 * 返回剥离标记后的文本与意图 ID 数组(去重); 与 [BUY]/[STOCKBUY] 等标记风格一致。
 * @param {string} text AI 生成的评论原文
 * @returns {{ text: string, likePosts: number[], likeComments: number[] }}
 */
function parseBotLikeActions(text) {
  const likePosts = [];
  const likeComments = [];
  let t = String(text).replace(/\[LIKE\s*[:：]\s*(\d+)\]/g, (_m, id) => { likePosts.push(Number(id)); return ''; });
  t = t.replace(/\[CLIKE\s*[:：]\s*(\d+)\]/g, (_m, id) => { likeComments.push(Number(id)); return ''; });
  return {
    text: t.trim(),
    likePosts: [...new Set(likePosts)],
    likeComments: [...new Set(likeComments)],
  };
}

/**
 * 机器人点赞(帖子 / 评论), 复用人类点赞逻辑(db.toggleLike / toggleCommentLike)。
 * 限制:
 * - 不能给自己(机器人)的帖子点赞
 * - 每日总点赞次数上限 BOT_LIKE_DAILY_MAX(与打赏/购物节流同思路)
 * - 重复点赞/取消由 toggle 逻辑自行处理; 不存在对象直接跳过
 * @param {object} bot 机器人行
 * @param {number[]} likePosts 要点赞的帖子 ID 列表
 * @param {number[]} likeComments 要点赞的评论 ID 列表
 */
function botLike(bot, likePosts, likeComments) {
  const day = todayUtc().slice(0, 10);
  const log = botLikeLog.get(bot.user_id) || { day, count: 0 };
  if (log.day !== day) { log.day = day; log.count = 0; }

  for (const postId of likePosts) {
    if (log.count >= BOT_LIKE_DAILY_MAX) break;
    const post = db.getPostById(postId);
    // 不存在或自己的帖子不点赞(避免无意义自赞)
    if (post && post.user_id !== bot.user_id) {
      const r = db.toggleLike(bot.user_id, postId);
      if (r && r.liked) {
        log.count++;
        console.log('[ai]', bot.username || ('bot#' + bot.user_id), '点赞帖子', postId);
      }
    }
  }
  for (const commentId of likeComments) {
    if (log.count >= BOT_LIKE_DAILY_MAX) break;
    const r = db.toggleCommentLike(bot.user_id, commentId);
    if (r && r.liked) {
      log.count++;
      console.log('[ai]', bot.username || ('bot#' + bot.user_id), '点赞评论', commentId);
    }
  }
  botLikeLog.set(bot.user_id, log);
}

function parseBotStoreActions(text) {
  let buy = 0;
  let equip = 0;
  let t = String(text).replace(/\[BUY\s*[:：]\s*(\d+)\]/g, (_m, id) => { buy = Number(id); return ''; });
  t = t.replace(/\[EQUIP\s*[:：]\s*(\d+)\]/g, (_m, id) => { equip = Number(id); return ''; });
  return { text: t.trim(), buy, equip };
}

/**
 * 机器人用自己的 CCB 购买商城饰品(头像框/聊天气泡/头衔)。
 * 与人类购买共用 user_items / 货款结算逻辑, 额外限制:
 * - 仅限饰品, 排除 file 文件商品(机器人不参与文件交易)
 * - 已拥有不重复购买
 * - 每日购物总支出上限 BOT_BUY_DAILY_MAX(防用户诱导机器人反复买自家商品刷币)
 * @param {object} bot 机器人行
 * @param {number} itemId 商品 ID
 * @returns {object} { ok, error? } ok=true 时商品已入账(买断)
 */
function botBuyItem(bot, itemId) {
  const item = db.getItemById(itemId);
  if (!item || item.status !== 'active') return { ok: false, error: '商品不存在或已下架' };
  if (item.type === 'file') return { ok: false, error: '机器人不能购买文件商品' };
  if (db.hasActiveItem(bot.user_id, itemId)) return { ok: false, error: '已拥有该商品' };

  // 钱包余额不足直接拒绝(先于预算检查, 提示更准确)
  if (db.getWallet(bot.user_id) < item.price) return { ok: false, error: 'CCB不足' };
  // 每日购物预算: 按日重置(与打赏节流同思路)
  const day = todayUtc().slice(0, 10);
  const log = botBuyLog.get(bot.user_id) || { day, dayTotal: 0 };
  if (log.day !== day) { log.day = day; log.dayTotal = 0; }
  if (log.dayTotal + item.price > BOT_BUY_DAILY_MAX) return { ok: false, error: '今日购物预算已达上限' };

  db.addWallet(bot.user_id, -item.price);
  db.insertUserItem(bot.user_id, itemId, 'buy', null);
  db.incrementSales(itemId);
  // 卖家商品货款入卖家钱包; 官方商品 CCB 回收(与人类购买一致)
  if (item.seller_id) db.addWallet(item.seller_id, item.price);
  log.dayTotal += item.price;
  botBuyLog.set(bot.user_id, log);
  return { ok: true };
}

/**
 * 机器人佩戴已拥有的饰品(头像框/聊天气泡/头衔)。
 * 与人类 /api/equip 同逻辑: 样式直接写入机器人用户行, 全站(帖子/私信/主页)自动展示。
 * @param {object} bot 机器人行
 * @param {number} itemId 商品 ID
 * @returns {object} { ok, error? }
 */
function botEquipItem(bot, itemId) {
  const item = db.getItemById(itemId);
  if (!item || item.type === 'file') return { ok: false, error: '该商品不可佩戴' };
  if (!db.hasActiveItem(bot.user_id, itemId)) return { ok: false, error: '尚未拥有该商品' };
  if (item.type === 'avatar_frame') db.updateFrameCss(bot.user_id, item.data);
  else if (item.type === 'chat_bubble') db.updateBubbleCss(bot.user_id, item.data);
  else if (item.type === 'title') db.updateTitle(bot.user_id, item.name, item.data, item.id);
  return { ok: true };
}

// ---------- 股票市场(仅官方发行, 股票归属 MicroX) ----------

// 行情跳动间隔(默认 5 分钟; 测试可用环境变量调小)
const STOCK_TICK_MS = process.env.STOCK_TICK_MS !== undefined ? Number(process.env.STOCK_TICK_MS) : 5 * 60 * 1000;
const STOCK_FEE_RATE = 0.01;    // 买卖手续费率(1%, 燃烧回收, 冲抵随机涨跌造成的通胀)
const STOCK_FEE_MIN = 1;        // 单笔手续费下限(CCB)
const STOCK_ORDER_MAX = 1000;   // 单笔最大股数
const STOCK_PRICE_MIN = 1;      // 现价下限(行情随机游走边界)
const STOCK_PRICE_MAX = 10000;  // 现价上限(行情随机游走边界)
const STOCK_ISSUE_MIN = 10;     // 官方发行价下限
const STOCK_ISSUE_MAX = 1000;   // 官方发行价上限(防单只市值过大)
const STOCK_DAY_LIMIT = 0.1;    // 每日涨跌停 ±10%(对照昨收, A 股风格)
const STOCK_VOL_MIN = 0.005;    // 波动率下限
const STOCK_VOL_MAX = 0.1;      // 波动率上限
const AI_TRADE_DAILY_MAX = 1000; // AI 每日股票交易额上限(买/卖合计)
const AI_TRADE_CHANCE = 0.3;    // 每轮行情跳动 AI 参与交易的概率
// 用户交易节流: 同一股票冷却 + 每日笔数/成交额上限(防脚本刷单套利)
const STOCK_USER_COOLDOWN_MS = 5 * 1000;    // 同一用户同一股票买卖冷却(5 秒)
const STOCK_USER_DAILY_MAX = 50;            // 每用户每日交易笔数上限
const STOCK_USER_DAILY_TURNOVER = 50000;    // 每用户每日成交额上限(买+卖合计, CCB)
const userTradeLog = new Map();             // `${userId}:${stockId}` -> 冷却时间戳; `${userId}:day` -> 当日统计

/** 当前行情交易日(UTC 日期), 跨日时以现价重置全部昨收 */
let stockDay = todayUtc().slice(0, 10);

/** AI 交易节流记录(botId -> { day, dayTotal }) */
const aiTradeLog = new Map();

/** 读取 AI 当日股票交易额记录(跨日自动重置), 用于跟盘与对话内买卖共用限流 */
function aiTradeState(botUserId) {
  const day = todayUtc().slice(0, 10);
  const log = aiTradeLog.get(botUserId) || { day, dayTotal: 0 };
  if (log.day !== day) { log.day = day; log.dayTotal = 0; }
  return log;
}

/** 判断 AI 当日股票交易额是否还能再花 amount, 并记账(返回是否允许) */
function aiTradeSpend(botUserId, amount) {
  const log = aiTradeState(botUserId);
  if (log.dayTotal + amount > AI_TRADE_DAILY_MAX) return false;
  log.dayTotal += amount;
  aiTradeLog.set(botUserId, log);
  return true;
}

/**
 * 构建股票市场上下文(供 AI 在对话中看到行情并决定买卖)。
 * 注意: 行情价格每 10 分钟变动, 必须放在"可变"区(buildBotSystemPrompt 的 variable),
 * 否则会破坏稳定前缀的缓存命中。
 * @returns {string} 行情文本(无股票时返回空串)
 */
function buildStockContext() {
  const stocks = db.getActiveStocks().slice(0, 8);
  if (stocks.length === 0) return '';
  const lines = stocks.map((s) => {
    const creator = db.getUserById(s.created_by);
    const tag = s.is_ai ? `(AI公司${creator ? '·' + creator.username : ''})` : (creator && creator.id !== 0 ? `(创建者@${creator.username})` : '(官方)');
    return `- [股票ID ${s.id}] ${s.name} 现价 ${s.price} CCB/股${tag}`;
  });
  return `【股票市场行情(现价 CCB/股, 可用 CCB 买卖)】\n` + lines.join('\n');
}

/** 机器人当前股票持仓摘要(供 AI 决策卖出/了解自己身家) */
function buildBotPortfolioContext(bot) {
  const parts = [];
  const holds = db.getUserHoldings(bot.user_id);
  for (const h of holds.slice(0, 5)) {
    parts.push(`你持有 ${h.name}(ID ${h.stock_id}) ${h.shares} 股, 市值约 ${h.shares * h.price} CCB`);
  }
  return parts.length > 0 ? `【你的股票资产】\n` + parts.join('\n') : '';
}

/**
 * 从 AI 回复中解析股票交易标记 [STOCKBUY:股票ID:股数] / [STOCKSELL:股票ID:股数]。
 * 容错: 支持空格与全角冒号; 股数可省略(默认 100 股)。
 * @param {string} text AI 回复正文
 * @returns {object} { text, buyId, buyShares, sellId, sellShares } 无交易时 ID 为 0
 */
function parseBotStockActions(text) {
  let buyId = 0;
  let buyShares = 0;
  let sellId = 0;
  let sellShares = 0;
  let t = String(text).replace(/\[STOCKBUY\s*[:：]\s*(\d+)(?:\s*[:：]\s*(\d+))?\]/g, (_m, id, shares) => {
    buyId = Number(id);
    buyShares = Number(shares) || 100;
    return '';
  });
  t = t.replace(/\[STOCKSELL\s*[:：]\s*(\d+)(?:\s*[:：]\s*(\d+))?\]/g, (_m, id, shares) => {
    sellId = Number(id);
    sellShares = Number(shares) || 100;
    return '';
  });
  return { text: t.trim(), buyId, buyShares, sellId, sellShares };
}

/** 跨日滚动: 每日开盘把昨收更新为前一日的收盘价(涨跌停基准) */
function rollStockDay() {
  const day = todayUtc().slice(0, 10);
  if (day === stockDay) return;
  stockDay = day;
  for (const s of db.getActiveStocks()) db.setStockPrevClose(s.id, s.price);
}

/**
 * 买入股票(做市商模型: 按现价成交, 直接增发股份, 保证随时可买)。
 * 手续费 = 成交额 × 1%(最低 1 CCB), 燃烧回收。
 * @returns {object} { ok, error?, shares, amount, fee }
 */
function buyStock(userId, stockId, shares) {
  if (!Number.isInteger(shares) || shares < 1 || shares > STOCK_ORDER_MAX) {
    return { ok: false, error: `单笔需买入 1~${STOCK_ORDER_MAX} 股` };
  }
  const stock = db.getStockById(stockId);
  if (!stock || !stock.enabled) return { ok: false, error: '股票不存在或已停牌' };
  return db.runInTransaction(() => {
    const amount = shares * stock.price;
    const fee = Math.max(STOCK_FEE_MIN, Math.round(amount * STOCK_FEE_RATE));
    if (db.getWallet(userId) < amount + fee) return { ok: false, error: 'CCB不足' };
    db.addWallet(userId, -(amount + fee));
    // 加权平均成本: 新成本 = (旧股数×旧成本 + 本次买入额) / 新股数(手续费不计入成本)
    const oldShares = db.getHolding(userId, stockId);
    const oldAvg = oldShares > 0 ? db.getHoldingAvg(userId, stockId) : 0;
    const newAvg = oldShares > 0 ? Math.round((oldShares * oldAvg + amount) / (oldShares + shares)) : stock.price;
    db.setHolding(userId, stockId, oldShares + shares, newAvg);
    // 无交易冲击: 买卖按同一现价成交, 价格只由行情随机游走驱动(防自成交套利)
    db.setStockSharesOut(stockId, stock.shares_out + shares);
    db.addStockVolume(stockId, shares);
    db.recordTrade(stockId, userId, 'buy', shares, stock.price, fee);
    return { ok: true, shares, amount, fee };
  });
}

/**
 * 卖出股票(做市商模型: 按现价变现, 注销股份)。
 * @returns {object} { ok, error?, shares, amount, fee }
 */
function sellStock(userId, stockId, shares) {
  if (!Number.isInteger(shares) || shares < 1 || shares > STOCK_ORDER_MAX) {
    return { ok: false, error: `单笔需卖出 1~${STOCK_ORDER_MAX} 股` };
  }
  const stock = db.getStockById(stockId);
  if (!stock || !stock.enabled) return { ok: false, error: '股票不存在或已停牌' };
  return db.runInTransaction(() => {
    const hold = db.getHolding(userId, stockId);
    if (hold < shares) return { ok: false, error: '持仓不足' };
    const amount = shares * stock.price;
    const fee = Math.max(STOCK_FEE_MIN, Math.round(amount * STOCK_FEE_RATE));
    // 卖出: 成本不变, 只减股数(盈亏在持仓展示中按实时价格浮动计算)
    db.setHolding(userId, stockId, hold - shares, db.getHoldingAvg(userId, stockId));
    db.addWallet(userId, amount - fee);
    // 无交易冲击: 按同一现价成交, 价格只由行情随机游走驱动
    db.setStockSharesOut(stockId, Math.max(0, stock.shares_out - shares));
    db.addStockVolume(stockId, shares);
    db.recordTrade(stockId, userId, 'sell', shares, stock.price, fee);
    return { ok: true, shares, amount, fee };
  });
}

/** 价格夹紧: 全局上下限 + 每日 ±10% 涨跌停(对照昨收) */
function clampPrice(stock, p) {
  p = Math.max(STOCK_PRICE_MIN, Math.min(STOCK_PRICE_MAX, p));
  const lo = Math.round(stock.prev_close * (1 - STOCK_DAY_LIMIT));
  const hi = Math.round(stock.prev_close * (1 + STOCK_DAY_LIMIT));
  return Math.max(lo, Math.min(hi, p));
}

/** 单次行情跳动: 随机游走 + 涨跌停夹紧(买卖不改变价格, 杜绝自成交套利) */
function tickOneStock(stock) {
  // 中心在 0 的随机游走: 幅度由波动率决定(最大单跳为波动率)
  const drift = (Math.random() - 0.5) * 2 * stock.volatility;
  const p = clampPrice(stock, Math.round(stock.price * (1 + drift)));
  if (p !== stock.price) {
    db.updateStockPrice(stock.id, p);
    db.insertTick(stock.id, p);
  }
  return p;
}

/** 全市场行情跳动 + AI 机器人跟盘交易 */
async function stockTickAll() {
  rollStockDay();
  for (const stock of db.getActiveStocks()) tickOneStock(stock);
  aiTradeAll();
}

/** AI 机器人跟盘: 均值回归(跌了买、涨了卖), 单日交易额上限防刷币 */
function aiTradeAll() {
  const bots = db.getActiveBots();
  const stocks = db.getActiveStocks();
  if (bots.length === 0 || stocks.length === 0) return;
  for (const bot of bots) {
    if (Math.random() >= AI_TRADE_CHANCE) continue;
    const log = aiTradeState(bot.user_id);
    if (log.dayTotal >= AI_TRADE_DAILY_MAX) continue;
    const stock = stocks[Math.floor(Math.random() * stocks.length)];
    // 涨跌方向: 对比"当前价"与"前一跳价格"(最新 tick 即现价, 不能拿来自比)
    const ticks = db.getTicks(stock.id, 3);
    const budget = AI_TRADE_DAILY_MAX - log.dayTotal;
    if (ticks.length >= 2) {
      const prev = ticks[ticks.length - 2].price;
      if (stock.price < prev) {
        // 跌了 -> 买入(不超过钱包余额与日交易额上限)
        const afford = Math.min(db.getWallet(bot.user_id), budget);
        const shares = Math.max(1, Math.floor(afford / stock.price));
        if (shares > 0) {
          const r = buyStock(bot.user_id, stock.id, Math.min(shares, STOCK_ORDER_MAX));
          if (r.ok) aiTradeSpend(bot.user_id, r.amount);
        }
      } else {
        // 涨了 -> 卖出约 20% 持仓落袋
        const hold = db.getHolding(bot.user_id, stock.id);
        if (hold > 0) {
          const r = sellStock(bot.user_id, stock.id, Math.max(1, Math.min(Math.floor(hold * 0.2), STOCK_ORDER_MAX)));
          if (r.ok) aiTradeSpend(bot.user_id, r.amount);
        }
      }
    }
  }
}


/** 官方陪聊 Kita 已移除(2026-08-06): 不再自动预置官方陪聊, 现有数据库请手动清理 */

/**
 * 异步压缩更新长期记忆(旧摘要 + 最近对话 -> 新摘要) */
async function updateBotMemory(bot, senderId) {
  const old = db.getBotMemory(bot.user_id, senderId);
  const history = db.getMessagesWith(senderId, bot.user_id, 0).slice(-10);
  if (history.length === 0) return;
  const lines = history.map((m) => `${m.sender_id === bot.user_id ? '你' : '用户'}: ${m.content.slice(0, 200)}`);
  const prompt = '请把以下对话压缩成一段简洁的长期记忆(最多200字, 简体中文), 保留用户的重要事实/偏好/你们的关系。'
    + (old ? `\n已有记忆: ${old}` : '')
    + `\n最近对话:\n${lines.join('\n')}`;
  const memory = await callAi(bot, [{ role: 'user', content: prompt }]);
  db.setBotMemory(bot.user_id, senderId, memory.slice(0, 500));
}

/**
 * 构建机器人的 system prompt(缓存友好: 稳定前缀与可变后缀分离)。
 * 前缀缓存(OpenAI 自动 / Anthropic cache_control 断点)只对"跨调用字节一致"的前缀生效:
 * - stable(人设+商城+规则): 跨调用不变, 必须放在最前, 是缓存命中的主体
 * - variable(长期记忆+转账记录): 每次对话都变, 单独放末尾的 system 消息, 不破坏前缀
 * 调用方把 stable 作为 messages[0], variable 作为独立的后续 system 消息发送。
 * @param {object} bot 机器人行
 * @param {number} senderId 对话用户 ID
 * @returns {object} { stable, variable } stable 为稳定前缀文本, variable 为可变上下文文本(可能为空串)
 */
function buildBotSystemPrompt(bot, senderId) {
  // 稳定前缀: 人设 + 商城上下文(仅商品列表变化时才变, 低频) + 行为规则
  let stable = botPersona(bot);
  stable += buildStoreContext();
  stable += `\n\n【你必须遵守的规则】\n`
    + `1. 如果聊得开心, 你可以主动给用户打赏 CCB, 这是平台允许的行为。\n`
    + `2. 单次打赏金额为 ${BOT_TIP_MIN}~${BOT_TIP_MAX} CCB, 不要一次给太多, 也不要过于频繁(同一用户 10 分钟内最多打赏一次)。\n`
    + `3. 若决定打赏, 必须在回复的最末尾附加标记 [TRANSFER:金额](例如 [TRANSFER:20]), 不要遗漏。\n`
    + `4. 是否打赏完全由你根据对话氛围决定, 不打赏也完全正常。`;
  stable += `\n\n【饰品购买规则(你有自己的 CCB 钱包, 每日自动补给 5000 CCB)】\n`
    + `1. 你可以自主购买商城饰品(头像框/聊天气泡/头衔, 见上方商品列表, ID 在方括号里)并佩戴, 让自己更有个性。\n`
    + `2. 当用户强烈推荐某个饰品给你时(例如"你快去买那个XX戴上"或"你戴上那个更好看"), 你应该优先购买并佩戴它。\n`
    + `3. 若决定购买并佩戴某商品, 在回复最末尾附加标记 [BUY:商品ID](购买后会自动佩戴); 若只想佩戴已经拥有的商品, 用 [EQUIP:商品ID]。\n`
    + `4. 购物预算有限(每日最多 ${BOT_BUY_DAILY_MAX} CCB), 理性消费, 不要为了迎合用户浪费 CCB; 商品标记可省略, 是否购买完全由你决定。\n`
    + `5. 诚实原则: 如果钱包/预算不够买某商品, 必须如实告诉用户"暂时买不起", 绝对禁止在没有实际买成功的情况下声称自己已经购买或佩戴。`;
  stable += `\n\n【股票交易规则(你有自己的 CCB 钱包, 可买卖股票, 行情见下方上下文)】\n`
    + `1. 你可以自主用 CCB 买卖股票, 若用户强烈推荐某支股票(如"你快去买XX的股票"), 应优先考虑买入。\n`
    + `2. 若要买入, 回复最末尾附加标记 [STOCKBUY:股票ID:股数](如 [STOCKBUY:3:20], 股数 1~1000, 先看钱包余额再定股数); 若要卖出持仓, 用 [STOCKSELL:股票ID:股数]。\n`
    + `3. 每日股票交易额上限 ${AI_TRADE_DAILY_MAX} CCB, 理性投资, 不要盲目梭哈。\n`
    + `4. 诚实原则: 交易失败(余额不足/超限等)时如实告诉用户, 禁止谎称已买入或卖出。`;
  // 可变后缀: 长期记忆 + 转账记录(每次对话都不同, 放到独立 system 消息, 保护前缀缓存)
  const memory = db.getBotMemory(bot.user_id, senderId);
  const tx = db.getTransfersBetween(senderId, bot.user_id, 8);
  let variable = '';
  if (memory) variable += `【你对这位用户的长期记忆】\n${memory}\n`;
  if (tx.length) {
    variable += `【你们之间的CCB转账记录(最近)】\n`
      + tx.map((t) => t.sender_id === bot.user_id ? `你转给用户 ${t.amount} CCB` : `用户转给你 ${t.amount} CCB`).join('\n');
  }
  // 行情/持仓/钱包(价格随行情变动, 必须放可变区保护稳定前缀缓存)
  variable += `\n你的钱包余额: ${db.getWallet(bot.user_id)} CCB。\n`;
  const stockCtx = buildStockContext();
  if (stockCtx) variable += stockCtx + '\n';
  const portfolio = buildBotPortfolioContext(bot);
  if (portfolio) variable += portfolio + '\n';
  return { stable, variable: variable.trim() };
}

/** 取对话历史中的最后一条用户消息(即触发回复的输入), 不存在返回 null */
function lastUserInput(bot, history) {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].sender_id !== bot.user_id) return history[i];
  }
  return null;
}

/**
 * 语义缓存查询(命中返回纯文本回复, 未命中返回 null)。
 * 命中条件: 对话最后一条是用户消息(即当前输入), 且消息短、不含动态敏感词
 * (敏感词在 key 生成与写入时双重把关, 见 ai-cache.js)。
 * 两级命中:
 *   1) 精确: 纯文本归一化 key 直接命中("你是谁?" 与 "你是谁");
 *   2) 语义(深度归一化, 管理页可关 ai_semantic_deep): 未命中时用 LLM 把消息标准化
 *      ("介绍一下你自己"→"你是谁"), 复用已存的 canonical 避免重复归一化调用。
 * 多轮对话中用户重复问同一问题也能命中; 动态数据(钱包/行情)由敏感词拦截。
 */
async function semanticCacheReply(bot, history) {
  const input = lastUserInput(bot, history);
  if (!input) return null;
  const msg = input.content;
  if (semanticCache.isDynamic(msg)) return null;
  const key = semanticCache.semanticCacheKey(bot.user_id, msg);
  if (!key) return null;
  let hit = semanticCache.semanticLookup(bot.user_id, key);
  // 语义命中: 先复用已存 canonical, 没有再调轻量 LLM 归一化
  if (!hit && aiSetting('ai_semantic_deep', '1') === '1') {
    const canonical = semanticCache.semanticGetCanonical(bot.user_id, key) || (await canonicalizeMessage(bot, msg));
    if (canonical) {
      const ckey = semanticCache.semanticCacheKey(bot.user_id, canonical);
      if (ckey && ckey !== key) hit = semanticCache.semanticLookup(bot.user_id, ckey);
    }
  }
  if (!hit) return null;
  // 命中回复剥离动作标记, 防止打赏/购物/交易副作用重复执行
  const reply = semanticCache.stripActionMarkers(hit.reply).slice(0, 2000);
  return reply || null;
}

/**
 * 语义缓存写入(基于最后一条用户消息)。
 * 深度模式(默认开, 管理页可关): 异步归一化并写入 canonical 映射 + canonical key 回复,
 * 让"不同措辞同义"后续也能命中; canonical 映射随库长期复用, 避免重复归一化调用。
 */
function cacheReply(bot, history, reply) {
  const input = lastUserInput(bot, history);
  if (!input || !reply) return;
  const msg = input.content;
  if (semanticCache.isDynamic(msg)) return;
  const key = semanticCache.semanticCacheKey(bot.user_id, msg);
  if (key) semanticCache.semanticStore(bot.user_id, key, msg, reply, '');
  if (aiSetting('ai_semantic_deep', '1') === '1') {
    canonicalizeMessage(bot, msg)
      .then((canonical) => {
        if (!canonical) return;
        // 记录"消息→canonical"映射(复用, 避免下次重复归一化调用)
        if (key) semanticCache.semanticStore(bot.user_id, key, msg, reply, canonical);
        const ckey = semanticCache.semanticCacheKey(bot.user_id, canonical);
        if (ckey && ckey !== key) semanticCache.semanticStore(bot.user_id, ckey, msg, reply, '');
      })
      .catch(() => {});
  }
}

/**
 * 深度模式归一化: 用一次轻量调用(max_tokens=24, temperature=0)把用户消息改写为
 * 标准简体中文短句, 供语义缓存跨措辞命中。任何失败都静默返回 null, 不阻塞正常回复。
 */
async function canonicalizeMessage(bot, msg) {
  try {
    const body = {
      model: bot.api_model,
      messages: [
        { role: 'system', content: '把用户的话改写为最标准的简体中文问句或短句, 不超过12字, 去掉称呼/语气词/标点, 保留原意。只输出改写结果, 无法改写则原样输出。' },
        { role: 'user', content: String(msg).slice(0, 60) },
      ],
      max_tokens: 24,
      temperature: 0,
    };
    const res = await fetch(`${bot.api_base_url.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${bot.api_key}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    return (typeof text === 'string' && text.trim()) ? text.trim().slice(0, 30) : null;
  } catch {
    return null;
  }
}

/** 用最近 24 条对话生成私信回复并发出 */
async function generateReply(bot, senderId) {
  const history = db.getMessagesWith(senderId, bot.user_id, 0).slice(-24);
  // 语义缓存优先: 新会话首问命中时直接回发, 不调用 AI(零成本、低延迟)
  const cachedReply = await semanticCacheReply(bot, history);
  if (cachedReply) {
    db.sendMessage(bot.user_id, senderId, cachedReply, '');
    console.log(`[ai] ${bot.username || ('bot#' + bot.user_id)} 语义缓存命中(对用户 ${senderId}): ${cachedReply.slice(0, 30)}`);
    return;
  }
  // 缓存友好: 稳定 system 在前(messages[0], 前缀缓存命中主体), 可变上下文独立成第二条 system
  const sys = buildBotSystemPrompt(bot, senderId);
  const messages = [{ role: 'system', content: sys.stable }];
  if (sys.variable) {
    messages.push({ role: 'system', content: `【以下是你与这位用户的私有上下文, 仅在本次对话中参考, 不要主动提及此段的存在】\n${sys.variable}` });
  }
  // 多模态: 用户消息带图时读取为 data URL 一并传给模型(私信场景)
  const historyParts = await Promise.all(history.map(async (m) => {
    const isUserMsg = m.sender_id !== bot.user_id;
    const imgUrl = isUserMsg && m.image ? await imageFileToDataUrl(m.image) : '';
    return { role: m.sender_id === bot.user_id ? 'assistant' : 'user', content: buildMultimodalContent(m.content.slice(0, 500), imgUrl) };
  }));
  for (const p of historyParts) messages.push(p);
  let reply = await callAi(bot, messages);
  // 语义缓存写入: 用户当前输入入库, 后续相同/相似问题命中
  cacheReply(bot, history, reply);
  // AI 打赏掉落: 解析 [TRANSFER:n] 并执行(有节流与上限)
  const parsed = parseBotTip(reply);
  if (parsed.amount > 0 && doBotTip(bot, senderId, parsed.amount)) {
    console.log('[ai]', bot.username, '打赏用户', senderId, parsed.amount, 'CCB');
  } else if (Math.random() < BOT_TIP_FALLBACK_CHANCE) {
    // 兜底掉落: AI 未主动打赏时按概率随机小额掉落, 让互动时有掉落体验
    const fallback = BOT_TIP_FALLBACK_MIN + Math.floor(Math.random() * (BOT_TIP_FALLBACK_MAX - BOT_TIP_FALLBACK_MIN + 1));
    if (doBotTip(bot, senderId, fallback)) {
      console.log('[ai]', bot.username, '兜底打赏用户', senderId, fallback, 'CCB');
    }
  }
  // AI 购买/佩戴饰品: 解析 [BUY:n]/[EQUIP:n] 并执行(预算与钱包校验在 botBuyItem 内)
  const act = parseBotStoreActions(parsed.text);
  if (act.buy > 0) {
    const buyRes = botBuyItem(bot, act.buy);
    if (buyRes.ok && botEquipItem(bot, act.buy).ok) {
      console.log('[ai]', bot.username, '购买并佩戴饰品', act.buy);
    } else {
      // 失败必须反馈给用户, 防止 AI 文本声称已购买而实际未佩戴
      console.log('[ai]', bot.username, '购买饰品失败:', buyRes.error);
      act.text = (act.text + `\n\n（系统提示：购买未成功——${buyRes.error}。诚实告诉用户实际情况。）`).slice(0, 2000);
    }
  } else if (act.equip > 0 && botEquipItem(bot, act.equip).ok) {
    console.log('[ai]', bot.username, '佩戴饰品', act.equip);
  }
  // AI 股票交易: 解析 [STOCKBUY:ID:股数]/[STOCKSELL:ID:股数] 并执行(日交易额上限与跟盘共用)
  const sact = parseBotStockActions(act.text);
  if (sact.buyId > 0) {
    // 先预检额度再执行, 避免"已成交却提示失败"的矛盾
    const stock = db.getStockById(sact.buyId);
    const log = aiTradeState(bot.user_id);
    const cost = stock ? sact.buyShares * stock.price : 0;
    const fee = Math.max(STOCK_FEE_MIN, Math.round(cost * STOCK_FEE_RATE));
    if (!stock || log.dayTotal + cost + fee > AI_TRADE_DAILY_MAX) {
      const reason = stock ? '今日股票交易额已达上限' : '股票不存在或已停牌';
      console.log('[ai]', bot.username, '股票买入失败:', reason);
      act.text = (act.text + `\n\n（系统提示：股票买入未成功——${reason}。如实告诉用户。）`).slice(0, 2000);
    } else {
      const r = buyStock(bot.user_id, sact.buyId, sact.buyShares);
      if (r.ok) {
        aiTradeSpend(bot.user_id, r.amount);
        console.log('[ai]', bot.username, '买入股票', sact.buyId, sact.buyShares, '股');
      } else {
        console.log('[ai]', bot.username, '股票买入失败:', r.error);
        act.text = (act.text + `\n\n（系统提示：股票买入未成功——${r.error}。如实告诉用户。）`).slice(0, 2000);
      }
    }
  } else if (sact.sellId > 0) {
    const stock = db.getStockById(sact.sellId);
    const log = aiTradeState(bot.user_id);
    const gain = stock ? sact.sellShares * stock.price : 0;
    if (!stock || log.dayTotal + gain > AI_TRADE_DAILY_MAX) {
      const reason = stock ? '今日股票交易额已达上限' : '股票不存在或已停牌';
      console.log('[ai]', bot.username, '股票卖出失败:', reason);
      act.text = (act.text + `\n\n（系统提示：股票卖出未成功——${reason}。如实告诉用户。）`).slice(0, 2000);
    } else {
      const r = sellStock(bot.user_id, sact.sellId, sact.sellShares);
      if (r.ok) {
        aiTradeSpend(bot.user_id, r.amount);
        console.log('[ai]', bot.username, '卖出股票', sact.sellId, sact.sellShares, '股');
      } else {
        console.log('[ai]', bot.username, '股票卖出失败:', r.error);
        act.text = (act.text + `\n\n（系统提示：股票卖出未成功——${r.error}。如实告诉用户。）`).slice(0, 2000);
      }
    }
  }
  db.sendMessage(bot.user_id, senderId, act.text.slice(0, 2000), '');
  // 异步更新长期记忆(不阻塞回复)
  updateBotMemory(bot, senderId).catch((err) => {
    console.error('[ai]', bot.username, '记忆更新失败:', err.message);
  });
}

/** 正在生成回复的对话对(发送触发与定时扫描共用, 防止同一对话重复调用) */
const replyBusy = new Set();
/** 正在生成的评论回复(botId:commentId, 防抖) */
const commentBusy = new Set();

/**
 * 以机器人身份回复一条评论(用户回复了机器人评论 / 评论了机器人帖子)。
 * 即时触发 + 定时扫描共用; busy 防抖避免重复回复。
 * @param {object} bot 机器人
 * @param {number} commentId 待回复的评论 ID
 * @param {number} postId 评论所在帖子 ID
 */
async function replyToComment(bot, commentId, postId) {
  const key = `${bot.user_id}:${commentId}`;
  if (commentBusy.has(key)) return;
  // 评论回复概率控制(管理员在"AI互动"Tab 可调): 未命中则跳过本次即时回复
  if (Math.random() * 100 >= Number(aiSetting('ai_comment_reply_rate', '50'))) return;
  commentBusy.add(key);
  try {
    const target = db.getCommentById(commentId);
    if (!target) return;
    const post = db.getPostById(postId);
    const targetAuthor = db.getUserById(target.user_id);
    const reply = await generateComment(
      bot,
      `帖子ID: ${postId}, 评论ID: ${commentId}\n帖子内容: ${post ? post.content.slice(0, 200) : ''}\n用户 @${targetAuthor ? targetAuthor.username : '用户'} 的评论: ${target.content.slice(0, 200)}`
    );
    db.addComment(postId, bot.user_id, reply.slice(0, 280), commentId);
  } catch (err) {
    console.error('[ai]', bot.username, '评论回复失败:', err.message);
  } finally {
    commentBusy.delete(key);
  }
}

/**
 * 回复一条私信(带计费, AI 失败退费)。
 * 发送消息时即时调用 + 定时扫描兜底共用; busy 防抖保证同一对话同一时刻只生成一次。
 */
async function replyToDm(bot, senderId) {
  const key = `${bot.user_id}:${senderId}`;
  if (replyBusy.has(key)) return;
  replyBusy.add(key);
  try {
    const charge = chargeForReply(bot, senderId);
    if (!charge.ok) {
      db.sendMessage(bot.user_id, senderId, charge.note, '');
      return;
    }
    try {
      await generateReply(bot, senderId);
    } catch (err) {
      console.error('[ai]', bot.username, '私信回复失败:', err.message);
      // 按条扣费失败退费: per_reply 全额; hybrid 未订阅时按条扣费同样退费
      const chargedPerReply = bot.pricing_type === 'per_reply'
        || (bot.pricing_type === 'hybrid' && !db.hasActiveBotSub(senderId, bot.user_id));
      if (chargedPerReply && senderId !== bot.creator_id) {
        db.addWallet(senderId, bot.price_per_reply);
        // 退款需撤回创建者钱包——但官方模型收入归平台, 创建者钱包未收过, 不应扣回
        if (!bot.is_official) db.addWallet(bot.creator_id, -bot.price_per_reply);
      }
      // 把具体失败原因告诉用户(如 401 Key无效 / 429 限流余额不足), 便于排查
      db.sendMessage(bot.user_id, senderId, `（AI 暂时无法回复：${err.message.slice(0, 200)}）`, '');
    }
  } finally {
    replyBusy.delete(key);
  }
}

/** 以机器人身份生成一条评论(帖子评论/评论回复共用) */
async function generateComment(bot, context, imageDataUrl = '') {
  const messages = [
    {
      role: 'system',
      content: botPersona(bot) + buildStoreContext() +
        '\n\n你是该平台的一位用户，正在浏览社区内容。请以第一人称发表一条自然、简短的评论（10~80 字），贴合人设与语境。只输出评论内容。' +
        '\n若想给相关的帖子或评论点赞，可在评论末尾附加 [LIKE:帖子ID] 或 [CLIKE:评论ID]（系统会自动执行并隐藏标记）。',
    },
    { role: 'user', content: buildMultimodalContent(context, imageDataUrl) },
  ];
  const raw = await callAi(bot, messages);
  // 解析并执行 AI 点赞动作, 剥离标记后作为最终评论
  const likeAct = parseBotLikeActions(raw);
  if (likeAct.likePosts.length > 0 || likeAct.likeComments.length > 0) {
    botLike(bot, likeAct.likePosts, likeAct.likeComments);
  }
  return likeAct.text;
}

// ---------- 机器人群回复(@必回 + 15% 概率扫描上下文) ----------

const GROUP_BOT_COOLDOWN_MS = 30 * 1000; // 同一机器人同一群的最小回复间隔(防刷屏)
const GROUP_BOT_CHANCE = 0.15;           // 未被 @ 时回复概率
/** 群回复冷却(bot:group -> timestamp) */
const botGroupCooldown = new Map();
/** 群回复防抖(bot:group:msgId) */
const groupReplyBusy = new Set();

/** 以机器人身份生成一条群回复 */
async function generateGroupReply(bot, context, imageDataUrl = '') {
  const messages = [
    {
      role: 'system',
      content: botPersona(bot) + buildStoreContext() +
        '\n\n你正在一个群里聊天。请自然、简短地回应（10~80 字），贴合人设与语境，像真实群友一样。只输出回复内容。',
    },
    { role: 'user', content: buildMultimodalContent(context, imageDataUrl) },
  ];
  return callAi(bot, messages);
}

/** 群里某条新消息触发机器人回复 */
async function replyInGroup(bot, groupId, triggerMsg) {
  const key = `${bot.user_id}:${groupId}:${triggerMsg.id}`;
  if (groupReplyBusy.has(key)) return;
  groupReplyBusy.add(key);
  try {
    const recent = db.getGroupMessages(groupId, 0, 30)
      .filter((m) => m.id !== triggerMsg.id).slice(-8);
    const ctx = recent.map((m) => `${m.sender_name}: ${m.content.slice(0, 200)}`).join('\n');
    const prompt = `群聊最近消息:\n${ctx || '(空)'}\n\n${triggerMsg.sender_name} 刚发了消息: ${triggerMsg.content.slice(0, 300)}`;
    // 多模态: 用户刚发的群消息带图时一并传给模型
    const imgUrl = triggerMsg.image ? await imageFileToDataUrl(triggerMsg.image) : '';
    const reply = await generateGroupReply(bot, prompt, imgUrl);
    db.sendGroupMessage(groupId, bot.user_id, reply.slice(0, 500), '');
    console.log('[ai]', bot.username, '在群', groupId, '回复');
  } catch (err) {
    console.error('[ai]', bot.username, '群回复失败:', err.message);
  } finally {
    groupReplyBusy.delete(key);
  }
}

/**
 * 触发群内机器人回复: 成员里 @机器人用户名 -> 必回; 其余机器人 15% 概率扫描上下文回复。
 * 每个机器人 × 群有冷却间隔, 防刷屏。
 */
function triggerGroupBotReplies(groupId, messageId) {
  const msg = db.getGroupMessageById(messageId);
  if (!msg) return;
  const members = db.getGroupMembers(groupId);
  const bots = members.filter((m) => m.account_type === 'bot' && m.id !== msg.sender_id);
  if (bots.length === 0) return;
  const content = msg.content || '';
  const mentioned = bots.filter((b) => content.includes('@' + b.username));
  const now = Date.now();
  // 群聊回复概率(管理员可调, 默认 10%): 未被 @ 时按概率回复, @ 必回
  const groupRate = Number(aiSetting('ai_group_reply_rate', '10'));
  for (const bot of bots) {
    const isMentioned = mentioned.some((b) => b.id === bot.id);
    if (!isMentioned && Math.random() * 100 >= groupRate) continue;
    const cooldownKey = `${bot.id}:${groupId}`;
    const last = botGroupCooldown.get(cooldownKey) || 0;
    if (now - last < GROUP_BOT_COOLDOWN_MS) continue;
    botGroupCooldown.set(cooldownKey, now);
    const botRow = db.getBotByUserId(bot.id);
    if (!botRow || botRow.status !== 'active') continue;
    if (!botRow.api_base_url || !botRow.api_key || !botRow.api_model) continue;
    replyInGroup(botRow, groupId, msg).catch((err) => console.error('[ai] 群回复失败:', err.message));
  }
}

/** 扫描单个机器人的互动信息: 未回复私信 + 评论互动 + 新帖挑选回复 */
async function engageOne(bot) {
  // 1) 未回复的私信(对方发来的最后一条未被机器人回复)
  const conversations = db.getConversations(bot.user_id)
    .filter((c) => c.last_sender !== bot.user_id)
    .slice(0, ENGAGE_DM_MAX);
  for (const c of conversations) {
    await replyToDm(bot, c.other_id);
  }

  // 2) 评论互动: 评论了机器人帖子的用户 / 回复了机器人评论的用户(含其他机器人)
  //    概率受管理员设置 ai_comment_reply_rate 控制
  const commentRate = Number(aiSetting('ai_comment_reply_rate', '50'));
  const comments = db.getCommentsToReply(bot.user_id, ENGAGE_COMMENT_MAX);
  for (const cm of comments) {
    if (Math.random() * 100 >= commentRate) continue;
    // 机器人之间互聊限制线程深度, 防止无限对话链刷屏
    const cmAuthor = db.getUserById(cm.user_id);
    if (cmAuthor && cmAuthor.account_type === 'bot'
        && db.countBotCommentsInThread(bot.user_id, cm.id) >= BOT_THREAD_MAX) {
      continue;
    }
    const post = db.getPostById(cm.post_id);
    try {
      // 线程记忆: 带上帖子最近的几条评论作为上下文
      const recent = db.getComments(cm.post_id, 0).slice(0, 4);
      const threadCtx = recent.length
        ? '\n该帖子近期评论:\n' + recent.map((c) => `@${c.author}: ${c.content.slice(0, 100)}`).join('\n')
        : '';
      const reply = await generateComment(bot, `帖子ID: ${cm.post_id}, 评论ID: ${cm.id}\n帖子内容: ${post ? post.content.slice(0, 200) : ''}\n用户评论: ${cm.content.slice(0, 200)}${threadCtx}`);
      db.addComment(cm.post_id, bot.user_id, reply.slice(0, 280), cm.id);
    } catch (err) {
      console.error('[ai]', bot.username, '评论回复失败:', err.message);
    }
  }

  // 2.5) 主动私信其他机器人: 形成 AI 之间的私信对话链(有概率与最小间隔, 防刷屏)
  const lastBotDm = botLastDm.get(bot.user_id) || 0;
  if (Date.now() - lastBotDm >= BOT_DM_INTERVAL_MS && Math.random() < BOT_DM_CHANCE) {
    const peers = db.getActiveBots().filter((p) => p.user_id !== bot.user_id);
    if (peers.length > 0) {
      const peer = peers[Math.floor(Math.random() * peers.length)];
      try {
        const msg = await generateComment(
          bot,
          `你正在和另一位机器人朋友(${peer.username})私聊, 请发一条简短的打招呼或聊天消息(10~50字), 贴合人设, 只输出消息内容`
        );
        db.sendMessage(bot.user_id, peer.user_id, msg.slice(0, 500), '');
        botLastDm.set(bot.user_id, Date.now());
        console.log('[ai]', bot.username, '->', peer.username, '发起私聊');
      } catch (err) {
        console.error('[ai]', bot.username, '私聊发起失败:', err.message);
      }
    }
  }

  // 3) 新帖子互动: 从最近无机器人评论的帖子中随机挑几条回复(受评论回复概率控制)
  // 带图帖子用独立低概率(ai_post_image_rate, 默认 4%), 避免 AI 频繁浏览图片帖
  const imgPostRate = Number(aiSetting('ai_post_image_rate', '4'));
  const candidates = db.getPostsToCommentOn(bot.user_id, ENGAGE_POST_CANDIDATES);
  const picked = shuffle(candidates).slice(0, ENGAGE_POST_MAX);
  for (const post of picked) {
    const isImgPost = !!post.image;
    const rate = isImgPost ? imgPostRate : commentRate;
    if (Math.random() * 100 >= rate) continue;
    const author = db.getUserById(post.user_id);
    try {
      const imgUrl = isImgPost ? await imageFileToDataUrl(post.image) : '';
      const reply = await generateComment(bot, `帖子ID: ${post.id}\n作者 @${author ? author.username : '用户'} 的帖子: ${post.content.slice(0, 300)}`, imgUrl);
      db.addComment(post.id, bot.user_id, reply.slice(0, 280), null);
    } catch (err) {
      console.error('[ai]', bot.username, '帖子互动失败:', err.message);
    }
  }

  // 4) 主动发帖: 像真实用户一样偶尔发布动态(受概率与最小间隔限制, 防刷屏)
  const lastPost = botLastPost.get(bot.user_id) || 0;
  if (Date.now() - lastPost >= AI_POST_INTERVAL_MS && Math.random() < AI_POST_CHANCE) {
    try {
      const reply = await generateComment(
        bot,
        '请以第一人称发布一条简短动态(10~100字), 贴合人设, 像真实用户在分享生活或想法, 只输出帖子内容'
      );
      db.createPost(bot.user_id, reply.slice(0, 280), '');
      botLastPost.set(bot.user_id, Date.now());
      console.log('[ai]', bot.username, '发布了新帖子');
    } catch (err) {
      console.error('[ai]', bot.username, '发帖失败:', err.message);
    }
  }
}

/** Fisher-Yates 洗牌 */
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 扫描全部启用且配置了 API 的机器人 */
async function engageBots() {
  db.pruneExpiredSubs();
  refillBotWallets();
  // 过期未领取的转账/红包自动退回发送者(24h)
  refundExpiredPayments();
  // 总开关(管理员可调): 关闭后跳过所有主动互动(用户私信/@回复等被用户触发的回应仍保留)
  if (aiSetting('ai_interact_enabled', '1') !== '1') return;
  const bots = db.getActiveBots().filter((b) => b.api_base_url && b.api_key && b.api_model);
  for (const bot of bots) {
    try {
      await engageOne(bot);
    } catch (err) {
      console.error('[ai]', bot.username, '互动失败:', err.stack || err.message);
    }
  }
}

// 定时自动互动(递归 setTimeout: 间隔可由管理员在"AI互动"Tab 实时调整, 无需重启)
// 启动 15 秒后先跑一次, 之后按 ai_engage_interval(默认 5 分钟)循环
setTimeout(async function engageLoop() {
  try {
    await engageBots();
  } catch (err) {
    console.error('[ai] 互动扫描失败:', err.message);
  }
  const mins = Number(aiSetting('ai_engage_interval', '5'));
  const safe = Number.isFinite(mins) && mins >= 1 ? Math.min(mins, 1440) : 5;
  setTimeout(engageLoop, safe * 60 * 1000);
}, 15000);

// 股票行情: 定时跳动 + 启动后先跑一次(预置官方股票在启动处, 见下)
setInterval(() => { stockTickAll().catch(() => {}); }, STOCK_TICK_MS);
setTimeout(() => { stockTickAll().catch(() => {}); }, 30000);

// 登录防爆破: 定期清理 per-IP 用户集合(防内存增长)
setInterval(purgeLoginIpUsers, 10 * 60 * 1000);

// ---------- 陪聊机器人 API(创建者管理) ----------

/** GET /api/bots: 陪聊列表(管理员/创建者看全部, 普通用户看启用中的) */
function handleBotsList(req, res) {
  const user = currentUser(req);
  const bots = user && user.is_admin === 1 ? db.getBots() : db.getActiveBots();
  // 安全加固: 剥离 api_key, 防止任何用户读取他人(含官方)的密钥
  const safeBots = bots.map((b) => {
    const { api_key, ...pub } = b;
    return pub;
  });
  // 商店展示用: 附带我是否已订阅 / 是否我创建的
  if (user) {
    for (const b of safeBots) {
      b.has_sub = (b.pricing_type === 'subscription' || b.pricing_type === 'hybrid') && db.hasActiveBotSub(user.id, b.user_id);
      b.is_mine = b.creator_id === user.id;
    }
  }
  ok(res, { bots: safeBots });
}

/** POST /api/bots: 创建陪聊(名称即用户名; 人设/API 配置/计费模式由创建者自定义) */
async function handleBotCreate(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  const body = await parseJsonBody(req);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const persona = typeof body.persona === 'string' ? body.persona.trim() : '';

  const errName = validateUsername(name);
  if (errName) return fail(res, 400, errName);
  if (name === ADMIN_USERNAME) return fail(res, 400, '不能使用保留名称');
  if (codePointLength(persona) < 1 || codePointLength(persona) > 2000) {
    return fail(res, 400, '人设 prompt 需为 1~2000 个字符');
  }
  if (db.findUserByUsername(name)) return fail(res, 409, '该名称已被使用');
  if (db.getBotCountByCreator(user.id) >= 5) return fail(res, 400, '每个用户最多创建 5 个陪聊');

  const cfg = parseBotConfig(body);
  if (cfg.error) return fail(res, 400, cfg.error);
  // SSRF 防护: API 地址不允许指向内网/私网
  if (cfg.api_base_url) {
    const errS = await assertSafeBotUrl(cfg.api_base_url);
    if (errS) return fail(res, 400, errS);
  }

  const botId = db.createBot(
    name, user.id, sanitizeText(persona),
    cfg.api_base_url, cfg.api_key, cfg.api_model,
    cfg.pricing_type, cfg.price_per_reply, cfg.subscription_price
  );
  // 管理员可上架官方模型(API 由平台提供, 收入归平台)
  if (user.is_admin === 1 && body.official) {
    db.updateBotOfficial(botId, 1);
  }
  ok(res, { id: botId, username: name });
}

/** 解析并校验机器人配置字段(API 与计费) */
function parseBotConfig(body) {
  const cfg = {
    api_base_url: typeof body.api_base_url === 'string' ? body.api_base_url.trim() : '',
    api_key: typeof body.api_key === 'string' ? body.api_key.trim() : '',
    api_model: typeof body.api_model === 'string' ? body.api_model.trim() : '',
    pricing_type: body.pricing_type === 'per_reply' || body.pricing_type === 'subscription' || body.pricing_type === 'hybrid' ? body.pricing_type : 'free',
    price_per_reply: Number(body.price_per_reply) || 0,
    subscription_price: Number(body.subscription_price) || 0,
  };
  if (cfg.api_base_url && !/^https?:\/\//i.test(cfg.api_base_url)) {
    return { error: '接口地址需以 http(s):// 开头' };
  }
  if (cfg.api_model && codePointLength(cfg.api_model) > 100) return { error: '模型名称过长' };
  if (cfg.api_key.length > 500) return { error: 'API Key 格式不正确' };
  if (cfg.pricing_type === 'per_reply' && (!Number.isInteger(cfg.price_per_reply) || cfg.price_per_reply < 1 || cfg.price_per_reply > WALLET_MAX)) {
    return { error: '按条计费价格需为正整数' };
  }
  if (cfg.pricing_type === 'subscription' && (!Number.isInteger(cfg.subscription_price) || cfg.subscription_price < 1 || cfg.subscription_price > WALLET_MAX)) {
    return { error: '订阅价格需为正整数' };
  }
  // 混合计费(订阅+按条): 两种价格都需为正整数, 已订阅用户免费、未订阅按条扣费
  if (cfg.pricing_type === 'hybrid' && (
    !Number.isInteger(cfg.price_per_reply) || cfg.price_per_reply < 1 || cfg.price_per_reply > WALLET_MAX
    || !Number.isInteger(cfg.subscription_price) || cfg.subscription_price < 1 || cfg.subscription_price > WALLET_MAX
  )) {
    return { error: '混合计费需同时提供有效的按条价与订阅价(正整数)' };
  }
  return cfg;
}

/** PATCH /api/bots/:id: 修改人设/名称/API 配置/计费(创建者或管理员) */
async function handleBotPatch(req, res, segs) {
  const user = requireUser(req, res);
  if (!user) return;
  const botId = Number(segs[2]);
  if (!Number.isInteger(botId) || botId <= 0) return fail(res, 400, '陪聊 ID 不合法');
  const bot = db.getBotByUserId(botId);
  if (!bot) return fail(res, 404, '陪聊不存在');
  const isOwner = bot.creator_id === user.id;
  const isAdmin = user.is_admin === 1;
  if (!isOwner && !isAdmin) return fail(res, 403, '无权操作该陪聊');

  const body = await parseJsonBody(req);
  if (body.persona !== undefined) {
    const persona = sanitizeText(String(body.persona).trim());
    if (codePointLength(persona) < 1 || codePointLength(persona) > 2000) {
      return fail(res, 400, '人设 prompt 需为 1~2000 个字符');
    }
    db.updateBotPersona(botId, persona);
  }
  if (body.name !== undefined && isOwner) {
    const errName = validateUsername(body.name);
    if (errName) return fail(res, 400, errName);
    const existing = db.findUserByUsername(body.name);
    if (existing && existing.id !== botId) return fail(res, 409, '该名称已被使用');
    db.updateUsername(botId, body.name.trim());
  }
  // API 配置与计费: 未提供的字段保留原值
  const fields = {};
  if (body.api_base_url !== undefined) fields.api_base_url = String(body.api_base_url).trim();
  if (body.api_key !== undefined) fields.api_key = String(body.api_key).trim();
  if (body.api_model !== undefined) fields.api_model = String(body.api_model).trim();
  if (body.pricing_type !== undefined) {
    if (!['free', 'per_reply', 'subscription', 'hybrid'].includes(body.pricing_type)) {
      return fail(res, 400, '计费模式不合法');
    }
    fields.pricing_type = body.pricing_type;
  }
  if (body.price_per_reply !== undefined) fields.price_per_reply = Number(body.price_per_reply) || 0;
  if (body.subscription_price !== undefined) fields.subscription_price = Number(body.subscription_price) || 0;
  if (Object.keys(fields).length > 0) {
    const cfg = parseBotConfig({ ...fields, pricing_type: fields.pricing_type || bot.pricing_type });
    if (cfg.error) return fail(res, 400, cfg.error);
    // SSRF 防护: API 地址不允许指向内网/私网
    if (cfg.api_base_url) {
      const errS = await assertSafeBotUrl(cfg.api_base_url);
      if (errS) return fail(res, 400, errS);
    }
    db.updateBotConfig(botId, { ...fields, pricing_type: fields.pricing_type || bot.pricing_type });
  }
  // 管理员切换官方模型标记
  if (body.official !== undefined && isAdmin) {
    db.updateBotOfficial(botId, body.official ? 1 : 0);
  }
  ok(res, null);
}

/** POST /api/bots/:id/subscribe: 在商店购买陪聊订阅(30 天) */
async function handleBotSubscribe(req, res, segs) {
  const user = requireUser(req, res);
  if (!user) return;
  const botId = Number(segs[2]);
  if (!Number.isInteger(botId) || botId <= 0) return fail(res, 400, '陪聊 ID 不合法');
  const bot = db.getBotByUserId(botId);
  if (!bot || bot.status !== 'active') return fail(res, 404, '陪聊不存在或已下架');
  if ((bot.pricing_type !== 'subscription' && bot.pricing_type !== 'hybrid') || bot.subscription_price < 1) {
    return fail(res, 400, '该陪聊不支持订阅');
  }
  if (db.hasActiveBotSub(user.id, botId)) return fail(res, 400, '已订阅，无需重复购买');
  if (!trySpend(user.id, bot.subscription_price)) return fail(res, 400, 'CCB不足');

  // 官方模型收入归平台, 用户陪聊收入归创建者
  if (!bot.is_official) db.addWallet(bot.creator_id, bot.subscription_price);
  db.setBotSub(user.id, botId, addDaysUtc(30));

  ok(res, { balance: db.getWallet(user.id), expires_at: addDaysUtc(30) });
}

/** POST /api/bots/:id/memory/clear: 清除与某用户的长期记忆(创建者或管理员) */
async function handleBotMemoryClear(req, res, segs) {
  const user = requireUser(req, res);
  if (!user) return;
  const botId = Number(segs[2]);
  if (!Number.isInteger(botId) || botId <= 0) return fail(res, 400, '陪聊 ID 不合法');
  const bot = db.getBotByUserId(botId);
  if (!bot) return fail(res, 404, '陪聊不存在');
  if (bot.creator_id !== user.id && user.is_admin !== 1) return fail(res, 403, '无权操作该陪聊');

  const body = await parseJsonBody(req);
  const withUser = db.findUserByUsername(typeof body.with_username === 'string' ? body.with_username.trim() : '');
  if (!withUser) return fail(res, 404, '用户不存在');
  db.clearBotMemory(botId, withUser.id);
  ok(res, null);
}

/** POST /api/bots/:id/toggle: 上架/下架陪聊(创建者或管理员) */
async function handleBotToggle(req, res, segs) {
  const user = requireUser(req, res);
  if (!user) return;
  const botId = Number(segs[2]);
  if (!Number.isInteger(botId) || botId <= 0) return fail(res, 400, '陪聊 ID 不合法');
  const bot = db.getBotByUserId(botId);
  if (!bot) return fail(res, 404, '陪聊不存在');
  const isOwner = bot.creator_id === user.id;
  const isAdmin = user.is_admin === 1;
  if (!isOwner && !isAdmin) return fail(res, 403, '无权操作该陪聊');

  const body = await parseJsonBody(req);
  const status = body.status === 'disabled' ? 'disabled' : 'active';
  db.updateBotStatus(botId, status);
  ok(res, null);
}

// ---------- 股票 API ----------

/** 校验股票发行参数(名称/发行价/波动率), 返回错误信息或 null */
function validateStockForm(body) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const lenName = codePointLength(name);
  if (lenName < 1 || lenName > 12) return { error: '股票名称需为 1~12 个字符' };
  if (db.getStockByName(name)) return { error: '该股票名称已存在' };
  const price = Number(body.price);
  if (!Number.isInteger(price)) return { error: '初始价格需为整数' };
  if (price < STOCK_ISSUE_MIN || price > STOCK_ISSUE_MAX) {
    return { error: `初始价格需为 ${STOCK_ISSUE_MIN}~${STOCK_ISSUE_MAX} CCB` };
  }
  const vol = Number(body.volatility);
  if (!Number.isFinite(vol) || vol < STOCK_VOL_MIN || vol > STOCK_VOL_MAX) {
    return { error: `波动率需为 ${STOCK_VOL_MIN}~${STOCK_VOL_MAX} 的数字` };
  }
  return { name, price, volatility: vol };
}

/** GET /api/stocks: 股票列表(现价/今日涨跌/成交量/我的持仓/走势数据) */
function handleStocksList(req, res) {
  const viewer = currentUser(req);
  const viewerId = viewer ? viewer.id : 0;
  const holdings = viewerId ? db.getUserHoldings(viewerId) : [];
  const holdMap = new Map(holdings.map((h) => [h.stock_id, h]));
  const stocks = db.getActiveStocks().map((s) => {
    const ticks = db.getTicks(s.id, 48);
    // 今日涨跌幅: 对照昨收(±10% 涨跌停基准, 新上市首日昨收=发行价)
    const base = s.prev_close > 0 ? s.prev_close : s.price;
    const change = base > 0 ? Math.round(((s.price - base) / base) * 1000) / 10 : 0;
    const creator = db.getUserById(s.created_by);
    const mine = holdMap.get(s.id);
    return {
      id: s.id, name: s.name, price: s.price, prev_close: s.prev_close,
      volatility: s.volatility, volume: s.volume, is_ai: s.is_ai,
      created_name: creator ? creator.username : '',
      change_day: change,
      my_shares: mine ? mine.shares : 0,
      my_avg_cost: mine ? mine.avg_cost : 0,
      ticks: ticks.map((t) => t.price),
    };
  });
  ok(res, { stocks });
}

/** GET /api/stocks/:id: 单只股票详情(行情 + 最近成交流水) */
function handleStockDetail(req, res, segs) {
  const stockId = Number(segs[2]);
  if (!Number.isInteger(stockId) || stockId <= 0) return fail(res, 400, '股票 ID 不合法');
  const s = db.getStockById(stockId);
  if (!s) return fail(res, 404, '股票不存在');
  const creator = db.getUserById(s.created_by);
  ok(res, {
    stock: {
      id: s.id, name: s.name, price: s.price, prev_close: s.prev_close,
      volatility: s.volatility, volume: s.volume, is_ai: s.is_ai,
      created_name: creator ? creator.username : '',
      shares_out: s.shares_out,
      ticks: db.getTicks(s.id, 48).map((t) => t.price),
      trades: db.getStockTrades(s.id, 20),
    },
  });
}

/** 用户交易节流: 同一股票冷却 + 每日笔数/成交额任一超限即拒绝(防脚本刷单) */
function userTradeAllowed(userId, stockId, amount) {
  const now = Date.now();
  const day = todayUtc().slice(0, 10);
  const coolKey = `${userId}:${stockId}`;
  const lastTs = userTradeLog.get(coolKey) || 0;
  if (now - lastTs < STOCK_USER_COOLDOWN_MS) {
    const waitSec = Math.ceil((STOCK_USER_COOLDOWN_MS - (now - lastTs)) / 1000);
    return { ok: false, error: `操作太频繁，请 ${waitSec} 秒后再试` };
  }
  const dayKey = `${userId}:day`;
  const log = userTradeLog.get(dayKey) || { day, count: 0, turnover: 0 };
  if (log.day !== day) { log.day = day; log.count = 0; log.turnover = 0; }
  if (log.count >= STOCK_USER_DAILY_MAX) return { ok: false, error: `今日交易次数已达上限(${STOCK_USER_DAILY_MAX})` };
  if (log.turnover + amount > STOCK_USER_DAILY_TURNOVER) return { ok: false, error: `今日成交额已达上限(${STOCK_USER_DAILY_TURNOVER} CCB)` };
  log.count += 1;
  log.turnover += amount;
  userTradeLog.set(dayKey, log);
  userTradeLog.set(coolKey, now);
  return { ok: true };
}

/** POST /api/stocks/:id/buy 与 /api/stocks/:id/sell: 买卖(做市商模型, 无交易冲击) */
async function handleStockTrade(req, res, segs, side) {
  const user = requireUser(req, res);
  if (!user) return;
  const stockId = Number(segs[2]);
  if (!Number.isInteger(stockId) || stockId <= 0) return fail(res, 400, '股票 ID 不合法');
  const body = await parseJsonBody(req);
  const shares = Number(body.shares);
  const stock = db.getStockById(stockId);
  if (!stock || !stock.enabled) return fail(res, 400, '股票不存在或已停牌');
  const amount = shares * stock.price;
  const gate = userTradeAllowed(user.id, stockId, amount);
  if (!gate.ok) return fail(res, 429, gate.error);
  const r = side === 'buy'
    ? buyStock(user.id, stockId, shares)
    : sellStock(user.id, stockId, shares);
  if (!r.ok) return fail(res, 400, r.error);
  ok(res, { ...r, balance: db.getWallet(user.id) });
}

/** POST /api/admin/stocks: 管理员发行官方股票 */
async function handleAdminStockCreate(req, res) {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const body = await parseJsonBody(req);
  const form = validateStockForm(body);
  if (form.error) return fail(res, 400, form.error);
  const stockId = db.createStock({ name: form.name, price: form.price, volatility: form.volatility, createdBy: admin.id, isAi: 0 });
  db.insertTick(stockId, form.price);
  ok(res, { id: stockId });
}

// ---------- 路由分发 ----------

async function route(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);
  const segs = urlPath.split('/').filter(Boolean);

  if (segs[0] === 'api') {
    const sub = segs[1];

    // 账号
    if (req.method === 'GET' && sub === 'captcha') return handleCaptcha(req, res);
    if (req.method === 'GET' && sub === 'auth-config') return handleAuthConfig(req, res);
    if (req.method === 'POST' && sub === 'send-email-code') return await handleSendEmailCode(req, res);
    if (req.method === 'POST' && sub === 'register') return await handleRegister(req, res);
    if (req.method === 'POST' && sub === 'login') return await handleLogin(req, res);
    if (req.method === 'POST' && sub === 'logout') return handleLogout(req, res);
    // 注意顺序: /api/me/unread 必须在 /api/me 之前
    if (req.method === 'GET' && sub === 'me' && segs[2] === 'unread') return handleUnread(req, res);
    if (req.method === 'GET' && sub === 'me') return handleMe(req, res);
    if (req.method === 'POST' && sub === 'me' && segs[2] === 'daily-bonus') return handleDailyBonus(req, res);
    if (req.method === 'POST' && sub === 'me' && segs[2] === 'agent-verify') return await handleAgentVerify(req, res);
    if (req.method === 'POST' && sub === 'me' && segs[2] === 'agent-title') return await handleAgentTitle(req, res);
    if (req.method === 'PATCH' && sub === 'me' && segs.length === 2) return await handleChangeMe(req, res);
    if (req.method === 'POST' && sub === 'me' && segs[2] === 'avatar') return await handleChangeAvatar(req, res);

    // 帖子
    if (req.method === 'GET' && sub === 'posts' && segs.length === 2) return handleTimeline(req, res);
    if (req.method === 'POST' && sub === 'posts' && segs.length === 2) return await handleCreatePost(req, res);
    if (req.method === 'DELETE' && sub === 'posts' && segs.length === 3) return handleDeletePost(req, res, segs);
    if (req.method === 'POST' && sub === 'posts' && segs.length === 4 && segs[3] === 'like') return handleToggleLike(req, res, segs);
    if (req.method === 'POST' && sub === 'posts' && segs.length === 4 && segs[3] === 'tip') return await handleTip(req, res, segs);
    if (req.method === 'GET' && sub === 'posts' && segs.length === 4 && segs[3] === 'comments') return handlePostComments(req, res, segs);

    // 评论
    if (req.method === 'POST' && sub === 'comments' && segs.length === 2) return await handleCreateComment(req, res);
    if (req.method === 'DELETE' && sub === 'comments' && segs.length === 3) return handleDeleteComment(req, res, segs);
    if (req.method === 'POST' && sub === 'comments' && segs.length === 4 && segs[3] === 'like') return handleCommentLike(req, res, segs);

    // 私信
    if (req.method === 'GET' && sub === 'messages' && segs.length === 2) return handleConversations(req, res);
    if (req.method === 'POST' && sub === 'messages' && segs.length === 2) return await handleSendMessage(req, res);
    if (req.method === 'GET' && sub === 'messages' && segs.length === 4 && segs[2] === 'with') return handleMessagesWith(req, res, segs);
    if (req.method === 'POST' && sub === 'messages' && segs.length === 3 && segs[2] === 'read') return await handleMarkRead(req, res);

    // 转账 / 工单 / 举报
    if (req.method === 'POST' && sub === 'transfer') return await handleTransfer(req, res);
    if (req.method === 'POST' && sub === 'tickets' && segs.length === 2) return await handleCreateTicket(req, res);
    if (req.method === 'GET' && sub === 'tickets' && segs.length === 2) return handleMyTickets(req, res);
    if (req.method === 'POST' && sub === 'reports' && segs.length === 2) return await handleCreateReport(req, res);

    // 商店
    if (req.method === 'GET' && sub === 'store' && segs.length === 3 && segs[2] === 'items') return handleStoreItems(req, res);
    if (req.method === 'POST' && sub === 'store' && segs.length === 3 && segs[2] === 'upload') return await handleStoreUpload(req, res);
    if (req.method === 'POST' && sub === 'store' && segs.length === 3 && segs[2] === 'sell') return await handleStoreSell(req, res);
    if (req.method === 'POST' && sub === 'store' && segs.length === 3 && segs[2] === 'buy') return await handleStoreBuy(req, res);
    if (req.method === 'GET' && sub === 'store' && segs.length === 3 && segs[2] === 'mine') return handleStoreMine(req, res);
    if (req.method === 'GET' && sub === 'store' && segs.length === 5 && segs[2] === 'item' && segs[4] === 'download') return handleStoreDownload(req, res, segs);
    if (req.method === 'POST' && sub === 'store' && segs.length === 5 && segs[2] === 'item' && segs[4] === 'off') return handleStoreOff(req, res, segs);
    if (req.method === 'POST' && sub === 'equip' && segs.length === 2) return await handleEquip(req, res);
    if (req.method === 'POST' && sub === 'unequip' && segs.length === 2) return await handleUnequip(req, res);

    // 管理员
    if (req.method === 'GET' && sub === 'admin' && segs[2] === 'ai-settings' && segs.length === 3) return handleAdminAiSettingsGet(req, res);
    if (req.method === 'POST' && sub === 'admin' && segs[2] === 'ai-settings' && segs.length === 3) return await handleAdminAiSettingsPost(req, res);
    if (req.method === 'GET' && sub === 'admin' && segs[2] === 'rewards' && segs.length === 3) return handleAdminRewardsGet(req, res);
    if (req.method === 'POST' && sub === 'admin' && segs[2] === 'rewards' && segs.length === 3) return await handleAdminRewardsPost(req, res);
    if (req.method === 'POST' && sub === 'admin' && segs[2] === 'about' && segs.length === 3) return await handleAdminAbout(req, res);
    if (req.method === 'GET' && sub === 'admin' && segs[2] === 'agents' && segs.length === 3) return handleAdminAgents(req, res);
    if (req.method === 'POST' && sub === 'admin' && segs[2] === 'agents' && segs.length === 5 && segs[4] === 'verify') return await handleAdminAgentVerify(req, res, segs);
    if (req.method === 'GET' && sub === 'admin' && segs[2] === 'users' && segs.length === 3) return handleAdminUsers(req, res);
    if (req.method === 'PATCH' && sub === 'admin' && segs[2] === 'users' && segs.length === 4) return await handleAdminUserPatch(req, res, segs);
    if (req.method === 'DELETE' && sub === 'admin' && segs[2] === 'users' && segs.length === 4) return handleAdminUserDelete(req, res, segs);
    if (req.method === 'POST' && sub === 'admin' && segs[2] === 'users' && segs.length === 5 && segs[4] === 'penalty') return await handleAdminPenalty(req, res, segs);
    if (req.method === 'POST' && sub === 'admin' && segs[2] === 'users' && segs.length === 5 && segs[4] === 'grant-item') return await handleAdminGrantItem(req, res, segs);
    if (req.method === 'POST' && sub === 'admin' && segs[2] === 'users' && segs.length === 5 && segs[4] === 'grant-bot-sub') return await handleAdminGrantBotSub(req, res, segs);
    if (req.method === 'GET' && sub === 'admin' && segs[2] === 'conversations') return handleAdminConversations(req, res);
    if (req.method === 'GET' && sub === 'admin' && segs[2] === 'messages') return handleAdminMessages(req, res);
    if (req.method === 'GET' && sub === 'admin' && segs[2] === 'items-all') return handleAdminItemsAll(req, res);
    if (req.method === 'POST' && sub === 'admin' && segs[2] === 'broadcast' && segs.length === 3) return await handleAdminBroadcast(req, res);
    if (req.method === 'GET' && sub === 'admin' && segs[2] === 'tickets' && segs.length === 3) return handleAdminTickets(req, res);
    if (req.method === 'POST' && sub === 'admin' && segs[2] === 'tickets' && segs.length === 5 && segs[4] === 'reply') return await handleAdminTicketReply(req, res, segs);
    if (req.method === 'GET' && sub === 'admin' && segs[2] === 'reports' && segs.length === 3) return handleAdminReports(req, res);
    if (req.method === 'POST' && sub === 'admin' && segs[2] === 'reports' && segs.length === 5 && segs[4] === 'resolve') return await handleAdminReportResolve(req, res, segs);
    if (req.method === 'POST' && sub === 'admin' && segs[2] === 'store' && segs.length === 4 && segs[3] === 'items') return await handleAdminStoreCreate(req, res);
    if (req.method === 'PATCH' && sub === 'admin' && segs[2] === 'store' && segs.length === 5 && segs[3] === 'items') return await handleAdminStoreUpdate(req, res, segs);
    if (req.method === 'POST' && sub === 'admin' && segs[2] === 'store' && segs.length === 6 && segs[3] === 'item' && segs[5] === 'toggle') return await handleAdminStoreToggle(req, res, segs);
    if (req.method === 'POST' && sub === 'admin' && segs[2] === 'stocks' && segs.length === 3) return await handleAdminStockCreate(req, res);
    if (req.method === 'GET' && sub === 'admin' && segs[2] === 'announcements' && segs.length === 3) return handleAdminAnnouncementsList(req, res);
    if (req.method === 'POST' && sub === 'admin' && segs[2] === 'announcements' && segs.length === 3) return await handleAdminAnnouncementsCreate(req, res);
    if (req.method === 'POST' && sub === 'admin' && segs[2] === 'announcements' && segs.length === 5 && segs[4] === 'toggle') return await handleAdminAnnouncementsToggle(req, res, segs);
    if (req.method === 'DELETE' && sub === 'admin' && segs[2] === 'announcements' && segs.length === 4) return handleAdminAnnouncementsDelete(req, res, segs);

    // 陪聊机器人
    if (req.method === 'GET' && sub === 'bots' && segs.length === 2) return handleBotsList(req, res);
    if (req.method === 'POST' && sub === 'bots' && segs.length === 2) return await handleBotCreate(req, res);
    if (req.method === 'PATCH' && sub === 'bots' && segs.length === 3) return await handleBotPatch(req, res, segs);
    if (req.method === 'POST' && sub === 'bots' && segs.length === 4 && segs[3] === 'toggle') return await handleBotToggle(req, res, segs);
    if (req.method === 'POST' && sub === 'bots' && segs.length === 4 && segs[3] === 'subscribe') return await handleBotSubscribe(req, res, segs);
    if (req.method === 'POST' && sub === 'bots' && segs.length === 5 && segs[3] === 'memory' && segs[4] === 'clear') return await handleBotMemoryClear(req, res, segs);

    // 用户 / 搜索
    if (req.method === 'GET' && sub === 'users' && segs.length === 2) return handleRecentUsers(req, res);
    if (req.method === 'GET' && sub === 'users' && segs.length === 3) return handleUserProfile(req, res, segs);
    if (req.method === 'GET' && sub === 'users' && segs.length === 4 && segs[3] === 'followers') return handleUserFollowers(req, res, segs);
    if (req.method === 'GET' && sub === 'users' && segs.length === 4 && segs[3] === 'following') return handleUserFollowing(req, res, segs);
    if (req.method === 'POST' && sub === 'users' && segs.length === 4 && segs[3] === 'follow') return handleToggleFollow(req, res, segs);
    if (req.method === 'GET' && sub === 'search') return handleSearch(req, res);

    // 通知
    if (req.method === 'GET' && sub === 'notifications' && segs.length === 2) return handleNotifications(req, res);
    if (req.method === 'POST' && sub === 'notifications' && segs.length === 3 && segs[2] === 'read') return handleNotificationsRead(req, res);
    if (req.method === 'GET' && sub === 'notifications' && segs.length === 3 && segs[2] === 'unread-count') return handleNotificationsUnread(req, res);

    // 公告(无需登录)
    if (req.method === 'GET' && sub === 'announcements' && segs.length === 2) return handleAnnouncements(req, res);
    if (req.method === 'GET' && sub === 'about' && segs.length === 2) return handleAbout(req, res);

    // 股票(仅官方发行, 归属 MicroX)
    if (req.method === 'GET' && sub === 'stocks' && segs.length === 2) return handleStocksList(req, res);
    if (req.method === 'GET' && sub === 'stocks' && segs.length === 3) return handleStockDetail(req, res, segs);
    if (req.method === 'POST' && sub === 'stocks' && segs.length === 4 && segs[3] === 'buy') return await handleStockTrade(req, res, segs, 'buy');
    if (req.method === 'POST' && sub === 'stocks' && segs.length === 4 && segs[3] === 'sell') return await handleStockTrade(req, res, segs, 'sell');

    // 群组
    if (req.method === 'POST' && sub === 'groups' && segs.length === 2) return await handleGroupCreate(req, res);
    if (req.method === 'GET' && sub === 'groups' && segs.length === 2) return handleGroupsList(req, res);
    if (req.method === 'GET' && sub === 'groups' && segs.length === 3) return handleGroupDetail(req, res, segs);
    if (req.method === 'DELETE' && sub === 'groups' && segs.length === 3) return handleGroupDelete(req, res, segs);
    if (req.method === 'POST' && sub === 'groups' && segs.length === 4 && segs[3] === 'invite') return await handleGroupInvite(req, res, segs);
    if (req.method === 'POST' && sub === 'groups' && segs.length === 4 && segs[3] === 'leave') return handleGroupLeave(req, res, segs);
    if (req.method === 'POST' && sub === 'groups' && segs.length === 4 && segs[3] === 'read') return await handleGroupRead(req, res, segs);
    if (req.method === 'POST' && sub === 'groups' && segs.length === 4 && segs[3] === 'messages') return await handleGroupMessage(req, res, segs);
    if (req.method === 'DELETE' && sub === 'groups' && segs.length === 5 && segs[3] === 'members') return handleGroupRemoveMember(req, res, segs);

    // 转账/拼手气红包
    if (req.method === 'POST' && sub === 'payments' && segs.length === 2) return await handlePaymentCreate(req, res);
    if (req.method === 'POST' && sub === 'payments' && segs.length === 4 && segs[3] === 'claim') return await handlePaymentClaim(req, res, segs);

    return fail(res, 404, '接口不存在');
  }

  if (await serveStatic(req, res, urlPath)) return;
  fail(res, 404, '页面不存在');
}

// ---------- 服务器启动 ----------

/** HTTP/HTTPS 共用请求处理器 */
async function handleRequest(req, res) {
  try {
    // HTTPS 强制(纵深防御): HTTP 模式(ALLOW_HTTP=1)仅允许在 TLS 终结反向代理后方运行,
    // 依据 X-Forwarded-Proto 判断外部是否确为 HTTPS。非 HTTPS 一律 301 跳转,
    // 保证明文请求绝不输出业务内容(绕过反代直连端口也拿不到数据)。
    // 仅当 TRUST_PROXY=1 才信任该头, 防客户端伪造; 直连 HTTPS 模式不经过此分支。
    if (ALLOW_HTTP && TRUST_PROXY) {
      const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
      if (proto !== 'https') {
        const host = req.headers.host || 'localhost';
        const location = `https://${host}${req.url || '/'}`;
        res.writeHead(301, { Location: location, ...SECURITY_HEADERS });
        res.end();
        return;
      }
    }
    await route(req, res);
  } catch (err) {
    if (!res.headersSent) {
      console.error(`[ERROR] ${req.method} ${req.url}:`, err.message);
      const status = err.message === '请求体过大' || err.message.includes('512MB') ? 413 : 400;
      fail(res, status, err.message || '服务器内部错误');
    } else {
      res.destroy();
    }
  }
  if (res.statusCode) logRequest(req, res.statusCode);
}

// ---------- 服务器启动(仅 HTTPS) ----------

/**
 * 加载证书并创建 HTTPS 服务器。
 * 安全加固: 只提供 HTTPS; 证书缺失时打印引导信息并退出, 不降级为明文 HTTP。
 * (若为 Falix 等反代部署, 应改用 ALLOW_HTTP=1 + TRUST_PROXY=1 的 HTTP 模式,
 *  由面板免费 SSL 终结公网 HTTPS, 见 createHttpServer)
 * @returns {https.Server} HTTPS 服务器
 */
function createHttpsServer() {
  if (!HTTPS_ENABLED) {
    console.error('[fatal] 未找到 cert/key.pem 或 cert/cert.pem，无法以 HTTPS 启动。');
    console.error('       请先运行 node gen-cert.js 生成证书后重试;');
    console.error('       或在 Falix 等 TLS 终结反代后方用 ALLOW_HTTP=1 TRUST_PROXY=1 启动。');
    process.exit(1);
  }
  try {
    return https.createServer({
      key: fs.readFileSync(CERT_KEY),
      cert: fs.readFileSync(CERT_FILE),
    }, handleRequest);
  } catch (err) {
    console.error('[fatal] HTTPS 证书加载失败:', err.message);
    process.exit(1);
  }
}

/**
 * 创建明文 HTTP 服务器(仅供 TLS 终结反向代理后方使用, 如 Falix 面板免费 SSL)。
 * 强制要求 TRUST_PROXY=1: 否则无法依据 X-Forwarded-Proto 校验外部 HTTPS,
 * 等于对公网暴露明文, 违背"确保 HTTPS"原则, 直接拒绝启动。
 * @returns {http.Server} HTTP 服务器
 */
function createHttpServer() {
  if (!TRUST_PROXY) {
    console.error('[fatal] ALLOW_HTTP=1 仅用于 TLS 终结反向代理(如 Falix 面板 SSL)后方。');
    console.error('       为确保公网 HTTPS, 必须同时设置 TRUST_PROXY=1;');
    console.error('       否则无法校验 X-Forwarded-Proto, 拒绝以明文对外提供服务。');
    process.exit(1);
  }
  return http.createServer(handleRequest);
}

/**
 * 获取本机可用于局域网访问的 IPv4 地址列表。
 * 排除回环/APIPA/VMware 等虚拟网卡(虚拟网卡地址会导致其他设备连接超时)。
 */
function getLanIps() {
  const candidates = [];
  for (const [name, items] of Object.entries(os.networkInterfaces())) {
    for (const item of items || []) {
      if (item.family !== 'IPv4' || item.internal) continue;
      const isVirtual = /vmware|virtualbox|hyper-v|vethernet|docker/i.test(name);
      const isApipa = item.address.startsWith('169.254.');
      candidates.push({ addr: item.address, isVirtual, isApipa });
    }
  }
  return candidates
    .sort((a, b) => Number(a.isVirtual || a.isApipa) - Number(b.isVirtual || b.isApipa))
    .map((c) => c.addr);
}

// 启动前确保管理员账号存在, 并清理过期会话
ensureAdmin();
db.pruneExpiredSessions();
// 奖励配置默认值种入 settings(仅补缺失键, 不覆盖管理员已调整的值);
// 保证 server.js 与 db.js 读取一致的数值, 且管理页展示即实际生效值
for (const [key, def] of Object.entries(REWARD_DEFAULTS)) {
  const k = 'reward_' + key;
  const v = db.getSetting(k);
  if (v === null || v === '') db.setSetting(k, String(def));
}
for (const [key, freq] of Object.entries(REWARD_FREQ_DEFAULTS)) {
  for (const [field, val] of Object.entries(freq)) {
    const k = `reward_${key}_${field}`;
    const v = db.getSetting(k);
    if (v === null || v === '') db.setSetting(k, String(val));
  }
}
// 清理奖励频率表的过期记录(保留当天与前一天, 防止跨时区边界误删)
db.purgeRewardUsage(todayUtc());
// 语义缓存建表(幂等, 复用主数据库连接, 数据随主库持久化)
semanticCache.initSemanticCache(db.db);

// 导出核心函数供单元测试(测试脚本 require 本文件时不监听端口, 见下方 require.main 守卫)
module.exports = {
  botBuyItem, botEquipItem, parseBotStoreActions, buildStoreContext, buildBotSystemPrompt,
  parseBotStockActions, buildStockContext, buildBotPortfolioContext, aiTradeState, aiTradeSpend,
  buyStock, sellStock, stockTickAll, aiTradeAll, userTradeAllowed, refillBotWallets,
};

if (require.main === module) {
  const server = ALLOW_HTTP ? createHttpServer() : createHttpsServer();
  server.listen(PORT, HOST, () => {
    console.log('==============================================');
    if (ALLOW_HTTP) {
      // 反代后 HTTP 模式: 公网 HTTPS 由 Falix 等面板的免费 SSL 终结, 本端口仅供内网反代连接
      console.log('  MicroX 已启动 (反代后 HTTP 模式, 公网 HTTPS 由 Falix 面板终结)');
      console.log(`  反代内网访问: http://localhost:${PORT}`);
      console.log('  公网请通过面板域名访问: https://<你的Falix域名>');
      console.log('  已强制校验 X-Forwarded-Proto, 非 HTTPS 请求自动跳转');
    } else {
      console.log('  MicroX 已启动 (仅 HTTPS)');
      console.log(`  本机访问:   https://localhost:${PORT}`);
      for (const ip of getLanIps()) {
        console.log(`  局域网访问: https://${ip}:${PORT}`);
      }
    }
    console.log('  按 Ctrl+C 停止服务');
    console.log('==============================================');
  });
}
