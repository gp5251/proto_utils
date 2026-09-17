/**
 * 调用序列的管道占位符解析(0.3.59,ADR-0012)。
 * 纯函数,零依赖:build.mjs 以 iife 打包为全局 Placeholder(ADR-0009,
 * 与 FormMapping/ResultTree 同一条共享源通道),webview 侧用它做编辑时标红,
 * 宿主侧序列引擎用它做发送前真解析——两端跑的是同一份源。
 *
 * 语法:{{stepN}} 取整步输出;{{stepN.path}} 取子路径。
 * path 复用 ResultTree 的取值直觉:点号取键(data.token)、方括号取索引(items[0])、
 * 引号方括号取含特殊字符的键(data["weird.key"])。
 * 步输出的根形态由序列引擎构造(一元 {data},流 {chunks:[{data}...]}),本模块只管按 path 取值。
 */

/** 一处占位符引用:raw 为原始 {{...}} 文本,step 为被引步序号,path 为其后路径(可空)。 */
export interface PlaceholderRef {
  raw: string;
  step: number;
  path: string;
}

/** 一处无法解析的占位符:reason 供编辑时标红与运行时报错复用。 */
export interface BadRef {
  raw: string;
  reason: string;
}

/** path 段:对象键 或 数组索引。 */
type PathSegment = { kind: 'key'; key: string } | { kind: 'index'; index: number };

/** 取不到值的统一错误:点名是哪个占位符、哪条路径,免静默注空难排查(ADR-0012)。 */
export class PlaceholderError extends Error {
  constructor(
    message: string,
    readonly ref: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = 'PlaceholderError';
  }
}

/** 匹配 {{...}}:内容不含花括号(path 里不会出现 }),整体独占判定另算。 */
const PLACEHOLDER_RE = /\{\{([^{}]*)\}\}/g;
/** 内容形如 step0 / step12.data / step0["k"];step 后必须紧跟数字。 */
const STEP_RE = /^step(\d+)(.*)$/;

/**
 * 把 path 切成访问段。支持:
 *   .key / [0] / ["key"] / ['key'] / 裸 key(首段无点)
 * 非法结构(未闭合括号/引号、空索引、非数字索引)抛 SyntaxError。
 */
function tokenizePath(path: string): PathSegment[] {
  const segs: PathSegment[] = [];
  let i = 0;
  while (i < path.length) {
    const c = path[i];
    if (c === '.') {
      i++;
      continue;
    }
    if (c === '[') {
      i++;
      const q = path[i];
      if (q === '"' || q === "'") {
        i++;
        let key = '';
        while (i < path.length && path[i] !== q) {
          if (path[i] === '\\' && i + 1 < path.length) {
            key += path[i + 1];
            i += 2;
          } else {
            key += path[i];
            i++;
          }
        }
        if (path[i] !== q) throw new SyntaxError('未闭合的引号');
        i++;
        if (path[i] !== ']') throw new SyntaxError('引号键后缺少 ]');
        i++;
        segs.push({ kind: 'key', key });
      } else {
        let num = '';
        while (i < path.length && path[i] !== ']') {
          num += path[i];
          i++;
        }
        if (path[i] !== ']') throw new SyntaxError('未闭合的 [');
        i++;
        if (!/^\d+$/.test(num)) throw new SyntaxError(`非法数组索引 "${num}"`);
        segs.push({ kind: 'index', index: Number.parseInt(num, 10) });
      }
      continue;
    }
    // 裸标识符:读到下一个 . 或 [ 为止
    let id = '';
    while (i < path.length && path[i] !== '.' && path[i] !== '[') {
      id += path[i];
      i++;
    }
    if (id === '') throw new SyntaxError('空路径段');
    segs.push({ kind: 'key', key: id });
  }
  return segs;
}

export type PathResult = { ok: true; value: unknown } | { ok: false };

/**
 * 按 path 从 root 取值。任一段走不下去(键不存在/索引越界/对标量取键)→ { ok:false }。
 * null 是合法值(存在即返回);仅"路径不存在"才判失败。
 */
export function getByPath(root: unknown, path: string): PathResult {
  let segs: PathSegment[];
  try {
    segs = tokenizePath(path);
  } catch {
    return { ok: false };
  }
  let cur = root;
  for (const s of segs) {
    if (s.kind === 'index') {
      if (!Array.isArray(cur) || s.index >= cur.length) return { ok: false };
      cur = cur[s.index];
    } else {
      if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return { ok: false };
      if (!Object.prototype.hasOwnProperty.call(cur, s.key)) return { ok: false };
      cur = (cur as Record<string, unknown>)[s.key];
    }
  }
  return { ok: true, value: cur };
}

