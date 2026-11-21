/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app } from 'electron';
import { ChildProcess, spawn } from 'child_process';
import { createHash } from 'crypto';
import { createWriteStream } from 'fs';
import { access, mkdir, readFile, rename, rm, statfs, writeFile } from 'fs/promises';
import { createServer } from 'net';
import { cpus, totalmem } from 'os';
import type { ClientRequest, IncomingMessage } from 'http';
import { pipeline, Transform } from 'stream';
import { timeout } from '../../../base/common/async.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { join } from '../../../base/common/path.js';
import { isWindows } from '../../../base/common/platform.js';
import { toErrorMessage } from '../../../base/common/errorMessage.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { ILifecycleMainService } from '../../lifecycle/electron-main/lifecycleMainService.js';
import { ILogService } from '../../log/common/log.js';
import { ILocalAIProviderCatalog, ILocalAIProviderInfo, ILocalLLMChatRequest, ILocalLLMFimRequest, ILocalLLMModelCatalog, ILocalLLMModelDownloadEvent, ILocalLLMModelInfo, ILocalLLMServerInfo, ILocalLLMService, ILocalLLMStreamEndEvent, ILocalLLMStreamTokenEvent, LocalAIProviderId } from '../common/localLLM.js';
import { getLocalLLMContextWindowTokens } from '../common/localLLMContextProfile.js';

const readinessTimeout = 120_000;
const gracefulShutdownTimeout = 2_000;

interface IActiveRequest {
	cancelled: boolean;
	request?: ClientRequest;
	process?: ChildProcess;
}

interface IServerPaths {
	readonly binary: string;
	readonly model: string;
	readonly modelId: string;
	readonly modelName: string;
	readonly nativeContextTokens: number;
	readonly maximumContextTokens: number;
	readonly minimumMemoryBytes: number;
	readonly recommendedMemoryBytes: number;
}

interface IModelDefinition {
	readonly id: string;
	readonly name: string;
	readonly parameters: string;
	readonly fileName: string;
	readonly downloadUrl: string;
	readonly sizeBytes: number;
	readonly sha256: string;
	readonly minimumMemoryBytes: number;
	readonly recommendedMemoryBytes: number;
	readonly nativeContextTokens: number;
	readonly maximumContextTokens: number;
}

interface IModelState {
	readonly selectedModelId?: string;
	readonly setupComplete?: boolean;
	readonly selectedProviderId?: LocalAIProviderId;
}

const externalProviderDefinitions: readonly Omit<ILocalAIProviderInfo, 'installed' | 'selected'>[] = [
	{ id: 'local', name: 'Local', description: 'Private on-device Qwen model', command: '' },
	{ id: 'codex', name: 'Codex', description: 'Use your installed and signed-in Codex CLI', command: 'codex' },
	{ id: 'cursor', name: 'Cursor', description: 'Use your installed and signed-in Cursor Agent CLI', command: 'agent' },
	{ id: 'claude', name: 'Claude', description: 'Use your installed and signed-in Claude Code CLI', command: 'claude' },
];

const gibibyte = 1024 * 1024 * 1024;
const modelDefinitions: readonly IModelDefinition[] = [
	{
		id: 'qwen2.5-coder-1.5b-q4-k-m',
		name: 'Qwen2.5-Coder 1.5B',
		parameters: '1.5B',
		fileName: 'qwen2.5-coder-1.5b-instruct-q4_k_m.gguf',
		downloadUrl: 'https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf',
		sizeBytes: 1_117_320_768,
		sha256: 'cc324af070c2ecbfd324a30884d2f951a7ff756aba85cb811a6ec436933bb046',
		minimumMemoryBytes: 4 * gibibyte,
		recommendedMemoryBytes: 6 * gibibyte,
		nativeContextTokens: 32_768,
		maximumContextTokens: 32_768,
	},
	{
		id: 'qwen2.5-coder-3b-q4-k-m',
		name: 'Qwen2.5-Coder 3B',
		parameters: '3B',
		fileName: 'qwen2.5-coder-3b-instruct-q4_k_m.gguf',
		downloadUrl: 'https://huggingface.co/Qwen/Qwen2.5-Coder-3B-Instruct-GGUF/resolve/main/qwen2.5-coder-3b-instruct-q4_k_m.gguf',
		sizeBytes: 2_104_932_800,
		sha256: '724fb256bec1ff062b2f65e4569e871ad2e95ab2a3989723d1769c54294730b7',
		minimumMemoryBytes: 6 * gibibyte,
		recommendedMemoryBytes: 8 * gibibyte,
		nativeContextTokens: 32_768,
		maximumContextTokens: 32_768,
	},
	{
		id: 'qwen2.5-coder-7b-q4-k-m',
		name: 'Qwen2.5-Coder 7B',
		parameters: '7B',
		fileName: 'qwen2.5-coder-7b-instruct-q4_k_m.gguf',
		downloadUrl: 'https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/qwen2.5-coder-7b-instruct-q4_k_m.gguf',
		sizeBytes: 4_683_073_536,
		sha256: '509287f78cb4d4cf6b3843734733b914b2c158e43e22a7f4bf5e963800894d3c',
		minimumMemoryBytes: 8 * gibibyte,
		recommendedMemoryBytes: 16 * gibibyte,
		nativeContextTokens: 32_768,
		maximumContextTokens: 65_536,
	},
	{
		id: 'qwen2.5-coder-14b-q4-k-m',
		name: 'Qwen2.5-Coder 14B',
		parameters: '14B',
		fileName: 'qwen2.5-coder-14b-instruct-q4_k_m.gguf',
		downloadUrl: 'https://huggingface.co/Qwen/Qwen2.5-Coder-14B-Instruct-GGUF/resolve/main/qwen2.5-coder-14b-instruct-q4_k_m.gguf',
		sizeBytes: 8_988_110_272,
		sha256: 'c1e659736d89ac1065fb495330fb824d94001974a4bfa78e7270e43476a8d940',
		minimumMemoryBytes: 16 * gibibyte,
		recommendedMemoryBytes: 24 * gibibyte,
		nativeContextTokens: 32_768,
		maximumContextTokens: 131_072,
	},
	{
		id: 'qwen2.5-coder-32b-q4-k-m',
		name: 'Qwen2.5-Coder 32B',
		parameters: '32B',
		fileName: 'qwen2.5-coder-32b-instruct-q4_k_m.gguf',
		downloadUrl: 'https://huggingface.co/Qwen/Qwen2.5-Coder-32B-Instruct-GGUF/resolve/main/qwen2.5-coder-32b-instruct-q4_k_m.gguf',
		sizeBytes: 19_851_335_872,
		sha256: '4d64b316b5e6319d9613e0d97935d9ebd631fc7e334da400d00085eca749d085',
		minimumMemoryBytes: 32 * gibibyte,
		recommendedMemoryBytes: 48 * gibibyte,
		nativeContextTokens: 32_768,
		maximumContextTokens: 131_072,
	},
];

