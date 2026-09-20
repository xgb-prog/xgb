/* 青柠漫剧播放器 — 授权服务器（Cloudflare Pages Functions 版）
 * 功能：激活码服务端验证，防止同一激活码多设备使用
 * 存储：Upstash Redis（永久存储）
 * 部署：Cloudflare Pages Functions
 * 版本：v2.0 - 预导入激活码，严格管理
 */

// 校验码密钥
const SECRET = 'FGMM-MANJU-2026';

// ========== 工具函数 ==========
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}

// 校验激活码格式和校验码
function verifyCodeFormat(code) {
  const match = code.match(/^FGMM-([DMY])-(\d{4})-([0-9A-F]{4})$/);
  if (!match) return false;
  const [, cardType, seq, sig] = match;
  let h = 0x811c9dc5;
  const s = cardType + '|' + seq + '|' + SECRET;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const expected = (h & 0xffff).toString(16).toUpperCase().padStart(4, '0');
  return expected === sig;
}

// ========== Redis 操作（Upstash REST API）==========
async function redisGet(env, key) {
  try {
    const res = await fetch(`${env.UPSTASH_REDIS_REST_URL}/get/${key}`, {
      headers: { 'Authorization': `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }
    });
    const data = await res.json();
    if (data && data.result) return JSON.parse(data.result);
    return null;
  } catch (e) {
    console.error('Redis GET 失败:', e.message);
    return null;
  }
}

async function redisSet(env, key, value) {
  try {
    // 使用 Upstash Redis 原生命令格式，更可靠
    const res = await fetch(`${env.UPSTASH_REDIS_REST_URL}/`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(['SET', key, JSON.stringify(value)])
    });
    const data = await res.json();
    if (data && data.error) {
      console.error('Redis SET 错误:', data.error);
      return false;
    }
    return true;
  } catch (e) {
    console.error('Redis SET 失败:', e.message);
    return false;
  }
}

const LICENSES_KEY = 'orange_player_licenses';
const CODES_KEY = 'orange_player_codes';

// ========== 主处理函数 ==========
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  let path = url.pathname;

  // 去掉 /api 前缀
  if (path.startsWith('/api')) {
    path = path.slice('/api'.length) || '/';
  }
  if (path === '') path = '/';

  console.log('[请求] method:', request.method, 'path:', path);

  // CORS 预检
  if (request.method === 'OPTIONS') {
    return jsonResponse({}, 200);
  }

  // 管理密码
  const ADMIN_PASSWORD = env.ADMIN_PASSWORD || 'orange-admin-2026';

  // ========== 首页状态 ==========
  if (path === '/' && request.method === 'GET') {
    const licenses = await redisGet(env, LICENSES_KEY) || {};
    const codes = await redisGet(env, CODES_KEY) || {};

    // 用 Set 统计所有已激活的激活码，避免重复或遗漏
    // （同时从 codes 和 licenses 中统计，确保数据不同步时也能正确统计）
    const activatedSet = new Set();
    for (const [code, info] of Object.entries(codes)) {
      if (info.status === 'activated') {
        activatedSet.add(code);
      }
    }
    for (const [code, lic] of Object.entries(licenses)) {
      if (lic.deviceFingerprint) {
        activatedSet.add(code);
      }
    }
    const activatedCount = activatedSet.size;

    const unusedCount = Object.values(codes).filter(c => c.status === 'unused').length;
    const disabledCount = Object.values(codes).filter(c => c.status === 'disabled').length;

    // 总激活码数：codes 中的数量 + 在 licenses 中但不在 codes 中的数量
    const allCodesSet = new Set(Object.keys(codes));
    for (const code of Object.keys(licenses)) {
      allCodesSet.add(code);
    }
    const totalCodes = allCodesSet.size;

    return jsonResponse({
      ok: true,
      msg: '青柠漫剧授权服务器运行中（Cloudflare Pages Functions 版）',
      storage: 'Upstash Redis',
      stats: {
        totalCodes,
        unused: unusedCount,
        activated: activatedCount,
        disabled: disabledCount,
        activeLicenses: Object.keys(licenses).length
      },
      time: new Date().toISOString()
    });
  }

  // 解析请求体
  let body = {};
  if (request.method === 'POST') {
    try {
      body = await request.json();
    } catch (e) {
      console.error('请求体解析失败:', e.message);
    }
  }

  // ========== 激活接口 ==========
  if (path === '/activate' && request.method === 'POST') {
    try {
      const { code, deviceFingerprint, days } = body;
      console.log('[激活请求] code:', code, 'deviceFingerprint:', deviceFingerprint);

      if (!code || !deviceFingerprint) {
        return jsonResponse({ ok: false, msg: '参数缺失：需要 code 和 deviceFingerprint' }, 400);
      }

      if (!verifyCodeFormat(code)) {
        return jsonResponse({ ok: false, msg: '激活码格式错误或校验码无效' }, 400);
      }

      const codes = await redisGet(env, CODES_KEY) || {};
      if (!codes[code]) {
        return jsonResponse({ ok: false, msg: '激活码无效或未发放，请联系客服' }, 403);
      }

      const codeInfo = codes[code];
      if (codeInfo.status === 'disabled') {
        return jsonResponse({ ok: false, msg: '激活码已被禁用，请联系客服' }, 403);
      }

      const licenses = await redisGet(env, LICENSES_KEY) || {};

      if (codeInfo.status === 'activated' && !licenses[code]) {
        return jsonResponse({ ok: false, msg: '激活码状态异常，请联系客服（该激活码可能已在其他设备激活）' }, 403);
      }

      if (licenses[code]) {
        const lic = licenses[code];
        if (lic.deviceFingerprint === deviceFingerprint) {
          lic.activatedAt = Date.now();
          // 忽略客户端传的 days，使用激活码本身的类型决定天数
          const cardType = code.match(/^FGMM-([DMY])-/)[1];
          lic.days = cardType === 'D' ? 1 : (cardType === 'Y' ? 365 : 30);
          delete lic.remainingDays;
          delete lic.unboundAt;
          await redisSet(env, LICENSES_KEY, licenses);
          return jsonResponse({
            ok: true, msg: '激活成功（同一设备续期）',
            activatedAt: lic.activatedAt,
            expireAt: lic.activatedAt + lic.days * 24 * 3600 * 1000,
            days: lic.days
          });
        } else if (lic.deviceFingerprint === null || lic.deviceFingerprint === undefined) {
          const remainingDays = lic.remainingDays || lic.days || 30;
          lic.deviceFingerprint = deviceFingerprint;
          lic.activatedAt = Date.now();
          lic.days = remainingDays;
          delete lic.remainingDays;
          delete lic.unboundAt;
          await redisSet(env, LICENSES_KEY, licenses);
          return jsonResponse({
            ok: true, msg: `激活成功（更换设备，剩余${remainingDays}天）`,
            activatedAt: lic.activatedAt,
            expireAt: lic.activatedAt + remainingDays * 24 * 3600 * 1000,
            remainingDays,
            days: remainingDays
          });
        } else {
          return jsonResponse({ ok: false, msg: '该激活码已绑定其他设备，无法在本设备使用。如需更换设备请联系客服解绑。' }, 403);
        }
      } else {
        if (codeInfo.status !== 'unused') {
          return jsonResponse({ ok: false, msg: '激活码状态异常，请联系客服' }, 403);
        }
        const cardType = code.match(/^FGMM-([DMY])-/)[1];
        // 忽略客户端传的 days，直接使用激活码类型对应的天数：D=1天, M=30天, Y=365天
        const useDays = cardType === 'D' ? 1 : (cardType === 'Y' ? 365 : 30);

        licenses[code] = {
          deviceFingerprint, activatedAt: Date.now(), days: useDays, firstActivatedAt: Date.now()
        };
        codes[code].status = 'activated';
        codes[code].activatedAt = Date.now();
        codes[code].deviceFingerprint = deviceFingerprint;

        await redisSet(env, LICENSES_KEY, licenses);
        await redisSet(env, CODES_KEY, codes);

        return jsonResponse({
          ok: true, msg: '激活成功',
          activatedAt: licenses[code].activatedAt,
          expireAt: licenses[code].activatedAt + useDays * 24 * 3600 * 1000,
          days: useDays
        });
      }
    } catch (e) {
      console.error('[激活错误]', e.message);
      return jsonResponse({ ok: false, msg: '服务器错误: ' + e.message }, 500);
    }
  }

  // ========== 验证接口 ==========
  if (path === '/verify' && request.method === 'POST') {
    try {
      const { code, deviceFingerprint } = body;
      const licenses = await redisGet(env, LICENSES_KEY) || {};
      if (!licenses[code]) return jsonResponse({ ok: false, msg: '激活码未激活' }, 200);
      const lic = licenses[code];
      if (lic.deviceFingerprint === null || lic.deviceFingerprint === undefined) return jsonResponse({ ok: false, msg: '激活码已解绑，请重新激活' }, 200);
      if (lic.deviceFingerprint !== deviceFingerprint) return jsonResponse({ ok: false, msg: '该激活码已绑定其他设备' }, 403);
      const expireAt = lic.activatedAt + (lic.days || 30) * 24 * 3600 * 1000;
      if (Date.now() > expireAt) return jsonResponse({ ok: false, msg: '激活码已过期' }, 200);
      return jsonResponse({
        ok: true, activatedAt: lic.activatedAt, expireAt,
        remainDays: Math.ceil((expireAt - Date.now()) / (24 * 3600 * 1000))
      });
    } catch (e) {
      return jsonResponse({ ok: false, msg: '服务器错误: ' + e.message }, 500);
    }
  }

  // ========== 管理接口：批量导入 ==========
  if (path === '/admin/import' && request.method === 'POST') {
    try {
      const { codes: codeList, password } = body;
      if (password !== ADMIN_PASSWORD) return jsonResponse({ ok: false, msg: '管理密码错误' }, 403);
      if (!codeList || !Array.isArray(codeList) || codeList.length === 0) return jsonResponse({ ok: false, msg: '参数缺失：需要 codes 数组' }, 400);

      const codes = await redisGet(env, CODES_KEY) || {};
      let imported = 0, skipped = 0, invalid = 0;
      for (const code of codeList) {
        const trimmed = String(code).trim();
        if (!trimmed) continue;
        if (!verifyCodeFormat(trimmed)) { invalid++; continue; }
        if (codes[trimmed]) { skipped++; continue; }
        const match = trimmed.match(/^FGMM-([DMY])-(\d{4})-/);
        const cardType = match ? match[1] : 'M';
        const seq = match ? match[2] : '0000';
        codes[trimmed] = { status: 'unused', cardType, seq, createdAt: Date.now() };
        imported++;
      }
      await redisSet(env, CODES_KEY, codes);
      return jsonResponse({
        ok: true, msg: `导入完成：成功${imported}个，跳过${skipped}个（已存在），无效${invalid}个（格式错误）`,
        stats: { imported, skipped, invalid, total: Object.keys(codes).length }
      });
    } catch (e) {
      return jsonResponse({ ok: false, msg: '服务器错误: ' + e.message }, 500);
    }
  }

  // ========== 管理接口：查询所有激活码 ==========
  if (path === '/admin/codes' && request.method === 'GET') {
    try {
      const password = url.searchParams.get('password');
      const status = url.searchParams.get('status');
      const page = parseInt(url.searchParams.get('page')) || 1;
      const pageSize = parseInt(url.searchParams.get('pageSize')) || 50;
      if (password !== ADMIN_PASSWORD) return jsonResponse({ ok: false, msg: '管理密码错误' }, 403);

      const codes = await redisGet(env, CODES_KEY) || {};
      const licenses = await redisGet(env, LICENSES_KEY) || {};

      // 合并 codes 和 licenses，确保在 licenses 中但不在 codes 中的激活码也能显示
      const merged = {};
      for (const [code, info] of Object.entries(codes)) {
        merged[code] = { ...info, code };
      }
      for (const [code, lic] of Object.entries(licenses)) {
        if (!merged[code]) {
          // 在 licenses 中但不在 codes 中，自动添加到 merged
          const cardType = code.match(/^FGMM-([DMY])-/) ? code.match(/^FGMM-([DMY])-/)[1] : 'M';
          merged[code] = {
            code,
            status: lic.deviceFingerprint ? 'activated' : 'unused',
            cardType,
            createdAt: lic.firstActivatedAt || lic.activatedAt || Date.now(),
            activatedAt: lic.activatedAt,
            deviceFingerprint: lic.deviceFingerprint,
            _fromLicenses: true
          };
        } else if (lic.deviceFingerprint && merged[code].status !== 'activated') {
          // codes 中状态不对，用 licenses 的状态修正
          merged[code].status = 'activated';
          merged[code].activatedAt = lic.activatedAt;
          merged[code].deviceFingerprint = lic.deviceFingerprint;
        }
      }

      let codeList = Object.values(merged);
      if (status) codeList = codeList.filter(c => c.status === status);
      codeList.sort((a, b) => (b.activatedAt || b.createdAt || 0) - (a.activatedAt || a.createdAt || 0));
      const total = codeList.length;
      const totalPages = Math.ceil(total / pageSize);
      const start = (page - 1) * pageSize;
      const pageData = codeList.slice(start, start + pageSize);
      return jsonResponse({ ok: true, total, page, pageSize, totalPages, codes: pageData });
    } catch (e) {
      return jsonResponse({ ok: false, msg: '服务器错误: ' + e.message }, 500);
    }
  }

  // ========== 管理接口：修复数据同步（支持 GET 和 POST，GET 可直接在浏览器地址栏访问）==========
  if (path === '/admin/fix-sync' && (request.method === 'POST' || request.method === 'GET')) {
    try {
      // GET 从 URL 参数读取密码，POST 从 body 读取密码
      const password = request.method === 'GET' ? url.searchParams.get('password') : (body.password || '');
      if (password !== ADMIN_PASSWORD) return jsonResponse({ ok: false, msg: '管理密码错误' }, 403);

      const codes = await redisGet(env, CODES_KEY) || {};
      const licenses = await redisGet(env, LICENSES_KEY) || {};
      let fixed = 0;

      for (const [code, lic] of Object.entries(licenses)) {
        if (!codes[code]) {
          // 在 licenses 中但不在 codes 中，添加到 codes
          const cardType = code.match(/^FGMM-([DMY])-/) ? code.match(/^FGMM-([DMY])-/)[1] : 'M';
          codes[code] = {
            status: lic.deviceFingerprint ? 'activated' : 'unused',
            cardType,
            createdAt: lic.firstActivatedAt || lic.activatedAt || Date.now(),
            activatedAt: lic.activatedAt,
            deviceFingerprint: lic.deviceFingerprint
          };
          fixed++;
        } else if (lic.deviceFingerprint && codes[code].status !== 'activated') {
          // 状态不对，修正
          codes[code].status = 'activated';
          codes[code].activatedAt = lic.activatedAt;
          codes[code].deviceFingerprint = lic.deviceFingerprint;
          fixed++;
        }
      }

      await redisSet(env, CODES_KEY, codes);
      return jsonResponse({
        ok: true,
        msg: `数据同步修复完成，修复了 ${fixed} 个激活码`,
        fixed,
        totalCodes: Object.keys(codes).length,
        totalLicenses: Object.keys(licenses).length
      });
    } catch (e) {
      return jsonResponse({ ok: false, msg: '服务器错误: ' + e.message }, 500);
    }
  }

  // ========== 管理接口：禁用 ==========
  if (path === '/admin/disable' && request.method === 'POST') {
    try {
      const { code, password } = body;
      if (password !== ADMIN_PASSWORD) return jsonResponse({ ok: false, msg: '管理密码错误' }, 403);
      const codes = await redisGet(env, CODES_KEY) || {};
      if (!codes[code]) return jsonResponse({ ok: false, msg: '激活码不存在' }, 404);
      codes[code].status = 'disabled';
      codes[code].disabledAt = Date.now();
      await redisSet(env, CODES_KEY, codes);
      return jsonResponse({ ok: true, msg: '激活码已禁用', code });
    } catch (e) {
      return jsonResponse({ ok: false, msg: '服务器错误: ' + e.message }, 500);
    }
  }

  // ========== 管理接口：启用 ==========
  if (path === '/admin/enable' && request.method === 'POST') {
    try {
      const { code, password } = body;
      if (password !== ADMIN_PASSWORD) return jsonResponse({ ok: false, msg: '管理密码错误' }, 403);
      const codes = await redisGet(env, CODES_KEY) || {};
      if (!codes[code]) return jsonResponse({ ok: false, msg: '激活码不存在' }, 404);
      codes[code].status = 'unused';
      codes[code].enabledAt = Date.now();
      delete codes[code].disabledAt;
      await redisSet(env, CODES_KEY, codes);
      return jsonResponse({ ok: true, msg: '激活码已启用（状态改为未激活）', code });
    } catch (e) {
      return jsonResponse({ ok: false, msg: '服务器错误: ' + e.message }, 500);
    }
  }

  // ========== 管理接口：解绑 ==========
  if (path === '/admin/unbind' && request.method === 'POST') {
    try {
      const { code, password } = body;
      if (password !== ADMIN_PASSWORD) return jsonResponse({ ok: false, msg: '管理密码错误' }, 403);
      if (!code) return jsonResponse({ ok: false, msg: '参数缺失：需要 code' }, 400);
      const licenses = await redisGet(env, LICENSES_KEY) || {};
      if (!licenses[code]) return jsonResponse({ ok: false, msg: '激活码不存在或未激活' }, 404);
      const lic = licenses[code];
      const expireAt = lic.activatedAt + (lic.days || 30) * 24 * 3600 * 1000;
      const remainMs = expireAt - Date.now();
      const remainingDays = Math.max(0, Math.ceil(remainMs / (24 * 3600 * 1000)));
      if (remainMs <= 0) {
        delete licenses[code];
        const codes = await redisGet(env, CODES_KEY) || {};
        if (codes[code]) {
          codes[code].status = 'unused';
          delete codes[code].activatedAt;
          delete codes[code].deviceFingerprint;
          await redisSet(env, CODES_KEY, codes);
        }
        await redisSet(env, LICENSES_KEY, licenses);
        return jsonResponse({ ok: true, msg: '激活码已过期，已删除', code, expired: true });
      }
      lic.deviceFingerprint = null;
      lic.remainingDays = remainingDays;
      lic.unboundAt = Date.now();
      await redisSet(env, LICENSES_KEY, licenses);
      const codes = await redisGet(env, CODES_KEY) || {};
      if (codes[code]) {
        codes[code].status = 'unused';
        codes[code].unboundAt = Date.now();
        delete codes[code].deviceFingerprint;
        await redisSet(env, CODES_KEY, codes);
      }
      return jsonResponse({
        ok: true, msg: `解绑成功，剩余${remainingDays}天，用户可在新设备重新激活`,
        code, remainingDays, expireAt, unboundAt: lic.unboundAt
      });
    } catch (e) {
      return jsonResponse({ ok: false, msg: '服务器错误: ' + e.message }, 500);
    }
  }

  // ========== 查询激活码状态（公开） ==========
  if (path.startsWith('/status/') && request.method === 'GET') {
    const code = decodeURIComponent(path.slice('/status/'.length));
    const codes = await redisGet(env, CODES_KEY) || {};
    const licenses = await redisGet(env, LICENSES_KEY) || {};
    if (codes[code] || licenses[code]) {
      const codeInfo = codes[code] || {};
      const lic = licenses[code] || {};
      const expireAt = lic.activatedAt ? lic.activatedAt + (lic.days || 30) * 24 * 3600 * 1000 : null;
      return jsonResponse({
        ok: true, code,
        status: codeInfo.status || (lic ? 'activated' : 'unknown'),
        cardType: codeInfo.cardType, createdAt: codeInfo.createdAt,
        activatedAt: lic.activatedAt, days: lic.days, remainingDays: lic.remainingDays,
        expireAt, expired: expireAt ? Date.now() > expireAt : false,
        deviceBound: lic.deviceFingerprint ? '已绑定' : (lic.deviceFingerprint === null ? '已解绑' : '未绑定')
      });
    } else {
      return jsonResponse({ ok: false, msg: '激活码不存在或未发放' }, 404);
    }
  }

  return jsonResponse({ ok: false, msg: 'Not Found' }, 404);
}
