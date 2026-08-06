/**
 * gen-cert.js — 生成 HTTPS 自签名证书(零依赖, 借助 openssl, 跨平台)
 *
 * 作用:
 *   在项目 cert/ 目录下生成 key.pem + cert.pem, 供 server.js 自动启用 HTTPS。
 *   证书为自签名, 有效期 398 天(符合 CA/B Forum 最佳实践上限), 同时包含
 *   localhost / 127.0.0.1 / 本机所有局域网 IP 的 SAN(Subject Alternative Name),
 *   保证通过局域网 IP 访问时不会出现 "证书与主机名不匹配" 错误。
 *
 * 适用场景:
 *   仅用于局域网直连部署。Falix 等公网部署无需此脚本——公网 HTTPS 由面板的
 *   Let's Encrypt 免费 SSL 终结, 服务端用 ALLOW_HTTP=1 TRUST_PROXY=1 以 HTTP 跑在反代后方。
 *
 * 用法:
 *   node gen-cert.js
 *
 * 前置条件:
 *   需要 openssl(Windows: Git for Windows 自带; Linux: apt install openssl)。
 *   自签名证书浏览器会提示"不受信任", 首次访问点"高级 → 继续前往"即可。
 *   想消除警告, 可在每台设备上把 cert/cert.pem 导入受信任根证书。
 */
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = __dirname;
const CERT_DIR = path.join(ROOT, 'cert');
const CERT_KEY = path.join(CERT_DIR, 'key.pem');
const CERT_FILE = path.join(CERT_DIR, 'cert.pem');
const CERT_CNF = path.join(CERT_DIR, 'openssl.cnf');
const CERT_DAYS = 398;  // 有效期上限 398 天(CA/B Forum 建议); 旧证书 10 年过长, 泄露后影响面大

// 常见的 Git/openssl 安装位置(找不到时用 PATH 里的 openssl)
const OPENSSL_CANDIDATES = [
  process.env.OPENSSL || '',
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'usr', 'bin', 'openssl.exe'),
  path.join(process.env.ProgramW6432 || 'C:\\Program Files', 'Git', 'usr', 'bin', 'openssl.exe'),
  path.join('C:\\Program Files', 'Git', 'usr', 'bin', 'openssl.exe'),
  path.join('D:\\Git', 'usr', 'bin', 'openssl.exe'),
  '/usr/bin/openssl',
  '/usr/local/bin/openssl',
].filter(Boolean);

function findOpenSSL() {
  for (const p of OPENSSL_CANDIDATES) {
    if (p && fs.existsSync(p)) return p;
  }
  // 跨平台: Windows 用 where, Linux/macOS 用 which, 从 PATH 查找 openssl
  const lookupCmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const found = execFileSync(lookupCmd, ['openssl'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().split(/\r?\n/)[0].trim();
    if (found) return found;
  } catch { /* PATH 里没有 */ }
  return null;
}

/** 排除虚拟网卡/APIPA 后的本机局域网 IPv4 列表(与 server.js getLanIps 一致) */
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

function buildConfig(ips) {
  const alt = [
    'DNS.1 = localhost',
    'DNS.2 = *.localhost',
    'IP.1 = 127.0.0.1',
    ...ips.map((ip, i) => `IP.${i + 2} = ${ip}`),
  ].join('\n');
  return `[req]
distinguished_name = dn
req_extensions = v3_req
x509_extensions = v3_ext
prompt = no

[dn]
CN = MicroX

[v3_req]
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[v3_ext]
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
${alt}
`;
}

async function main() {
  const openssl = findOpenSSL();
  if (!openssl) {
    console.error('[gen-cert] 未找到 openssl。请安装 OpenSSL(Linux: apt install openssl; Windows: Git for Windows)后重试。');
    process.exit(1);
  }
  console.log('[gen-cert] 使用 openssl:', openssl);

  fs.mkdirSync(CERT_DIR, { recursive: true });
  const ips = getLanIps();
  console.log('[gen-cert] 本机局域网 IP:', ips.length ? ips.join(', ') : '(未检测到)');
  fs.writeFileSync(CERT_CNF, buildConfig(ips), 'utf8');

  // 生成 RSA 2048 私钥 + 自签名证书(同时满足服务器认证用途)
  const args = [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', CERT_KEY,
    '-out', CERT_FILE,
    '-days', String(CERT_DAYS),
    '-config', CERT_CNF,
  ];
  execFileSync(openssl, args, { stdio: 'inherit' });
  fs.rmSync(CERT_CNF, { force: true });

  console.log('');
  console.log('[gen-cert] 证书已生成:');
  console.log('  私钥:', CERT_KEY);
  console.log('  证书:', CERT_FILE);
  console.log('');
  console.log('  HTTPS 已启用。重启服务后访问:');
  console.log('  本机: https://localhost:25185');
  for (const ip of ips)   console.log('  局域网: https://' + ip + ':25185');
  console.log('');
  console.log('  注意: 自签名证书浏览器会提示"不受信任", 首次访问点"高级 → 继续前往"。');
  console.log('  想彻底消除警告, 请把 cert/cert.pem 导入每台设备的受信任根证书。');
}

main().catch((err) => {
  console.error('[gen-cert] 生成失败:', err.message);
  process.exit(1);
});
