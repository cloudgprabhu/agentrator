import { readFileSync } from "node:fs";
import { parse as parseYaml, stringify as yamlStringify } from "yaml";
import { z } from "zod";

const normalizeText = (value: string): string => value.trim().replace(/\s+/g, " ");

const NonEmptyTextSchema = z.string().transform(normalizeText).pipe(z.string().min(1));

const OptionalRepoPathSchema = z.union([NonEmptyTextSchema, z.null()]);

export const TASK_PLAN_VERSION = 1 as const;

export const TaskPlanChildTaskSchema = z
  .object({
    title: NonEmptyTextSchema,
    summary: NonEmptyTextSchema,
    acceptanceCriteria: z.array(NonEmptyTextSchema).min(1),
    dependencies: z.array(NonEmptyTextSchema),
    suggestedFiles: z.array(NonEmptyTextSchema),
    labels: z.array(NonEmptyTextSchema),
  })
  .strict();

export const TaskPlanSchema = z
  .object({
    version: z.literal(TASK_PLAN_VERSION),
    parentIssue: NonEmptyTextSchema,
    specPath: OptionalRepoPathSchema,
    adrPath: OptionalRepoPathSchema,
    childTasks: z.array(TaskPlanChildTaskSchema).min(1),
  })
  .strict();

export type TaskPlanChildTask = z.infer<typeof TaskPlanChildTaskSchema>;
export type TaskPlan = z.infer<typeof TaskPlanSchema>;
export interface TaskPlanValidationOptions {
  expectedParentIssue?: string;
}

function formatIssuePath(path: (string | number)[]): string {
  if (path.length === 0) return "<root>";

  let rendered = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      rendered += `[${segment}]`;
      continue;
    }
    rendered += rendered ? `.${segment}` : segment;
  }
  return rendered;
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${formatIssuePath(issue.path)}: ${issue.message}`)
    .join("; ");
}

export function validateTaskPlan(
  input: unknown,
  source = "<task-plan>",
  options: TaskPlanValidationOptions = {},
): TaskPlan {
  try {
    const parsed = TaskPlanSchema.parse(input);
    if (
      options.expectedParentIssue &&
      parsed.parentIssue !== normalizeText(options.expectedParentIssue)
    ) {
      throw new Error(
        `Invalid task plan in ${source}: parentIssue must be ${normalizeText(options.expectedParentIssue)} but was ${parsed.parentIssue}`,
      );
    }
    return parsed;
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(`Invalid task plan in ${source}: ${formatZodError(error)}`);
    }
    throw error;
  }
}

export function parseTaskPlan(
  content: string,
  source = "<task-plan>",
  options: TaskPlanValidationOptions = {},
): TaskPlan {
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse task plan YAML in ${source}: ${message}`);
  }

  return validateTaskPlan(parsed, source, options);
}

export function readTaskPlanFile(
  filePath: string,
  options: TaskPlanValidationOptions = {},
): TaskPlan {
  return parseTaskPlan(readFileSync(filePath, "utf-8"), filePath, options);
}

export function taskPlanToYaml(plan: TaskPlan): string {
  return yamlStringify(validateTaskPlan(plan), { indent: 2 });
}
