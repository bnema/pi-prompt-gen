import { clampThinkingLevel, getSupportedThinkingLevels, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";

export interface PromptModelSelection {
  model?: Model<Api>;
  thinkingLevel?: ModelThinkingLevel;
}

export interface PromptModelSelectionControllerOptions {
  availableModels?: Model<Api>[];
  selectedModel?: Model<Api>;
  selectedThinkingLevel?: ModelThinkingLevel;
  onSelectionChange?: (selection: Required<PromptModelSelection>) => void;
}

export class PromptModelSelectionController {
  private readonly availableModels: Model<Api>[];
  private model: Model<Api> | undefined;
  private thinkingLevel: ModelThinkingLevel | undefined;
  private readonly onSelectionChange: ((selection: Required<PromptModelSelection>) => void) | undefined;

  constructor(options: PromptModelSelectionControllerOptions = {}) {
    this.availableModels = options.availableModels ?? [];
    this.model = options.selectedModel ?? this.availableModels[0];
    this.thinkingLevel = this.model
      ? normalizeThinkingLevel(this.model, options.selectedThinkingLevel)
      : options.selectedThinkingLevel;
    this.onSelectionChange = options.onSelectionChange;
  }

  cycleModel(): boolean {
    if (this.availableModels.length === 0) return false;

    const currentIndex = this.model
      ? this.availableModels.findIndex((model) => sameModel(model, this.model))
      : -1;
    const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % this.availableModels.length : 0;
    const nextModel = this.availableModels[nextIndex];
    if (!nextModel) return false;

    this.model = nextModel;
    this.thinkingLevel = normalizeThinkingLevel(nextModel, this.thinkingLevel);
    this.emitChange();
    return true;
  }

  cycleThinkingLevel(): boolean {
    if (!this.model) return false;

    const levels = getSupportedThinkingLevels(this.model);
    if (levels.length === 0) return false;

    const currentIndex = this.thinkingLevel ? levels.indexOf(this.thinkingLevel) : -1;
    const nextLevel = levels[(currentIndex + 1) % levels.length];
    if (!nextLevel) return false;

    this.thinkingLevel = nextLevel;
    this.emitChange();
    return true;
  }

  selection(): PromptModelSelection | undefined {
    if (!this.model && !this.thinkingLevel) return undefined;
    return { model: this.model, thinkingLevel: this.thinkingLevel };
  }

  label(): string {
    const modelPart = this.model ? modelLabel(this.model) : "model";
    const thinkingPart = this.thinkingLevel ?? "off";
    return `${modelPart}:${thinkingPart}`;
  }

  statusModelLabel(): string | undefined {
    return this.model ? modelLabel(this.model) : undefined;
  }

  private emitChange(): void {
    if (!this.model || !this.thinkingLevel) return;
    this.onSelectionChange?.({ model: this.model, thinkingLevel: this.thinkingLevel });
  }
}

export function normalizeThinkingLevel(model: Model<Api>, level: ModelThinkingLevel | undefined): ModelThinkingLevel {
  return clampThinkingLevel(model, level ?? "off");
}

function sameModel(a: Model<Api>, b: Model<Api> | undefined): boolean {
  if (!b) return false;
  return a.provider === b.provider && a.id === b.id;
}

function modelLabel(model: Model<Api>): string {
  return model.id || model.name;
}
