const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Keep appearance; remove instructions for making a studio asset/model sheet. */
export function openingIdentity(description: string): string {
  return description.split(/[,;\n]|\.(?=\s|$)/).map(clause => clause.trim()).filter(clause => clause
    && !/^(?:full[- ]body\s+)?character\s+(?:concept(?:\s+(?:art|render|turnaround))?|turnaround|model sheet)(?:\s+framing)?$/i.test(clause)
    && !/^(?:high[- ]end\s+)?3d animated(?: character| film style| feature quality)?$/i.test(clause)
    && !/^(?:(?:Pixar|Disney|DreamWorks)(?:\s+and\s+(?:Pixar|Disney|DreamWorks))?(?:\s+(?:animation style|aesthetic|look))?|\d+k resolution|Octane render)$/i.test(clause)
    && !/\b(?:studio (?:backdrop|background|product lighting|lighting)|studio product lighting|rim lighting|character (?:asset|model sheet framing)|full[- ]body character asset)\b/i.test(clause))
    .join(". ").replace(/\bstanding (?:in a relaxed posture|upright)\b/gi, "").replace(/\s+/g, " ").trim();
}

export function openingSubjectAction(action: string, name: string, names: string[]): string {
  const identity = `(?:${names.map(escape).sort((a, b) => b.length - a.length).join("|")})`;
  // Shared lists ("Ridley, Cleo, and Barns gaze ...") describe an action each
  // subject can perform independently, without introducing their companions.
  const shared = action.replace(new RegExp(`${identity}(?:(?:\\s*,\\s*(?:and\\s+)?|\\s+and\\s+)${identity})+`, "gi"), name);
  return shared.split(new RegExp(`(?<=[.!?;])\\s+|,\\s*(?=${identity}\\b)`, "i"))
    .filter(clause => !names.some(other => other !== name && new RegExp(`\\b${escape(other)}\\b`, "i").test(clause)))
    .join(" ").trim();
}
