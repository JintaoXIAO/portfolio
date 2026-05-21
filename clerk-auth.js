// Clerk JWT 验证 — 使用 Workers 内建 Web Crypto + Clerk JWKS 公钥验证
// 不依赖任何外部库（jose 等）以保持 Worker bundle 体积最小
//
// 工作原理：
// 1. Clerk 用 RS256 签名 session token，公钥发布在 https://<frontend-api>/.well-known/jwks.json
// 2. 我们获取 JWKS 公钥（带缓存，避免每次请求都打 Clerk）
// 3. 用 token header 中的 kid 找对应公钥，crypto.subtle.verify 验证签名
// 4. 验证成功后检查 exp / nbf / iss 等 claim
// 5. 返回 payload 中的 sub（userId）

const CLERK_FRONTEND_API = 'https://ample-dinosaur-70.clerk.accounts.dev';
const JWKS_URL = `${CLERK_FRONTEND_API}/.well-known/jwks.json`;
const EXPECTED_ISSUER = CLERK_FRONTEND_API;

// 简单的内存缓存：JWKS 公钥几乎不变，缓存 1 小时
let jwksCache = null;
let jwksCacheExpiry = 0;
const JWKS_TTL_MS = 60 * 60 * 1000; // 1 小时

/**
 * 主入口：从 Authorization 头提取 token，验证后返回 userId
 * @returns {Promise<string|null>} userId 或 null
 */
export async function verifyClerkToken(request) {
  const auth = request.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1].trim();
  if (!token) return null;

  try {
    const payload = await verifyJWT(token);
    return payload.sub || null;
  } catch (err) {
    console.warn('[clerk-auth] token 验证失败:', err.message);
    return null;
  }
}

/**
 * 验证 JWT 完整流程
 */
async function verifyJWT(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('JWT 格式不正确');

  const [headerB64, payloadB64, signatureB64] = parts;
  const header = JSON.parse(b64UrlDecodeToString(headerB64));
  const payload = JSON.parse(b64UrlDecodeToString(payloadB64));

  // 算法检查
  if (header.alg !== 'RS256') {
    throw new Error(`不支持的算法: ${header.alg}`);
  }
  if (!header.kid) {
    throw new Error('JWT header 缺少 kid');
  }

  // claim 检查
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) {
    throw new Error('token 已过期');
  }
  if (payload.nbf && payload.nbf > now + 5) {
    // 允许 5 秒时钟偏差
    throw new Error('token 尚未生效');
  }
  if (payload.iss && payload.iss !== EXPECTED_ISSUER) {
    throw new Error(`签发者不匹配: ${payload.iss}`);
  }

  // 找匹配的 JWK
  const jwks = await getJWKS();
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    // 缓存可能过期了（Clerk rotate 了密钥），强制刷新一次
    jwksCache = null;
    const fresh = await getJWKS();
    const retry = fresh.keys.find((k) => k.kid === header.kid);
    if (!retry) throw new Error(`找不到 kid=${header.kid} 对应的公钥`);
    return verifySignature(retry, headerB64, payloadB64, signatureB64, payload);
  }

  return verifySignature(jwk, headerB64, payloadB64, signatureB64, payload);
}

async function verifySignature(jwk, headerB64, payloadB64, signatureB64, payload) {
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = b64UrlDecodeToBytes(signatureB64);

  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, data);
  if (!ok) throw new Error('签名验证失败');
  return payload;
}

async function getJWKS() {
  const now = Date.now();
  if (jwksCache && now < jwksCacheExpiry) return jwksCache;

  const resp = await fetch(JWKS_URL);
  if (!resp.ok) throw new Error(`获取 JWKS 失败: HTTP ${resp.status}`);
  const json = await resp.json();
  if (!json.keys || !Array.isArray(json.keys)) {
    throw new Error('JWKS 响应格式错误');
  }
  jwksCache = json;
  jwksCacheExpiry = now + JWKS_TTL_MS;
  return json;
}

// === Base64URL helpers ===

function b64UrlDecodeToString(s) {
  return new TextDecoder().decode(b64UrlDecodeToBytes(s));
}

function b64UrlDecodeToBytes(s) {
  // base64url -> base64
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  // 补齐 padding
  while (s.length % 4 !== 0) s += '=';
  const binary = atob(s);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
