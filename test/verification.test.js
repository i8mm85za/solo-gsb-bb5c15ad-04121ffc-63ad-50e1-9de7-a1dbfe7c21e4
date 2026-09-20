'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeImposition } = require('../src/imposition');
const { suggestNextObservation } = require('../src/verification');

const BASE = { totalPages: 8, sheetsPerSignature: 2, binding: 'left', flip: 'short' };
// 基准布局（左装订 / 短边翻转），第 1 帖：
//   第 1 张：正面 [8, 1]，背面 [2, 7]；第 2 张：正面 [6, 3]，背面 [4, 5]
// 其余三种组合（第 1 张）：
//   左装订 / 长边翻转：正面 [8, 1]，背面 [7, 2]（背面内容倒置）
//   右装订 / 短边翻转：正面 [1, 8]，背面 [7, 2]
//   右装订 / 长边翻转：正面 [1, 8]，背面 [2, 7]（背面内容倒置）

function verify(observations, overrides = {}) {
  return computeImposition({ ...BASE, ...overrides, observations }).verification;
}

/** 构造一条观察的便捷函数。 */
function obs(patch) {
  return { signature: 1, sheet: 1, side: 'front', position: 'left', page: 8, orientation: 'upright', ...patch };
}

/* ------------------------------ 兼容与开关 ------------------------------ */

test('无观察时原流程兼容：verification.enabled = false，结果其余部分不变', () => {
  const plain = computeImposition(BASE);
  assert.deepEqual(plain.verification, { enabled: false });
  const emptyArr = computeImposition({ ...BASE, observations: [] });
  assert.deepEqual(emptyArr.verification, { enabled: false });
  const strip = (r) => {
    const c = JSON.parse(JSON.stringify(r));
    delete c.verification;
    delete c.meta.generatedAt;
    return c;
  };
  assert.deepEqual(strip(emptyArr), strip(plain));
});

test('核验不改变当前设置下的拼版结果', () => {
  const withObs = computeImposition({ ...BASE, observations: [obs({})] });
  const without = computeImposition(BASE);
  const strip = (r) => {
    const c = JSON.parse(JSON.stringify(r));
    delete c.verification;
    delete c.meta.generatedAt;
    return c;
  };
  assert.deepEqual(strip(withObs), strip(without));
});

/* ------------------------------ 结论判定 ------------------------------ */

test('唯一零差异组合 = 当前设置：验证通过', () => {
  const v = verify([
    obs({}),
    obs({ side: 'back', page: 2, orientation: 'upright' }),
  ]);
  assert.equal(v.enabled, true);
  assert.equal(v.observationCount, 2);
  assert.equal(v.conclusion.status, 'verified');
  assert.equal(v.conclusion.verified, true);
  assert.equal(v.conclusion.matchesCurrent, true);
  assert.deepEqual(v.conclusion.combination, { binding: 'left', flip: 'short' });
  assert.deepEqual(v.conclusion.tied, []);
  // 候选按规则排序：当前设置（零差异）排第一
  const first = v.candidates[0];
  assert.equal(first.rank, 1);
  assert.equal(first.isCurrent, true);
  assert.equal(first.zeroDiff, true);
  assert.equal(first.wrongObservations, 0);
  assert.equal(first.wrongFields, 0);
  // 其余三种组合均有差异
  v.candidates.slice(1).forEach((c) => assert.ok(c.wrongObservations > 0));
});

test('唯一零差异组合为其他设置：验证通过但标记与当前设置不一致', () => {
  // 观察对应「右装订 / 长边翻转」：正面左页位第 1 页，背面左页位第 2 页且内容倒置
  const v = verify([
    obs({ page: 1 }),
    obs({ side: 'back', page: 2, orientation: 'rotated' }),
  ]);
  assert.equal(v.conclusion.status, 'verified');
  assert.equal(v.conclusion.verified, true);
  assert.equal(v.conclusion.matchesCurrent, false);
  assert.deepEqual(v.conclusion.combination, { binding: 'right', flip: 'long' });
});

