export const SAFE_REGEX_MAX_PATTERN_LENGTH = 256;
export const SAFE_REGEX_MAX_INPUT_LENGTH = 4_096;

export interface SafeRegexIssue {
  readonly code: "REGEX_INVALID" | "REGEX_UNSAFE";
  readonly message: string;
}

/** A deliberately small synchronous-safe RegExp subset for untrusted configuration. */
export function inspectSafeRegex(pattern: string): SafeRegexIssue | undefined {
  if (pattern.length > SAFE_REGEX_MAX_PATTERN_LENGTH) return {
    code: "REGEX_UNSAFE",
    message: `Regular expressions are limited to ${SAFE_REGEX_MAX_PATTERN_LENGTH} characters`,
  };
  let escaped = false;
  let inCharacterClass = false;
  let quantifiers = 0;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (escaped) {
      if ((character !== undefined && /[0-9]/.test(character))
        || (character === "k" && pattern[index + 1] === "<")) return {
        code: "REGEX_UNSAFE", message: "Regular expression backreferences are not supported",
      };
      escaped = false;
      continue;
    }
    if (character === "\\") { escaped = true; continue; }
    if (inCharacterClass) { if (character === "]") inCharacterClass = false; continue; }
    if (character === "[") { inCharacterClass = true; continue; }
    if (character === "(" || character === ")") return {
      code: "REGEX_UNSAFE", message: "Regular expression groups and lookarounds are not supported",
    };
    if (character === "*" || character === "+" || character === "?") { quantifiers += 1; continue; }
    if (character === "{") {
      const repetition = /^\{([0-9]+)(?:,([0-9]*))?\}/.exec(pattern.slice(index));
      if (!repetition) return {
        code: "REGEX_UNSAFE", message: "Unescaped braces are only supported as bounded quantifiers",
      };
      const lower = Number(repetition[1]);
      const upper = repetition[2] === undefined || repetition[2] === "" ? lower : Number(repetition[2]);
      if (lower > SAFE_REGEX_MAX_INPUT_LENGTH || upper > SAFE_REGEX_MAX_INPUT_LENGTH) return {
        code: "REGEX_UNSAFE",
        message: `Regular expression repetitions are limited to ${SAFE_REGEX_MAX_INPUT_LENGTH}`,
      };
      quantifiers += 1;
      index += repetition[0].length - 1;
      continue;
    }
    if (character === "}") return {
      code: "REGEX_UNSAFE", message: "Unescaped braces are only supported as bounded quantifiers",
    };
  }
  if (quantifiers > 1) return {
    code: "REGEX_UNSAFE", message: "Regular expressions may contain at most one quantifier",
  };
  try { new RegExp(pattern); } catch { return { code: "REGEX_INVALID", message: "Regular expression syntax is invalid" }; }
  return undefined;
}
