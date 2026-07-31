import { EnumOption } from '../call/types';

const NBSP = '\u00A0';

export function enumOptionLabel(opt: EnumOption, options: EnumOption[]): string {
  // widths 以 opt 自身长度兜底,故 repeat 计数恒为非负
  const nameWidth = options.reduce((max, item) => Math.max(max, item.name.length), opt.name.length);
  const numberWidth = options.reduce(
    (max, item) => Math.max(max, String(item.number).length),
    String(opt.number).length
  );
  const number = String(opt.number);
  const paddedName = opt.name + NBSP.repeat(nameWidth - opt.name.length);
  const paddedNumber = NBSP.repeat(numberWidth - number.length) + number;
  let label = `${paddedName}${NBSP}${NBSP}${paddedNumber}`;
  if (opt.comment) {
    label += `${NBSP.repeat(4)}—${NBSP.repeat(4)}${opt.comment}`;
  }
  return label;
}
