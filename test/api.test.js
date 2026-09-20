'use strict';

/**
 * HTTP 接口集成测试：启动 Express app（随机端口），验证试印核验
 * 「下一处观察建议」随 /api/impose 响应进入 verification 导出数据。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../server');

const BASE = { totalPages: 8, sheetsPerSignature: 2, binding: 'left', flip: 'short' };

function obs(patch) {
  return { signature: 1, sheet: 1, side: 'front', position: 'left', page: 8, orientation: 'upright', ...patch };
}

async function withServer(run) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

async function impose(base, body) {
  const resp = await fetch(`${base}/api/impose`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  return { status: resp.status, data };
}

test('接口：无法判定时 suggestion 进入 verification 导出数据，含定位与各候选预期值', async () => {
  await withServer(async (base) => {
    const { status, data } = await impose(base, { ...BASE, observations: [obs({})] });
    assert.equal(status, 200);
    const v = data.verification;
    assert.equal(v.enabled, true);
    assert.equal(v.conclusion.status, 'undetermined');
    const s = v.conclusion.suggestion;
    assert.equal(s.available, true);
    assert.deepEqual(s.location, { signature: 1, sheet: 1, side: 'back', position: 'left' });
    assert.equal(s.expectations.length, 2);
    assert.deepEqual(
      s.expectations.map((e) => [e.binding, e.flip, e.page, e.orientation]),
      [
        ['left', 'short', 2, 'upright'],
        ['left', 'long', 7, 'rotated'],
      ]
    );
    assert.equal(typeof s.outcomeGroups, 'number');
    assert.equal(typeof s.worstCaseRemaining, 'number');
    assert.match(s.message, /建议下一步观察/);
  });
});

test('接口：并列但无法继续区分时 suggestion.available = false 且给出原因', async () => {
  await withServer(async (base) => {
    // 1 页 1 张：观察 3 个页位（留背面右页位未观察），左装订两种翻转仍并列且剩余页位无区分度
    const { status, data } = await impose(base, {
      totalPages: 1,
      sheetsPerSignature: 1,
      binding: 'left',
      flip: 'short',
      observations: [
        { signature: 1, sheet: 1, side: 'front', position: 'left', page: null, orientation: 'upright' },
        { signature: 1, sheet: 1, side: 'front', position: 'right', page: 1, orientation: 'upright' },
        { signature: 1, sheet: 1, side: 'back', position: 'left', page: null, orientation: 'upright' },
      ],
    });
    assert.equal(status, 200);
    assert.equal(data.verification.conclusion.status, 'undetermined');
    const s = data.verification.conclusion.suggestion;
    assert.equal(s.available, false);
    assert.equal(s.reason, 'indistinguishable');
    assert.equal(s.location, undefined);
  });
});

test('接口：全部页位观察完仍并列时 reason = no-unobserved-slot', async () => {
  await withServer(async (base) => {
    const { status, data } = await impose(base, {
      totalPages: 1,
      sheetsPerSignature: 1,
      binding: 'left',
      flip: 'short',
      observations: [
        { signature: 1, sheet: 1, side: 'front', position: 'left', page: null, orientation: 'upright' },
        { signature: 1, sheet: 1, side: 'front', position: 'right', page: 1, orientation: 'upright' },
        { signature: 1, sheet: 1, side: 'back', position: 'left', page: null, orientation: 'upright' },
        { signature: 1, sheet: 1, side: 'back', position: 'right', page: null, orientation: 'upright' },
      ],
    });
    assert.equal(status, 200);
    const s = data.verification.conclusion.suggestion;
    assert.equal(s.available, false);
    assert.equal(s.reason, 'no-unobserved-slot');
  });
});

test('接口：verified / failed 与无观察响应均不含 suggestion（行为不变）', async () => {
  await withServer(async (base) => {
    // 唯一零差异 → verified
    const ok = await impose(base, {
      ...BASE,
      observations: [
        obs({}),
        obs({ side: 'back', page: 2, orientation: 'upright' }),
      ],
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.verification.conclusion.status, 'verified');
    assert.equal(ok.data.verification.conclusion.suggestion, undefined);

    // failed
    const fail = await impose(base, {
      ...BASE,
      observations: [
        obs({ side: 'back', position: 'left', page: 2, orientation: 'upright' }),
        obs({ side: 'back', position: 'right', page: 7, orientation: 'upright' }),
        obs({ side: 'front', position: 'left', page: 1, orientation: 'upright' }),
      ],
    });
    assert.equal(fail.data.verification.conclusion.status, 'failed');
    assert.equal(fail.data.verification.conclusion.suggestion, undefined);

    // 无观察 → { enabled: false }，结构不变
    const none = await impose(base, BASE);
    assert.equal(none.status, 200);
    assert.deepEqual(none.data.verification, { enabled: false });

    const empty = await impose(base, { ...BASE, observations: [] });
    assert.deepEqual(empty.data.verification, { enabled: false });
  });
});

test('接口：健康检查与静态页面不受影响', async () => {
  await withServer(async (base) => {
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /骑马钉/);
  });
});
