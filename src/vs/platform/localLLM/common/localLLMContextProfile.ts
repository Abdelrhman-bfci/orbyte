/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const localLLMMinimumContextTokens = 8_192;
export const localLLMHighContextThreshold = 65_536;

/**
 * Chooses a context window that leaves useful memory headroom for the editor,
 * model weights, Metal/CUDA buffers, and generation. Q8 KV cache is used by
 * the server, so small coding models can safely use their complete 32K window.
 */
export function getLocalLLMContextWindowTokens(maximumContextTokens: number, memoryBytes: number, minimumMemoryBytes: number, recommendedMemoryBytes: number): number {
	const boundedMaximum = Math.max(localLLMMinimumContextTokens, Math.floor(maximumContextTokens));
	if (memoryBytes >= recommendedMemoryBytes) {
		return boundedMaximum;
	}

	// An installed model is allowed to run below its recommended memory, but its
	// KV cache must leave room for model weights and the editor. Scale the model's
	// own maximum instead of tying context size to a 3B/7B/14B product name. This
	// also lets future 64K and 128K models use their complete window on capable
	// hardware without another code change.
	if (memoryBytes > minimumMemoryBytes && recommendedMemoryBytes > minimumMemoryBytes) {
		const availableRatio = Math.min(1, (memoryBytes - minimumMemoryBytes) / (recommendedMemoryBytes - minimumMemoryBytes));
		const scaledContext = localLLMMinimumContextTokens + (boundedMaximum - localLLMMinimumContextTokens) * availableRatio;
		return Math.max(localLLMMinimumContextTokens, Math.floor(scaledContext / 1024) * 1024);
	}
	return Math.min(boundedMaximum, localLLMMinimumContextTokens);
}

export type LocalLLMTaskKind = 'chat' | 'planner' | 'analysis' | 'implementer';

/** Keeps generation bounded while allowing complete multi-file edit protocols. */
export function getLocalLLMGenerationTokens(contextWindowTokens: number, task: LocalLLMTaskKind): number {
	switch (task) {
		case 'planner':
			return contextWindowTokens >= 65_536 ? 2_048 : contextWindowTokens >= 16_384 ? 1_536 : 768;
		case 'analysis':
			return contextWindowTokens >= 65_536 ? 2_048 : contextWindowTokens >= 16_384 ? 1_536 : 768;
		case 'implementer':
			return contextWindowTokens >= localLLMHighContextThreshold ? 8_192 : contextWindowTokens >= 32_768 ? 6_144 : contextWindowTokens >= 16_384 ? 4_096 : 3_072;
		case 'chat':
			return contextWindowTokens >= localLLMHighContextThreshold ? 6_144 : contextWindowTokens >= 16_384 ? 4_096 : 2_048;
	}
}