/** 扫出字符串里全部占位符:合法的进 refs,不合法的进 bad。 */
function scan(text: string): { refs: PlaceholderRef[]; bad: BadRef[] } {
  const refs: PlaceholderRef[] = [];
  const bad: BadRef[] = [];
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    const raw = m[0];
    const content = m[1].trim();
    const sm = STEP_RE.exec(content);
    if (!sm) {
      bad.push({ raw, reason: '不是合法的 stepN 引用' });
      continue;
    }
    const path = sm[2];
    // path 非空时必须以 . 或 [ 开头(step0foo 视为非法)
    if (path !== '' && path[0] !== '.' && path[0] !== '[') {
      bad.push({ raw, reason: 'step 序号后需接 . 或 [' });
      continue;
    }
    try {
      tokenizePath(path);
    } catch (e) {
      bad.push({ raw, reason: e instanceof Error ? e.message : '路径非法' });
      continue;
    }
    refs.push({ raw, step: Number.parseInt(sm[1], 10), path });
  }
  return { refs, bad };
}

/**
 * 编辑时静态校验(占位符标红):返回全部问题引用。
 * 只能静态判定的两类:结构非法、前向/自引用(ref.step >= currentStep)。
 * 路径能否取到值依赖运行时响应数据,不在这里判(交给 resolve 时兜底)。
 */
export function findInvalidRefs(text: string, currentStep: number): BadRef[] {
  const { refs, bad } = scan(text);
  const out = bad.slice();
  for (const r of refs) {
    if (r.step >= currentStep) {
      out.push({ raw: r.raw, reason: r.step === currentStep ? '不能引用当前步自身' : '不能引用尚未执行的后续步' });
    }
  }
  return out;
}

/** 字符串插值时把值转文本:字符串原样,数字/布尔 String,对象/数组 JSON,null/undefined 空串。 */
function stringifyForInterp(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** 解析单个引用为值;取不到即抛 PlaceholderError(点名 raw 与原因)。 */
function resolveRef(ref: PlaceholderRef, outputs: Record<number, unknown>, currentStep: number): unknown {
  if (ref.step >= currentStep) {
    throw new PlaceholderError(`占位符 ${ref.raw} 引用了未就绪的步`, ref.raw, '前向/自引用');
  }
  if (!Object.prototype.hasOwnProperty.call(outputs, ref.step)) {
    throw new PlaceholderError(`占位符 ${ref.raw} 引用的第 ${ref.step} 步没有输出`, ref.raw, '步无输出');
  }
  const r = getByPath(outputs[ref.step], ref.path);
  if (!r.ok) {
    const where = ref.path === '' ? '整个输出' : `路径 ${ref.path}`;
    throw new PlaceholderError(`占位符 ${ref.raw} 在第 ${ref.step} 步的${where}取不到值`, ref.raw, '路径取空');
  }
  return r.value;
}

/**
 * 解析含占位符的字符串:
 * - 整串恰好是单个占位符(去空白后)→ 返回其原始值(保留 number/bool/object 类型,ADR-0012)。
 * - 否则 → 逐个替换为文本后拼接,返回字符串。
 * 无占位符的字符串原样返回。
 */
export function resolveString(text: string, outputs: Record<number, unknown>, currentStep: number): unknown {
  if (!text.includes('{{')) return text;
  const trimmed = text.trim();
  // 整值独占:全串就是一个 {{...}}
  const whole = /^\{\{[^{}]*\}\}$/.exec(trimmed);
  const { refs, bad } = scan(text);
  if (bad.length > 0) {
    throw new PlaceholderError(`占位符 ${bad[0].raw} 非法:${bad[0].reason}`, bad[0].raw, bad[0].reason);
  }
  if (whole && refs.length === 1) {
    return resolveRef(refs[0], outputs, currentStep);
  }
  // 字符串内插值:按出现顺序替换
  let out = '';
  let last = 0;
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    out += text.slice(last, m.index);
    const ref = refs.find((r) => r.raw === m[0]);
    // scan 已保证 refs 覆盖全部合法占位符且无 bad;此处必命中
    out += stringifyForInterp(resolveRef(ref!, outputs, currentStep));
    last = m.index + m[0].length;
  }
  out += text.slice(last);
  return out;
}

/**
 * 深度解析请求值树:遍历对象/数组,对含占位符的字符串叶调 resolveString。
 * 非字符串标量原样保留;不含 {{ 的字符串跳过扫描。
 */
export function resolveDeep(value: unknown, outputs: Record<number, unknown>, currentStep: number): unknown {
  if (typeof value === 'string') {
    return value.includes('{{') ? resolveString(value, outputs, currentStep) : value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolveDeep(v, outputs, currentStep));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = resolveDeep(v, outputs, currentStep);
    }
    return out;
  }
  return value;
}
