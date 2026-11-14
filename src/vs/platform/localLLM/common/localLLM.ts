/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const localLLMChannelName = 'localLLM';

export const ILocalLLMService = createDecorator<ILocalLLMService>('localLLMService');

export type LocalLLMServerState = 'stopped' | 'starting' | 'ready' | 'stopping' | 'error';
export type LocalLLMModelRecommendation = 'recommended' | 'compatible';
export type LocalLLMModelDownloadState = 'downloading' | 'verifying' | 'complete' | 'cancelled' | 'error';

export interface ILocalLLMServerInfo {
	readonly state: LocalLLMServerState;
	readonly port?: number;
	readonly modelPath?: string;
	readonly modelId?: string;
	readonly modelName?: string;
	readonly error?: string;
}

export interface ILocalLLMHardwareProfile {
	readonly memoryBytes: number;
	readonly cpuCount: number;
	readonly cpuModel: string;
	readonly gpuAcceleration: string;
	readonly freeDiskBytes: number;
}

export interface ILocalLLMModelInfo {
	readonly id: string;
	readonly name: string;
	readonly parameters: string;
	readonly quantization: string;
	readonly sizeBytes: number;
	readonly minimumMemoryBytes: number;
	readonly recommendedMemoryBytes: number;
	readonly recommendation: LocalLLMModelRecommendation;
	readonly installed: boolean;
	readonly bundled: boolean;
	readonly selected: boolean;
	readonly canDownload: boolean;
	readonly warning?: string;
}

export interface ILocalLLMModelCatalog {
	readonly hardware: ILocalLLMHardwareProfile;
	readonly models: readonly ILocalLLMModelInfo[];
	readonly selectedModelId?: string;
	readonly setupRequired: boolean;
}

export interface ILocalLLMModelDownloadEvent {
	readonly modelId: string;
	readonly state: LocalLLMModelDownloadState;
	readonly receivedBytes: number;
	readonly totalBytes: number;
	readonly error?: string;
}

export interface ILocalLLMChatMessage {
	readonly role: 'system' | 'user' | 'assistant';
	readonly content: string;
}

export interface ILocalLLMChatRequest {
	readonly requestId: string;
	readonly messages: readonly ILocalLLMChatMessage[];
	readonly maxTokens?: number;
	readonly temperature?: number;
	readonly topP?: number;
}

export interface ILocalLLMFimRequest {
	readonly requestId: string;
	readonly prompt: string;
	readonly maxTokens?: number;
	readonly temperature?: number;
	readonly stop?: readonly string[];
}

export interface ILocalLLMStreamTokenEvent {
	readonly requestId: string;
	readonly token: string;
}

export interface ILocalLLMStreamEndEvent {
	readonly requestId: string;
	readonly cancelled: boolean;
	readonly error?: string;
}

export interface ILocalLLMService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeState: Event<ILocalLLMServerInfo>;
	readonly onDidChangeModels: Event<ILocalLLMModelCatalog>;
	readonly onDidDownloadModel: Event<ILocalLLMModelDownloadEvent>;
	readonly onDidStreamToken: Event<ILocalLLMStreamTokenEvent>;
	readonly onDidStreamEnd: Event<ILocalLLMStreamEndEvent>;

	getState(): Promise<ILocalLLMServerInfo>;
	getModelCatalog(): Promise<ILocalLLMModelCatalog>;
	selectModel(modelId: string): Promise<ILocalLLMModelCatalog>;
	downloadModel(modelId: string): Promise<void>;
	cancelModelDownload(modelId: string): Promise<void>;
	startServer(): Promise<ILocalLLMServerInfo>;
	stopServer(): Promise<void>;
	streamChat(request: ILocalLLMChatRequest): Promise<string>;
	streamFimCompletion(request: ILocalLLMFimRequest): Promise<string>;
	cancelRequest(requestId: string): Promise<void>;
}
