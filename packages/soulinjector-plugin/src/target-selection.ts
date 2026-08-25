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
  const config = await repository.getTargetConfig(context.installationId, context.projectId, input.targetConfigRevision);
  const target = config?.config.targets.find((candidate) => candidate.id === input.targetId);
  if (!target) throw new Error("target configuration revision or target id is not available");
  return [
    { targetConfigRevision: input.targetConfigRevision },
    { targetId: target.id },
    { architecture: target.architecture },
    { chip: target.chip },
    { transport: target.transport },
    { requiredPrimitives: target.requiredPrimitives.join(",") },
  ];
}
