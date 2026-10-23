declare module "ml-random-forest" {
  export class RandomForestClassifier {
    constructor(options?: { nEstimators?: number; seed?: number; replacement?: boolean; maxFeatures?: number; treeOptions?: Record<string, unknown> });
    train(features: number[][], labels: number[]): void;
    predict(features: number[][]): number[];
    toJSON(): unknown;
    static load(model: unknown): RandomForestClassifier;
  }
}