test('观察不足以区分（仅正面页位）：并列最优返回无法判定，不强行推荐', () => {
  const v = verify([obs({})]);
  assert.equal(v.conclusion.status, 'undetermined');
  assert.equal(v.conclusion.verified, false);
  assert.equal(v.conclusion.combination, null);
  // 正面左页位第 8 页：左装订的两种翻转均零差异
  assert.deepEqual(v.conclusion.tied, [
    { binding: 'left', flip: 'short' },
    { binding: 'left', flip: 'long' },
  ]);
  // 「当前设置优先」只用于排序：当前设置排第一，但结论仍为无法判定
  assert.equal(v.candidates[0].isCurrent, true);
  assert.equal(v.candidates[0].tied, true);
  assert.equal(v.candidates[1].tied, true);
  assert.match(v.conclusion.message, /无法判定/);
});

test('唯一最优但仍有差异：验证未通过并给出最接近组合', () => {
  const v = verify([
    obs({ side: 'back', position: 'left', page: 2, orientation: 'upright' }),
    obs({ side: 'back', position: 'right', page: 7, orientation: 'upright' }),
    obs({ side: 'front', position: 'left', page: 1, orientation: 'upright' }),
  ]);
  assert.equal(v.conclusion.status, 'failed');
  assert.equal(v.conclusion.verified, false);
  assert.equal(v.conclusion.combination, null);
  // 左装订 / 短边翻转仅第 3 条（正面左页位）不符，唯一最优
  assert.deepEqual(v.conclusion.best, { binding: 'left', flip: 'short', wrongObservations: 1, wrongFields: 1 });
  assert.equal(v.candidates[0].binding, 'left');
  assert.equal(v.candidates[0].flip, 'short');
});

/* ------------------------------ 排序规则 ------------------------------ */

test('排序：错误观察数最少 → 错误字段数最少 → 固定组合顺序', () => {
  // 各组合得分：左/短 (1,1)；右/短 (2,2)；右/长 (2,2)；左/长 (2,3)
  const v = verify([
    obs({ side: 'back', position: 'left', page: 2, orientation: 'upright' }),
    obs({ side: 'front', position: 'left', page: 8, orientation: 'upright' }),
    obs({ side: 'front', position: 'right', page: 8, orientation: 'upright' }),
  ]);
  assert.equal(v.conclusion.status, 'failed');
  assert.deepEqual(
    v.candidates.map((c) => `${c.binding}/${c.flip}`),
    ['left/short', 'right/short', 'right/long', 'left/long']
  );
  assert.deepEqual(
    v.candidates.map((c) => [c.wrongObservations, c.wrongFields]),
    [[1, 1], [2, 2], [2, 2], [2, 3]]
  );
  // 右/短 与 右/长 并列 (2,2)：均非当前设置，按固定组合顺序排列
  assert.equal(v.candidates[1].flip, 'short');
  assert.equal(v.candidates[2].flip, 'long');
});

test('排序：分数相同时当前设置优先（结论仍为无法判定）', () => {
  // 当前设置改为右装订 / 长边翻转；观察仅正面左页位第 1 页（右装订两种翻转均零差异）
  const v = verify([obs({ page: 1 })], { binding: 'right', flip: 'long' });
  assert.equal(v.conclusion.status, 'undetermined');
  assert.deepEqual(v.conclusion.tied, [
    { binding: 'right', flip: 'long' },
    { binding: 'right', flip: 'short' },
  ]);
  assert.equal(v.candidates[0].binding, 'right');
  assert.equal(v.candidates[0].flip, 'long');
  assert.equal(v.candidates[0].isCurrent, true);
  assert.equal(v.candidates[1].binding, 'right');
  assert.equal(v.candidates[1].flip, 'short');
});

/* ------------------------------ 字段比对细节 ------------------------------ */

