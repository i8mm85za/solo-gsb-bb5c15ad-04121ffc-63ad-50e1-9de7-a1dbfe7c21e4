'use strict';

/**
 * 试印核验（trial print verification）。
 *
 * 针对当前拼版输入录入 1～12 条实物观察（帖 / 张 / 正背面 / 左右页位 /
 * 看到的页码或空白 / 内容朝向），用同一输入分别重算
 * 「左/右装订 × 长/短边翻转」四种设置，逐条比对页码、空白与朝向：
 *
 * - 页码 / 空白字段：观察为空白时期望页位必须为空白；观察为页码时必须与期望页码一致；
 * - 朝向字段：仅当观察与期望页位均非空白时比对（空白页无内容朝向可言，记为跳过）；
 *   正面恒为正向；背面长边翻转为倒置（180°）、短边翻转为正向。
 *
 * 每种设置统计错误观察数（任一字段不符即计）与错误字段总数，
 * 候选按「错误观察数最少 → 错误字段数最少 → 当前设置优先 → 固定组合顺序」排序。
 * 结论：
 * - 唯一零差异组合           → verified（验证通过，可标记该组合）；
 * - 并列最优（含多个零差异） → undetermined（无法判定，返回全部并列组合，不强行推荐）；
 * - 唯一最优但仍有差异       → failed（验证未通过，给出最接近的组合与差异数）。
 *
 * 无法判定时额外计算「下一处观察建议」（suggestNextObservation）：
 * 遍历所有尚未观察的页位，取并列组合在该页位的期望（页码 / 空白 + 内容朝向），
 * 按观察后可能形成的结果对并列组合分组，以「最坏情况下剩余并列候选数最少」
 * （最大分组大小最小）为首要目标选出最有区分度的页位；并列时依次按
 * 结果分组数更多 → 非空白结果更多 → 背面优先 → 帖 / 张 / 页位顺序（正先于背、
 * 左先于右）确定唯一建议。建议包含定位与各并列组合的预期值；
 * 所有页位都不能继续区分（或已无未观察页位）时明确返回 available:false。
 *
 * 非法索引（帖 / 张越界）、重复观察（同一帖 / 张 / 面 / 页位）与非法字段值
 * 均抛出明确错误；无观察（缺省 / null / 空数组）时返回 { enabled: false }，原流程不变。
 */

const MAX_OBSERVATIONS = 12;

/** 固定组合顺序：候选排序的最终并列打破规则。 */
const COMBO_ORDER = [
  { binding: 'left', flip: 'short' },
  { binding: 'left', flip: 'long' },
  { binding: 'right', flip: 'short' },
  { binding: 'right', flip: 'long' },
];

const SIDE_VALUES = ['front', 'back'];
const POSITION_VALUES = ['left', 'right'];
const ORIENTATION_VALUES = ['upright', 'rotated'];

const BINDING_TEXT = { left: '左装订', right: '右装订' };
const FLIP_TEXT = { long: '长边翻转', short: '短边翻转' };
const SIDE_TEXT = { front: '正面', back: '背面' };
const POSITION_TEXT = { left: '左页位', right: '右页位' };
const ORIENTATION_TEXT = { upright: '正向', rotated: '倒置' };

/** 解析帖 / 张 / 页码这类正整数索引：接受整数或纯数字字符串，其余返回 NaN。 */
function toPositiveInt(value) {
  const n = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);
  return Number.isInteger(n) ? n : NaN;
}

function comboText(combo) {
  return `${BINDING_TEXT[combo.binding]} · ${FLIP_TEXT[combo.flip]}`;
}

/** 期望内容朝向：正面恒为正向；背面长边翻转倒置（180°）、短边翻转正向。 */
function expectedOrientation(side, flip) {
  if (side === 'front') return 'upright';
  return flip === 'long' ? 'rotated' : 'upright';
}

/**
 * 校验并规范化观察列表。
 * structure = { signatureCount, sheetCounts, totalPages }（由基准拼版结果给出，
 * 四种组合的帖 / 张结构相同，故以基准结果校验即可）。
 * 返回带 1 起始序号 index 的规范观察数组；任何非法值、越界索引或重复观察都抛出明确错误。
 */
