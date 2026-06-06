// Zero-dependency ANSI. Enabled only when attached to a TTY and NO_COLOR unset.
const enabled =
  !process.env.NO_COLOR &&
  (Boolean(process.stderr.isTTY) || Boolean(process.stdout.isTTY));

function paint(code: number): (s: string) => string {
  return (s: string) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : s);
}

export const color = {
  red: paint(31),
  green: paint(32),
  yellow: paint(33),
  blue: paint(34),
  cyan: paint(36),
  gray: paint(90),
  dim: paint(2),
  bold: paint(1),
};