test('朝向字段：长边翻转的背面期望倒置，短边翻转期望正向', () => {
  // 观察背面左页位第 2 页、倒置：唯一对应「右装订 / 长边翻转」
  const v = verify([obs({ side: 'back', page: 2, orientation: 'rotated' })]);
  assert.equal(v.conclusion.status, 'verified');
  assert.deepEqual(v.conclusion.combination, { binding: 'right', flip: 'long' });
  const longCand = v.candidates.find((c) => c.binding === 'right' && c.flip === 'long');
  assert.equal(longCand.details[0].orientationMatch, true);
  const shortCand = v.candidates.find((c) => c.binding === 'left' && c.flip === 'short');
  // 左 / 短背面左页位也是第 2 页，但朝向为正向 -> 仅朝向字段不符
  assert.equal(shortCand.details[0].pageMatch, true);
  assert.equal(shortCand.details[0].orientationMatch, false);
  assert.equal(shortCand.wrongFields, 1);
});

test('空白观察：空白页位匹配；朝向字段在涉及空白时跳过（不计入错误字段）', () => {
  // 10 页 2 张/帖 -> 第 2 帖第 2 张全部页位为空白（与装订 / 翻转无关）
  const v = computeImposition({
    totalPages: 10,
    sheetsPerSignature: 2,
    binding: 'left',
    flip: 'short',
    observations: [{ signature: 2, sheet: 2, side: 'front', position: 'left', page: null, orientation: 'rotated' }],
  }).verification;
  // 四种组合该页位均为空白 -> 全部零差异 -> 并列，无法判定
  assert.equal(v.conclusion.status, 'undetermined');
  assert.equal(v.conclusion.tied.length, 4);
  v.candidates.forEach((c) => {
    assert.equal(c.wrongObservations, 0);
    assert.equal(c.wrongFields, 0);
    assert.equal(c.details[0].pageMatch, true);
    assert.equal(c.details[0].orientationMatch, null); // 空白无朝向可比，跳过
  });
});

test('空白页位上看到页码：页码字段不符，朝向字段跳过', () => {
  const v = computeImposition({
    totalPages: 10,
    sheetsPerSignature: 2,
    binding: 'left',
    flip: 'short',
    observations: [{ signature: 2, sheet: 2, side: 'front', position: 'left', page: 5, orientation: 'upright' }],
  }).verification;
  // 所有组合该页位均为空白 -> 全部 1 条观察不符、1 个字段不符（朝向跳过）
  assert.equal(v.conclusion.status, 'undetermined');
  assert.equal(v.conclusion.tied.length, 4);
  v.candidates.forEach((c) => {
    assert.equal(c.wrongObservations, 1);
    assert.equal(c.wrongFields, 1);
    assert.equal(c.details[0].pageMatch, false);
    assert.equal(c.details[0].orientationMatch, null);
  });
});

test('空白位置随装订方向变化：左装订的空白页位在右装订下可能持有页码', () => {
  // 10 页 -> 第 2 帖第 1 张正面左页位：左装订为空白（16），右装订为第 9 页
  const v = computeImposition({
    totalPages: 10,
    sheetsPerSignature: 2,
    binding: 'left',
    flip: 'short',
    observations: [{ signature: 2, sheet: 1, side: 'front', position: 'left', page: null, orientation: 'upright' }],
  }).verification;
  // 仅左装订两种组合零差异 -> 并列 2 个
  assert.equal(v.conclusion.status, 'undetermined');
  assert.deepEqual(v.conclusion.tied, [
    { binding: 'left', flip: 'short' },
    { binding: 'left', flip: 'long' },
  ]);
  const right = v.candidates.find((c) => c.binding === 'right' && c.flip === 'short');
  assert.equal(right.details[0].pageMatch, false);
  assert.equal(right.details[0].expected.page, 9);
});

/* ------------------------------ 输入校验 ------------------------------ */

test('观察记录类型与条数校验', () => {
  assert.throws(() => computeImposition({ ...BASE, observations: 'x' }), /必须为数组/);
  assert.throws(() => computeImposition({ ...BASE, observations: {} }), /必须为数组/);
  const tooMany = Array.from({ length: 13 }, () => obs({}));
  assert.throws(() => computeImposition({ ...BASE, observations: tooMany }), /最多 12 条/);
});