function normalizeObservations(raw, structure) {
  const { signatureCount, sheetCounts, totalPages } = structure;
  const seen = new Map();
  return raw.map((entry, i) => {
    const no = i + 1;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`第 ${no} 条观察必须为对象（含 signature / sheet / side / position / page / orientation）`);
    }
    const signature = toPositiveInt(entry.signature);
    if (!Number.isInteger(signature) || signature < 1 || signature > signatureCount) {
      throw new Error(`第 ${no} 条观察：帖号必须为 1 ~ ${signatureCount} 的整数（收到 ${JSON.stringify(entry.signature)}）`);
    }
    const sheetCount = sheetCounts[signature - 1];
    const sheet = toPositiveInt(entry.sheet);
    if (!Number.isInteger(sheet) || sheet < 1 || sheet > sheetCount) {
      throw new Error(`第 ${no} 条观察：第 ${signature} 帖共 ${sheetCount} 张，张号必须为 1 ~ ${sheetCount} 的整数（收到 ${JSON.stringify(entry.sheet)}）`);
    }
    const side = entry.side;
    if (!SIDE_VALUES.includes(side)) {
      throw new Error(`第 ${no} 条观察：面必须为 'front'（正面）或 'back'（背面）`);
    }
    const position = entry.position;
    if (!POSITION_VALUES.includes(position)) {
      throw new Error(`第 ${no} 条观察：页位必须为 'left'（左页位）或 'right'（右页位）`);
    }
    if (entry.page === undefined) {
      throw new Error(`第 ${no} 条观察：缺少 page 字段（看到的页码，或 null 表示空白页）`);
    }
    let page = null;
    if (entry.page !== null) {
      const p = toPositiveInt(entry.page);
      if (!Number.isInteger(p) || p < 1 || p > totalPages) {
        throw new Error(`第 ${no} 条观察：page 必须为 1 ~ ${totalPages} 的整数页码，或 null 表示空白页（收到 ${JSON.stringify(entry.page)}）`);
      }
      page = p;
    }
    const orientation = entry.orientation;
    if (!ORIENTATION_VALUES.includes(orientation)) {
      throw new Error(`第 ${no} 条观察：内容朝向必须为 'upright'（正向）或 'rotated'（倒置）`);
    }
    const key = `${signature}/${sheet}/${side}/${position}`;
    if (seen.has(key)) {
      throw new Error(`重复观察：第 ${no} 条与第 ${seen.get(key)} 条指向同一页位（第 ${signature} 帖 第 ${sheet} 张 ${SIDE_TEXT[side]} ${POSITION_TEXT[position]}）`);
    }
    seen.set(key, no);
    return { index: no, signature, sheet, side, position, page, blank: page === null, orientation };
  });
}

/** 单条观察与某一设置下拼版结果的逐字段比对。 */
function compareObservation(obs, layout) {
  const slot = layout.signatures[obs.signature - 1].sheets[obs.sheet - 1][obs.side][obs.position];
  const expected = {
    blank: slot.blank,
    page: slot.blank ? null : slot.page,
    orientation: expectedOrientation(obs.side, layout.input.flip),
  };
  const pageMatch = obs.blank ? slot.blank : (!slot.blank && slot.page === obs.page);
  // 任一侧为空白时没有内容朝向可比，朝向字段记为跳过（null，不计入错误字段）
  const orientationMatch = obs.blank || slot.blank ? null : obs.orientation === expected.orientation;
  const wrongFields = (pageMatch ? 0 : 1) + (orientationMatch === false ? 1 : 0);
  return {
    observation: obs.index,
    signature: obs.signature,
    sheet: obs.sheet,
    side: obs.side,
    position: obs.position,
    observed: { blank: obs.blank, page: obs.page, orientation: obs.orientation },
    expected,
    pageMatch,
    orientationMatch,
    wrongFields,
    match: wrongFields === 0,
  };
}

