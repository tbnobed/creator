const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function openingSubjectAction(action: string, name: string, names: string[]): string {
  const identity = `(?:${names.map(escape).sort((a, b) => b.length - a.length).join("|")})`;
  // Shared lists of supplied names describe an action each
  // subject can perform independently, without introducing their companions.
  const shared = action.replace(new RegExp(`${identity}(?:(?:\\s*,\\s*(?:and\\s+)?|\\s+and\\s+)${identity})+`, "gi"), name);
  return shared.split(new RegExp(`(?<=[.!?;])\\s+|,\\s*(?=${identity}\\b)`, "i"))
    .filter(clause => !names.some(other => other !== name && new RegExp(`\\b${escape(other)}\\b`, "i").test(clause)))
    .join(" ").trim();
}