test('非法索引返回明确错误', () => {
  assert.throws(() => verify([obs({ signature: 0 })]), /帖号/);
  assert.throws(() => verify([obs({ signature: 2 })]), /帖号/);
  assert.throws(() => verify([obs({ signature: 1.5 })]), /帖号/);
  assert.throws(() => verify([obs({ sheet: 0 })]), /张号/);
  assert.throws(() => verify([obs({ sheet: 3 })]), /张号/);
});

test('非法字段值返回明确错误', () => {
  assert.throws(() => verify([obs({ side: 'top' })]), /正面|背面/);
  assert.throws(() => verify([obs({ position: 'middle' })]), /页位/);
  assert.throws(() => verify([obs({ page: 9 })]), /页码/);
  assert.throws(() => verify([obs({ page: 1.5 })]), /页码/);
  assert.throws(() => verify([obs({ page: undefined })]), /page/);
  assert.throws(() => verify([obs({ orientation: 'sideways' })]), /朝向/);
  assert.throws(() => verify([null]), /必须为对象/);
});

test('重复观察返回明确错误', () => {
  assert.throws(
    () => verify([obs({}), obs({ page: 1 })]),
    /重复观察/
  );
  // 不同页位不算重复
  const v = verify([obs({}), obs({ position: 'right', page: 1 })]);
  assert.equal(v.enabled, true);
});

test('索引与页码接受纯数字字符串', () => {
  const v = verify([obs({ signature: '1', sheet: '1', page: '8' })]);
  assert.equal(v.observations[0].signature, 1);
  assert.equal(v.observations[0].sheet, 1);
  assert.equal(v.observations[0].page, 8);
});

test('均衡分帖：张号按各帖实际张数校验', () => {
  const base = { totalPages: 17, sheetsPerSignature: 2, binding: 'left', flip: 'short', balancedSplit: true };
  // 末帖仅 1 张 -> 第 2 张为非法索引
  assert.throws(
    () => computeImposition({
      ...base,
      observations: [{ signature: 3, sheet: 2, side: 'front', position: 'left', page: 17, orientation: 'upright' }],
    }),
    /张号/
  );
  const v = computeImposition({
    ...base,
    observations: [{ signature: 3, sheet: 1, side: 'front', position: 'right', page: 17, orientation: 'upright' }],
  }).verification;
  assert.equal(v.enabled, true);
  const current = v.candidates.find((c) => c.isCurrent);
  assert.equal(current.details[0].pageMatch, true);
});

/* ------------------------------ 结果结构（导出内容） ------------------------------ */

test('核验结果包含观察、候选评分与结论（用于导出 JSON）', () => {
  const v = verify([obs({})]);
  assert.equal(v.maxObservations, 12);
  assert.deepEqual(v.current, { binding: 'left', flip: 'short' });
  assert.deepEqual(v.observations, [
    { index: 1, signature: 1, sheet: 1, side: 'front', position: 'left', page: 8, blank: false, orientation: 'upright' },
  ]);
  assert.equal(v.candidates.length, 4);
  v.candidates.forEach((c, i) => {
    assert.equal(c.rank, i + 1);
    assert.equal(typeof c.wrongObservations, 'number');
    assert.equal(typeof c.wrongFields, 'number');
    assert.equal(typeof c.zeroDiff, 'boolean');
    assert.equal(c.details.length, 1);
    const d = c.details[0];
    assert.equal(d.observation, 1);
    assert.equal(d.signature, 1);
    assert.equal(d.sheet, 1);
    assert.equal(d.side, 'front');
    assert.equal(d.position, 'left');
    assert.equal(typeof d.pageMatch, 'boolean');
    assert.equal(typeof d.match, 'boolean');
  });
  assert.ok(['verified', 'undetermined', 'failed'].includes(v.conclusion.status));
  assert.equal(typeof v.conclusion.message, 'string');
});