/** 某一设置（候选组合）的整体评分：逐条比对 + 错误观察数 / 错误字段数。 */
function scoreCandidate(combo, layout, observations) {
  const details = observations.map((obs) => compareObservation(obs, layout));
  const wrongObservations = details.filter((d) => !d.match).length;
  const wrongFields = details.reduce((sum, d) => sum + d.wrongFields, 0);
  return {
    binding: combo.binding,
    flip: combo.flip,
    isCurrent: false,
    tied: false,
    rank: 0,
    zeroDiff: wrongObservations === 0,
    wrongObservations,
    wrongFields,
    details,
  };
}

/** 排序：错误观察数最少 → 错误字段数最少 → 当前设置优先 → 固定组合顺序。 */
function rankCandidates(candidates, current) {
  const fixedOrder = new Map(COMBO_ORDER.map((c, i) => [`${c.binding}/${c.flip}`, i]));
  candidates.forEach((c) => {
    c.isCurrent = c.binding === current.binding && c.flip === current.flip;
  });
  candidates.sort((a, b) =>
    a.wrongObservations - b.wrongObservations
    || a.wrongFields - b.wrongFields
    || Number(b.isCurrent) - Number(a.isCurrent)
    || fixedOrder.get(`${a.binding}/${a.flip}`) - fixedOrder.get(`${b.binding}/${b.flip}`)
  );
  candidates.forEach((c, i) => {
    c.rank = i + 1;
  });
}

/**
 * 结论。排序只决定展示顺序；是否可判定只看评分前两项是否并列：
 * 唯一零差异 → verified；并列最优（含多个零差异）→ undetermined；唯一最优但有差异 → failed。
 */
function conclude(candidates, current, observationCount) {
  const best = candidates[0];
  const tied = candidates.filter(
    (c) => c.wrongObservations === best.wrongObservations && c.wrongFields === best.wrongFields
  );
  tied.forEach((c) => {
    c.tied = tied.length > 1;
  });
  const bestRef = {
    binding: best.binding,
    flip: best.flip,
    wrongObservations: best.wrongObservations,
    wrongFields: best.wrongFields,
  };
  if (best.zeroDiff && tied.length === 1) {
    return {
      status: 'verified',
      verified: true,
      matchesCurrent: best.isCurrent,
      combination: { binding: best.binding, flip: best.flip },
      tied: [],
      best: bestRef,
      message: best.isCurrent
        ? `验证通过：全部 ${observationCount} 条观察与当前设置（${comboText(best)}）完全一致。`
        : `验证通过：实物唯一对应「${comboText(best)}」，与当前设置（${comboText(current)}）不一致，请核对拼版设置。`,
    };
  }
  if (tied.length > 1) {
    return {
      status: 'undetermined',
      verified: false,
      matchesCurrent: null,
      combination: null,
      tied: tied.map((c) => ({ binding: c.binding, flip: c.flip })),
      best: bestRef,
      message: best.zeroDiff
        ? `无法判定：${tied.length} 种设置（${tied.map(comboText).join('；')}）与全部 ${observationCount} 条观察均一致，观察不足以区分，请补充更有区分度的观察（如背面页位）。`
        : `无法判定：${tied.length} 种设置（${tied.map(comboText).join('；')}）并列最优（各 ${best.wrongObservations} 条观察不符、共 ${best.wrongFields} 个字段不符），请补充观察后再核验。`,
    };
  }
  return {
    status: 'failed',
    verified: false,
    matchesCurrent: null,
    combination: null,
    tied: [],
    best: bestRef,
    message: `验证未通过：四种设置均存在差异；最接近的是「${comboText(best)}」（${best.wrongObservations} 条观察不符、共 ${best.wrongFields} 个字段不符），请检查观察录入或拼版设置。`,
  };
}

