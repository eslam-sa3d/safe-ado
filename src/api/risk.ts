/**
 * Agile Hive risk assessment: probability × impact → exposure, for both the current
 * and the residual (after mitigation) assessment.
 */
export const PROBABILITIES = ["Almost Certain", "Very Likely", "Likely", "Unlikely", "Very Unlikely", "Unspecified"] as const;
export const IMPACTS = ["Catastrophic", "Major", "Moderate", "Minor", "Insignificant", "Unspecified"] as const;

export type Probability = (typeof PROBABILITIES)[number];
export type ImpactLevel = (typeof IMPACTS)[number];
export type Exposure = "EXTREME" | "HIGH" | "MEDIUM" | "LOW" | "INTERMEDIATE";

// Rows: probability (Almost Certain..Very Unlikely); columns: impact (Catastrophic..Insignificant).
const MATRIX: Exposure[][] = [
  ["EXTREME", "HIGH", "HIGH", "HIGH", "HIGH"],
  ["HIGH", "HIGH", "HIGH", "HIGH", "MEDIUM"],
  ["HIGH", "HIGH", "HIGH", "MEDIUM", "MEDIUM"],
  ["HIGH", "HIGH", "MEDIUM", "MEDIUM", "MEDIUM"],
  ["HIGH", "HIGH", "MEDIUM", "MEDIUM", "LOW"],
];

/** Exposure for a probability/impact pair; any "Unspecified" (or missing) value gives INTERMEDIATE. */
export function exposure(probability?: Probability, impact?: ImpactLevel): Exposure {
  const r = probability ? PROBABILITIES.indexOf(probability) : -1;
  const c = impact ? IMPACTS.indexOf(impact) : -1;
  if (r < 0 || c < 0 || r > 4 || c > 4) return "INTERMEDIATE";
  return MATRIX[r][c];
}

export const EXPOSURE_RANK: Record<Exposure, number> = { EXTREME: 4, HIGH: 3, INTERMEDIATE: 2, MEDIUM: 1, LOW: 0 };

export const EXPOSURE_COLOR: Record<Exposure, string> = {
  EXTREME: "#8b0000",
  HIGH: "#cd4a45",
  INTERMEDIATE: "#8a8886",
  MEDIUM: "#d67f3c",
  LOW: "#339933",
};
