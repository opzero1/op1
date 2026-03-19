import { z } from "zod";

export const evidenceKindSchema = z.enum([
	"file-slice",
	"symbol-slice",
	"grep-hit",
	"diagnostic",
	"diff",
	"session-note",
]);
export type EvidenceKind = z.infer<typeof evidenceKindSchema>;

export const evidenceSliceSchema = z.object({
	id: z.string(),
	kind: evidenceKindSchema,
	path: z.string().optional(),
	symbol: z.string().optional(),
	startLine: z.number().int().positive().optional(),
	endLine: z.number().int().positive().optional(),
	reason: z.string(),
	excerpt: z.string(),
	tokenCount: z.number().int().nonnegative(),
	provenance: z.string(),
	redacted: z.boolean().default(false),
});
export type EvidenceSlice = z.infer<typeof evidenceSliceSchema>;

export const groundingBundleSchema = z.object({
	bundleId: z.string(),
	createdAt: z.string(),
	taskSummary: z.string(),
	failureSummary: z.string(),
	evidenceSlices: z.array(evidenceSliceSchema),
	tokenBudget: z.number().int().positive(),
	includedTokens: z.number().int().nonnegative(),
	omittedReasons: z.array(z.string()),
	provenance: z.array(z.string()).default([]),
});
export type GroundingBundle = z.infer<typeof groundingBundleSchema>;

export const patchOperationSchema = z.enum([
	"create",
	"update",
	"rename",
	"delete",
]);
export type PatchOperation = z.infer<typeof patchOperationSchema>;

export const patchAnchorSchema = z
	.object({
		exactText: z.string().optional(),
		startLine: z.number().int().positive().optional(),
		endLine: z.number().int().positive().optional(),
		hash: z.string().optional(),
	})
	.refine(
		(value) =>
			value.exactText !== undefined ||
			value.startLine !== undefined ||
			value.hash !== undefined,
		{
			message: "Patch anchors require exactText, line bounds, or hash evidence",
		},
	);

export const patchCandidateSchema = z.object({
	path: z.string(),
	operation: patchOperationSchema,
	previousPath: z.string().optional(),
	anchors: z.array(patchAnchorSchema).default([]),
	replacement: z.string().optional(),
	content: z.string().optional(),
});
export type PatchCandidate = z.infer<typeof patchCandidateSchema>;

export const patchValidationFailureCodeSchema = z.enum([
	"out-of-root",
	"ambiguous-anchor",
	"generated-target",
	"binary-target",
	"missing-read",
	"create-update-mismatch",
	"rename-target-conflict",
	"structural-boundary",
]);
export type PatchValidationFailureCode = z.infer<
	typeof patchValidationFailureCodeSchema
>;

const patchValidationOkSchema = z.object({
	ok: z.literal(true),
	strategy: z.enum(["apply_patch", "hash-anchor", "manual"]),
	score: z.number().min(0).max(1),
	warnings: z.array(z.string()).default([]),
});

const patchValidationErrorSchema = z.object({
	ok: z.literal(false),
	reason: patchValidationFailureCodeSchema,
	message: z.string(),
	path: z.string().optional(),
	details: z.record(z.string(), z.string()).default({}),
});

export const patchValidationResultSchema = z.discriminatedUnion("ok", [
	patchValidationOkSchema,
	patchValidationErrorSchema,
]);
export type PatchValidationResult = z.infer<typeof patchValidationResultSchema>;

export const retryTriggerSourceSchema = z.enum([
	"hook",
	"tool",
	"operator",
	"verification",
]);
export type RetryTriggerSource = z.infer<typeof retryTriggerSourceSchema>;

export const retryFailureClassSchema = z.enum([
	"grounding",
	"selection",
	"serialization",
	"patch-recovery",
	"patch-safety",
	"runtime",
]);
export type RetryFailureClass = z.infer<typeof retryFailureClassSchema>;

export const retryTriggerSchema = z.object({
	source: retryTriggerSourceSchema,
	type: z.string(),
	failureClass: retryFailureClassSchema,
	failureMessage: z.string(),
	attempt: z.number().int().nonnegative(),
	maxAttempts: z.number().int().positive(),
	dedupeKey: z.string(),
	path: z.string().optional(),
	symbol: z.string().optional(),
});
export type RetryTrigger = z.infer<typeof retryTriggerSchema>;

export const repromptActionSchema = z.enum([
	"retry-helper",
	"retry-helper-with-oracle",
	"suppress",
	"fail-closed",
]);
export type RepromptAction = z.infer<typeof repromptActionSchema>;

export const repromptTaskClassSchema = z.enum([
	"implementation",
	"debug",
	"test",
	"review",
	"question",
	"plan",
	"research",
]);
export type RepromptTaskClass = z.infer<typeof repromptTaskClassSchema>;

export const repromptDecisionSchema = z.object({
	action: repromptActionSchema,
	reason: z.string(),
	suppressionReason: z.string().optional(),
	trigger: retryTriggerSchema,
	bundle: groundingBundleSchema.optional(),
	oracleRequired: z.boolean().default(false),
	taskClass: repromptTaskClassSchema.optional(),
});
export type RepromptDecision = z.infer<typeof repromptDecisionSchema>;