/**
 * 下一处观察建议（仅无法判定 / 并列最优时计算）。
 *
 * 遍历当前结果中所有「尚未观察」的页位（按 帖 → 张 → 正面 → 背面 → 左 → 右），
 * 取每个并列组合在该页位的期望值（页码或空白、内容朝向）。观察该页位后，
 * 并列组合会按观察可能得到的结果（期望签名）分组：
 *   - 首要目标：最小化最坏情况下剩余候选数 = 最大分组的大小（minimax）；
 *   - 并列时依次按：
 *       1. 可形成的结果分组数更多（distinct 签名数）；
 *       2. 非空白结果分组数更多（含真实页码的签名数）；
 *       3. 背面优先于正面（背面携带翻转 / 装订信息，通常更有区分度）；
 *       4. 帖号 → 张号 → 页位顺序（正先于背、左先于右，即枚举顺序）。
 * 任一未观察页位能把并列组合区分开（分组数 ≥ 2）时给出唯一建议，
 * 建议含定位（帖 / 张 / 面 / 页位）与各并列组合（按结论中的并列顺序）的预期值；
 * 全部页位都不能继续区分或已无未观察页位时返回
 * { available: false, reason, message }。
 *
 * @param {Array<{binding:string, flip:string}>} tiedCombos 并列组合（≥2）
 * @param {Map<string, object>} layoutMap 组合键 -> 该组合重算的拼版结果
 * @param {Array<object>} observations 已规范化的观察（仅用于排除已观察页位）
 * @param {{signatureCount:number, sheetCounts:number[]}} structure
 * @returns {object} 建议对象（available: true 时含 location / expectations 等）
 */