test('12 条观察可正常核验：由基准结果生成的观察唯一对应当前设置', () => {
  const input = { totalPages: 16, sheetsPerSignature: 1, binding: 'left', flip: 'short' };
  const base = computeImposition(input);
  // 从前 3 帖（12 个页位）生成与当前设置一致的观察
  const observations = [];
  outer: for (const sig of base.signatures) {
    for (const sheet of sig.sheets) {
      for (const side of ['front', 'back']) {
        for (const position of ['left', 'right']) {
          const slot = sheet[side][position];
          observations.push({
            signature: sig.index,
            sheet: sheet.index,
            side,
            position,
            page: slot.blank ? null : slot.page,
            orientation: side === 'back' && input.flip === 'long' ? 'rotated' : 'upright',
          });
          if (observations.length === 12) break outer;
        }
      }
    }
  }
  const v = computeImposition({ ...input, observations }).verification;
  assert.equal(v.observationCount, 12);
  assert.equal(v.conclusion.status, 'verified');
  assert.equal(v.conclusion.matchesCurrent, true);
});

/* ------------------------------ 下一处观察建议 ------------------------------ */

test('建议：两组合并列时给出区分页位（背面优先），含定位与各候选预期值', () => {
  // 仅观察正面左页位第 8 页：左装订两种翻转并列；最早枚举的可区分页位为第 1 张背面左页位
  const v = verify([obs({})]);
  assert.equal(v.conclusion.status, 'undetermined');
  const s = v.conclusion.suggestion;
  assert.equal(s.available, true);
  assert.deepEqual(s.location, { signature: 1, sheet: 1, side: 'back', position: 'left' });
  assert.equal(s.outcomeGroups, 2);
  assert.equal(s.worstCaseRemaining, 1);
  assert.deepEqual(
    s.expectations.map((e) => [e.binding, e.flip, e.blank ? null : e.page, e.blank ? null : e.orientation]),
    [
      ['left', 'short', 2, 'upright'],
      ['left', 'long', 7, 'rotated'],
    ]
  );
  s.expectations.forEach((e) => assert.equal(e.tied, true));
  assert.match(s.message, /第 1 帖/);
  assert.match(s.message, /第 1 张/);
  assert.match(s.message, /背面/);
  assert.match(s.message, /左页位/);
  assert.match(s.message, /第 2 页/);
  assert.match(s.message, /第 7 页/);
});

test('建议：四组合并列时选择结果分组最多、最坏剩余最少的页位', () => {
  // 10 页 2 张/帖，观察第 2 帖第 2 张空白页位：四种组合全部零差异并列
  const v = computeImposition({
    ...BASE,
    totalPages: 10,
    observations: [{ signature: 2, sheet: 2, side: 'front', position: 'left', page: null, orientation: 'rotated' }],
  }).verification;
  assert.equal(v.conclusion.status, 'undetermined');
  assert.equal(v.conclusion.tied.length, 4);
  const s = v.conclusion.suggestion;
  assert.equal(s.available, true);
  // 第 1 帖第 1 张背面左页位四种组合给出 4 种结果：2/正、7/倒、7/正、2/倒
  assert.deepEqual(s.location, { signature: 1, sheet: 1, side: 'back', position: 'left' });
  assert.equal(s.outcomeGroups, 4);
  assert.equal(s.worstCaseRemaining, 1);
  assert.equal(s.expectations.length, 4);
  assert.deepEqual(
    s.expectations.map((e) => (e.blank ? 'blank' : `${e.page}/${e.orientation}`)),
    ['2/upright', '7/rotated', '7/upright', '2/rotated']
  );
});

test('建议：剩余未观察页位在并列组合下全部相同 → 明确返回无建议（indistinguishable）', () => {
  // 1 页 1 张：左装订两种翻转下全部页位相同（背面均空白）。观察 3 个页位、留 1 个未观察，
  // 并列仍在，但剩余页位无法区分
  const v = computeImposition({
    totalPages: 1,
    sheetsPerSignature: 1,
    binding: 'left',
    flip: 'short',
    observations: [
      { signature: 1, sheet: 1, side: 'front', position: 'left', page: null, orientation: 'upright' },
      { signature: 1, sheet: 1, side: 'front', position: 'right', page: 1, orientation: 'upright' },
      { signature: 1, sheet: 1, side: 'back', position: 'left', page: null, orientation: 'upright' },
    ],
  }).verification;
  assert.equal(v.conclusion.status, 'undetermined');
  assert.deepEqual(v.conclusion.tied, [
    { binding: 'left', flip: 'short' },
    { binding: 'left', flip: 'long' },
  ]);
  const s = v.conclusion.suggestion;
  assert.equal(s.available, false);
  assert.equal(s.reason, 'indistinguishable');
  assert.equal(s.location, undefined);
  assert.match(s.message, /无法继续区分|再观察/);
});

