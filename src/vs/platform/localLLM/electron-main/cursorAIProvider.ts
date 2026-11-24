/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { shell } from 'electron';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { SdkLoginResult } from '@cursor/sdk';
import { IEncryptionMainService, KnownStorageProvider } from '../../encryption/common/encryptionService.js';
import { StorageScope, StorageTarget } from '../../storage/common/storage.js';
import { IApplicationStorageMainService } from '../../storage/electron-main/storageMainService.js';

const credentialKey = 'secret.orbyte.ai.cursor';
const apiUrl = 'https://api2.cursor.sh';
const websiteUrl = 'https://cursor.com';

export class CursorAIProvider {

	private session: Pick<SdkLoginResult, 'apiKey' | 'apiKeyExpiresAtMs'> | undefined;

	constructor(private readonly encryption: IEncryptionMainService, private readonly storage: IApplicationStorageMainService) { }

	async signIn(signal: AbortSignal): Promise<void> {
		const { Cursor } = await import('@cursor/sdk');
		signal.throwIfAborted();
		if (!await this.encryption.isEncryptionAvailable() || await this.encryption.getKeyStorageProvider() === KnownStorageProvider.basicText) {
			throw new Error('Unlock your system credential store to connect Cursor.');
		}
		const loginSignal = AbortSignal.any([signal, AbortSignal.timeout(5 * 60_000)]);
		const { apiKey, apiKeyExpiresAtMs } = await Cursor.auth.login({
			backendUrl: apiUrl,
			websiteUrl,
			apiKeyName: 'Orbyte',
			signal: loginSignal,
			store: null,
			openBrowser: url => shell.openExternal(url),
		}).catch(() => {
			throw new Error('Cursor could not finish sign-in. Check your connection and account access, then try again.');
		});
		const session = { apiKey, apiKeyExpiresAtMs };
		const encrypted = await this.encryption.encrypt(JSON.stringify(session));
		signal.throwIfAborted();
		this.storage.store(credentialKey, encrypted, StorageScope.APPLICATION, StorageTarget.MACHINE);
		this.session = session;
	}

	async getApiKey(): Promise<string | undefined> {
		if (!this.session) {
			const stored = this.storage.get(credentialKey, StorageScope.APPLICATION);
			if (!stored) {
				return undefined;
			}
			const session = JSON.parse(await this.encryption.decrypt(stored)) as Partial<SdkLoginResult>;
			if (typeof session.apiKey === 'string' && typeof session.apiKeyExpiresAtMs === 'number') {
				this.session = { apiKey: session.apiKey, apiKeyExpiresAtMs: session.apiKeyExpiresAtMs };
			}
		}
		return this.session && this.session.apiKeyExpiresAtMs > Date.now() ? this.session.apiKey : undefined;
	}

	async stream(apiKey: string, prompt: string, signal: AbortSignal, onToken: (text: string) => void): Promise<string | undefined> {
		const { Agent, AuthenticationError, JsonlLocalAgentStore } = await import('@cursor/sdk');
		signal.throwIfAborted();
		// Orbyte supplies the selected context in the prompt and owns the review and apply steps.
		const directory = await mkdtemp(join(tmpdir(), 'orbyte-cursor-'));
		try {
			await using agent = await Agent.create({
				apiKey,
				model: { id: 'auto' },
				tools: [],
				local: { cwd: directory, settingSources: [], store: new JsonlLocalAgentStore(join(directory, 'session')) },
			});
			signal.throwIfAborted();
			let emitted = false;
			const run = await agent.send(prompt, { onDelta: ({ update }) => {
				if (!signal.aborted && update.type === 'text-delta' && update.text) {
					emitted = true;
					onToken(update.text);
				}
			} });
			const cancel = () => { void run.cancel().catch(() => { }); };
			signal.addEventListener('abort', cancel, { once: true });
			if (signal.aborted) {
				cancel();
			}
			try {
				const result = await run.wait();
				if (result.status !== 'finished') {
					return 'Cursor could not complete the request. Check your Cursor account access and usage.';
				}
				if (!emitted && result.result && !signal.aborted) {
					onToken(result.result);
				}
				return emitted || result.result ? undefined : 'Cursor did not return a response.';
			} finally {
				signal.removeEventListener('abort', cancel);
			}
		} catch (error) {
			if (error instanceof AuthenticationError) {
				if (this.session?.apiKey === apiKey) {
					this.session = undefined;
					this.storage.remove(credentialKey, StorageScope.APPLICATION);
				}
				return 'Cursor sign-in is required. Reconnect from AI provider settings.';
			}
			return 'Cursor could not complete the request. Check your connection and Cursor account access.';
		} finally {
			await rm(directory, { recursive: true, force: true }).catch(() => { });
		}
	}
}
