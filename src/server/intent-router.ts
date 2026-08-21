/**
 * V1 学生意图路由（2026-08-18，去门禁化的一部分）。
 *
 * 确定性优先的粗粒度学生回复分类器。定位：**只做路由/打标签，绝不当门禁**——
 * 任何分类错误都应能被"默认推进 + 教练回声 + 检查点回滚"自愈，而不是阻塞流程。
 *
 * 意图空间刻意保持粗（6 类），粒度只到"系统需要做出的状态决策"为止：
 *   - exhausted：放弃补充材料 / 直接推进（想不出来、没了、够了、进入下一步）
 *   - object：反对 / 修改 / 推翻（对当前提案或已确认内容）
 *   - accept：纯确认（对 / 好 / 可以 / 嗯 / 没问题 / 继续 等短句）
 *   - clarify：澄清请求
 *   - content：有实质内容（论点 / 论据 / 场景等）
 *   - unknown：无法判定
 *
 * 判定顺序（先命中的赢）：exhausted → clarify → object → accept → content → unknown。
 * 关键顺序约束：object 优先于 accept（"可以，但第二点换掉"是反对）。
 */
export type StudentIntent =
  | "exhausted"
  | "skip"
  | "object"
  | "accept"
  | "clarify"
  | "content"
  | "unknown";

/** 明确跳过当前环节：Step3 打转熔断出口、Step2 视为放弃补充。 */
const SKIP_RE =
  /^(跳过|先跳过|略过|先略过|暂时跳过|这拍先跳过|这步先跳过|先不填|暂时不填|先过|暂时过|过吧|先过这[拍步]|这[拍步]先过)[。.!！~～]?$/i;

/** 放弃补充/直接推进：整句短拒绝 + 常用短语子串（语义对齐 server.ts studentSignalsExhausted）。 */
const EXHAUSTED_FULL_RE =
  /^(没有(更多|了)?|想不到(更多|了)?|想不出(更多|了)?|说完了|先这样|就这样|够了|可以了|先走|我不补充了|进入下一步|下一步|先进入下一步)[。.!！~～]?$/i;

const EXHAUSTED_SUB_RE =
  /没有更多|想不出更多|想不到更多|说完了|先这样吧|就这些|没有别的了|没有了|想不出来了|想不到了|想不到别的|想不出别的|暂时想不到|暂时想不出|想不出什么|想不到什么|没有别的想法|没有别的角度|展开不了|展开不出来|没法展开|无法展开|不展开了|先不展开|不硬展开|暂时展开不了|展开不下去/;

const CLARIFY_RE =
  /什么意思|没听懂|没明白|没理解|再说一遍|再讲一遍|解释一下|能举个例子吗|不懂你|没太懂|听不懂|不太明白|没搞懂/;

/** 反对/修改：命中即优先于 accept（"可以，但…"也算反对）。
 *  注意子串误伤（2026-08-21 实机）：「换掉」会命中内容句里的「替换掉」，
 *  「要改」会命中「需要改进/改革」——用负向后行排除。 */
const OBJECT_RE =
  /改成|换成|(?<!替)换掉|换一下|换个|去掉|删掉|不对|不是这个|等等|等一下|重写|重新来|重新写|不要|算了|撤销|回退|别用|我想改|(?<!需)要改|别这样|换一个|重来|作废|推翻|有异议|还有一(个|点)|补充一(个|点)|换个角度|先别/;

/** 纯确认：整句为短确认词（长度受限，防把实质内容误判为 accept）。 */
const ACCEPT_RE =
  /^(对|好|可以|嗯|行|ok|好的|可以了|没问题|继续|确认|是|就这样|挺好|可以啊|行吧|对对|嗯嗯|好嘞|没问题了)[。.!！~～\s]*$/i;

function hasSubstantiveContent(t: string): boolean {
  // 至少 4 个字符且不是纯确认/纯语气词；含具体名词/动词信号优先。
  if (t.length < 4) return false;
  if (/^(嗯|啊|哦|呃|em|emm|哈)[。.!！~～\s]*$/i.test(t)) return false;
  return true;
}

/**
 * 分类学生回复。返回粗粒度意图，绝不抛出、绝不阻塞调用方。
 */
export function classifyStudentReply(message: string): StudentIntent {
  const t = String(message || "").trim();
  if (!t) return "unknown";

  // 1) skip（先于 exhausted："先过/先跳过"归 skip）
  if (SKIP_RE.test(t)) return "skip";

  // 2) exhausted（短句拒绝 / 推进信号）
  if (EXHAUSTED_FULL_RE.test(t) || EXHAUSTED_SUB_RE.test(t)) return "exhausted";

  // 3) clarify
  if (CLARIFY_RE.test(t)) return "clarify";

  // 4) object（优先于 accept）
  if (OBJECT_RE.test(t)) return "object";

  // 5) accept（整句短确认）
  if (ACCEPT_RE.test(t)) return "accept";

  // 6) content（有实质内容）
  if (hasSubstantiveContent(t)) return "content";

  return "unknown";
}

/**
 * 学生是否放弃补充 / 明确跳过当前环节（exhausted ∪ skip）。
 * 供 Step1/Step2/Step3 统一使用：Step1 视为放弃补角度、Step3 视为打转跳过出口。
 */
export function isStudentExhausted(message: string): boolean {
  const i = classifyStudentReply(message);
  return i === "exhausted" || i === "skip";
}