export class LocalLLMMainService extends Disposable implements ILocalLLMService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeState = this._register(new Emitter<ILocalLLMServerInfo>());
	readonly onDidChangeState = this._onDidChangeState.event;

	private readonly _onDidChangeModels = this._register(new Emitter<ILocalLLMModelCatalog>());
	readonly onDidChangeModels = this._onDidChangeModels.event;

	private readonly _onDidDownloadModel = this._register(new Emitter<ILocalLLMModelDownloadEvent>());
	readonly onDidDownloadModel = this._onDidDownloadModel.event;

	private readonly _onDidStreamToken = this._register(new Emitter<ILocalLLMStreamTokenEvent>());
	readonly onDidStreamToken = this._onDidStreamToken.event;

	private readonly _onDidStreamEnd = this._register(new Emitter<ILocalLLMStreamEndEvent>());
	readonly onDidStreamEnd = this._onDidStreamEnd.event;

	private _state: ILocalLLMServerInfo = { state: 'stopped' };
	private _serverProcess: ChildProcess | undefined;
	private _startPromise: Promise<ILocalLLMServerInfo> | undefined;
	private _isStopping = false;
	private readonly _activeRequests = new Map<string, IActiveRequest>();
	private readonly _modelDownloads = new Map<string, AbortController>();
	private _modelState: IModelState | undefined;
	private _selectModelPromise: Promise<ILocalLLMModelCatalog> | undefined;

	constructor(
		@IEnvironmentMainService private readonly _environmentMainService: IEnvironmentMainService,
		@ILifecycleMainService lifecycleMainService: ILifecycleMainService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		this._register(lifecycleMainService.onWillShutdown(event => {
			event.join('localLLM', this.stopServer());
		}));

		const onWillQuit = () => this._forceKill();
		app.on('will-quit', onWillQuit);
		this._register(toDisposable(() => app.removeListener('will-quit', onWillQuit)));
	}

	async getState(): Promise<ILocalLLMServerInfo> {
		return this._state;
	}

	async getProviderCatalog(): Promise<ILocalAIProviderCatalog> {
		const state = await this._readModelState();
		const selectedProviderId = state.selectedProviderId ?? 'local';
		const providers = await Promise.all(externalProviderDefinitions.map(async provider => ({
			...provider,
			installed: provider.id === 'local' || await this._commandAvailable(provider.command),
			selected: provider.id === selectedProviderId,
		})));
		return { selectedProviderId, providers };
	}

	async selectProvider(providerId: LocalAIProviderId): Promise<ILocalAIProviderCatalog> {
		const provider = externalProviderDefinitions.find(candidate => candidate.id === providerId);
		if (!provider) {
			throw new Error(`Unknown AI provider: ${providerId}.`);
		}
		if (provider.id !== 'local' && !await this._commandAvailable(provider.command)) {
			throw new Error(`${provider.name} CLI is not installed or is not available on PATH.`);
		}
		const state = await this._readModelState();
		await this._writeModelState({ ...state, selectedProviderId: providerId });
		if (providerId === 'local') {
			if (state.setupComplete) {
				await this.startServer();
			}
		} else {
			await this.stopServer();
		}
		return this.getProviderCatalog();
	}

	async getModelCatalog(): Promise<ILocalLLMModelCatalog> {
		const state = await this._readModelState();
		const modelDirectory = this._modelDirectory();
		await mkdir(modelDirectory, { recursive: true });
		const fileSystem = await statfs(modelDirectory);
		const freeDiskBytes = fileSystem.bavail * fileSystem.bsize;
		const memoryBytes = totalmem();
		const processor = cpus()[0];
		const installed = new Map<string, { path: string; bundled: boolean }>();

		for (const definition of modelDefinitions) {
			const downloadedPath = join(modelDirectory, definition.fileName);
			if (await this._pathExists(downloadedPath)) {
				installed.set(definition.id, { path: downloadedPath, bundled: false });
				continue;
			}
			if (definition.parameters === '3B') {
				const bundledPath = await this._resolveBundledModelPath();
				if (bundledPath) {
					installed.set(definition.id, { path: bundledPath, bundled: true });
				}
			}
		}

		const eligible = modelDefinitions.filter(definition => definition.minimumMemoryBytes <= memoryBytes || installed.has(definition.id));
		const visibleDefinitions = eligible.some(definition => definition.parameters !== '1.5B')
			? eligible.filter(definition => definition.parameters !== '1.5B')
			: eligible;
		const recommendedDefinition = [...visibleDefinitions]
			.reverse()
			.find(definition => definition.recommendedMemoryBytes <= memoryBytes)
			?? visibleDefinitions[0];
		const selectedModelId = state.selectedModelId && installed.has(state.selectedModelId)
			? state.selectedModelId
			: recommendedDefinition && installed.has(recommendedDefinition.id) ? recommendedDefinition.id : installed.keys().next().value;

		const models: ILocalLLMModelInfo[] = visibleDefinitions.map(definition => {
			const install = installed.get(definition.id);
			const requiredFreeDisk = Math.ceil(definition.sizeBytes * 1.1);
			let warning: string | undefined;
			if (!install && freeDiskBytes < requiredFreeDisk) {
				warning = `Not enough free disk space. ${this._formatBytes(requiredFreeDisk)} is required.`;
			} else if (definition.recommendedMemoryBytes > memoryBytes) {
				warning = 'Runs with limited memory headroom. Close memory-heavy apps for best performance.';
			}
			return {
				id: definition.id,
				name: definition.name,
				parameters: definition.parameters,
				quantization: 'Q4_K_M',
				sizeBytes: definition.sizeBytes,
				minimumMemoryBytes: definition.minimumMemoryBytes,
				recommendedMemoryBytes: definition.recommendedMemoryBytes,
				nativeContextTokens: definition.nativeContextTokens,
				maximumContextTokens: definition.maximumContextTokens,
				contextWindowTokens: getLocalLLMContextWindowTokens(definition.maximumContextTokens, memoryBytes, definition.minimumMemoryBytes, definition.recommendedMemoryBytes),
				recommendation: definition.id === recommendedDefinition?.id ? 'recommended' : 'compatible',
				installed: Boolean(install),
				bundled: install?.bundled ?? false,
				selected: definition.id === selectedModelId,
				canDownload: !install && freeDiskBytes >= requiredFreeDisk && !this._modelDownloads.has(definition.id),
				warning,
			};
		});

		return {
			hardware: {
				memoryBytes,
				cpuCount: cpus().length,
				cpuModel: processor?.model.trim() || `${process.platform} ${process.arch}`,
				gpuAcceleration: process.platform === 'darwin' && process.arch === 'arm64' ? 'Apple Metal' : 'Automatic GPU offload',
				freeDiskBytes,
			},
			models,
			selectedModelId,
			setupRequired: !state.setupComplete,
		};
	}

	async selectModel(modelId: string): Promise<ILocalLLMModelCatalog> {
		if (this._selectModelPromise) {
			return this._selectModelPromise;
		}
		this._selectModelPromise = this._doSelectModel(modelId);
		try {
			return await this._selectModelPromise;
		} finally {
			this._selectModelPromise = undefined;
		}
	}

	private async _doSelectModel(modelId: string): Promise<ILocalLLMModelCatalog> {
		const definition = this._modelDefinition(modelId);
		const modelPath = await this._resolveModelPath(definition);
		if (!modelPath) {
			throw new Error(`${definition.name} is not installed.`);
		}

		const previousState = await this._readModelState();
		this._modelState = { ...previousState, selectedModelId: modelId, setupComplete: previousState.setupComplete };
		try {
			await this.stopServer();
			await this.startServer();
			await this._writeModelState({ ...previousState, selectedModelId: modelId, setupComplete: true });
		} catch (error) {
			this._modelState = previousState;
			await this._writeModelState(previousState);
			throw error;
		}
		const catalog = await this.getModelCatalog();
		this._onDidChangeModels.fire(catalog);
		return catalog;
	}

	async downloadModel(modelId: string): Promise<void> {
		const definition = this._modelDefinition(modelId);
		if (this._modelDownloads.has(modelId)) {
			throw new Error(`${definition.name} is already downloading.`);
		}
		if (await this._resolveModelPath(definition)) {
			await this.selectModel(modelId);
			return;
		}

		const modelDirectory = this._modelDirectory();
		await mkdir(modelDirectory, { recursive: true });
		const fileSystem = await statfs(modelDirectory);
		const freeDiskBytes = fileSystem.bavail * fileSystem.bsize;
		if (freeDiskBytes < Math.ceil(definition.sizeBytes * 1.1)) {
			throw new Error(`Not enough free disk space to download ${definition.name}.`);
		}

		const controller = new AbortController();
		this._modelDownloads.set(modelId, controller);
		const destination = join(modelDirectory, definition.fileName);
		const temporary = `${destination}.part`;
		let receivedBytes = 0;
		let lastProgressAt = 0;
		try {
			await rm(temporary, { force: true });
			const response = await this._openDownload(definition.downloadUrl, controller.signal);
			const declaredLength = Number(response.headers['content-length']) || definition.sizeBytes;
			const hash = createHash('sha256');
			this._onDidDownloadModel.fire({ modelId, state: 'downloading', receivedBytes: 0, totalBytes: declaredLength });
			const progress = new Transform({
				transform: (chunk: Buffer, _encoding, callback) => {
					receivedBytes += chunk.length;
					hash.update(chunk);
					const now = Date.now();
					if (now - lastProgressAt >= 100) {
						lastProgressAt = now;
						this._onDidDownloadModel.fire({ modelId, state: 'downloading', receivedBytes, totalBytes: declaredLength });
					}
					callback(null, chunk);
				},
			});
			const output = createWriteStream(temporary, { flags: 'wx' });
			await new Promise<void>((resolve, reject) => {
				const cancel = () => {
					const error = new Error('Model download cancelled.');
					response.destroy(error);
					progress.destroy(error);
					output.destroy(error);
				};
				controller.signal.addEventListener('abort', cancel, { once: true });
				pipeline(response, progress, output, error => {
					controller.signal.removeEventListener('abort', cancel);
					error ? reject(error) : resolve();
				});
			});
			this._onDidDownloadModel.fire({ modelId, state: 'verifying', receivedBytes, totalBytes: definition.sizeBytes });
			if (receivedBytes !== definition.sizeBytes) {
				throw new Error(`Downloaded file size is ${receivedBytes} bytes; expected ${definition.sizeBytes} bytes.`);
			}
			const digest = hash.digest('hex');
			if (digest !== definition.sha256) {
				throw new Error('Downloaded model failed SHA-256 verification.');
			}
			await rename(temporary, destination);
			this._onDidDownloadModel.fire({ modelId, state: 'complete', receivedBytes, totalBytes: definition.sizeBytes });
			await this.selectModel(modelId);
		} catch (error) {
			await rm(temporary, { force: true });
			if (controller.signal.aborted) {
				this._onDidDownloadModel.fire({ modelId, state: 'cancelled', receivedBytes, totalBytes: definition.sizeBytes });
				return;
			}
			const message = toErrorMessage(error);
			this._onDidDownloadModel.fire({ modelId, state: 'error', receivedBytes, totalBytes: definition.sizeBytes, error: message });
			throw error;
		} finally {
			this._modelDownloads.delete(modelId);
			const catalog = await this.getModelCatalog();
			this._onDidChangeModels.fire(catalog);
		}
	}

	async cancelModelDownload(modelId: string): Promise<void> {
		this._modelDownloads.get(modelId)?.abort();
	}

	async startServer(): Promise<ILocalLLMServerInfo> {
		if (this._state.state === 'ready' && this._serverProcess?.exitCode === null) {
			return this._state;
		}

		if (this._startPromise) {
			return this._startPromise;
		}

		this._startPromise = this._doStartServer();
		try {
			return await this._startPromise;
		} finally {
			this._startPromise = undefined;
		}
	}

	private async _doStartServer(): Promise<ILocalLLMServerInfo> {
		this._setState({ state: 'starting' });
		this._isStopping = false;

		try {
			const paths = await this._resolveServerPaths();
			const port = await this._findFreePort();
			const contextWindowTokens = getLocalLLMContextWindowTokens(paths.maximumContextTokens, totalmem(), paths.minimumMemoryBytes, paths.recommendedMemoryBytes);
			const args = [
				'--model', paths.model,
				'--host', '127.0.0.1',
				'--port', String(port),
				'--ctx-size', String(contextWindowTokens),
				'--n-gpu-layers', '999',
				'--parallel', '1',
				'--flash-attn', 'on',
				'--cache-type-k', contextWindowTokens > paths.nativeContextTokens ? 'q4_0' : 'q8_0',
				'--cache-type-v', contextWindowTokens > paths.nativeContextTokens ? 'q4_0' : 'q8_0',
				'--jinja',
				'--no-webui',
			];
			if (contextWindowTokens > paths.nativeContextTokens) {
				args.push(
					'--rope-scaling', 'yarn',
					'--rope-scale', String(contextWindowTokens / paths.nativeContextTokens),
					'--yarn-orig-ctx', String(paths.nativeContextTokens),
				);
			}

			this._logService.info(`[localLLM] Starting llama-server on 127.0.0.1:${port}.`);
			const child = spawn(paths.binary, args, {
				cwd: this._environmentMainService.appRoot,
				windowsHide: true,
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			this._serverProcess = child;

			child.stdout.setEncoding('utf8');
			child.stderr.setEncoding('utf8');
			child.stdout.on('data', data => this._logService.trace(`[localLLM] ${String(data).trimEnd()}`));
			child.stderr.on('data', data => this._logService.debug(`[localLLM] ${String(data).trimEnd()}`));
			child.on('error', error => this._handleProcessFailure(error));
			child.on('exit', (code, signal) => {
				this._serverProcess = undefined;
				if (!this._isStopping) {
					const error = `llama-server exited unexpectedly (code: ${code ?? 'none'}, signal: ${signal ?? 'none'}).`;
					this._logService.error(`[localLLM] ${error}`);
					this._setState({ state: 'error', error });
					this._endAllRequests(error);
				}
			});

			await this._waitUntilReady(port, child);
			const info: ILocalLLMServerInfo = { state: 'ready', port, modelPath: paths.model, modelId: paths.modelId, modelName: paths.modelName, contextWindowTokens };
			this._setState(info);
			return info;
		} catch (error) {
			this._forceKill();
			const message = toErrorMessage(error);
			this._setState({ state: 'error', error: message });
			throw error;
		}
	}

	async stopServer(): Promise<void> {
		if (!this._serverProcess) {
			this._setState({ state: 'stopped' });
			return;
		}

		this._isStopping = true;
		this._setState({ state: 'stopping' });
		this._endAllRequests(undefined, true);
		const child = this._serverProcess;

		await new Promise<void>(resolve => {
			let didFinish = false;
			const finish = () => {
				if (didFinish) {
					return;
				}
				didFinish = true;
				resolve();
			};
			child.once('exit', finish);
			child.kill('SIGTERM');
			setTimeout(() => {
				if (child.exitCode === null) {
					child.kill('SIGKILL');
				}
				finish();
			}, gracefulShutdownTimeout);
		});

		this._serverProcess = undefined;
		this._isStopping = false;
		this._setState({ state: 'stopped' });
	}

	async streamChat(chatRequest: ILocalLLMChatRequest): Promise<string> {
		const provider = (await this._readModelState()).selectedProviderId ?? 'local';
		if (provider !== 'local') {
			return this._streamExternalProvider(provider, chatRequest);
		}
		await this.startServer();
		this._prepareRequest(chatRequest.requestId);

		void this._streamRequest(chatRequest.requestId, '/v1/chat/completions', {
			model: 'local-model',
			messages: chatRequest.messages,
			stream: true,
			max_tokens: chatRequest.maxTokens ?? 2048,
			temperature: chatRequest.temperature ?? 0.2,
			top_p: chatRequest.topP ?? 0.95,
			cache_prompt: true,
		}, value => {
			const response = value as { choices?: { delta?: { content?: string } }[] };
			return response.choices?.[0]?.delta?.content;
		});

		return chatRequest.requestId;
	}

	async streamFimCompletion(fimRequest: ILocalLLMFimRequest): Promise<string> {
		await this.startServer();
		this._prepareRequest(fimRequest.requestId);

		void this._streamRequest(fimRequest.requestId, '/completion', {
			prompt: fimRequest.prompt,
			stream: true,
			n_predict: fimRequest.maxTokens ?? 512,
			temperature: fimRequest.temperature ?? 0.1,
			cache_prompt: true,
			stop: fimRequest.stop ?? ['<|endoftext|>', '<|fim_pad|>'],
		}, value => {
			const response = value as { content?: string };
			return response.content;
		});

		return fimRequest.requestId;
	}

	async cancelRequest(requestId: string): Promise<void> {
		const activeRequest = this._activeRequests.get(requestId);
		if (!activeRequest) {
			return;
		}

		activeRequest.cancelled = true;
		activeRequest.request?.destroy();
		activeRequest.process?.kill('SIGTERM');
		this._activeRequests.delete(requestId);
		this._onDidStreamEnd.fire({ requestId, cancelled: true });
	}

	private _prepareRequest(requestId: string): void {
		if (!requestId) {
			throw new Error('A local LLM request ID is required.');
		}
		if (this._activeRequests.has(requestId)) {
			throw new Error(`A local LLM request with ID ${requestId} is already active.`);
		}
		this._activeRequests.set(requestId, { cancelled: false });
	}

	private async _streamExternalProvider(providerId: Exclude<LocalAIProviderId, 'local'>, chatRequest: ILocalLLMChatRequest): Promise<string> {
		this._prepareRequest(chatRequest.requestId);
		const activeRequest = this._activeRequests.get(chatRequest.requestId)!;
		const prompt = chatRequest.messages.map(message => `<${message.role}>\n${message.content}\n</${message.role}>`).join('\n\n');
		const cwd = chatRequest.cwd || process.cwd();
		const definition = externalProviderDefinitions.find(candidate => candidate.id === providerId)!;
		const args = providerId === 'codex'
			? ['exec', '--json', '--sandbox', 'read-only', '--ephemeral', '--skip-git-repo-check', '-']
			: providerId === 'cursor'
				? ['-p', '--output-format', 'stream-json', '--stream-partial-output']
				: ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
		const child = spawn(definition.command, args, {
			cwd,
			env: process.env,
			shell: isWindows,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		activeRequest.process = child;
		// Keep the prompt off the command line. Besides avoiding command-length limits, this
		// prevents shell metacharacters in code or user requests from being interpreted on
		// Windows where installed CLI shims are launched through cmd.exe.
		child.stdin?.end(prompt);
		let stdoutBuffer = '';
		let stderr = '';
		let emitted = false;
		let lastCumulativeText = '';
		let finished = false;
		const emitText = (text: string | undefined, cumulative = false) => {
			if (!text) {
				return;
			}
			const token = cumulative && text.startsWith(lastCumulativeText) ? text.slice(lastCumulativeText.length) : text;
			if (cumulative) {
				lastCumulativeText = text;
			}
			if (token) {
				emitted = true;
				this._onDidStreamToken.fire({ requestId: chatRequest.requestId, token });
			}
		};
		const consumeLine = (line: string) => {
			const trimmed = line.trim();
			if (!trimmed) {
				return;
			}
			try {
				const value = JSON.parse(trimmed) as Record<string, unknown>;
				if (providerId === 'codex') {
					const item = value.item as Record<string, unknown> | undefined;
					if (value.type === 'item.completed' && item?.type === 'agent_message') {
						emitText(typeof item.text === 'string' ? item.text : undefined);
					}
				} else if (providerId === 'cursor') {
					const message = value.message as Record<string, unknown> | undefined;
					const content = Array.isArray(message?.content) ? message.content as Record<string, unknown>[] : [];
					const text = content.filter(part => part.type === 'text').map(part => typeof part.text === 'string' ? part.text : '').join('');
					emitText(text || (!emitted && typeof value.result === 'string' ? value.result : undefined), Boolean(text));
				} else {
					const event = value.event as Record<string, unknown> | undefined;
					const delta = event?.delta as Record<string, unknown> | undefined;
					const result = typeof value.result === 'string' ? value.result : undefined;
					emitText(typeof delta?.text === 'string' ? delta.text : (!emitted ? result : undefined));
				}
			} catch {
				if (!emitted && !trimmed.startsWith('{')) {
					emitText(`${trimmed}\n`);
				}
			}
		};
		child.stdout?.setEncoding('utf8');
		child.stdout?.on('data', chunk => {
			stdoutBuffer += String(chunk);
			const lines = stdoutBuffer.split(/\r?\n/);
			stdoutBuffer = lines.pop() ?? '';
			for (const line of lines) {
				consumeLine(line);
			}
		});
		child.stderr?.setEncoding('utf8');
		child.stderr?.on('data', chunk => stderr += String(chunk));
		const finish = (error?: string) => {
			if (finished) {
				return;
			}
			finished = true;
			if (stdoutBuffer) {
				consumeLine(stdoutBuffer);
			}
			this._activeRequests.delete(chatRequest.requestId);
			if (!activeRequest.cancelled) {
				this._onDidStreamEnd.fire({ requestId: chatRequest.requestId, cancelled: false, error });
			}
		};
		child.once('error', error => finish(toErrorMessage(error)));
		child.once('close', code => finish(code === 0 ? undefined : (stderr.trim() || `${definition.name} CLI exited with code ${code}.`)));
		return chatRequest.requestId;
	}

	private _commandAvailable(command: string): Promise<boolean> {
		return new Promise(resolve => {
			const child = spawn(command, ['--version'], { shell: isWindows, stdio: 'ignore' });
			let settled = false;
			const finish = (available: boolean) => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					resolve(available);
				}
			};
			const timer = setTimeout(() => { child.kill(); finish(false); }, 3000);
			child.once('error', () => finish(false));
			child.once('close', code => finish(code === 0));
		});
	}

	private async _streamRequest(requestId: string, path: string, body: object, getToken: (value: object) => string | undefined): Promise<void> {
		const activeRequest = this._activeRequests.get(requestId);
		const port = this._state.port;
		if (!activeRequest || !port) {
			return;
		}

		try {
			const { request: httpRequest } = await import('http');
			if (activeRequest.cancelled) {
				return;
			}
			await new Promise<void>((resolve, reject) => {
				const payload = JSON.stringify(body);
				const clientRequest = httpRequest({
					host: '127.0.0.1',
					port,
					path,
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'Content-Length': Buffer.byteLength(payload),
					},
				}, response => {
					response.setEncoding('utf8');
					if ((response.statusCode ?? 500) >= 400) {
						let errorBody = '';
						response.on('data', chunk => errorBody += String(chunk));
						response.on('end', () => reject(new Error(`llama-server returned HTTP ${response.statusCode}: ${errorBody.slice(0, 1000)}`)));
						return;
					}

					let buffer = '';
					response.on('data', chunk => {
						buffer += String(chunk);
						const lines = buffer.split(/\r?\n/);
						buffer = lines.pop() ?? '';
						for (const line of lines) {
							this._consumeServerSentEventLine(requestId, line, getToken);
						}
					});
					response.on('end', () => {
						if (buffer) {
							this._consumeServerSentEventLine(requestId, buffer, getToken);
						}
						resolve();
					});
					response.on('error', reject);
				});

				activeRequest.request = clientRequest;
				clientRequest.on('error', reject);
				clientRequest.end(payload);
			});

			if (!activeRequest.cancelled) {
				this._onDidStreamEnd.fire({ requestId, cancelled: false });
			}
		} catch (error) {
			if (!activeRequest.cancelled) {
				const message = toErrorMessage(error);
				this._logService.error(`[localLLM] Request ${requestId} failed: ${message}`);
				this._onDidStreamEnd.fire({ requestId, cancelled: false, error: message });
			}
		} finally {
			this._activeRequests.delete(requestId);
		}
	}

	private _consumeServerSentEventLine(requestId: string, line: string, getToken: (value: object) => string | undefined): void {
		const trimmed = line.trim();
		if (!trimmed.startsWith('data:')) {
			return;
		}

		const data = trimmed.slice(5).trim();
		if (!data || data === '[DONE]') {
			return;
		}

		try {
			const token = getToken(JSON.parse(data) as object);
			if (token) {
				this._onDidStreamToken.fire({ requestId, token });
			}
		} catch (error) {
			this._logService.warn(`[localLLM] Ignoring malformed streaming event: ${toErrorMessage(error)}`);
		}
	}

	private async _resolveServerPaths(): Promise<IServerPaths> {
		const binary = await this._resolveBinaryPath();
		const catalog = await this.getModelCatalog();
		const selectedModelId = catalog.selectedModelId;
		if (!selectedModelId) {
			throw new Error('No local AI model is installed. Choose a model in Orbyte AI to continue.');
		}
		const definition = this._modelDefinition(selectedModelId);
		const model = await this._resolveModelPath(definition);
		if (!model) {
			throw new Error(`${definition.name} is not installed.`);
		}
		return {
			binary,
			model,
			modelId: definition.id,
			modelName: definition.name,
			nativeContextTokens: definition.nativeContextTokens,
			maximumContextTokens: definition.maximumContextTokens,
			minimumMemoryBytes: definition.minimumMemoryBytes,
			recommendedMemoryBytes: definition.recommendedMemoryBytes,
		};
	}

	private async _resolveBinaryPath(): Promise<string> {
		const platformDirectory = `${process.platform}-${process.arch}`;
		const executable = isWindows ? 'llama-server.exe' : 'llama-server';
		const packagedRoot = join(process.resourcesPath, 'local-llm');
		const developmentRoot = join(this._environmentMainService.appRoot, 'resources', 'local-llm');
		const candidates = [packagedRoot, developmentRoot];

		for (const root of candidates) {
			const binary = join(root, platformDirectory, executable);
			try {
				await access(binary);
				return binary;
			} catch {
				// Try the next supported resource layout.
			}
		}

		throw new Error(`Bundled local LLM binary was not found. Expected ${executable} under resources/local-llm/${platformDirectory}.`);
	}

	private _modelDefinition(modelId: string): IModelDefinition {
		const definition = modelDefinitions.find(candidate => candidate.id === modelId);
		if (!definition) {
			throw new Error(`Unknown local AI model: ${modelId}.`);
		}
		return definition;
	}

	private _modelDirectory(): string {
		return join(this._environmentMainService.userDataPath, 'local-llm', 'models');
	}

	private _modelStatePath(): string {
		return join(this._environmentMainService.userDataPath, 'local-llm', 'model-state.json');
	}

	private async _readModelState(): Promise<IModelState> {
		if (this._modelState) {
			return this._modelState;
		}
		try {
			const raw = await readFile(this._modelStatePath(), 'utf8');
			const parsed = JSON.parse(raw) as IModelState;
			this._modelState = {
				selectedModelId: typeof parsed.selectedModelId === 'string' ? parsed.selectedModelId : undefined,
				setupComplete: parsed.setupComplete === true,
				selectedProviderId: parsed.selectedProviderId === 'codex' || parsed.selectedProviderId === 'cursor' || parsed.selectedProviderId === 'claude' ? parsed.selectedProviderId : 'local',
			};
		} catch {
			this._modelState = {};
		}
		return this._modelState;
	}

	private async _writeModelState(state: IModelState): Promise<void> {
		const statePath = this._modelStatePath();
		await mkdir(join(this._environmentMainService.userDataPath, 'local-llm'), { recursive: true });
		const temporaryPath = `${statePath}.tmp`;
		await writeFile(temporaryPath, JSON.stringify(state, undefined, '\t'), 'utf8');
		await rename(temporaryPath, statePath);
		this._modelState = state;
	}

	private async _resolveBundledModelPath(): Promise<string | undefined> {
		const roots = [
			join(process.resourcesPath, 'local-llm', 'models'),
			join(this._environmentMainService.appRoot, 'resources', 'local-llm', 'models'),
		];
		for (const root of roots) {
			for (const fileName of ['qwen2.5-coder.gguf', 'qwen2.5-coder-3b-instruct-q4_k_m.gguf']) {
				const candidate = join(root, fileName);
				if (await this._pathExists(candidate)) {
					return candidate;
				}
			}
		}
		return undefined;
	}

	private async _resolveModelPath(definition: IModelDefinition): Promise<string | undefined> {
		const downloaded = join(this._modelDirectory(), definition.fileName);
		if (await this._pathExists(downloaded)) {
			return downloaded;
		}
		if (definition.parameters === '3B') {
			return this._resolveBundledModelPath();
		}
		return undefined;
	}

	private async _pathExists(path: string): Promise<boolean> {
		try {
			await access(path);
			return true;
		} catch {
			return false;
		}
	}

	private _formatBytes(bytes: number): string {
		return `${(bytes / gibibyte).toFixed(1)} GB`;
	}

	private async _openDownload(url: string, signal: AbortSignal, redirects = 0): Promise<IncomingMessage> {
		if (redirects > 8) {
			throw new Error('Too many redirects while downloading the model.');
		}
		const { get } = await import('https');
		return new Promise<IncomingMessage>((resolve, reject) => {
			const request = get(url, {
				signal,
				headers: { 'User-Agent': 'Orbyte-Local-AI' },
			}, response => {
				const statusCode = response.statusCode ?? 500;
				const location = response.headers.location;
				if (statusCode >= 300 && statusCode < 400 && location) {
					response.resume();
					resolve(this._openDownload(new URL(location, url).toString(), signal, redirects + 1));
					return;
				}
				if (statusCode !== 200) {
					response.resume();
					reject(new Error(`Model download returned HTTP ${statusCode}.`));
					return;
				}
				resolve(response);
			});
			request.once('error', reject);
		});
	}

	private async _findFreePort(): Promise<number> {
		return new Promise<number>((resolve, reject) => {
			const server = createServer();
			server.unref();
			server.once('error', reject);
			server.listen(0, '127.0.0.1', () => {
				const address = server.address();
				if (!address || typeof address === 'string') {
					server.close();
					reject(new Error('Unable to allocate a local port for llama-server.'));
					return;
				}
				const port = address.port;
				server.close(error => error ? reject(error) : resolve(port));
			});
		});
	}

	private async _waitUntilReady(port: number, child: ChildProcess): Promise<void> {
		const startedAt = Date.now();
		while (Date.now() - startedAt < readinessTimeout) {
			if (this._state.state === 'error') {
				throw new Error(this._state.error ?? 'llama-server failed before becoming ready.');
			}
			if (child.exitCode !== null || child.signalCode !== null) {
				throw new Error(`llama-server exited before becoming ready (code: ${child.exitCode ?? 'none'}, signal: ${child.signalCode ?? 'none'}).`);
			}
			if (await this._isHealthy(port)) {
				return;
			}
			await timeout(250);
		}
		throw new Error(`llama-server did not become ready within ${readinessTimeout / 1000} seconds.`);
	}

	private async _isHealthy(port: number): Promise<boolean> {
		const { get } = await import('http');
		return new Promise<boolean>(resolve => {
			const healthRequest = get({ host: '127.0.0.1', port, path: '/health', timeout: 1000 }, response => {
				response.resume();
				resolve(response.statusCode === 200);
			});
			healthRequest.once('timeout', () => {
				healthRequest.destroy();
				resolve(false);
			});
			healthRequest.once('error', () => resolve(false));
		});
	}

	private _handleProcessFailure(error: Error): void {
		if (this._isStopping) {
			return;
		}
		const message = toErrorMessage(error);
		this._logService.error(`[localLLM] llama-server process error: ${message}`);
		this._setState({ state: 'error', error: message });
		this._endAllRequests(message);
	}

	private _endAllRequests(error?: string, cancelled = false): void {
		for (const [requestId, activeRequest] of this._activeRequests) {
			activeRequest.cancelled = cancelled;
			activeRequest.request?.destroy();
			activeRequest.process?.kill('SIGTERM');
			this._onDidStreamEnd.fire({ requestId, cancelled, error });
		}
		this._activeRequests.clear();
	}

	private _setState(state: ILocalLLMServerInfo): void {
		this._state = state;
		this._onDidChangeState.fire(state);
	}

	private _forceKill(): void {
		this._isStopping = true;
		this._endAllRequests(undefined, true);
		if (this._serverProcess?.exitCode === null) {
			this._serverProcess.kill('SIGKILL');
		}
		this._serverProcess = undefined;
	}

	override dispose(): void {
		this._forceKill();
		super.dispose();
	}
}
