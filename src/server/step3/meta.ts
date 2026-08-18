/**
 * Step3 meta 发言判定 + reuseQuote 历史回填校验（纯函数，可测试）。
 *
 * - isMetaComment：meta 发言（"我前面已经说过了啊"等）不落槽，指回历史。
 *   先宽后紧——宁判不定交 LLM，也不把抱怨当内容落槽（产品反馈④）。
 * - validateReuseQuote：LLM 声明的历史引用必须是最近 N 条学生发言（跨 body，
 *   含 displayText）中出现的子串，防止模型伪造"学生之前说过"的内容。
 */

const META_PATTERNS: RegExp[] = [
  /^我(前面|刚才|之前|上面|刚|早就|不是)?(已经)?(说|讲|答|写|提)(过|了)/,
  /^已经(说|写|确认|答)(过|了)/,
  /^这个(刚才|之前)?(说|答|写)(过|了)/,
  /^刚才(已经)?(说|答|写)(过|了)/,
  /^上面(已经)?(说|答|写)(过|了)/,
  /^(重复了|重复啊|说过啊|说过了呀)/,
  /^问过了/,
  /再说一遍/,
  // 非锚定/反问形态（"这前面不是已经解释了，…"类）——指回历史的抱怨，不落槽。
  // 误伤护栏：动词白名单只覆盖"说/讲/答/写/解释/提"，纯内容句（"压力不是已经存在的吗"）不命中。
  /不是已经(说|讲|答|写|解释|提)/,
  /前面(不是)?已经(说|讲|答|写|解释|提)/,
  /^[这那](个)?(前面|上面|之前)(不是)?(已经)?(说|讲|答|写|解释|提)/,
];

export function isMetaComment(text: string): boolean {
  const t = String(text || '').trim();
  if (!t) return false;
  return META_PATTERNS.some((re) => re.test(t));
}

/**
 * reuseQuote 校验：quote 必须是最近 maxMinutes 条学生纪要（跨 body，含 displayText）
 * 中某条的子串（仿 parseBatchBeats 的 msg.indexOf 思路）。命中返回引用文本本身
 * （落槽用），否则 null。
 */
export function validateReuseQuote(
  session: any,
  quote: string,
  maxMinutes = 30,
): string | null {
  const q = String(quote || '').trim();
  if (q.length < 4) return null;
  const subs = Array.isArray(session?.step3?.subpoints)
    ? session.step3.subpoints
    : [];
  const texts: string[] = [];
  for (const sp of subs) {
    for (const m of Array.isArray(sp?.minutes) ? sp.minutes : []) {
      if (m?.role !== 'student') continue;
      const t = String(m.text || '').trim();
      if (t) texts.push(t);
      const d = String(m.displayText || '').trim();
      if (d && d !== t) texts.push(d);
    }
  }
  for (const t of texts.slice(-maxMinutes)) {
    if (t.includes(q)) return q;
  }
  return null;
}
