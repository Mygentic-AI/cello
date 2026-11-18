// The model's shape, apart from any runtime, so the deterministic screen can be copied where no model runs (the server screens listings).
export interface InjectionClassifier {
  windows(text: string): string[];
  score(window: string): Promise<number>;
  classify(text: string): Promise<{ injectionProbability: number; label?: string }>;
}