function suggestNextObservation(tiedCombos, layoutMap, observations, structure) {
  const { signatureCount, sheetCounts } = structure;
  const observedKeys = new Set(
    observations.map((o) => `${o.signature}/${o.sheet}/${o.side}/${o.position}`)
  );

  let considered = 0;
  let best = null;

  // 枚举顺序即最终并列打破规则：帖 → 张 → 正面 → 背面 → 左 → 右
  for (let signature = 1; signature <= signatureCount; signature += 1) {
    for (let sheet = 1; sheet <= sheetCounts[signature - 1]; sheet += 1) {
      for (const side of SIDE_VALUES) {
        for (const position of POSITION_VALUES) {
          if (observedKeys.has(`${signature}/${sheet}/${side}/${position}`)) continue;

          const expectations = tiedCombos.map((combo) => {
            const layout = layoutMap.get(`${combo.binding}/${combo.flip}`);
            const slot = layout.signatures[signature - 1].sheets[sheet - 1][side][position];
            const blank = slot.blank;
            return {
              binding: combo.binding,
              flip: combo.flip,
              tied: true,
              blank,
              page: blank ? null : slot.page,
              orientation: blank ? null : expectedOrientation(side, combo.flip),
            };
          });

          // 按观察可能得到的结果分组：空白统一为一个签名；非空白按 页码 + 朝向 分组
          const groups = new Map();
          expectations.forEach((exp) => {
            const key = exp.blank ? 'blank' : `page:${exp.page}:${exp.orientation}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(exp);
          });
          const groupCount = groups.size;
          const worstCaseRemaining = Math.max(...[...groups.values()].map((g) => g.length));
          const nonBlankGroups = [...groups.keys()].filter((k) => k !== 'blank').length;
          considered += 1;

          if (groupCount < 2) continue; // 该页位无法继续区分并列组合
          const score = { worstCaseRemaining, groupCount, nonBlankGroups, sideRank: side === 'back' ? 1 : 0 };
          if (
            !best
            || score.worstCaseRemaining < best.score.worstCaseRemaining
            || (score.worstCaseRemaining === best.score.worstCaseRemaining && score.groupCount > best.score.groupCount)
            || (score.worstCaseRemaining === best.score.worstCaseRemaining && score.groupCount === best.score.groupCount
              && score.nonBlankGroups > best.score.nonBlankGroups)
            || (score.worstCaseRemaining === best.score.worstCaseRemaining && score.groupCount === best.score.groupCount
              && score.nonBlankGroups === best.score.nonBlankGroups && score.sideRank > best.score.sideRank)
            // side 也相同：枚举顺序天然保证帖 / 张 / 页位更靠前者先胜出，不替换
          ) {
            best = { signature, sheet, side, position, expectations, score };
          }
        }
      }
    }
  }

  if (considered === 0) {
    return {
      available: false,
      reason: 'no-unobserved-slot',
      message: '已无未观察页位：全部页位均已观察，但并列组合仍无法区分，请核对观察录入是否有误。',
    };
  }
  if (!best) {
    return {
      available: false,
      reason: 'indistinguishable',
      message: '无更有区分度的观察位置：其余未观察页位在并列组合下结果均相同，再观察也无法继续区分。',
    };
  }

  const { signature, sheet, side, position, expectations } = best;
  const outcomeText = (exp) => {
    if (exp.blank) return '空白';
    return `第 ${exp.page} 页 · ${ORIENTATION_TEXT[exp.orientation]}`;
  };
  return {
    available: true,
    location: { signature, sheet, side, position },
    expectations,
    outcomeGroups: best.score.groupCount,
    worstCaseRemaining: best.score.worstCaseRemaining,
    message: `建议下一步观察：第 ${signature} 帖 · 第 ${sheet} 张 · ${SIDE_TEXT[side]} · ${POSITION_TEXT[position]}（最坏情况下也可把 ${expectations.length} 个并列组合缩减至 ${best.score.worstCaseRemaining} 个）。各组合预期：${expectations.map((e) => `${comboText(e)}→「${outcomeText(e)}」`).join('；')}。`,
  };
}

/**
 * 在拼版结果上执行试印核验。
 *
 * @param {object} result               computeImposition 的基准结果（当前设置）
 * @param {Array|undefined|null} rawObservations 原始观察记录（缺省 / null / 空数组 = 不启用）
 * @param {function} recompute          以覆盖输入重算拼版的函数（即 computeImposition）
 * @returns {object} verification 结果（未启用时为 { enabled: false }）
 */
function attachVerification(result, rawObservations, recompute) {
  if (rawObservations === undefined || rawObservations === null) {
    return { enabled: false };
  }
  if (!Array.isArray(rawObservations)) {
    throw new Error(`观察记录 observations 必须为数组（1～${MAX_OBSERVATIONS} 条）`);
  }
  if (rawObservations.length === 0) {
    return { enabled: false };
  }
  if (rawObservations.length > MAX_OBSERVATIONS) {
    throw new Error(`观察记录最多 ${MAX_OBSERVATIONS} 条（收到 ${rawObservations.length} 条）`);
  }

  const structure = {
    signatureCount: result.signatureCount,
    sheetCounts: result.signatures.map((sig) => sig.actualSheetCount),
    totalPages: result.input.totalPages,
  };
  const observations = normalizeObservations(rawObservations, structure);
  const current = { binding: result.input.binding, flip: result.input.flip };

  // 同一输入重算四种「装订 × 翻转」组合；核验只关心页码 / 空白 / 朝向，
  // 与纸张适配检查无关，重算时关闭适配输入以避免无谓的逐页位检查。
  // 布局同时按组合键缓存：无法判定时供「下一处观察建议」复用，不重复重算。
  const layoutMap = new Map();
  const candidates = COMBO_ORDER.map((combo) => {
    const layout = recompute({
      ...result.input,
      binding: combo.binding,
      flip: combo.flip,
      paperWidth: 0,
      paperHeight: 0,
      pageWidth: 0,
      pageHeight: 0,
      bleedMm: 0,
      safetyMm: 0,
    });
    layoutMap.set(`${combo.binding}/${combo.flip}`, layout);
    return scoreCandidate(combo, layout, observations);
  });
  rankCandidates(candidates, current);
  const conclusion = conclude(candidates, current, observations.length);

  // 无法判定时计算下一处观察建议；其余结论不带 suggestion。
  if (conclusion.status === 'undetermined') {
    conclusion.suggestion = suggestNextObservation(conclusion.tied, layoutMap, observations, {
      signatureCount: structure.signatureCount,
      sheetCounts: structure.sheetCounts,
    });
  }

  return {
    enabled: true,
    maxObservations: MAX_OBSERVATIONS,
    observationCount: observations.length,
    current,
    observations,
    candidates,
    conclusion,
  };
}

module.exports = { attachVerification, suggestNextObservation, MAX_OBSERVATIONS, COMBO_ORDER };
