import process from "node:process";

export const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  cyan: "\u001b[36m",
  yellow: "\u001b[33m",
  green: "\u001b[32m",
  red: "\u001b[31m",
  gray: "\u001b[90m"
};

export function supportsColor() {
  if (process.env.FORCE_COLOR != null && process.env.FORCE_COLOR !== "0") {
    return true;
  }

  if (process.env.NO_COLOR != null) {
    return false;
  }

  return Boolean(process.stdout?.isTTY);
}

export function colorize(text, color) {
  if (!supportsColor()) {
    return text;
  }

  return `${color}${text}${ANSI.reset}`;
}
