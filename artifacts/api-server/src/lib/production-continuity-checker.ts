import type { ProductionState } from "./production-types";

export type ContinuityCheckInput = {
  production: ProductionState;
  shots: { id: string; sceneNumber: number; mediaUrl: string; previousShotUrl?: string }[];
};
export interface ContinuityChecker {
  check(input: ContinuityCheckInput): Promise<{
    status: "NOT_IMPLEMENTED" | "CHECKED";
    issues: ProductionState["review"]["issues"];
  }>;
}
// An empty result from this adapter never asserts visual consistency.
export const continuityChecker: ContinuityChecker = {
  async check() { return { status: "NOT_IMPLEMENTED", issues: [] }; },
};
