export class ResourceNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResourceNotFoundError";
  }
}

export function assertOwnedAssetSelections({
  characterIds,
  foundCharacterIds,
  settingId,
  settingFound,
  message = "One or more selected studio assets were not found",
}: {
  characterIds: string[];
  foundCharacterIds: string[];
  settingId?: string | null;
  settingFound: boolean;
  message?: string;
}): void {
  const foundCharacters = new Set(foundCharacterIds);
  if (
    foundCharacterIds.length !== characterIds.length ||
    characterIds.some((characterId) => !foundCharacters.has(characterId)) ||
    (settingId != null && !settingFound)
  ) {
    throw new ResourceNotFoundError(message);
  }
}