test('建议：全部页位均已观察仍并列 → 明确返回无建议（no-unobserved-slot）', () => {
  // 1 页 1 张共 4 个页位，全部观察：左装订两翻转仍并列（背面无内容朝向可比）
  const v = computeImposition({
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
  }).verification;
  assert.equal(v.conclusion.status, 'undetermined');
  const s = v.conclusion.suggestion;
  assert.equal(s.available, false);
  assert.equal(s.reason, 'no-unobserved-slot');
  assert.equal(s.location, undefined);
  assert.match(s.message, /已无未观察页位/);
});

test('建议：已观察页位被排除，新增观察后建议位置随之推进', () => {
  // 观察正面左页位第 8 页时建议第 1 张背面左页位；把该页位也观察掉（短边正向第 2 页）后，
  // 组合唯一对应 → verified，不再带建议
  const before = verify([obs({})]);
  assert.deepEqual(before.conclusion.suggestion.location, { signature: 1, sheet: 1, side: 'back', position: 'left' });
  const after = verify([
    obs({}),
    obs({ side: 'back', position: 'left', page: 2, orientation: 'upright' }),
  ]);
  assert.equal(after.conclusion.status, 'verified');
  assert.equal(after.conclusion.suggestion, undefined);
});

test('建议：非并列结论（verified / failed）不附 suggestion', () => {
  const verified = verify([
    obs({}),
    obs({ side: 'back', page: 2, orientation: 'upright' }),
  ]);
  assert.equal(verified.conclusion.status, 'verified');
  assert.equal(verified.conclusion.suggestion, undefined);

  const failed = verify([
    obs({ side: 'back', position: 'left', page: 2, orientation: 'upright' }),
    obs({ side: 'back', position: 'right', page: 7, orientation: 'upright' }),
    obs({ side: 'front', position: 'left', page: 1, orientation: 'upright' }),
  ]);
  assert.equal(failed.conclusion.status, 'failed');
  assert.equal(failed.conclusion.suggestion, undefined);
});

test('建议：多帖时定位取最早可区分页位（帖 / 张顺序优先）', () => {
  // 16 页、每帖 1 张共 4 帖；仅观察第 4 帖正面左页位（左装订两翻转并列），
  // 建议仍应指向第 1 帖第 1 张背面左页位
  const base = { totalPages: 16, sheetsPerSignature: 1, binding: 'left', flip: 'short' };
  const slot = computeImposition(base).signatures[3].sheets[0].front.left;
  const v = computeImposition({
    ...base,
    observations: [
      { signature: 4, sheet: 1, side: 'front', position: 'left', page: slot.page, orientation: 'upright' },
    ],
  }).verification;
  assert.equal(v.conclusion.status, 'undetermined');
  assert.deepEqual(v.conclusion.suggestion.location, { signature: 1, sheet: 1, side: 'back', position: 'left' });
});

