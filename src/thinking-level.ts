import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const satisfies readonly ModelThinkingLevel[];
const VALID_THINKING_LEVELS = new Set<ModelThinkingLevel>(THINKING_LEVELS);

export function isValidThinkingLevel(level: unknown): level is ModelThinkingLevel {
  return VALID_THINKING_LEVELS.has(level as ModelThinkingLevel);
}

export function getSupportedThinkingLevels(model: Model<Api>): ModelThinkingLevel[] {
  return THINKING_LEVELS.filter((level) => isThinkingLevelSupported(model, level));
}

export function clampThinkingLevel(model: Model<Api>, level: ModelThinkingLevel): ModelThinkingLevel {
  if (isThinkingLevelSupported(model, level)) return level;
  if (!model.reasoning) return "off";

  const startIndex = THINKING_LEVELS.indexOf(level);
  for (let offset = 1; offset < THINKING_LEVELS.length; offset += 1) {
    const candidate = THINKING_LEVELS[(Math.max(startIndex, 0) + offset) % THINKING_LEVELS.length];
    if (candidate && isThinkingLevelSupported(model, candidate)) return candidate;
  }
  return "off";
}

function isThinkingLevelSupported(model: Model<Api>, level: ModelThinkingLevel): boolean {
  if (level === "off") return true;
  if (!model.reasoning) return false;

  if (model.thinkingLevelMap && Object.hasOwn(model.thinkingLevelMap, level)) {
    return model.thinkingLevelMap[level] != null;
  }

  return VALID_THINKING_LEVELS.has(level);
}
