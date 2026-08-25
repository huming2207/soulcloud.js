import type { ActionEncodingContext, CommandArgument } from "@soulcloud/plugin-sdk";
import type { SoulInjectorRepository } from "./repository";

export interface TargetSelectionInput {
  targetConfigRevision: number;
  targetId: string;
}

export async function targetSelectionArgs(
  repository: Pick<SoulInjectorRepository, "getTargetConfig">,
  input: TargetSelectionInput,
  context: ActionEncodingContext,
): Promise<CommandArgument[]> {
  const config = await repository.getTargetConfig(context.installationId, input.targetConfigRevision);
  const target = config?.projectId === context.projectId
    ? config.config.targets.find((candidate) => candidate.id === input.targetId)
    : undefined;
  if (!target) throw new Error("target configuration revision or target id is not available");
  return [
    { targetId: target.id },
    { architecture: target.architecture },
    { chip: target.chip },
    { transport: target.transport },
    { requiredPrimitives: target.requiredPrimitives.join(",") },
  ];
}