test('建议：均衡 / 章节分帖下按各帖实际张数枚举，正常给出建议', () => {
  // 均衡分帖 17 页：各帖实际张数 [2,2,1]
  const balanced = computeImposition({
    totalPages: 17,
    sheetsPerSignature: 2,
    binding: 'left',
    flip: 'short',
    balancedSplit: true,
    observations: [{ signature: 3, sheet: 1, side: 'front', position: 'right', page: 17, orientation: 'upright' }],
  }).verification;
  assert.equal(balanced.conclusion.status, 'undetermined');
  assert.equal(balanced.conclusion.suggestion.available, true);
  assert.deepEqual(balanced.conclusion.suggestion.location, { signature: 1, sheet: 1, side: 'back', position: 'left' });

  // 章节优先分帖：3 帖
  const chapter = computeImposition({
    totalPages: 20,
    sheetsPerSignature: 2,
    binding: 'left',
    flip: 'short',
    chapterSplit: true,
    chapterStarts: [1, 9, 14, 18],
    observations: [{ signature: 1, sheet: 1, side: 'front', position: 'left', page: 8, orientation: 'upright' }],
  }).verification;
  assert.equal(chapter.conclusion.status, 'undetermined');
  assert.equal(chapter.conclusion.suggestion.available, true);
  assert.deepEqual(chapter.conclusion.suggestion.location, { signature: 1, sheet: 1, side: 'back', position: 'left' });
});

/* ---------- 纯算法单测：构造最小布局验证 minimax 与各项并列打破规则 ---------- */

/**
 * 构造单帖单张的最小拼版布局：slotSpec[side][position] 为 { page } 或 null（空白）。
 */
function fakeLayout(combo, slotSpec) {
  const mk = (spec) => (spec === null ? { page: null, blank: true } : { page: spec.page, blank: false });
  return {
    input: { binding: combo.binding, flip: combo.flip },
    signatures: [{
      sheets: [{
        front: { left: mk(slotSpec.front.left), right: mk(slotSpec.front.right) },
        back: { left: mk(slotSpec.back.left), right: mk(slotSpec.back.right) },
      }],
    }],
  };
}

/** 以 { 'binding/flip': slotSpec } 构造 layoutMap。 */
function fakeLayoutMap(tied, specsByKey) {
  const map = new Map();
  tied.forEach((combo) => map.set(`${combo.binding}/${combo.flip}`, fakeLayout(combo, specsByKey[`${combo.binding}/${combo.flip}`])));
  return map;
}

const TIED2 = [{ binding: 'left', flip: 'short' }, { binding: 'left', flip: 'long' }];
const STRUCT11 = { signatureCount: 1, sheetCounts: [1] };

test('算法：首要目标为最小化最坏剩余候选数（最坏值优先于枚举顺序）', () => {
  // 四个并列组合。先枚举到的 front/left：3 空白 + 1 页码 -> 分组 2、最坏 3；
  // back/left：2 空白 + 2 个不同页码 -> 分组 2、最坏 2。
  // 分组数相同但最坏值更小 -> 尽管正面更靠前枚举，仍选背面左页位（minimax 优先）。
  const tied = [
    { binding: 'left', flip: 'short' },
    { binding: 'left', flip: 'long' },
    { binding: 'right', flip: 'short' },
    { binding: 'right', flip: 'long' },
  ];
  const specsByKey = {
    'left/short': { front: { left: null, right: null }, back: { left: { page: 9 }, right: null } },
    'left/long': { front: { left: null, right: null }, back: { left: null, right: null } },
    'right/short': { front: { left: null, right: null }, back: { left: { page: 9 }, right: null } },
    'right/long': { front: { left: { page: 1 }, right: null }, back: { left: null, right: null } },
  };
  const s = suggestNextObservation(tied, fakeLayoutMap(tied, specsByKey), [], STRUCT11);
  assert.equal(s.available, true);
  assert.deepEqual(s.location, { signature: 1, sheet: 1, side: 'back', position: 'left' });
  assert.equal(s.outcomeGroups, 2);
  assert.equal(s.worstCaseRemaining, 2);
});

test('算法：最坏剩余与分组数相同时，非空白结果分组多者优先', () => {
  // front/left：空白 + 页码 1（1 个非空白分组）；front/right：页码 1 + 页码 2（2 个非空白分组）
  // 两者分组均为 2、最坏均为 1、同为正面 -> 选非空白分组更多的 front/right
  const specsByKey = {
    'left/short': { front: { left: null, right: { page: 1 } }, back: { left: null, right: null } },
    'left/long': { front: { left: { page: 1 }, right: { page: 2 } }, back: { left: { page: 1 }, right: null } },
  };
  const s = suggestNextObservation(TIED2, fakeLayoutMap(TIED2, specsByKey), [], STRUCT11);
  assert.equal(s.available, true);
  assert.deepEqual(s.location, { signature: 1, sheet: 1, side: 'front', position: 'right' });
  assert.equal(s.outcomeGroups, 2);
});

