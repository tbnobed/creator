import { sql } from "drizzle-orm";
import { imageStudioAssetsTable, imageStudioJobsTable } from "@workspace/db";

// Reserved filenames emitted by the mask editor. Do not hide ordinary uploads
// merely because their names contain "mask".
export const EDITOR_MASK_NAME_PATTERN =
  "^(mask-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|outpaint-mask-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[0-9]+x[0-9]+)[.]png$";

export function isEditorMaskName(name: string): boolean {
  return new RegExp(EDITOR_MASK_NAME_PATTERN, "i").test(name);
}

export function galleryAssetCondition() {
  return sql`(
    ${imageStudioAssetsTable.storageKey} not like '%/image-studio/mask-%'
    and not (
      ${imageStudioAssetsTable.jobId} is null
      and ${imageStudioAssetsTable.name} ~* ${EDITOR_MASK_NAME_PATTERN}
    )
    and not exists (
      select 1 from ${imageStudioJobsTable}
      where ${imageStudioJobsTable.tenantId} = ${imageStudioAssetsTable.tenantId}
        and ${imageStudioJobsTable.maskAssetId} = ${imageStudioAssetsTable.id}
    )
  )`;
}