test('算法：前三项并列时背面优先于正面，随后按左页位优先', () => {
  // 正面左右与背面左右都给出同样的「空白 vs 页码 1」二分（最坏 1、分组 2、非空白 1），
  // 背面优先 -> 背面内左先于右
  const specsByKey = {
    'left/short': {
      front: { left: null, right: null },
      back: { left: null, right: null },
    },
    'left/long': {
      front: { left: { page: 1 }, right: { page: 1 } },
      back: { left: { page: 1 }, right: { page: 1 } },
    },
  };
  const s = suggestNextObservation(TIED2, fakeLayoutMap(TIED2, specsByKey), [], STRUCT11);
  assert.deepEqual(s.location, { signature: 1, sheet: 1, side: 'back', position: 'left' });
});

test('算法：背面两个页位完全等分时取枚举靠前者（左页位）', () => {
  // 正面在两组合下完全相同（不可区分）；背面左右均为「空白 vs 页码 3/倒置」二分，
  // 各项分数一致 -> 左页位先于右页位
  const specsByKey = {
    'left/short': {
      front: { left: { page: 1 }, right: { page: 1 } },
      back: { left: null, right: null },
    },
    'left/long': {
      front: { left: { page: 1 }, right: { page: 1 } },
      back: { left: { page: 3 }, right: { page: 3 } },
    },
  };
  const s = suggestNextObservation(TIED2, fakeLayoutMap(TIED2, specsByKey), [], STRUCT11);
  assert.deepEqual(s.location, { signature: 1, sheet: 1, side: 'back', position: 'left' });
});

test('算法：所有未观察页位签名一致 → 无建议（indistinguishable）', () => {
  const spec = { front: { left: { page: 1 }, right: null }, back: { left: null, right: null } };
  const specsByKey = { 'left/short': spec, 'left/long': spec };
  // 正面左页位已观察，其余全部相同
  const s = suggestNextObservation(
    TIED2,
    fakeLayoutMap(TIED2, specsByKey),
    [{ signature: 1, sheet: 1, side: 'front', position: 'left' }],
    STRUCT11
  );
  assert.equal(s.available, false);
  assert.equal(s.reason, 'indistinguishable');
});

test('算法：无未观察页位 → 无建议（no-unobserved-slot）', () => {
  const spec = { front: { left: { page: 1 }, right: null }, back: { left: null, right: null } };
  const specsByKey = { 'left/short': spec, 'left/long': spec };
  const observations = [];
  for (const side of ['front', 'back']) {
    for (const position of ['left', 'right']) {
      observations.push({ signature: 1, sheet: 1, side, position });
    }
  }
  const s = suggestNextObservation(TIED2, fakeLayoutMap(TIED2, specsByKey), observations, STRUCT11);
  assert.equal(s.available, false);
  assert.equal(s.reason, 'no-unobserved-slot');
});

test('算法：期望中的空白页不带朝向（orientation 为 null），非空白按翻转给朝向', () => {
  // 背面左页位：短边为空白、长边为第 2 页倒置
  const specsByKey = {
    'left/short': { front: { left: { page: 1 }, right: null }, back: { left: null, right: null } },
    'left/long': { front: { left: { page: 1 }, right: null }, back: { left: { page: 2 }, right: null } },
  };
  const s = suggestNextObservation(TIED2, fakeLayoutMap(TIED2, specsByKey), [], STRUCT11);
  assert.deepEqual(s.location, { signature: 1, sheet: 1, side: 'back', position: 'left' });
  assert.deepEqual(
    s.expectations.map((e) => ({ blank: e.blank, page: e.page, orientation: e.orientation })),
    [
      { blank: true, page: null, orientation: null },
      { blank: false, page: 2, orientation: 'rotated' },
    ]
  );
});

