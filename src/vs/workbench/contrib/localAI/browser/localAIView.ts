/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { IAction } from '../../../../base/common/actions.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter } from '../../../../base/common/event.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { DisposableStore, IReference } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { basename, dirname, extUri, isEqual, joinPath, relativePath } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { getCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { linesDiffComputers } from '../../../../editor/common/diff/linesDiffComputers.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IResolvedTextEditorModel, ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ILocalLLMChatMessage, ILocalLLMModelCatalog, ILocalLLMModelDownloadEvent, ILocalLLMModelInfo, ILocalLLMService, LocalLLMServerState } from '../../../../platform/localLLM/common/localLLM.js';
import { IMarkdownRendererService } from '../../../../platform/markdown/browser/markdownRenderer.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { getLocalLLMGenerationTokens, localLLMMinimumContextTokens } from '../../../../platform/localLLM/common/localLLMContextProfile.js';
import { ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewletViewOptions } from '../../../browser/parts/views/viewsViewlet.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ISearchService, QueryType } from '../../../services/search/common/search.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { parseLocalAIAgentResponse, validateLocalAIAgentProposal } from './context/agentEditProtocol.js';
import { getLocalAIAgentStreamProgress } from './context/agentStreamProgress.js';
import { ILocalAIContext, ILocalAIContextService } from './context/localAIContext.js';
import { formatAgentFeatureImplementerMessages, formatAgentFeatureReviewerMessages, formatAgentRepairMessages, formatAgentTaskPlannerMessages, formatAgentTesterMessages, formatChatMessages, ILocalAIAgentFeatureTask, ILocalAIAttachment, ILocalAIWorkspaceRootContext, LocalAIChatMode } from './context/promptFormatter.js';
import { localAIContextTokens, scoreLocalAIWorkspacePath } from './context/smartWorkspaceContext.js';
import { InlineEditController } from './inlineEditController.js';

export interface ILocalAIViewPaneOptions extends IViewletViewOptions {
	readonly localAIChatSessionId?: string;
	readonly onDidRequestNewChat?: () => void;
}

export interface ILocalAIChatActivity {
	readonly title: string;
	readonly running: boolean;
	readonly progress: number | undefined;
	readonly pendingChanges: number;
}

interface IChatMessage {
	readonly role: 'user' | 'assistant';
	content: string;
	readonly mode?: LocalAIChatMode;
	readonly attachmentNames?: readonly string[];
	agentChanges?: IChatAgentChangeSummary[];
	agentSteps?: IChatAgentStep[];
}

type AgentSubagentStatus = 'queued' | 'running' | 'completed' | 'handedOff' | 'skipped' | 'failed';

interface IChatAgentStep {
	readonly id: string;
	readonly stage: AgentSubagentStage;
	readonly name: string;
	status: AgentSubagentStatus;
	detail: string;
	files?: readonly string[];
	/** Ephemeral size of the active model stream; never used as an edit proposal. */
	streamedCharacters?: number;
}

interface IChatAgentChangeSummary {
	readonly resource: string;
	readonly displayPath: string;
	readonly addedLines: number;
	readonly removedLines: number;
	readonly state: 'accepted' | 'rejected';
}

interface ILocalAIResourcePick extends IQuickPickItem {
	readonly resource: URI;
	readonly resourceKind: 'file' | 'folder';
	readonly mentionPath: string;
}

interface IAgentTarget {
	readonly resource: URI;
	readonly displayPath: string;
	readonly originalText: string;
}

type AgentSubagentStage = 'planner' | 'implementer' | 'reviewer' | 'tester' | 'integrationTester';

interface IAgentFeatureTask {
	readonly id: string;
	readonly title: string;
	readonly instruction: string;
	readonly paths: readonly string[];
	readonly dependsOn?: readonly string[];
	readonly needsTests: boolean;
	targets: readonly IAgentTarget[];
	references: readonly IAgentTarget[];
	implementerResponse?: string;
	candidateResponse?: string;
	reviewerResponses: string[];
	testerResponse?: string;
	satisfiedWithoutChanges?: boolean;
}

interface IAgentWorkflow {
	readonly tasks: IAgentFeatureTask[];
	currentTask: number;
	reviewerIndex: number;
}

interface IPendingAgentRequest {
	readonly requestId: string;
	readonly stage: AgentSubagentStage;
	readonly stepId?: string;
	readonly targets: readonly IAgentTarget[];
	readonly instruction: string;
	readonly context: ILocalAIContext | undefined;
	readonly history: readonly ILocalLLMChatMessage[];
	readonly attachments: readonly ILocalAIAttachment[];
	readonly workspaceRoots: readonly ILocalAIWorkspaceRootContext[];
	readonly plannerResponse?: string;
	readonly workflow?: IAgentWorkflow;
	readonly reviewKind?: 'analysis' | 'repairInitial' | 'repairAfterReview';
}

interface IPendingAgentFileChange {
	readonly target: IAgentTarget;
	readonly proposedText: string;
	readonly reference: IReference<IResolvedTextEditorModel>;
	readonly originalReference: IReference<IResolvedTextEditorModel>;
	readonly appliedVersionId: number;
	readonly addedLines: number;
	readonly removedLines: number;
	readonly created?: boolean;
}

interface IPendingAgentChangeSet {
	readonly summary: string;
	readonly message: IChatMessage;
	readonly files: IPendingAgentFileChange[];
}

const localAIChatHistoryStorageKey = 'localAI.chatHistory';
const localAIChatModeStorageKey = 'localAI.chatMode';
const maximumStoredMessages = 40;
const maximumAttachmentBytes = 64 * 1024;
const maximumAttachedFiles = 8;
const maximumAutoDetectedFiles = 4;
const agentRequestInactivityTimeout = 120_000;
const maximumInitialPromptTimeout = 30 * 60_000;
export class LocalAIViewPane extends ViewPane {

	static readonly ID = 'workbench.view.localAI';

	private readonly _messageRenderStore = this._register(new DisposableStore());
	private readonly _attachmentRenderStore = this._register(new DisposableStore());
	private readonly _agentChangeReferences = this._register(new DisposableStore());
	private readonly _renderScheduler = this._register(new RunOnceScheduler(() => this._renderMessages(), 50));
	private readonly _mentionScheduler = this._register(new RunOnceScheduler(() => void this._showMentionPickerFromInput(), 150));
	private readonly _requestWatchdog = this._register(new RunOnceScheduler(() => {
		void this._handleRequestTimeout().catch(error => this._handleWorkflowError(error));
	}, agentRequestInactivityTimeout));
	private readonly _onDidChangeActivity = this._register(new Emitter<ILocalAIChatActivity>());
	readonly onDidChangeActivity = this._onDidChangeActivity.event;
	private readonly _messages: IChatMessage[] = [];
	private readonly _pendingAttachments: ILocalAIAttachment[] = [];
	private readonly _modelDownloads = new Map<string, ILocalLLMModelDownloadEvent>();
	private _recentAgentResources: URI[] = [];
	private _modeButton: HTMLButtonElement | undefined;
	private _modelButton: HTMLButtonElement | undefined;
	private _messagesContainer: HTMLElement | undefined;
	private _attachmentsContainer: HTMLElement | undefined;
	private _input: HTMLTextAreaElement | undefined;
	private _sendButton: HTMLButtonElement | undefined;
	private _stopButton: HTMLButtonElement | undefined;
	private _stateElement: HTMLElement | undefined;
	private _preparingRequest = false;
	private _activeRequestId: string | undefined;
	private _activeAgentResponse = '';
	private _pendingAgentRequest: IPendingAgentRequest | undefined;
	private _pendingAgentChangeSet: IPendingAgentChangeSet | undefined;
	private _mode: LocalAIChatMode;
	private _mentionPickerOpen = false;
	private _modelCatalog: ILocalLLMModelCatalog | undefined;
	private _modelManagerVisible = false;
	private _modelSelectionPending = false;
	private readonly _chatSessionId: string;
	private readonly _onDidRequestNewChat: (() => void) | undefined;
	private _chatTitle: string;

	constructor(
		options: ILocalAIViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService private readonly _contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@ILocalLLMService private readonly _localLLMService: ILocalLLMService,
		@ILocalAIContextService private readonly _contextService: ILocalAIContextService,
		@IMarkdownRendererService private readonly _markdownRendererService: IMarkdownRendererService,
		@IEditorService private readonly _editorService: IEditorService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IStorageService private readonly _storageService: IStorageService,
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
		@IDialogService private readonly _dialogService: IDialogService,
		@IFileDialogService private readonly _fileDialogService: IFileDialogService,
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@ISearchService private readonly _searchService: ISearchService,
		@ITextModelService private readonly _textModelService: ITextModelService,
		@ILanguageService private readonly _languageService: ILanguageService,
		@ITextFileService private readonly _textFileService: ITextFileService,
	) {
		super(options, keybindingService, _contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._chatSessionId = options.localAIChatSessionId ?? 'default';
		this._onDidRequestNewChat = options.onDidRequestNewChat;
		this._chatTitle = localize('localAIUntitledChat', "New Chat");
		this._mode = this._restoreMode();
		this._restoreHistory();

		this._register(this._localLLMService.onDidChangeState(state => this._updateServerState(state.state)));
		this._register(this._localLLMService.onDidChangeModels(catalog => {
			this._modelCatalog = catalog;
			this._modelManagerVisible = catalog.setupRequired || this._modelManagerVisible;
			this._renderModelButton();
			this._renderMessages();
			this._updateSetupAvailability();
		}));
		this._register(this._localLLMService.onDidDownloadModel(event => this._handleModelDownload(event)));
		this._register(this._localLLMService.onDidStreamToken(event => {
			if (event.requestId !== this._activeRequestId) {
				return;
			}
			this._requestWatchdog.schedule();
			const response = this._messages.at(-1);
			if (response?.role === 'assistant') {
				if (response.mode === 'agent') {
					this._activeAgentResponse += event.token;
					const agentRequest = this._pendingAgentRequest;
					if (agentRequest) {
						const step = response.agentSteps?.find(candidate => candidate.id === (agentRequest.stepId ?? agentRequest.stage));
						if (step?.status === 'running') {
							step.streamedCharacters = this._activeAgentResponse.length;
							this._renderScheduler.schedule();
						}
					}
				} else {
					response.content += event.token;
					this._renderScheduler.schedule();
				}
			}
		}));
		this._register(this._localLLMService.onDidStreamEnd(event => {
			void this._handleStreamEnd(event.requestId, event.error).catch(error => this._handleWorkflowError(error));
		}));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('local-ai-view');

		const header = dom.append(container, dom.$('.local-ai-header'));
		this._stateElement = dom.append(header, dom.$('span.local-ai-state'));
		this._stateElement.textContent = localize('localAIStopped', "Local model stopped");
		const headerActions = dom.append(header, dom.$('.local-ai-header-actions'));
		const newChatButton = dom.append(headerActions, dom.$<HTMLButtonElement>('button.local-ai-button.secondary'));
		newChatButton.type = 'button';
		newChatButton.textContent = localize('localAINewChat', "New Chat");
		this._register(dom.addDisposableListener(newChatButton, dom.EventType.CLICK, () => {
			if (this._onDidRequestNewChat) {
				this._onDidRequestNewChat();
			} else {
				void this._newChat();
			}
		}));

		this._messagesContainer = dom.append(container, dom.$('.local-ai-messages'));
		const inputArea = dom.append(container, dom.$('.local-ai-input-area'));
		this._attachmentsContainer = dom.append(inputArea, dom.$('.local-ai-attachments'));
		this._input = dom.append(inputArea, dom.$('textarea.local-ai-input'));
		this._input.rows = 3;
		this._updateInputPlaceholder();
		this._input.setAttribute('aria-label', localize('localAIInputAriaLabel', "Orbyte AI chat input"));

		const inputToolbar = dom.append(inputArea, dom.$('.local-ai-input-toolbar'));
		const toolbarStart = dom.append(inputToolbar, dom.$('.local-ai-toolbar-start'));
		const contextActions = dom.append(toolbarStart, dom.$('.local-ai-context-actions'));
		const attachButton = dom.append(contextActions, dom.$<HTMLButtonElement>('button.local-ai-icon-button.local-ai-add-context'));
		attachButton.type = 'button';
		attachButton.textContent = '+';
		attachButton.title = localize('localAIAttachFilesTitle', "Attach Files");
		attachButton.setAttribute('aria-label', localize('localAIAttachFilesAriaLabel', "Attach Files"));
		const mentionButton = dom.append(contextActions, dom.$<HTMLButtonElement>('button.local-ai-icon-button'));
		mentionButton.type = 'button';
		mentionButton.textContent = '@';
		mentionButton.title = localize('localAIMentionResourceTitle', "Mention Workspace File or Folder");
		mentionButton.setAttribute('aria-label', localize('localAIMentionResourceAriaLabel', "Mention Workspace File or Folder"));
		this._register(dom.addDisposableListener(mentionButton, dom.EventType.CLICK, () => void this._showMentionPicker()));
		this._register(dom.addDisposableListener(attachButton, dom.EventType.CLICK, () => void this._attachFiles()));

		this._modelButton = dom.append(toolbarStart, dom.$<HTMLButtonElement>('button.local-ai-model-picker'));
		this._modelButton.type = 'button';
		this._modelButton.setAttribute('aria-haspopup', 'dialog');
		this._modelButton.setAttribute('aria-label', localize('localAIModelAriaLabel', "Choose local AI model"));
		this._register(dom.addDisposableListener(this._modelButton, dom.EventType.CLICK, () => {
			// Model setup is the action the user needs when setup is required, so the
			// picker must remain available instead of becoming a no-op in that state.
			this._modelManagerVisible = this._modelCatalog?.setupRequired || !this._modelManagerVisible;
			this._renderMessages();
		}));

		this._modeButton = dom.append(inputToolbar, dom.$<HTMLButtonElement>('button.local-ai-mode-picker'));
		this._modeButton.type = 'button';
		this._modeButton.setAttribute('aria-haspopup', 'menu');
		this._modeButton.setAttribute('aria-label', localize('localAIModeAriaLabel', "Choose Orbyte AI mode"));
		this._register(dom.addDisposableListener(this._modeButton, dom.EventType.CLICK, () => this._showModeMenu()));

		const submitActions = dom.append(inputToolbar, dom.$('.local-ai-submit-actions'));
		this._sendButton = dom.append(submitActions, dom.$('button.local-ai-button.local-ai-send'));
		this._sendButton.type = 'button';
		this._sendButton.textContent = '↑';
		this._sendButton.title = localize('localAISend', "Send");
		this._sendButton.setAttribute('aria-label', localize('localAISend', "Send"));
		this._stopButton = dom.append(submitActions, dom.$('button.local-ai-button.local-ai-stop'));
		this._stopButton.type = 'button';
		this._stopButton.textContent = '■';
		this._stopButton.title = localize('localAIStop', "Stop");
		this._stopButton.setAttribute('aria-label', localize('localAIStop', "Stop"));
		this._stopButton.hidden = true;

		this._register(dom.addDisposableListener(this._sendButton, dom.EventType.CLICK, () => void this._send()));
		this._register(dom.addDisposableListener(this._stopButton, dom.EventType.CLICK, () => void this._stopGeneration()));
		this._register(dom.addDisposableListener(this._input, dom.EventType.INPUT, () => {
			if (this._input?.value.slice(0, this._input.selectionStart).match(/(?:^|\s)@$/)) {
				this._mentionScheduler.schedule();
			}
		}));
		this._register(dom.addDisposableListener(this._input, dom.EventType.KEY_DOWN, event => {
			if (event.key === 'Enter' && !event.shiftKey) {
				event.preventDefault();
				void this._send();
			}
		}));

		void this._localLLMService.getState().then(state => this._updateServerState(state.state));
		void this._initializeModels();
		this._renderMode();
		this._renderModelButton();
		this._renderAttachments();
		this._renderMessages();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
	}

	focusInput(): void {
		this._input?.focus();
	}

	getActivity(): ILocalAIChatActivity {
		const steps = this._messages.at(-1)?.agentSteps ?? [];
		const completed = steps.filter(step => step.status === 'completed' || step.status === 'handedOff' || step.status === 'skipped' || step.status === 'failed').length;
		return {
			title: this._chatTitle,
			running: this._preparingRequest || Boolean(this._activeRequestId),
			progress: steps.length ? Math.max(0, Math.min(1, completed / steps.length)) : undefined,
			pendingChanges: this._pendingAgentChangeSet?.files.length ?? 0,
		};
	}

	canClose(): boolean {
		return !this._preparingRequest && !this._activeRequestId && !(this._pendingAgentChangeSet?.files.length);
	}

	clearSessionStorage(): void {
		this._storageService.remove(this._historyStorageKey, StorageScope.WORKSPACE);
		this._storageService.remove(this._modeStorageKey, StorageScope.WORKSPACE);
	}

	private _emitActivity(): void {
		this._onDidChangeActivity.fire(this.getActivity());
	}

	showModelManager(): void {
		this._modelManagerVisible = true;
		this._renderMessages();
	}

	private async _initializeModels(): Promise<void> {
		try {
			this._modelCatalog = await this._localLLMService.getModelCatalog();
			this._modelManagerVisible = this._modelCatalog.setupRequired;
			this._renderModelButton();
			this._renderMessages();
			this._updateSetupAvailability();
			if (!this._modelCatalog.setupRequired) {
				await this._localLLMService.startServer();
			}
		} catch (error) {
			this._notificationService.error(localize('localAIModelInitializationError', "Unable to initialize local models: {0}", error instanceof Error ? error.message : String(error)));
		}
	}

	private _renderModelButton(): void {
		if (!this._modelButton) {
			return;
		}
		const selected = this._modelCatalog?.models.find(model => model.selected);
		this._renderDropdownButton(this._modelButton, selected?.parameters ?? localize('localAIChooseModelCompact', "Model"));
		this._modelButton.title = selected
			? localize('localAICurrentModel', "Current model: {0}", selected.name)
			: localize('localAIChooseModel', "Choose a local AI model");
	}

	private _handleModelDownload(event: ILocalLLMModelDownloadEvent): void {
		if (event.state === 'complete' || event.state === 'cancelled') {
			this._modelDownloads.delete(event.modelId);
		} else {
			this._modelDownloads.set(event.modelId, event);
		}
		if (event.state === 'error') {
			this._notificationService.error(localize('localAIModelDownloadError', "Model download failed: {0}", event.error ?? localize('localAIUnknownError', "Unknown error")));
		}
		this._renderMessages();
	}

	private async _useModel(model: ILocalLLMModelInfo): Promise<void> {
		if (this._modelSelectionPending) {
			return;
		}
		this._modelSelectionPending = true;
		this._renderMessages();
		try {
			this._modelCatalog = await this._localLLMService.selectModel(model.id);
			this._modelManagerVisible = false;
			this._renderModelButton();
			this._renderMessages();
			this._updateSetupAvailability();
		} catch (error) {
			this._notificationService.error(localize('localAISelectModelError', "Unable to use {0}: {1}", model.name, error instanceof Error ? error.message : String(error)));
		} finally {
			this._modelSelectionPending = false;
			this._renderMessages();
		}
	}

	private async _downloadModel(model: ILocalLLMModelInfo): Promise<void> {
		try {
			await this._localLLMService.downloadModel(model.id);
			this._modelCatalog = await this._localLLMService.getModelCatalog();
			this._modelManagerVisible = false;
			this._renderModelButton();
			this._renderMessages();
			this._updateSetupAvailability();
		} catch (error) {
			this._notificationService.error(localize('localAIModelDownloadError', "Model download failed: {0}", error instanceof Error ? error.message : String(error)));
		}
	}

	private _updateSetupAvailability(): void {
		const setupRequired = this._modelCatalog?.setupRequired === true;
		if (this._input && !this._activeRequestId) {
			this._input.disabled = setupRequired;
		}
		if (this._sendButton && !this._activeRequestId) {
			this._sendButton.disabled = setupRequired;
		}
	}

	private _formatBytes(bytes: number): string {
		return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
	}

	private _setMode(mode: LocalAIChatMode): void {
		if (this._mode === mode) {
			return;
		}
		this._mode = mode;
		this._storageService.store(this._modeStorageKey, mode, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this._renderMode();
		this._updateInputPlaceholder();
		this._input?.focus();
	}

	private _renderMode(): void {
		if (this._modeButton) {
			this._renderDropdownButton(this._modeButton, this._modeLabel(this._mode));
			this._modeButton.title = localize('localAICurrentMode', "Current mode: {0}", this._modeLabel(this._mode));
		}
	}

	private _renderDropdownButton(button: HTMLButtonElement, label: string): void {
		dom.clearNode(button);
		const labelElement = dom.append(button, dom.$('span.local-ai-dropdown-label'));
		labelElement.textContent = label;
		const chevron = dom.append(button, dom.$('span.codicon.codicon-chevron-down.local-ai-dropdown-chevron'));
		chevron.setAttribute('aria-hidden', 'true');
	}

	private _showModeMenu(): void {
		if (!this._modeButton) {
			return;
		}
		const modes: readonly LocalAIChatMode[] = ['ask', 'plan', 'agent'];
		const actions: IAction[] = modes.map(mode => ({
			id: `workbench.action.localAI.mode.${mode}`,
			label: this._modeLabel(mode),
			tooltip: '',
			class: undefined,
			enabled: true,
			checked: mode === this._mode,
			run: async () => this._setMode(mode),
		}));
		this._contextMenuService.showContextMenu({
			getAnchor: () => this._modeButton!,
			getActions: () => actions,
		});
	}

	private _restoreMode(): LocalAIChatMode {
		const stored = this._storageService.get(this._modeStorageKey, StorageScope.WORKSPACE);
		return stored === 'ask' || stored === 'plan' || stored === 'agent' ? stored : 'ask';
	}

	private get _historyStorageKey(): string {
		return this._chatSessionId === 'default' ? localAIChatHistoryStorageKey : `${localAIChatHistoryStorageKey}.${this._chatSessionId}`;
	}

	private get _modeStorageKey(): string {
		return this._chatSessionId === 'default' ? localAIChatModeStorageKey : `${localAIChatModeStorageKey}.${this._chatSessionId}`;
	}

	private _modeLabel(mode: LocalAIChatMode): string {
		switch (mode) {
			case 'plan':
				return localize('localAIPlanMode', "Plan");
			case 'agent':
				return localize('localAIAgentMode', "Agent");
			default:
				return localize('localAIAskMode', "Ask");
		}
	}

	private _updateInputPlaceholder(): void {
		if (!this._input) {
			return;
		}
		switch (this._mode) {
			case 'plan':
				this._input.placeholder = localize('localAIPlanPlaceholder', "Describe the change to plan…");
				break;
			case 'agent':
				this._input.placeholder = localize('localAIAgentPlaceholder', "Describe the change to implement…");
				break;
			default:
				this._input.placeholder = localize('localAIAskPlaceholder', "Ask about your code…");
		}
	}

	private _prepareProjectInstructions(): void {
		this._setMode('agent');
		if (!this._input) {
			return;
		}
		this._input.value = localize(
			'localAIGenerateInstructionsPrompt',
			"Create or update AGENTS.md with concise project architecture, build, test, formatting, and contribution instructions for AI coding agents. Inspect the workspace first and preserve existing instructions."
		);
		this._input.focus();
		this._input.setSelectionRange(this._input.value.length, this._input.value.length);
	}

	private _renderAttachments(): void {
		if (!this._attachmentsContainer) {
			return;
		}
		this._attachmentRenderStore.clear();
		dom.clearNode(this._attachmentsContainer);
		this._attachmentsContainer.hidden = this._pendingAttachments.length === 0;
		for (const attachment of this._pendingAttachments) {
			const chip = dom.append(this._attachmentsContainer, dom.$('span.local-ai-attachment'));
			chip.title = attachment.uri;
			const name = dom.append(chip, dom.$('span.local-ai-attachment-name'));
			name.textContent = attachment.name;
			const remove = dom.append(chip, dom.$<HTMLButtonElement>('button.local-ai-attachment-remove'));
			remove.type = 'button';
			remove.textContent = '×';
			remove.setAttribute('aria-label', localize('localAIRemoveAttachment', "Remove {0}", attachment.name));
			this._attachmentRenderStore.add(dom.addDisposableListener(remove, dom.EventType.CLICK, () => {
				const index = this._pendingAttachments.findIndex(candidate => candidate.uri === attachment.uri);
				if (index >= 0) {
					this._pendingAttachments.splice(index, 1);
					this._renderAttachments();
				}
			}));
		}
	}

	private async _attachFiles(): Promise<void> {
		const resources = await this._fileDialogService.showOpenDialog({
			title: localize('localAIAttachFilesDialogTitle', "Attach Files to Orbyte AI"),
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: true,
		});
		if (!resources) {
			return;
		}
		for (const resource of resources) {
			await this._addAttachment(resource);
		}
		this._renderAttachments();
		this._input?.focus();
	}

	private async _showMentionPickerFromInput(): Promise<void> {
		if (!this._input || !this._input.value.slice(0, this._input.selectionStart).match(/(?:^|\s)@$/)) {
			return;
		}
		await this._showMentionPicker(true);
	}

	private async _showMentionPicker(replaceTrigger = false): Promise<void> {
		if (this._mentionPickerOpen) {
			return;
		}
		this._mentionPickerOpen = true;
		const disposables = new DisposableStore();
		try {
			if (!this._workspaceContextService.getWorkspace().folders.length) {
				this._notificationService.warn(localize('localAINoWorkspaceResources', "Open a workspace folder to mention files or folders."));
				return;
			}

			const picker = disposables.add(this._quickInputService.createQuickPick<ILocalAIResourcePick>());
			picker.placeholder = localize('localAIMentionResourcePlaceholder', "Select a File or Folder to Add as Context");
			picker.matchOnDescription = true;
			let searchSequence = 0;
			const updateItems = async (pattern: string): Promise<void> => {
				const sequence = ++searchSequence;
				picker.busy = true;
				try {
					const items = await this._workspaceResourcePicks(pattern, 100);
					if (sequence === searchSequence) {
						picker.items = items;
					}
				} finally {
					if (sequence === searchSequence) {
						picker.busy = false;
					}
				}
			};
			const picked = await new Promise<ILocalAIResourcePick | undefined>(resolve => {
				let settled = false;
				const settle = (item: ILocalAIResourcePick | undefined): void => {
					if (!settled) {
						settled = true;
						resolve(item);
					}
				};
				disposables.add(picker.onDidChangeValue(value => void updateItems(value)));
				disposables.add(picker.onDidAccept(() => {
					settle(picker.selectedItems[0]);
					picker.hide();
				}));
				disposables.add(picker.onDidHide(() => settle(undefined)));
				picker.show();
				void updateItems('');
			});
			if (!picked) {
				return;
			}
			if (picked.resourceKind === 'folder') {
				await this._addFolderAttachments(picked.resource);
			} else {
				await this._addAttachment(picked.resource);
			}
			this._insertMention(picked.mentionPath, replaceTrigger);
			this._renderAttachments();
		} finally {
			disposables.dispose();
			this._mentionPickerOpen = false;
			this._input?.focus();
		}
	}

	private async _searchWorkspaceFiles(pattern = '', maxResults = 300, roots: readonly URI[] = this._workspaceContextService.getWorkspace().folders.map(folder => folder.uri)): Promise<URI[]> {
		if (!roots.length) {
			return [];
		}
		const result = await this._searchService.fileSearch({
			type: QueryType.File,
			folderQueries: roots.map(folder => ({ folder })),
			filePattern: pattern,
			sortByScore: true,
			maxResults,
			excludePattern: {
				'**/.build/**': true,
				'**/.gradle/**': true,
				'**/.git/**': true,
				'**/build/classes/**': true,
				'**/build/generated/**': true,
				'**/build/resources/**': true,
				'**/build/tmp/**': true,
				'**/node_modules/**': true,
				'**/out/**': true,
				'**/resources/local-llm/**': true,
				'**/target/**': true,
			},
		});
		return result.results.map(result => result.resource);
	}

	private async _workspaceResourcePicks(pattern = '', maxResults = 300): Promise<ILocalAIResourcePick[]> {
		const workspaceFolders = this._workspaceContextService.getWorkspace().folders;
		if (!workspaceFolders.length) {
			return [];
		}
		const resources = await this._searchWorkspaceFiles(pattern, maxResults);
		const folderPicks = new Map<string, ILocalAIResourcePick>();
		const normalizedPattern = pattern.trim().toLowerCase();
		const addFolderPick = (resource: URI, label: string, mentionPath: string): void => {
			const description = mentionPath.endsWith('/') ? mentionPath : `${mentionPath}/`;
			if (normalizedPattern && !`${label} ${description}`.toLowerCase().includes(normalizedPattern)) {
				return;
			}
			folderPicks.set(resource.toString(), {
				label,
				description,
				resource,
				resourceKind: 'folder',
				mentionPath: description,
				iconClass: ThemeIcon.asClassName(Codicon.folder),
			});
		};

		for (const workspaceFolder of workspaceFolders) {
			addFolderPick(workspaceFolder.uri, workspaceFolder.name, './');
		}
		for (const resource of resources) {
			for (const workspaceFolder of workspaceFolders) {
				const filePath = relativePath(workspaceFolder.uri, resource);
				if (!filePath || filePath === '..' || filePath.startsWith('../')) {
					continue;
				}
				let folder = dirname(resource);
				while (isEqual(folder, workspaceFolder.uri) || relativePath(workspaceFolder.uri, folder)?.match(/^(?!\.\.\/).+/)) {
					const folderPath = relativePath(workspaceFolder.uri, folder);
					addFolderPick(folder, isEqual(folder, workspaceFolder.uri) ? workspaceFolder.name : basename(folder), folderPath || './');
					if (isEqual(folder, workspaceFolder.uri)) {
						break;
					}
					folder = dirname(folder);
				}
				break;
			}
		}

		const filePicks: ILocalAIResourcePick[] = resources.map(resource => {
			const path = this._workspaceRelativePath(resource);
			return {
				label: basename(resource),
				description: path,
				resource,
				resourceKind: 'file' as const,
				mentionPath: path,
				iconClass: ThemeIcon.asClassName(Codicon.file),
			};
		});
		const maximumFolders = Math.min(folderPicks.size, Math.max(20, Math.floor(maxResults / 2)));
		return [...folderPicks.values()].slice(0, maximumFolders).concat(filePicks.slice(0, maxResults - maximumFolders));
	}

	private _workspaceRelativePath(resource: URI): string {
		for (const folder of this._workspaceContextService.getWorkspace().folders) {
			const path = relativePath(folder.uri, resource);
			if (path && path !== '..' && !path.startsWith('../')) {
				return path;
			}
		}
		return basename(resource);
	}

	private _insertMention(path: string, replaceTrigger: boolean): void {
		if (!this._input) {
			return;
		}
		const cursor = this._input.selectionStart;
		const start = replaceTrigger && cursor > 0 && this._input.value[cursor - 1] === '@' ? cursor - 1 : cursor;
		const mention = `@{${path}} `;
		this._input.setRangeText(mention, start, cursor, 'end');
	}

	private async _addAttachment(resource: URI): Promise<void> {
		if (this._pendingAttachments.some(attachment => attachment.uri === resource.toString())) {
			return;
		}
		if (this._pendingAttachments.length >= maximumAttachedFiles) {
			this._notificationService.warn(localize('localAITooManyAttachments', "Orbyte AI supports up to {0} attached files per message.", maximumAttachedFiles));
			return;
		}
		try {
			const file = await this._fileService.readFile(resource, { length: maximumAttachmentBytes });
			const content = file.value.toString();
			if (content.includes('\0')) {
				this._notificationService.warn(localize('localAIBinaryAttachment', "{0} is not a supported text file.", basename(resource)));
				return;
			}
			this._pendingAttachments.push({
				uri: resource.toString(),
				name: this._workspaceRelativePath(resource),
				content,
			});
		} catch (error) {
			this._notificationService.error(localize('localAIAttachmentReadError', "Unable to attach {0}: {1}", basename(resource), error instanceof Error ? error.message : String(error)));
		}
	}

	private async _addFolderAttachments(resource: URI): Promise<void> {
		const available = maximumAttachedFiles - this._pendingAttachments.length;
		if (available <= 0) {
			this._notificationService.warn(localize('localAITooManyAttachments', "Orbyte AI supports up to {0} attached files per message.", maximumAttachedFiles));
			return;
		}
		const resources = await this._searchWorkspaceFiles('', 120, [resource]);
		const prioritized = resources.sort((left, right) => {
			const score = (candidate: URI): number => {
				const path = this._workspaceRelativePath(candidate).toLowerCase();
				const fileName = basename(candidate).toLowerCase();
				if (/^(pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?)$/.test(fileName)) {
					return 1000;
				}
				if (/application\.(?:properties|ya?ml)$/.test(fileName) || /application\.java$/.test(fileName)) {
					return 900;
				}
				if (/(?:^|\/)(?:service|controller|repository|entity|model|dto|config)(?:\/|$)/.test(path)) {
					return 700;
				}
				if (path.includes('/src/main/') || path.startsWith('src/main/')) {
					return 500;
				}
				return 100;
			};
			return score(right) - score(left) || this._workspaceRelativePath(left).localeCompare(this._workspaceRelativePath(right));
		});
		for (const file of prioritized.slice(0, available)) {
			await this._addAttachment(file);
		}
		if (!resources.length) {
			this._notificationService.warn(localize('localAIFolderHasNoFiles', "No supported files were found in {0}.", this._workspaceRelativePath(resource)));
		} else if (resources.length > available) {
			this._notificationService.info(localize('localAIFolderAttachmentLimit', "Added the first {0} files from {1}. Attachments are limited to {2} files per message.", available, this._workspaceRelativePath(resource), maximumAttachedFiles));
		}
	}

	private async _resolveTypedMentions(value: string): Promise<void> {
		const paths = new Set<string>();
		for (const match of value.matchAll(/@\{(?<braced>[^}]+)\}|@(?<plain>[^\s]+)/g)) {
			const path = match.groups?.braced ?? match.groups?.plain;
			if (path) {
				paths.add(path.replace(/[.,;:!?]+$/, ''));
			}
		}
		for (const path of paths) {
			if (this._pendingAttachments.some(attachment => attachment.name === path)) {
				continue;
			}
			const picks = await this._workspaceResourcePicks(path, 50);
			const normalizedPath = path.replace(/^\.\//, '');
			const exact = picks.find(pick => pick.mentionPath.replace(/^\.\//, '').replace(/\/$/, '') === normalizedPath.replace(/\/$/, '')) ?? picks.find(pick => pick.label === path);
			if (exact) {
				if (exact.resourceKind === 'folder') {
					await this._addFolderAttachments(exact.resource);
				} else {
					await this._addAttachment(exact.resource);
				}
			}
		}
		this._renderAttachments();
	}

	private async _resolveSmartWorkspaceContext(value: string): Promise<void> {
		const available = Math.min(maximumAutoDetectedFiles, maximumAttachedFiles - this._pendingAttachments.length);
		if (available <= 0 || !this._workspaceContextService.getWorkspace().folders.length) {
			return;
		}

		const promptTokens = localAIContextTokens(value);
		if (!promptTokens.size && !/[./\\]/.test(value)) {
			return;
		}

		const activeResource = getCodeEditor(this._editorService.activeTextEditorControl)?.getModel()?.uri.toString();
		const openResources = new Set(this._editorService.editors
			.map(editor => editor.resource?.toString())
			.filter((resource): resource is string => Boolean(resource)));
		const folderRequested = /\b(directory|folder|module|package)\b/i.test(value);
		const resources = await this._searchWorkspaceFiles('', 600);
		const ranked = resources
			.filter(resource => resource.toString() !== activeResource && !this._pendingAttachments.some(attachment => attachment.uri === resource.toString()))
			.map(resource => {
				const path = this._workspaceRelativePath(resource);
				const score = scoreLocalAIWorkspacePath(value, path, {
					folderRequested,
					open: openResources.has(resource.toString()),
				});

				return { resource, path, score };
			})
			.filter(candidate => candidate.score > 0)
			.sort((left, right) => right.score - left.score || left.path.length - right.path.length);

		const threshold = folderRequested ? 55 : 90;
		let detected = ranked.filter(candidate => candidate.score >= threshold).slice(0, available);
		if (!detected.length && ranked[0]?.score >= 65 && (!ranked[1] || ranked[0].score > ranked[1].score)) {
			detected = [ranked[0]];
		}
		for (const candidate of detected) {
			await this._addAttachment(candidate.resource);
		}
		this._renderAttachments();
	}

	private async _resolveRecentAgentContext(): Promise<void> {
		const activeResource = getCodeEditor(this._editorService.activeTextEditorControl)?.getModel()?.uri.toString();
		for (const resource of this._recentAgentResources) {
			if (this._pendingAttachments.length >= maximumAttachedFiles) {
				break;
			}
			if (resource.toString() === activeResource || this._pendingAttachments.some(attachment => attachment.uri === resource.toString())) {
				continue;
			}
			await this._addAttachment(resource);
		}
		this._renderAttachments();
	}

	private async _workspaceRootContext(): Promise<ILocalAIWorkspaceRootContext[]> {
		const workspaceFolders = this._workspaceContextService.getWorkspace().folders;
		if (!workspaceFolders.length) {
			return [];
		}
		const resources = await this._searchWorkspaceFiles('', 300);
		return workspaceFolders.map(folder => ({
			uri: folder.uri.toString(),
			name: folder.name,
			files: resources
				.map(resource => relativePath(folder.uri, resource))
				.filter((path): path is string => Boolean(path && path !== '..' && !path.startsWith('../'))),
		}));
	}

	private async _send(): Promise<void> {
		const value = this._input?.value.trim();
		if (!value || this._preparingRequest || this._activeRequestId) {
			return;
		}
		this._preparingRequest = true;
		this._emitActivity();

		const mode = this._mode;
		if (!this._messages.some(message => message.role === 'user')) {
			this._chatTitle = value.replace(/\s+/g, ' ').slice(0, 42) || localize('localAIUntitledChat', "New Chat");
			this._emitActivity();
		}
		if (mode === 'agent' && this._pendingAgentChangeSet?.files.length) {
			// A follow-up Agent instruction means the user wants to continue from the
			// staged result. Resolve that result first so the next turn gets a fresh,
			// current snapshot instead of silently remaining blocked by review state.
			await this._acceptAllAgentChanges();
			if (this._pendingAgentChangeSet?.files.length) {
				this._preparingRequest = false;
				this._emitActivity();
				this._notificationService.warn(localize('localAIResolveChanges', "Some current Agent changes could not be accepted. Resolve them before continuing."));
				return;
			}
		}
		let context: ILocalAIContext | undefined;
		let attachments: ILocalAIAttachment[];
		let agentTargets: IAgentTarget[];
		let workspaceRoots: ILocalAIWorkspaceRootContext[];
		try {
			context = await this._contextService.collect();
			await this._resolveTypedMentions(value);
			await this._resolveSmartWorkspaceContext(value);
			if (mode === 'agent') {
				await this._resolveRecentAgentContext();
			}
			attachments = [...this._pendingAttachments];
			agentTargets = mode === 'agent' ? await this._collectAgentTargets(attachments) : [];
			workspaceRoots = mode === 'agent' ? await this._workspaceRootContext() : [];
		} catch (error) {
			this._preparingRequest = false;
			this._emitActivity();
			this._notificationService.error(localize('localAIContextPreparationError', "Unable to prepare workspace context: {0}", error instanceof Error ? error.message : String(error)));
			return;
		}
		if (mode === 'agent' && !agentTargets.length && !workspaceRoots.length) {
			this._preparingRequest = false;
			this._emitActivity();
			this._notificationService.warn(localize('localAIAgentNoWorkspace', "Open a workspace folder or a text file before asking Agent to make changes."));
			return;
		}
		if (mode === 'agent') {
			this._recentAgentResources = agentTargets.map(target => target.resource);
		}
		const history: ILocalLLMChatMessage[] = this._messages.map(message => ({
			role: message.role,
			content: message.attachmentNames?.length ? `${message.content}\n\nAttached files: ${message.attachmentNames.join(', ')}` : message.content,
		}));
		this._input!.value = '';
		this._messages.push({ role: 'user', content: value, mode, attachmentNames: attachments.map(attachment => attachment.name) });
		this._messages.push({
			role: 'assistant',
			content: mode === 'agent' ? localize('localAIAgentPlannerRunning', "Planner subagent is selecting the relevant files…") : '',
			mode,
			agentSteps: mode === 'agent' ? [{
				id: 'planner',
				stage: 'planner',
				name: localize('localAIPlannerName', "Planner"),
				status: 'running',
				detail: localize('localAIAgentPlannerInspecting', "Inspecting the workspace and selecting relevant files."),
			}] : undefined,
		});
		this._pendingAttachments.length = 0;
		this._renderAttachments();
		this._storeHistory();
		this._renderMessages();
		this._emitActivity();
		this._setInputEnabled(false);
		if (mode === 'agent') {
			this._preparingRequest = false;
			await this._startAgentSubagent({
				targets: agentTargets,
				instruction: value,
				context,
				history,
				attachments,
				workspaceRoots,
			}, 'planner', formatAgentTaskPlannerMessages(value, workspaceRoots, agentTargets.map(target => ({ uri: target.resource.toString(), displayPath: target.displayPath })), this._maximumFeatureTasks()));
			return;
		}

		const requestId = generateUuid();
		this._activeRequestId = requestId;
		this._preparingRequest = false;
		this._emitActivity();
		try {
			const messages = formatChatMessages(context, value, history, mode, attachments, workspaceRoots, this._contextWindowTokens());
			this._scheduleInitialRequestWatchdog(messages);
			await this._localLLMService.streamChat({
				requestId,
				messages,
				maxTokens: getLocalLLMGenerationTokens(this._contextWindowTokens(), mode === 'plan' ? 'planner' : 'chat'),
				temperature: mode === 'plan' ? 0.15 : 0.2,
			});
		} catch (error) {
			this._requestWatchdog.cancel();
			this._activeRequestId = undefined;
			this._activeAgentResponse = '';
			this._pendingAgentRequest = undefined;
			this._setInputEnabled(true);
			this._messages.at(-1)!.content = localize('localAIStartError', "Unable to start the local model: {0}", error instanceof Error ? error.message : String(error));
			this._storeHistory();
			this._renderMessages();
		}
	}

	private _maximumFeatureTasks(): number {
		const selected = this._modelCatalog?.models.find(model => model.selected);
		const parameterBillions = Number.parseFloat(selected?.parameters ?? '3');
		const memoryBytes = this._modelCatalog?.hardware.memoryBytes ?? 0;
		if (parameterBillions >= 14) {
			return 8;
		}
		if (parameterBillions >= 7) {
			return memoryBytes >= 16 * 1024 ** 3 ? 6 : 5;
		}
		return memoryBytes >= 12 * 1024 ** 3 ? 4 : 3;
	}

	private _contextWindowTokens(): number {
		return this._modelCatalog?.models.find(model => model.selected)?.contextWindowTokens ?? localLLMMinimumContextTokens;
	}

	private _scheduleInitialRequestWatchdog(messages: readonly ILocalLLMChatMessage[]): void {
		// llama.cpp emits the first stream token only after evaluating the complete
		// prompt. Large coding contexts can legitimately need several minutes on
		// an 8 GB machine. Once streaming begins, the normal inactivity timeout is
		// restored by the token listener.
		const approximatePromptTokens = messages.reduce((total, message) => total + message.content.length, 0) / 3;
		const selectedParameters = Number.parseFloat(this._modelCatalog?.models.find(model => model.selected)?.parameters ?? '3');
		const estimatedPromptThroughput = selectedParameters >= 32 ? 12 : selectedParameters >= 14 ? 25 : selectedParameters >= 7 ? 45 : 70;
		const estimatedPromptTime = approximatePromptTokens / estimatedPromptThroughput * 1000 + 60_000;
		this._requestWatchdog.schedule(Math.min(maximumInitialPromptTimeout, Math.max(agentRequestInactivityTimeout, Math.ceil(estimatedPromptTime))));
	}

	private async _startAgentSubagent(base: Omit<IPendingAgentRequest, 'requestId' | 'stage'>, stage: AgentSubagentStage, messages: readonly ILocalLLMChatMessage[]): Promise<void> {
		const requestId = generateUuid();
		this._activeRequestId = requestId;
		this._activeAgentResponse = '';
		this._pendingAgentRequest = { ...base, requestId, stage };
		const response = this._messages.at(-1);
		if (response?.role === 'assistant') {
			for (const step of response.agentSteps ?? []) {
				if (step.status === 'running' && step.id !== (base.stepId ?? stage)) {
					step.status = 'completed';
				}
			}
			this._setAgentStep(response, stage, 'running', stage === 'planner'
				? localize('localAIAgentPlannerInspecting', "Inspecting the workspace and selecting relevant files.")
				: stage === 'implementer'
					? localize('localAIAgentImplementerEditing', "Preparing targeted code changes for the selected files.")
					: stage === 'reviewer'
						? localize('localAIAgentReviewerValidating', "Repairing and validating the proposed changes before review.")
						: localize('localAIAgentTesterRunning', "Checking the feature changes and validation risks."), undefined, base.stepId);
			response.content = stage === 'planner'
				? localize('localAIAgentPlannerRunning', "Planner subagent is selecting the relevant files…")
				: stage === 'implementer'
					? localize('localAIAgentImplementerRunning', "Implementer subagent is preparing targeted changes…")
					: stage === 'reviewer'
						? localize('localAIAgentReviewerRunning', "Reviewer subagent is checking the feature proposal…")
						: stage === 'tester'
							? localize('localAIAgentTesterRunningMessage', "Tester subagent is preparing a focused validation plan…")
							: localize('localAIIntegrationTesterRunningMessage', "Integration Tester is checking cross-feature risks…");
		}
		this._setInputEnabled(false);
		this._storeHistory();
		this._renderMessages();
		try {
			this._scheduleInitialRequestWatchdog(messages);
			const taskKind = stage === 'planner'
				? 'planner'
				: stage === 'tester' || stage === 'integrationTester' || (stage === 'reviewer' && base.reviewKind === 'analysis')
					? 'analysis'
					: 'implementer';
			const maxTokens = getLocalLLMGenerationTokens(this._contextWindowTokens(), taskKind);
			await this._localLLMService.streamChat({
				requestId,
				messages,
				maxTokens,
				temperature: stage === 'planner' ? 0.1 : 0.05,
			});
		} catch (error) {
			this._requestWatchdog.cancel();
			this._activeRequestId = undefined;
			this._activeAgentResponse = '';
			this._pendingAgentRequest = undefined;
			this._setInputEnabled(true);
			if (response?.role === 'assistant') {
				this._setAgentStep(response, stage, 'failed', localize('localAISubagentFailedDetail', "Could not start: {0}", error instanceof Error ? error.message : String(error)), undefined, base.stepId);
				this._skipUnfinishedAgentSteps(response, localize('localAISubagentSkippedAfterFailure', "Not run because the active subagent could not start."));
				response.content = localize('localAISubagentStartError', "{0} subagent could not start: {1}", stage, error instanceof Error ? error.message : String(error));
			}
			this._storeHistory();
			this._renderMessages();
		}
	}

	private _setAgentStep(message: IChatMessage, stage: AgentSubagentStage, status: AgentSubagentStatus, detail: string, files?: readonly string[], id: string = stage, name: string = this._agentStageName(stage)): void {
		const steps = message.agentSteps ??= [];
		const existing = steps.find(step => step.id === id);
		if (existing) {
			existing.status = status;
			existing.detail = detail;
			existing.files = files;
			existing.streamedCharacters = undefined;
			this._emitActivity();
			return;
		}
		steps.push({ id, stage, name, status, detail, files });
		this._emitActivity();
	}

	private _moveAgentStepBefore(message: IChatMessage, stepId: string, beforeStepId: string): void {
		const steps = message.agentSteps;
		if (!steps) {
			return;
		}
		const stepIndex = steps.findIndex(step => step.id === stepId);
		const beforeIndex = steps.findIndex(step => step.id === beforeStepId);
		if (stepIndex < 0 || beforeIndex < 0 || stepIndex < beforeIndex) {
			return;
		}
		const [step] = steps.splice(stepIndex, 1);
		steps.splice(steps.findIndex(candidate => candidate.id === beforeStepId), 0, step);
	}

	private _abortAgentWorkflow(response: IChatMessage, message: string): void {
		for (const step of response.agentSteps ?? []) {
			if (step.status === 'queued' || step.status === 'running') {
				step.status = 'skipped';
				step.detail = localize('localAISubagentNotRun', "Not run because an earlier feature could not produce a safe change.");
			}
		}
		this._pendingAgentRequest = undefined;
		response.content = message;
		this._setInputEnabled(true);
		this._emitActivity();
		this._storeHistory();
		this._renderMessages();
		this._notificationService.warn(message);
	}

	private _skipUnfinishedAgentSteps(response: IChatMessage, detail: string): void {
		for (const step of response.agentSteps ?? []) {
			if (step.status === 'queued' || step.status === 'running') {
				step.status = 'skipped';
				step.detail = detail;
			}
		}
	}

	private _agentStageName(stage: AgentSubagentStage): string {
		switch (stage) {
			case 'planner': return localize('localAIPlannerName', "Planner");
			case 'implementer': return localize('localAIImplementerName', "Implementer");
			case 'reviewer': return localize('localAIReviewerName', "Reviewer");
			case 'tester': return localize('localAITesterName', "Tester");
			case 'integrationTester': return localize('localAIIntegrationTesterName', "Integration Tester");
		}
	}

	private _decodeAgentXml(value: string): string {
		return value
			.replace(/^\s*<!\[CDATA\[/, '')
			.replace(/\]\]>\s*$/, '')
			.replaceAll('&quot;', '"')
			.replaceAll('&apos;', "'")
			.replaceAll('&lt;', '<')
			.replaceAll('&gt;', '>')
			.replaceAll('&amp;', '&')
			.trim();
	}

	private _featureTasksFromPlanner(request: IPendingAgentRequest, plannerResponse: string, selectedTargets: readonly IAgentTarget[]): IAgentWorkflow {
		const maximumTasks = this._maximumFeatureTasks();
		const tasks: IAgentFeatureTask[] = [];
		const ids = new Set<string>();
		const taskPattern = /<task\b([^>]*)>([\s\S]*?)<\/task>/gi;
		for (const match of plannerResponse.matchAll(taskPattern)) {
			if (tasks.length >= maximumTasks) {
				break;
			}
			const attributes = match[1];
			const body = match[2];
			const attribute = (name: string): string => this._decodeAgentXml(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(attributes)?.[1] ?? '');
			let id = attribute('id').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80) || `feature-${tasks.length + 1}`;
			while (ids.has(id)) {
				id = `${id}-${tasks.length + 1}`;
			}
			ids.add(id);
			const title = attribute('title') || id.replaceAll('-', ' ');
			const instruction = this._decodeAgentXml(/<instruction>([\s\S]*?)<\/instruction>/i.exec(body)?.[1] ?? title);
			const paths = [...body.matchAll(/<path>([\s\S]*?)<\/path>/gi)].map(path => this._decodeAgentXml(path[1]).replaceAll('\\', '/')).filter(Boolean).slice(0, maximumAttachedFiles);
			const dependsOn = [...body.matchAll(/<task_id>([\s\S]*?)<\/task_id>/gi)].map(dependency => this._decodeAgentXml(dependency[1])).filter(Boolean).slice(0, maximumTasks);
			tasks.push({
				id,
				title: title.slice(0, 120),
				instruction: instruction.slice(0, 3000),
				paths,
				dependsOn,
				needsTests: !/\bneeds_tests\s*=\s*["']false["']/i.test(attributes),
				targets: [],
				references: [],
				reviewerResponses: [],
			});
		}
		if (!tasks.length) {
			tasks.push({
				id: 'feature-1',
				title: localize('localAIFallbackFeatureTitle', "Requested change"),
				instruction: request.instruction,
				paths: selectedTargets.map(target => target.displayPath),
				needsTests: true,
				targets: [],
				references: [],
				reviewerResponses: [],
			});
		}

		const owned = new Set<string>();
		for (const task of tasks) {
			const normalizedPaths = task.paths.map(path => path.toLowerCase().replace(/^\.\//, ''));
			task.targets = selectedTargets.filter(target => {
				const key = target.resource.toString();
				if (owned.has(key)) {
					return false;
				}
				const displayPath = target.displayPath.toLowerCase().replace(/^\.\//, '');
				const matches = normalizedPaths.some(path => displayPath === path || displayPath.endsWith(`/${path}`) || path.endsWith(`/${displayPath}`) || basename(target.resource).toLowerCase() === path.split('/').at(-1));
				if (matches) {
					owned.add(key);
				}
				return matches;
			});
			const prompt = `${request.instruction}\n${task.instruction}`;
			const targetUris = new Set(task.targets.map(target => target.resource.toString()));
			task.references = selectedTargets
				.filter(target => !targetUris.has(target.resource.toString()))
				.map(target => ({ target, score: scoreLocalAIWorkspacePath(prompt, target.displayPath) }))
				.filter(candidate => candidate.score >= 90)
				.sort((left, right) => right.score - left.score || left.target.displayPath.length - right.target.displayPath.length)
				.slice(0, 3)
				.map(candidate => candidate.target);
		}
		const requestsDependencies = /\b(?:add|install|include|update|configure)\b[\s\S]{0,80}\bdependenc(?:y|ies)\b|\brequired\s+dependenc(?:y|ies)\b/i.test(request.instruction);
		if (requestsDependencies && tasks.length < maximumTasks) {
			const manifestNames = new Set(['pom.xml', 'build.gradle', 'build.gradle.kts', 'package.json', 'pyproject.toml', 'requirements.txt']);
			const manifest = selectedTargets.find(target => {
				const fileName = basename(target.resource).toLowerCase();
				return manifestNames.has(fileName) && !owned.has(target.resource.toString());
			});
			if (manifest) {
				let id = 'feature-dependencies';
				let suffix = 2;
				while (ids.has(id)) {
					id = `feature-dependencies-${suffix++}`;
				}
				ids.add(id);
				owned.add(manifest.resource.toString());
				tasks.push({
					id,
					title: localize('localAIDependencyFeatureTitle', "Add required dependencies"),
					instruction: localize('localAIDependencyFeatureInstruction', "Update {0} with only the dependencies required for this request: {1}", manifest.displayPath, request.instruction.slice(0, 1000)),
					paths: [manifest.displayPath],
					needsTests: true,
					targets: [manifest],
					references: [],
					reviewerResponses: [],
				});
			}
		}
		// Smart context can discover related files, but it must never silently make
		// them editable. Only an explicit planner path or the dependency-manifest
		// rule above gives a feature ownership of an existing file.
		return { tasks, currentTask: 0, reviewerIndex: 0 };
	}

	private _prepareWorkflowSteps(message: IChatMessage, workflow: IAgentWorkflow): void {
		for (const task of workflow.tasks) {
			const suffix = ` · ${task.title}`;
			const files = task.paths.length ? task.paths : task.targets.map(target => target.displayPath);
			this._setAgentStep(message, 'implementer', 'queued', localize('localAISubagentQueued', "Waiting for isolated feature context."), files, `${task.id}:implementer`, `${this._agentStageName('implementer')}${suffix}`);
			this._setAgentStep(message, 'reviewer', 'queued', localize('localAISafetyReviewerQueued', "Waiting to review structure and safety."), files, `${task.id}:reviewer:safety`, `${this._agentStageName('reviewer')} · Safety${suffix}`);
			this._setAgentStep(message, 'reviewer', 'queued', localize('localAIContractReviewerQueued', "Waiting to review behavior and integration contracts."), files, `${task.id}:reviewer:contract`, `${this._agentStageName('reviewer')} · Contract${suffix}`);
			this._setAgentStep(message, 'tester', 'queued', localize('localAITesterQueued', "Waiting to inspect feature tests and commands."), files, `${task.id}:tester`, `${this._agentStageName('tester')}${suffix}`);
		}
		this._setAgentStep(message, 'integrationTester', 'queued', localize('localAIIntegrationTesterQueued', "Waiting for all feature reviews."), undefined, 'integration:tester', this._agentStageName('integrationTester'));
	}

	private _promptTask(task: IAgentFeatureTask): ILocalAIAgentFeatureTask {
		return {
			id: task.id,
			title: task.title,
			instruction: task.instruction,
			paths: task.paths.length ? task.paths : task.targets.map(target => target.displayPath),
			dependsOn: task.dependsOn,
			needsTests: task.needsTests,
		};
	}

	private async _startFeatureImplementer(request: IPendingAgentRequest, workflow: IAgentWorkflow): Promise<void> {
		const task = workflow.tasks[workflow.currentTask];
		const attachments = this._agentTaskAttachments(request, task);
		const context = request.context && task.targets.some(target => target.resource.toString() === request.context?.uri) ? request.context : undefined;
		await this._startAgentSubagent({
			...request,
			stepId: `${task.id}:implementer`,
			targets: task.targets,
			attachments,
			workflow,
		}, 'implementer', formatAgentFeatureImplementerMessages(context, request.instruction, this._promptTask(task), attachments, request.workspaceRoots, this._contextWindowTokens()));
	}

	private async _startFeatureReviewer(request: IPendingAgentRequest, workflow: IAgentWorkflow, kind: 'analysis' | 'repairInitial' | 'repairAfterReview'): Promise<void> {
		const task = workflow.tasks[workflow.currentTask];
		const attachments = this._agentTaskAttachments(request, task);
		if (kind !== 'analysis') {
			const stepId = `${task.id}:reviewer:repair`;
			const response = this._messages.at(-1);
			if (response?.role === 'assistant') {
				this._setAgentStep(response, 'reviewer', 'queued', localize('localAIRepairReviewerQueued', "Waiting to repair reviewer findings."), task.targets.map(target => target.displayPath), stepId, `${this._agentStageName('reviewer')} · Repair · ${task.title}`);
				this._moveAgentStepBefore(response, stepId, `${task.id}:tester`);
			}
			const concerns = kind === 'repairInitial'
				? [localize('localAIInvalidFeatureProposal', "The feature proposal was not machine-readable or structurally safe."), ...this._featureProposalErrors(task, task.candidateResponse ?? '')]
				: task.reviewerResponses;
			if (kind === 'repairInitial') {
				this._appendMalformedJavaTargetReasons(request, concerns);
			}
			const context = request.context && task.targets.some(target => target.resource.toString() === request.context?.uri) ? request.context : undefined;
			await this._startAgentSubagent({ ...request, stepId, targets: task.targets, attachments, workflow, reviewKind: kind }, 'reviewer', formatAgentRepairMessages(
				context,
				task.instruction,
				task.candidateResponse ?? '',
				concerns,
				attachments,
				request.workspaceRoots,
				this._contextWindowTokens(),
			));
			return;
		}
		const reviewKind = workflow.reviewerIndex === 0 ? 'Safety' : 'Contract';
		const stepId = `${task.id}:reviewer:${workflow.reviewerIndex === 0 ? 'safety' : 'contract'}`;
		await this._startAgentSubagent({ ...request, stepId, targets: task.targets, attachments, workflow, reviewKind: kind }, 'reviewer', formatAgentFeatureReviewerMessages(
			request.instruction,
			this._promptTask(task),
			task.candidateResponse ?? '',
			attachments,
			workflow.reviewerIndex === 0 ? [] : [localize('localAIPreviousReviewContext', "A separate safety reviewer already inspected this feature. Perform an independent {0} review.", reviewKind)],
			this._contextWindowTokens(),
		));
	}

	private async _startFeatureTester(request: IPendingAgentRequest, workflow: IAgentWorkflow): Promise<void> {
		const task = workflow.tasks[workflow.currentTask];
		const attachments = this._agentTaskAttachments(request, task);
		await this._startAgentSubagent({ ...request, stepId: `${task.id}:tester`, targets: task.targets, attachments, workflow }, 'tester', formatAgentTesterMessages(
			request.instruction,
			this._promptTask(task),
			task.candidateResponse ?? '',
			attachments,
			this._availableTestCommands(request.workspaceRoots),
			this._contextWindowTokens(),
		));
	}

	private _availableTestCommands(roots: readonly ILocalAIWorkspaceRootContext[]): string[] {
		const files = roots.flatMap(root => root.files).map(file => file.toLowerCase());
		const commands: string[] = [];
		if (files.some(file => file.endsWith('pom.xml'))) { commands.push('./mvnw test', 'mvn test'); }
		if (files.some(file => /(^|\/)build\.gradle(?:\.kts)?$/.test(file))) { commands.push('./gradlew test'); }
		if (files.some(file => file.endsWith('package.json'))) { commands.push('pnpm test', 'npm test'); }
		if (files.some(file => /(^|\/)(pyproject\.toml|pytest\.ini)$/.test(file))) { commands.push('pytest'); }
		return commands.slice(0, 6);
	}

	private _featureProposalErrors(task: IAgentFeatureTask, candidateResponse: string): string[] {
		const parsed = parseLocalAIAgentResponse(candidateResponse, task.targets.map(target => ({ id: target.resource.toString(), displayPath: target.displayPath, originalText: target.originalText })), task.instruction);
		if (this._candidateStateAlreadyPresent(task, candidateResponse)) {
			return [];
		}
		const errors = [...parsed.errors];
		for (const file of parsed.files) {
			const target = task.targets.find(target => target.resource.toString() === file.targetId);
			if (!target) {
				continue;
			}
			const validation = validateLocalAIAgentProposal(target.originalText, file.content, task.instruction, target.displayPath);
			if (!validation.safe) {
				errors.push(`${target.displayPath}: ${validation.reason ?? localize('localAIAgentUnsafeChange', "the proposal could damage existing code.")}`);
			}
		}
		const ownedCreates = parsed.creates.filter(create => this._taskOwnsCreate(task, create.uri));
		if (!parsed.files.length && !ownedCreates.length && !task.satisfiedWithoutChanges && !this._candidateStateAlreadyPresent(task, candidateResponse) && !errors.length) {
			errors.push(localize('localAIAgentNoMachineEdits', "The implementer returned no machine-readable file operations."));
		}
		return errors;
	}

	private _taskOwnsCreate(task: IAgentFeatureTask, uri: string): boolean {
		if (task.targets.some(target => target.resource.toString() === uri)) {
			return false;
		}
		let normalized = uri.replaceAll('\\', '/').toLowerCase();
		try {
			normalized = decodeURIComponent(URI.parse(uri).path).replaceAll('\\', '/').toLowerCase();
		} catch {
			// Keep the original normalized value for malformed model output.
		}
		return task.paths.some(path => {
			const expected = path.replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase();
			return normalized === expected || normalized.endsWith(`/${expected}`);
		});
	}

	private _candidateStateAlreadyPresent(task: IAgentFeatureTask, candidateResponse: string): boolean {
		if (!/\bdependenc(?:y|ies)\b/i.test(task.instruction)) {
			return false;
		}
		const searchBlocks = [...candidateResponse.matchAll(/<search>([\s\S]*?)<\/search>/gi)]
			.map(match => match[1])
			.filter(block => /<dependency\b/i.test(block));
		const dependencySource = searchBlocks.length ? searchBlocks.join('\n') : candidateResponse;
		const dependencies = [...dependencySource.matchAll(/<dependency\b[\s\S]*?<groupId>\s*([^<]+?)\s*<\/groupId>[\s\S]*?<artifactId>\s*([^<]+?)\s*<\/artifactId>[\s\S]*?<\/dependency>/gi)]
			.map(match => ({ groupId: match[1].trim(), artifactId: match[2].trim() }));
		if (!dependencies.length) {
			return false;
		}
		const originals = task.targets.map(target => target.originalText).join('\n');
		return dependencies.every(dependency => {
			const group = `<groupId>${dependency.groupId}</groupId>`;
			const artifact = `<artifactId>${dependency.artifactId}</artifactId>`;
			return originals.includes(group) && originals.includes(artifact);
		});
	}

	private _normalizedFeatureResponse(task: IAgentFeatureTask, candidateResponse: string): string {
		const parsed = parseLocalAIAgentResponse(candidateResponse, task.targets.map(target => ({ id: target.resource.toString(), displayPath: target.displayPath, originalText: target.originalText })), task.instruction);
		const files = parsed.files.flatMap(file => {
			const target = task.targets.find(candidate => candidate.resource.toString() === file.targetId);
			return target ? [`<file uri="${this._escapeAgentAttribute(file.targetId)}">${this._agentCdata(file.content)}</file>`] : [];
		});
		const creates = parsed.creates
			.filter(create => this._taskOwnsCreate(task, create.uri))
			.map(create => `<create uri="${this._escapeAgentAttribute(create.uri)}">${this._agentCdata(create.content)}</create>`);
		return `<local_ai_agent_response>\n<summary>${this._agentCdata(parsed.summary || task.title)}</summary>\n<changes>\n${[...files, ...creates].join('\n')}\n</changes>\n</local_ai_agent_response>`;
	}

	private async _advanceFeatureWorkflow(agentRequest: IPendingAgentRequest, workflow: IAgentWorkflow, response: IChatMessage): Promise<void> {
		workflow.currentTask++;
		workflow.reviewerIndex = 0;
		if (workflow.currentTask < workflow.tasks.length) {
			await this._startFeatureImplementer(agentRequest, workflow);
		} else if (workflow.tasks.length === 1) {
			this._setAgentStep(response, 'integrationTester', 'completed', localize('localAIIntegrationTesterNotRequired', "Cross-feature testing is not required for a single feature; the focused Tester completed validation."), undefined, 'integration:tester');
			this._setInputEnabled(true);
			await this._stageAgentResponse(agentRequest.requestId, this._combinedWorkflowResponse(workflow), response);
		} else {
			await this._startIntegrationTester(agentRequest, workflow);
		}
	}

	private async _startIntegrationTester(request: IPendingAgentRequest, workflow: IAgentWorkflow): Promise<void> {
		const invalidTask = workflow.tasks.find(task => this._featureProposalErrors(task, task.candidateResponse ?? task.implementerResponse ?? '').length > 0);
		if (invalidTask) {
			const response = this._messages.at(-1);
			if (response?.role === 'assistant') {
				this._setAgentStep(response, 'integrationTester', 'failed', localize('localAIIntegrationTesterInvalidFeature', "Integration was not run because {0} did not produce a safe proposal.", invalidTask.title), undefined, 'integration:tester');
				this._abortAgentWorkflow(response, localize('localAIAgentUnsafeFeatureStopped', "Agent stopped because {0} could not produce a safe change. No partial changes were staged.", invalidTask.title));
			}
			return;
		}
		const targets = [...new Map(workflow.tasks.flatMap(task => task.targets).map(target => [target.resource.toString(), target])).values()].slice(0, maximumAttachedFiles);
		const attachments = this._agentTargetAttachments(request, targets);
		const task: ILocalAIAgentFeatureTask = {
			id: 'integration',
			title: localize('localAIIntegrationTaskTitle', "Cross-feature integration"),
			instruction: localize('localAIIntegrationTaskInstruction', "Check cross-feature contracts, build risks, and the smallest relevant integration test commands for the complete requested change."),
			paths: targets.map(target => target.displayPath),
			dependsOn: workflow.tasks.map(task => task.id),
			needsTests: true,
		};
		await this._startAgentSubagent({ ...request, stepId: 'integration:tester', targets, attachments, workflow }, 'integrationTester', formatAgentTesterMessages(
			request.instruction,
			task,
			this._combinedWorkflowResponse(workflow),
			attachments,
			this._availableTestCommands(request.workspaceRoots),
			this._contextWindowTokens(),
		));
	}

	private _escapeAgentAttribute(value: string): string {
		return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
	}

	private _agentCdata(value: string): string {
		return `<![CDATA[${value.replaceAll(']]>', ']]]]><![CDATA[>')}]]>`;
	}

	private _combinedWorkflowResponse(workflow: IAgentWorkflow): string {
		const files = new Map<string, { content: string; displayPath: string }>();
		const creates = new Map<string, string>();
		for (const task of workflow.tasks) {
			const candidate = task.candidateResponse ?? task.implementerResponse ?? '';
			const parsed = parseLocalAIAgentResponse(candidate, task.targets.map(target => ({ id: target.resource.toString(), displayPath: target.displayPath, originalText: target.originalText })), task.instruction);
			for (const file of parsed.files) {
				const target = task.targets.find(target => target.resource.toString() === file.targetId);
				if (target && !files.has(file.targetId)) {
					files.set(file.targetId, { content: file.content, displayPath: target.displayPath });
				}
			}
			for (const create of parsed.creates) {
				if (this._taskOwnsCreate(task, create.uri) && !creates.has(create.uri)) {
					creates.set(create.uri, create.content);
				}
			}
		}
		const changes = [
			...[...files].map(([uri, file]) => `<file uri="${this._escapeAgentAttribute(uri)}">${this._agentCdata(file.content)}</file>`),
			...[...creates].map(([uri, content]) => `<create uri="${this._escapeAgentAttribute(uri)}">${this._agentCdata(content)}</create>`),
		].join('\n');
		return `<local_ai_agent_response>\n<summary>${this._agentCdata(localize('localAIMultiFeatureSummary', "Prepared and reviewed {0} feature task(s).", workflow.tasks.length))}</summary>\n<changes>\n${changes}\n</changes>\n</local_ai_agent_response>`;
	}

	private async _targetsFromPlanner(request: IPendingAgentRequest, plannerResponse: string): Promise<IAgentTarget[]> {
		const targets = [...request.targets];
		const seen = new Set(targets.map(target => target.resource.toString()));
		const plan = `${request.instruction}\n${plannerResponse}`.toLowerCase();
		for (const root of request.workspaceRoots) {
			for (const file of root.files) {
				if (targets.length >= maximumAttachedFiles) {
					return targets;
				}
				const normalizedPath = file.replaceAll('\\', '/');
				const fileName = basename(URI.file(normalizedPath));
				if (!plan.includes(normalizedPath.toLowerCase()) && !plan.includes(fileName.toLowerCase())) {
					continue;
				}
				const resource = joinPath(URI.parse(root.uri), normalizedPath);
				if (seen.has(resource.toString())) {
					continue;
				}
				try {
					const reference = await this._textModelService.createModelReference(resource);
					try {
						targets.push({
							resource,
							displayPath: normalizedPath,
							originalText: reference.object.textEditorModel.getValue(),
						});
						seen.add(resource.toString());
					} finally {
						reference.dispose();
					}
				} catch {
					// A stale planner path is ignored; the implementer still receives every
					// successfully resolved target and the bounded workspace outline.
				}
			}
		}
		return targets;
	}

	private _agentTargetAttachments(request: IPendingAgentRequest, targets: readonly IAgentTarget[]): ILocalAIAttachment[] {
		const combined = new Map<string, ILocalAIAttachment>();
		for (const target of targets) {
			combined.set(target.resource.toString(), {
				uri: target.resource.toString(),
				name: target.displayPath,
				content: target.originalText,
			});
		}
		// Feature subagents receive editable targets plus explicitly ranked read-only
		// references; only request.targets are accepted by the edit parser.
		// Falling back to the request attachments is reserved for legacy/single-stage
		// calls that do not yet have resolved targets.
		if (!targets.length) {
			for (const attachment of request.attachments) {
				combined.set(attachment.uri, attachment);
			}
		}
		return [...combined.values()].slice(0, maximumAttachedFiles);
	}

	private _agentTaskAttachments(request: IPendingAgentRequest, task: IAgentFeatureTask): ILocalAIAttachment[] {
		const contextTargets = [...new Map([...task.targets, ...task.references].map(target => [target.resource.toString(), target])).values()];
		return this._agentTargetAttachments(request, contextTargets);
	}

	private async _handleRequestTimeout(): Promise<void> {
		const requestId = this._activeRequestId;
		if (!requestId) {
			return;
		}

		const agentRequest = this._pendingAgentRequest;
		const response = this._messages.at(-1);
		this._activeRequestId = undefined;
		this._activeAgentResponse = '';
		this._renderScheduler.cancel();
		try {
			await this._localLLMService.cancelRequest(requestId);
		} catch {
			// The local server may already have completed or disconnected. The UI must
			// still leave its running state and hand control back to the user.
		}

		if (response?.role === 'assistant' && agentRequest?.stage === 'integrationTester' && agentRequest.workflow) {
			this._setAgentStep(response, 'integrationTester', 'handedOff', localize('localAIIntegrationTesterTimedOut', "Integration review stopped after the model produced no output before its context-aware timeout. Feature-level validation completed, so the prepared changes are available for review."), undefined, agentRequest.stepId);
			response.content = localize('localAIIntegrationTesterTimedOutSummary', "Integration review timed out; prepared changes passed feature-level review and are ready for your review.");
			this._setInputEnabled(true);
			await this._stageAgentResponse(requestId, this._combinedWorkflowResponse(agentRequest.workflow), response);
			return;
		}

		this._pendingAgentRequest = undefined;
		this._setInputEnabled(true);
		if (response?.role === 'assistant') {
			if (agentRequest) {
				this._setAgentStep(response, agentRequest.stage, 'failed', localize('localAISubagentTimedOutDetail', "Stopped after the model produced no output before its context-aware timeout."), undefined, agentRequest.stepId);
				this._skipUnfinishedAgentSteps(response, localize('localAISubagentSkippedAfterTimeout', "Not run because the active subagent timed out."));
			}
			response.content = localize('localAIRequestTimedOut', "The local model stopped responding. You can retry the request or choose a smaller model context.");
		}
		this._emitActivity();
		this._storeHistory();
		this._renderMessages();
		this._notificationService.warn(localize('localAIRequestTimedOut', "The local model stopped responding. You can retry the request or choose a smaller model context."));
	}

	private _handleWorkflowError(error: unknown): void {
		this._requestWatchdog.cancel();
		this._activeRequestId = undefined;
		this._activeAgentResponse = '';
		const agentRequest = this._pendingAgentRequest;
		this._pendingAgentRequest = undefined;
		const response = this._messages.at(-1);
		const message = error instanceof Error ? error.message : String(error);
		if (response?.role === 'assistant') {
			if (agentRequest) {
				this._setAgentStep(response, agentRequest.stage, 'failed', localize('localAISubagentFailedDetail', "Failed: {0}", message), undefined, agentRequest.stepId);
				this._skipUnfinishedAgentSteps(response, localize('localAISubagentSkippedAfterFailure', "Not run because the active subagent failed."));
			}
			response.content = localize('localAIWorkflowError', "Agent workflow could not finish: {0}", message);
		}
		this._setInputEnabled(true);
		this._emitActivity();
		this._storeHistory();
		this._renderMessages();
		this._notificationService.error(localize('localAIWorkflowError', "Agent workflow could not finish: {0}", message));
	}

	private async _stopGeneration(): Promise<void> {
		this._preparingRequest = false;
		this._requestWatchdog.cancel();
		const requestId = this._activeRequestId;
		const agentRequest = this._pendingAgentRequest;
		const response = this._messages.at(-1);
		this._activeRequestId = undefined;
		this._activeAgentResponse = '';
		this._pendingAgentRequest = undefined;
		if (requestId) {
			try {
				await this._localLLMService.cancelRequest(requestId);
			} catch {
				// Cancellation is best effort. The local server may have already ended,
				// but every visible workflow step must still leave its loading state.
			}
		}
		if (response?.role === 'assistant' && agentRequest) {
			const activeStep = response.agentSteps?.find(step => step.id === (agentRequest.stepId ?? agentRequest.stage));
			this._setAgentStep(response, agentRequest.stage, 'skipped', localize('localAISubagentStoppedByUser', "Stopped by you."), activeStep?.files, agentRequest.stepId);
			this._skipUnfinishedAgentSteps(response, localize('localAISubagentSkippedAfterStop', "Not run because the workflow was stopped."));
			response.content = localize('localAIAgentStopped', "Agent workflow stopped.");
		}
		this._setInputEnabled(true);
		this._storeHistory();
		this._renderMessages();
	}

	private async _newChat(): Promise<void> {
		if (this._pendingAgentChangeSet?.files.length) {
			const pendingCount = this._pendingAgentChangeSet.files.length;
			const { result } = await this._dialogService.prompt<'accept' | 'reject' | 'cancel'>({
				type: 'warning',
				title: localize('localAIResolveBeforeNewChatTitle', "Resolve Agent Changes"),
				message: localize('localAIResolveBeforeNewChat', "Accept or reject the pending Agent changes before starting a new chat."),
				detail: localize('localAIResolveBeforeNewChatDetail', "Agent has changes waiting for review in {0} file(s).", pendingCount),
				buttons: [{
					label: localize('localAIAcceptAndNewChat', "Accept Changes && Start New Chat"),
					run: () => 'accept',
				}, {
					label: localize('localAIRejectAndNewChat', "Reject Changes && Start New Chat"),
					run: () => 'reject',
				}],
				cancelButton: {
					label: localize('localAIKeepReviewing', "Keep Reviewing"),
					run: () => 'cancel',
				},
			});
			if (result === 'cancel') {
				this._focusPendingChangeReview();
				return;
			}
			if (result === 'accept') {
				await this._acceptAllAgentChanges();
			} else {
				await this._rejectAllAgentChanges();
			}
			if (this._pendingAgentChangeSet?.files.length) {
				this._notificationService.warn(localize('localAIResolveChangesFailed', "Some Agent changes still need review before a new chat can start."));
				this._focusPendingChangeReview();
				await this._openAgentDiff(this._pendingAgentChangeSet.files[0]);
				return;
			}
		}
		await this._stopGeneration();
		this._messages.length = 0;
		this._pendingAttachments.length = 0;
		this._recentAgentResources = [];
		this._storageService.remove(this._historyStorageKey, StorageScope.WORKSPACE);
		this._renderAttachments();
		this._renderMessages();
		this._input?.focus();
	}

	private _focusPendingChangeReview(): void {
		this._renderMessages();
		const review = this._messagesContainer?.querySelector<HTMLElement>('.local-ai-change-set');
		review?.scrollIntoView({ block: 'nearest' });
		review?.querySelector<HTMLButtonElement>('.local-ai-change-set-actions .local-ai-button:not(.secondary)')?.focus();
	}

	private async _handleStreamEnd(requestId: string, error: string | undefined): Promise<void> {
		if (requestId !== this._activeRequestId) {
			return;
		}
		this._requestWatchdog.cancel();

		const response = this._messages.at(-1);
		const agentResponse = this._activeAgentResponse;
		const agentRequest = this._pendingAgentRequest;
		this._activeRequestId = undefined;
		this._activeAgentResponse = '';
		this._renderScheduler.cancel();
		if (error) {
			this._setInputEnabled(true);
			if (response?.role === 'assistant') {
				if (agentRequest) {
					this._setAgentStep(response, agentRequest.stage, 'failed', localize('localAISubagentFailedDetail', "Failed: {0}", error), undefined, agentRequest.stepId);
					this._skipUnfinishedAgentSteps(response, localize('localAISubagentSkippedAfterFailure', "Not run because the active subagent failed."));
				}
				response.content = localize('localAIResponseError', "Local model error: {0}", error);
			}
			this._pendingAgentRequest = undefined;
		} else if (response?.role === 'assistant' && response.mode === 'agent' && agentRequest?.requestId === requestId) {
			if (agentRequest.stage === 'planner') {
				const targets = await this._targetsFromPlanner(agentRequest, agentResponse);
				const workflow = this._featureTasksFromPlanner(agentRequest, agentResponse, targets);
				this._setAgentStep(response, 'planner', 'completed', localize('localAIAgentPlannerSplit', "Split the request into {0} focused feature task(s) across {1} file(s).", workflow.tasks.length, targets.length), targets.map(target => target.displayPath));
				this._prepareWorkflowSteps(response, workflow);
				await this._startFeatureImplementer({ ...agentRequest, targets, plannerResponse: agentResponse, workflow }, workflow);
				return;
			}

			if (agentRequest.stage === 'implementer') {
				const workflow = agentRequest.workflow;
				const task = workflow?.tasks[workflow.currentTask];
				if (!workflow || !task) {
					this._setAgentStep(response, 'implementer', 'failed', localize('localAIAgentWorkflowMissing', "The feature workflow state was unavailable."), undefined, agentRequest.stepId);
					response.content = localize('localAIAgentWorkflowMissing', "The feature workflow state was unavailable.");
					this._setInputEnabled(true);
					return;
				}
				task.implementerResponse = agentResponse;
				const errors = this._featureProposalErrors(task, agentResponse);
				if (errors.length) {
					task.candidateResponse = agentResponse;
					this._appendMalformedJavaTargetReasons(agentRequest, errors);
					this._setAgentStep(response, 'implementer', 'handedOff', localize('localAIAgentImplementerHandedOffWithReason', "Proposal required repair: {0}", errors[0]), task.targets.map(target => target.displayPath), agentRequest.stepId);
					await this._startFeatureReviewer(agentRequest, workflow, 'repairInitial');
				} else {
					task.satisfiedWithoutChanges = this._candidateStateAlreadyPresent(task, agentResponse)
						&& !parseLocalAIAgentResponse(agentResponse, task.targets.map(target => ({ id: target.resource.toString(), displayPath: target.displayPath, originalText: target.originalText })), task.instruction).files.length;
					task.candidateResponse = this._normalizedFeatureResponse(task, agentResponse);
					this._setAgentStep(response, 'implementer', 'completed', task.satisfiedWithoutChanges
						? localize('localAIAgentImplementerAlreadySatisfied', "The requested state is already present; no edit is required.")
						: localize('localAIAgentImplementerCompleted', "Prepared a machine-readable feature proposal."), task.targets.map(target => target.displayPath), agentRequest.stepId);
					if (task.satisfiedWithoutChanges) {
						this._setAgentStep(response, 'reviewer', 'skipped', localize('localAISubagentAlreadySatisfied', "Not required because the requested state is already present."), task.targets.map(target => target.displayPath), `${task.id}:reviewer:safety`);
						this._setAgentStep(response, 'reviewer', 'skipped', localize('localAISubagentAlreadySatisfied', "Not required because the requested state is already present."), task.targets.map(target => target.displayPath), `${task.id}:reviewer:contract`);
						this._setAgentStep(response, 'tester', 'skipped', localize('localAISubagentAlreadySatisfied', "Not required because the requested state is already present."), task.targets.map(target => target.displayPath), `${task.id}:tester`);
						await this._advanceFeatureWorkflow(agentRequest, workflow, response);
						return;
					}
					workflow.reviewerIndex = 0;
					await this._startFeatureReviewer(agentRequest, workflow, 'analysis');
				}
				return;
			}

			if (agentRequest.stage === 'reviewer') {
				const workflow = agentRequest.workflow;
				const task = workflow?.tasks[workflow.currentTask];
				if (!workflow || !task) {
					this._setInputEnabled(true);
					return;
				}
				if (agentRequest.reviewKind === 'repairInitial' || agentRequest.reviewKind === 'repairAfterReview') {
					const errors = this._featureProposalErrors(task, agentResponse);
					task.candidateResponse = errors.length ? agentResponse : this._normalizedFeatureResponse(task, agentResponse);
					this._setAgentStep(response, 'reviewer', errors.length ? 'failed' : 'completed', errors.length
						? localize('localAIRepairReviewerFailedWithReason', "The repair response was still unsafe: {0}", errors[0])
						: localize('localAIRepairReviewerCompleted', "Repaired the feature proposal for validation."), task.targets.map(target => target.displayPath), agentRequest.stepId);
					if (errors.length) {
						this._abortAgentWorkflow(response, localize('localAIAgentRepairFailedStopped', "Agent stopped because it could not safely repair {0}. No partial changes were staged.", task.title));
						return;
					}
					if (agentRequest.reviewKind === 'repairInitial') {
						workflow.reviewerIndex = 0;
						await this._startFeatureReviewer(agentRequest, workflow, 'analysis');
					} else {
						await this._startFeatureTester(agentRequest, workflow);
					}
					return;
				}
				task.reviewerResponses.push(agentResponse);
				this._setAgentStep(response, 'reviewer', 'completed', /verdict\s*=\s*["']changes_required["']/i.test(agentResponse)
					? localize('localAIReviewerFoundIssues', "Completed review and reported changes to repair.")
					: localize('localAIReviewerApproved', "Completed an independent focused review."), task.targets.map(target => target.displayPath), agentRequest.stepId);
				workflow.reviewerIndex++;
				if (workflow.reviewerIndex < 2) {
					await this._startFeatureReviewer(agentRequest, workflow, 'analysis');
				} else if (task.reviewerResponses.some(review => /verdict\s*=\s*["']changes_required["']/i.test(review))) {
					await this._startFeatureReviewer(agentRequest, workflow, 'repairAfterReview');
				} else {
					await this._startFeatureTester(agentRequest, workflow);
				}
				return;
			}

			if (agentRequest.stage === 'tester') {
				const workflow = agentRequest.workflow;
				const task = workflow?.tasks[workflow.currentTask];
				if (!workflow || !task) {
					this._setInputEnabled(true);
					return;
				}
				task.testerResponse = agentResponse;
				const blocked = /status\s*=\s*["']blocked["']/i.test(agentResponse);
				this._setAgentStep(response, 'tester', blocked ? 'handedOff' : 'completed', blocked
					? localize('localAITesterBlocked', "Static test review found a blocker; deterministic validation will decide staging.")
					: localize('localAITesterCompleted', "Prepared the focused static test plan and commands."), task.targets.map(target => target.displayPath), agentRequest.stepId);
				await this._advanceFeatureWorkflow(agentRequest, workflow, response);
				return;
			}

			if (agentRequest.stage === 'integrationTester') {
				const workflow = agentRequest.workflow;
				if (!workflow) {
					this._setInputEnabled(true);
					return;
				}
				const blocked = /status\s*=\s*["']blocked["']/i.test(agentResponse);
				this._setAgentStep(response, 'integrationTester', blocked ? 'handedOff' : 'completed', blocked
					? localize('localAIIntegrationTesterBlocked', "Integration test review reported risks; deterministic validation will enforce safety.")
					: localize('localAIIntegrationTesterCompleted', "Completed the cross-feature static test review."), undefined, agentRequest.stepId);
				this._setInputEnabled(true);
				await this._stageAgentResponse(requestId, this._combinedWorkflowResponse(workflow), response);
				return;
			}
		} else {
			this._setInputEnabled(true);
		}
		this._storeHistory();
		this._renderMessages();
	}

	private async _collectAgentTargets(attachments: readonly ILocalAIAttachment[]): Promise<IAgentTarget[]> {
		const editor = getCodeEditor(this._editorService.activeTextEditorControl);
		const model = editor?.getModel();
		const targets: IAgentTarget[] = [];
		if (model && !(model.uri.scheme === Schemas.untitled && !model.getValue().trim())) {
			targets.push({
				resource: model.uri,
				displayPath: this._workspaceRelativePath(model.uri),
				originalText: model.getValue(),
			});
		}
		for (const attachment of attachments) {
			const resource = URI.parse(attachment.uri);
			if (targets.some(target => target.resource.toString() === resource.toString())) {
				continue;
			}
			try {
				const reference = await this._textModelService.createModelReference(resource);
				try {
					targets.push({
						resource,
						displayPath: attachment.name,
						originalText: reference.object.textEditorModel.getValue(),
					});
				} finally {
					reference.dispose();
				}
			} catch (error) {
				this._notificationService.warn(localize('localAIAgentTargetReadError', "Agent cannot edit {0}: {1}", attachment.name, error instanceof Error ? error.message : String(error)));
			}
		}
		return targets;
	}

	private async _stageAgentResponse(requestId: string, rawResponse: string, response: IChatMessage): Promise<void> {
		const request = this._pendingAgentRequest;
		this._pendingAgentRequest = undefined;
		if (!request || request.requestId !== requestId) {
			return;
		}

		const parsed = parseLocalAIAgentResponse(rawResponse, request.targets.map(target => ({
			id: target.resource.toString(),
			displayPath: target.displayPath,
			originalText: target.originalText,
		})), request.instruction);
		const rejectionReasons = [...parsed.errors];
		response.content = parsed.summary || localize('localAIAgentPreparedChanges', "Agent prepared changes for review.");
		if (parsed.errors.length) {
			this._notificationService.warn(localize('localAIAgentInvalidEdits', "Some Agent edits could not be applied safely: {0}", parsed.errors.slice(0, 3).join(' ')));
		}
		const changes: IPendingAgentFileChange[] = [];
		const stagedResources = new Set<string>();
		for (const file of parsed.files) {
			const target = request.targets.find(candidate => candidate.resource.toString() === file.targetId);
			if (!target || stagedResources.has(target.resource.toString())) {
				continue;
			}
			if (file.content === target.originalText) {
				continue;
			}
			const validation = validateLocalAIAgentProposal(target.originalText, file.content, request.instruction, target.displayPath);
			if (!validation.safe) {
				rejectionReasons.push(`${target.displayPath}: ${validation.reason ?? localize('localAIAgentUnsafeChange', "the proposal could damage existing code.")}`);
				this._notificationService.warn(localize(
					'localAIAgentDestructiveEditRejected',
					"Skipped unsafe changes to {0}: {1}",
					target.displayPath,
					validation.reason ?? localize('localAIAgentUnsafeChange', "the proposal could damage existing code."),
				));
				continue;
			}
			try {
				const reference = await this._textModelService.createModelReference(target.resource);
				const model = reference.object.textEditorModel;
				if (model.getValue() !== target.originalText) {
					reference.dispose();
					rejectionReasons.push(localize('localAIAgentFileChangedReason', "{0} changed while the subagents were working.", target.displayPath));
					this._notificationService.warn(localize('localAIAgentFileChanged', "{0} changed while Agent was working and was skipped.", target.displayPath));
					continue;
				}
				const originalReference = await this._textModelService.createSyntheticDocument(
					target.originalText,
					this._languageService.createById(model.getLanguageId()),
				);
				const lineChanges = this._computeLineChanges(target.originalText, file.content);
				model.pushStackElement();
				model.pushEditOperations(null, [{ range: model.getFullModelRange(), text: file.content }], () => null);
				model.pushStackElement();
				this._agentChangeReferences.add(reference);
				this._agentChangeReferences.add(originalReference);
				changes.push({
					target,
					proposedText: file.content,
					reference,
					originalReference,
					appliedVersionId: model.getVersionId(),
					addedLines: lineChanges.added,
					removedLines: lineChanges.removed,
				});
				stagedResources.add(target.resource.toString());
			} catch (error) {
				rejectionReasons.push(`${target.displayPath}: ${error instanceof Error ? error.message : String(error)}`);
				this._notificationService.error(localize('localAIAgentApplyError', "Unable to prepare changes for {0}: {1}", target.displayPath, error instanceof Error ? error.message : String(error)));
			}
		}

		const workspaceFolders = this._workspaceContextService.getWorkspace().folders;
		for (const create of parsed.creates.slice(0, maximumAutoDetectedFiles)) {
			let resource: URI;
			try {
				resource = URI.parse(create.uri);
			} catch {
				this._notificationService.warn(localize('localAIAgentInvalidCreateUri', "Skipped an invalid new-file URI: {0}", create.uri));
				continue;
			}
			const workspaceFolder = workspaceFolders.find(folder => extUri.isEqualOrParent(resource, folder.uri) && !isEqual(resource, folder.uri));
			if (!workspaceFolder) {
				rejectionReasons.push(localize('localAIAgentCreateOutsideWorkspaceReason', "New file URI is outside the workspace: {0}", create.uri));
				this._notificationService.warn(localize('localAIAgentCreateOutsideWorkspace', "Skipped new file outside the workspace: {0}", create.uri));
				continue;
			}
			if (create.content.length > 256 * 1024 || create.content.includes('\0')) {
				rejectionReasons.push(localize('localAIAgentCreateInvalidContentReason', "New file content is invalid or oversized: {0}", this._workspaceRelativePath(resource)));
				this._notificationService.warn(localize('localAIAgentCreateInvalidContent', "Skipped invalid or oversized content for {0}.", this._workspaceRelativePath(resource)));
				continue;
			}
			if (await this._fileService.exists(resource)) {
				rejectionReasons.push(localize('localAIAgentCreateExistsReason', "The requested new file already exists: {0}", this._workspaceRelativePath(resource)));
				this._notificationService.warn(localize('localAIAgentCreateExists', "Skipped creating {0} because it already exists.", this._workspaceRelativePath(resource)));
				continue;
			}

			let created = false;
			try {
				await this._fileService.createFolder(dirname(resource));
				await this._fileService.writeFile(resource, VSBuffer.fromString(create.content));
				created = true;
				const reference = await this._textModelService.createModelReference(resource);
				const model = reference.object.textEditorModel;
				const originalReference = await this._textModelService.createSyntheticDocument('', this._languageService.createById(model.getLanguageId()));
				const lineChanges = this._computeLineChanges('', create.content);
				const target: IAgentTarget = {
					resource,
					displayPath: this._workspaceRelativePath(resource),
					originalText: '',
				};
				this._agentChangeReferences.add(reference);
				this._agentChangeReferences.add(originalReference);
				changes.push({
					target,
					proposedText: create.content,
					reference,
					originalReference,
					appliedVersionId: model.getVersionId(),
					addedLines: lineChanges.added,
					removedLines: 0,
					created: true,
				});
			} catch (error) {
				if (created) {
					await this._fileService.del(resource).catch(() => undefined);
				}
				rejectionReasons.push(`${this._workspaceRelativePath(resource)}: ${error instanceof Error ? error.message : String(error)}`);
				this._notificationService.error(localize('localAIAgentCreateError', "Unable to prepare new file {0}: {1}", this._workspaceRelativePath(resource), error instanceof Error ? error.message : String(error)));
			}
		}

		if (!changes.length) {
			if (request.stage === 'implementer') {
				const errors = rejectionReasons.length ? rejectionReasons : [localize('localAIAgentNoMachineEdits', "The implementer returned no machine-readable file operations.")];
				this._appendMalformedJavaTargetReasons(request, errors);
				this._setAgentStep(response, 'implementer', 'handedOff', localize('localAIAgentImplementerHandedOff', "Proposal required repair; handed off to Reviewer."), request.targets.map(target => target.displayPath));
				const attachments = this._agentTargetAttachments(request, request.targets);
				await this._startAgentSubagent({ ...request, attachments }, 'reviewer', formatAgentRepairMessages(
					request.context,
					request.instruction,
					rawResponse,
					errors,
					attachments,
					request.workspaceRoots,
					this._contextWindowTokens(),
				));
				return;
			}
			const reason = rejectionReasons.slice(0, 3).join(' ') || localize('localAIAgentNoMachineEdits', "The reviewer returned no machine-readable file operations.");
			this._setAgentStep(response, request.stage, 'failed', localize('localAIAgentReviewerFailed', "Could not produce a safe change set."), request.targets.map(target => target.displayPath), request.stepId);
			response.content = localize('localAIAgentNoEditWithReason', "No changes were applied. Reviewer result: {0}", reason);
			this._notificationService.warn(localize('localAIAgentNoEditWithReason', "No changes were applied. Reviewer result: {0}", reason));
			this._emitActivity();
			this._storeHistory();
			this._renderMessages();
			return;
		}
		this._setAgentStep(response, request.stage, 'completed', request.stage === 'integrationTester'
			? localize('localAIAgentWorkflowCompleted', "Completed subagent validation and prepared a safe change set for review.")
			: request.stage === 'reviewer'
				? localize('localAIAgentReviewerCompleted', "Validated a safe change set for review.")
				: localize('localAIAgentImplementerCompleted', "Prepared a safe change set for review."), changes.map(change => change.target.displayPath), request.stepId);
		this._recentAgentResources = [...new Map([...this._recentAgentResources, ...changes.map(change => change.target.resource)].map(resource => [resource.toString(), resource])).values()];
		this._pendingAgentChangeSet = { summary: response.content, message: response, files: changes };
		this._emitActivity();
		this._storeHistory();
		this._renderMessages();
		await this._openAgentDiff(changes[0]);
	}

	private _appendMalformedJavaTargetReasons(request: IPendingAgentRequest, errors: string[]): void {
		for (const target of request.targets) {
			if (!target.displayPath.toLowerCase().endsWith('.java')) {
				continue;
			}
			const baseline = validateLocalAIAgentProposal(target.originalText, target.originalText, '', target.displayPath);
			if (!baseline.safe) {
				const reason = localize('localAIMalformedJavaTarget', "Existing Java target is structurally invalid: {0}. Return exactly one complete <file> repair for this URI: {1}", baseline.reason ?? target.displayPath, target.resource.toString());
				if (!errors.includes(reason)) {
					errors.unshift(reason);
				}
			}
		}
	}

	private _computeLineChanges(originalText: string, proposedText: string): { added: number; removed: number } {
		const diff = linesDiffComputers.getDefault().computeDiff(
			originalText.split(/\r?\n/),
			proposedText.split(/\r?\n/),
			{ ignoreTrimWhitespace: false, maxComputationTimeMs: 500, computeMoves: false },
		);
		let added = 0;
		let removed = 0;
		for (const change of diff.changes) {
			added += change.modified.length;
			removed += change.original.length;
		}
		return { added, removed };
	}

	private async _openAgentDiff(change: IPendingAgentFileChange): Promise<void> {
		await this._editorService.openEditor({
			original: { resource: change.originalReference.object.textEditorModel.uri },
			modified: { resource: change.target.resource },
			label: localize('localAIAgentDiffLabel', "{0} — Orbyte Changes", change.target.displayPath),
			options: { pinned: true },
		});
	}

	private _renderModelManager(): void {
		if (!this._messagesContainer || !this._modelCatalog) {
			return;
		}

		const catalog = this._modelCatalog;
		const manager = dom.append(this._messagesContainer, dom.$('.local-ai-model-manager'));
		const header = dom.append(manager, dom.$('.local-ai-model-manager-header'));
		const heading = dom.append(header, dom.$('.local-ai-model-manager-heading'));
		const title = dom.append(heading, dom.$('h2'));
		title.textContent = catalog.setupRequired
			? localize('localAIModelSetupTitle', "Choose your local AI model")
			: localize('localAIModelManagerTitle', "Local AI models");
		const subtitle = dom.append(heading, dom.$('p'));
		subtitle.textContent = catalog.setupRequired
			? localize('localAIModelSetupDescription', "Orbyte matched these private, on-device models to your computer. Choose one to finish setup.")
			: localize('localAIModelManagerDescription', "Switch models or download another model matched to this computer.");
		if (!catalog.setupRequired) {
			const closeButton = dom.append(header, dom.$<HTMLButtonElement>('button.local-ai-model-close.codicon.codicon-close'));
			closeButton.type = 'button';
			closeButton.title = localize('localAICloseModels', "Close model manager");
			closeButton.setAttribute('aria-label', localize('localAICloseModels', "Close model manager"));
			this._messageRenderStore.add(dom.addDisposableListener(closeButton, dom.EventType.CLICK, () => {
				this._modelManagerVisible = false;
				this._renderMessages();
			}));
		}

		const hardware = dom.append(manager, dom.$('.local-ai-hardware-card'));
		const hardwareIcon = dom.append(hardware, dom.$('span.codicon.codicon-device-desktop'));
		hardwareIcon.setAttribute('aria-hidden', 'true');
		const hardwareText = dom.append(hardware, dom.$('.local-ai-hardware-text'));
		const hardwareTitle = dom.append(hardwareText, dom.$('strong'));
		hardwareTitle.textContent = localize('localAIHardwareDetected', "Detected: {0}", catalog.hardware.cpuModel);
		const hardwareDetails = dom.append(hardwareText, dom.$('span'));
		hardwareDetails.textContent = localize(
			'localAIHardwareDetails',
			"{0} memory · {1} CPU cores · {2} · {3} free",
			this._formatBytes(catalog.hardware.memoryBytes),
			catalog.hardware.cpuCount,
			catalog.hardware.gpuAcceleration,
			this._formatBytes(catalog.hardware.freeDiskBytes),
		);

		const list = dom.append(manager, dom.$('.local-ai-model-list'));
		for (const model of catalog.models) {
			const progress = this._modelDownloads.get(model.id);
			const isDownloading = progress?.state === 'downloading' || progress?.state === 'verifying';
			const card = dom.append(list, dom.$('.local-ai-model-card'));
			card.classList.toggle('selected', model.selected && !catalog.setupRequired);
			const modelHeader = dom.append(card, dom.$('.local-ai-model-card-header'));
			const identity = dom.append(modelHeader, dom.$('.local-ai-model-identity'));
			const name = dom.append(identity, dom.$('strong'));
			name.textContent = model.name;
			const badges = dom.append(identity, dom.$('.local-ai-model-badges'));
			const sizeBadge = dom.append(badges, dom.$('span.local-ai-model-badge'));
			sizeBadge.textContent = `${model.quantization} · ${this._formatBytes(model.sizeBytes)}`;
			const contextBadge = dom.append(badges, dom.$('span.local-ai-model-badge'));
			contextBadge.textContent = model.contextWindowTokens > model.nativeContextTokens
				? localize('localAIModelExtendedContextWindow', "{0}K extended context · {1}K native", model.contextWindowTokens / 1024, model.nativeContextTokens / 1024)
				: localize('localAIModelContextWindow', "{0}K context", model.contextWindowTokens / 1024);
			const recommendationBadge = dom.append(badges, dom.$(`span.local-ai-model-badge.${model.recommendation}`));
			recommendationBadge.textContent = model.recommendation === 'recommended'
				? localize('localAIRecommendedModel', "Recommended")
				: localize('localAICompatibleModel', "Maximum · slower");

			const actionButton = dom.append(modelHeader, dom.$<HTMLButtonElement>('button.local-ai-button'));
			actionButton.type = 'button';
			if (isDownloading) {
				actionButton.classList.add('secondary');
				actionButton.textContent = localize('localAICancelDownload', "Cancel");
				this._messageRenderStore.add(dom.addDisposableListener(actionButton, dom.EventType.CLICK, () => void this._localLLMService.cancelModelDownload(model.id)));
			} else if (model.selected && !catalog.setupRequired) {
				actionButton.textContent = localize('localAIModelInUse', "In use");
				actionButton.disabled = true;
			} else if (model.installed) {
				actionButton.textContent = catalog.setupRequired
					? localize('localAIUseInstalledModel', "Use installed")
					: localize('localAIUseModel', "Use");
				actionButton.disabled = this._modelSelectionPending;
				this._messageRenderStore.add(dom.addDisposableListener(actionButton, dom.EventType.CLICK, () => void this._useModel(model)));
			} else {
				actionButton.textContent = localize('localAIDownloadAndUseModel', "Download & Use");
				actionButton.disabled = !model.canDownload;
				this._messageRenderStore.add(dom.addDisposableListener(actionButton, dom.EventType.CLICK, () => void this._downloadModel(model)));
			}

			const description = dom.append(card, dom.$('.local-ai-model-description'));
			description.textContent = model.parameters === '3B'
				? localize('localAIModel3BDescription', "Fast coding chat and edits with the best balance for this computer.")
				: model.parameters === '7B'
					? localize('localAIModel7BDescription', "Stronger code reasoning, with slower responses and higher memory use.")
					: localize('localAIModelGenericDescription', "Higher-capability local coding model for machines with more memory.");
			if (model.warning) {
				const warning = dom.append(card, dom.$('.local-ai-model-warning'));
				warning.textContent = model.warning;
			}
			if (isDownloading && progress) {
				const progressRow = dom.append(card, dom.$('.local-ai-model-progress'));
				const progressTrack = dom.append(progressRow, dom.$('.local-ai-model-progress-track'));
				const progressFill = dom.append(progressTrack, dom.$('.local-ai-model-progress-fill'));
				const percentage = progress.totalBytes > 0 ? Math.min(100, Math.round(progress.receivedBytes / progress.totalBytes * 100)) : 0;
				progressFill.style.width = `${percentage}%`;
				const progressLabel = dom.append(progressRow, dom.$('span'));
				progressLabel.textContent = progress.state === 'verifying'
					? localize('localAIVerifyingModel', "Verifying download…")
					: localize('localAIDownloadingModel', "Downloading {0}% · {1} of {2}", percentage, this._formatBytes(progress.receivedBytes), this._formatBytes(progress.totalBytes));
			} else if (progress?.state === 'error') {
				const error = dom.append(card, dom.$('.local-ai-model-warning.error'));
				error.textContent = progress.error ?? localize('localAIModelDownloadFailed', "Download failed.");
			}
		}

		const privacy = dom.append(manager, dom.$('.local-ai-model-privacy'));
		privacy.textContent = localize('localAIModelPrivacy', "Models download from the official Qwen repository and run entirely on your device. SHA-256 verification is required before use.");
	}

	private _renderMessages(): void {
		if (!this._messagesContainer) {
			return;
		}

		this._messageRenderStore.clear();
		dom.clearNode(this._messagesContainer);
		if (this._modelManagerVisible) {
			this._renderModelManager();
			return;
		}
		if (this._messages.length === 0) {
			const empty = dom.append(this._messagesContainer, dom.$('.local-ai-empty'));
			const icon = dom.append(empty, dom.$('span.local-ai-empty-icon.codicon.codicon-chat-sparkle'));
			icon.setAttribute('aria-hidden', 'true');
			const title = dom.append(empty, dom.$('h2.local-ai-empty-title'));
			title.textContent = localize('localAIEmptyTitle', "Build with Orbyte Agent");
			const caution = dom.append(empty, dom.$('div.local-ai-empty-caution'));
			caution.textContent = localize('localAIEmptyCaution', "AI responses may be inaccurate");
			const instructions = dom.append(empty, dom.$('.local-ai-empty-instructions'));
			const instructionsButton = dom.append(instructions, dom.$<HTMLButtonElement>('button.local-ai-link-button'));
			instructionsButton.type = 'button';
			instructionsButton.textContent = localize('localAIGenerateInstructions', "Generate Agent Instructions");
			instructions.append(` ${localize('localAIInstructionsSuffix', "to onboard Orbyte AI onto your codebase.")}`);
			this._messageRenderStore.add(dom.addDisposableListener(instructionsButton, dom.EventType.CLICK, () => this._prepareProjectInstructions()));
			const privacy = dom.append(empty, dom.$('.local-ai-empty-privacy'));
			privacy.textContent = localize('localAIEmptyPrivacy', "Runs locally. Your code stays in your orbit.");
			return;
		}

		for (const message of this._messages) {
			const messageElement = dom.append(this._messagesContainer, dom.$(`.local-ai-message.${message.role}`));
			const label = dom.append(messageElement, dom.$('.local-ai-message-label'));
			label.textContent = message.role === 'user'
				? localize('localAIYouWithMode', "You · {0}", this._modeLabel(message.mode ?? 'ask'))
				: localize('localAIName', "Orbyte AI");
			const body = dom.append(messageElement, dom.$('.local-ai-message-body'));
			this._renderSubagentActivity(messageElement, message);
			if (message.role === 'user') {
				body.textContent = message.content;
				if (message.attachmentNames?.length) {
					const attachments = dom.append(body, dom.$('.local-ai-message-attachments'));
					for (const name of message.attachmentNames) {
						const attachment = dom.append(attachments, dom.$('span.local-ai-attachment.readonly'));
						attachment.textContent = name;
					}
				}
			} else if (!message.content) {
				body.textContent = localize('localAIThinking', "Thinking…");
			} else {
				const rendered = this._messageRenderStore.add(this._markdownRendererService.render(new MarkdownString(message.content), {
					codeBlockRenderer: (languageAlias, value) => Promise.resolve(this._renderCodeBlock(languageAlias, value, message.mode ?? 'ask')),
				}));
				body.appendChild(rendered.element);
			}
			this._renderResolvedAgentChanges(messageElement, message);
		}
		this._renderPendingChangeSet();

		this._messagesContainer.scrollTop = this._messagesContainer.scrollHeight;
	}

	private _renderSubagentActivity(messageElement: HTMLElement, message: IChatMessage): void {
		if (message.role !== 'assistant' || !message.agentSteps?.length) {
			return;
		}
		const activity = dom.append(messageElement, dom.$('.local-ai-subagents'));
		const header = dom.append(activity, dom.$('.local-ai-subagents-header'));
		const title = dom.append(header, dom.$('span.local-ai-subagents-title'));
		title.textContent = localize('localAISubagentsTitle', "Subagents");
		const running = message.agentSteps.filter(step => step.status === 'running').length;
		const queued = message.agentSteps.filter(step => step.status === 'queued').length;
		const completed = message.agentSteps.filter(step => step.status === 'completed' || step.status === 'handedOff').length;
		const skipped = message.agentSteps.filter(step => step.status === 'skipped').length;
		const failed = message.agentSteps.filter(step => step.status === 'failed').length;
		const count = dom.append(header, dom.$('.local-ai-subagents-count'));
		count.textContent = failed || skipped
			? localize('localAISubagentsCountWithFailures', "{0} running · {1} queued · {2} completed · {3} skipped · {4} failed", running, queued, completed, skipped, failed)
			: localize('localAISubagentsCount', "{0} running · {1} queued · {2} completed", running, queued, completed);
		const list = dom.append(activity, dom.$('.local-ai-subagents-list'));
		for (const step of message.agentSteps) {
			const row = dom.append(list, dom.$(`.local-ai-subagent.${step.status}`));
			row.dataset.level = step.stage === 'planner' || step.stage === 'integrationTester' ? '0' : '1';
			const iconName = step.status === 'queued' ? 'circle-large-outline' : step.status === 'running' ? 'loading' : step.status === 'completed' ? 'pass-filled' : step.status === 'handedOff' ? 'arrow-swap' : step.status === 'skipped' ? 'circle-slash' : 'error';
			const icon = dom.append(row, dom.$(`span.local-ai-subagent-icon.codicon.codicon-${iconName}`));
			if (step.status === 'running') {
				icon.classList.add('codicon-modifier-spin');
			}
			icon.setAttribute('aria-hidden', 'true');
			const content = dom.append(row, dom.$('.local-ai-subagent-content'));
			const identity = dom.append(content, dom.$('.local-ai-subagent-identity'));
			const name = dom.append(identity, dom.$('strong'));
			name.textContent = step.name;
			const status = dom.append(identity, dom.$(`span.local-ai-subagent-status.${step.status}`));
			status.textContent = step.status === 'queued'
				? localize('localAISubagentQueuedStatus', "Queued")
				: step.status === 'running'
				? localize('localAISubagentRunning', "Running")
				: step.status === 'completed'
					? localize('localAISubagentCompleted', "Completed")
					: step.status === 'handedOff'
						? localize('localAISubagentHandedOff', "Handed off")
						: step.status === 'skipped'
							? localize('localAISubagentSkipped', "Skipped")
							: localize('localAISubagentFailed', "Failed");
			const detail = dom.append(content, dom.$('.local-ai-subagent-detail'));
			detail.textContent = step.detail;
			if (step.status === 'running' && step.streamedCharacters) {
				const agentRequest = this._pendingAgentRequest;
				const progress = agentRequest && step.id === (agentRequest.stepId ?? agentRequest.stage)
					? getLocalAIAgentStreamProgress(agentRequest.stage, this._activeAgentResponse)
					: undefined;
				const live = dom.append(content, dom.$('.local-ai-subagent-live'));
				const liveIcon = dom.append(live, dom.$('span.codicon.codicon-pulse'));
				liveIcon.setAttribute('aria-hidden', 'true');
				const received = Math.max(1, Math.ceil(step.streamedCharacters / 4));
				const liveText = dom.append(live, dom.$('span'));
				liveText.textContent = progress?.preview
					? localize('localAISubagentStreamingPreview', "Live · about {0} tokens · {1}", received, progress.preview)
					: localize('localAISubagentStreaming', "Live · about {0} tokens received", received);
			}
			if (step.files?.length) {
				const files = dom.append(content, dom.$('.local-ai-subagent-files'));
				for (const file of step.files.slice(0, maximumAttachedFiles)) {
					const chip = dom.append(files, dom.$('span.local-ai-subagent-file'));
					chip.textContent = file;
				}
			}
		}
	}

	private _renderResolvedAgentChanges(messageElement: HTMLElement, message: IChatMessage): void {
		if (message.role !== 'assistant' || !message.agentChanges?.length) {
			return;
		}
		const container = dom.append(messageElement, dom.$('.local-ai-change-set.resolved'));
		const header = dom.append(container, dom.$('.local-ai-change-set-header'));
		const accepted = message.agentChanges.filter(change => change.state === 'accepted').length;
		const rejected = message.agentChanges.length - accepted;
		const title = dom.append(header, dom.$('.local-ai-change-set-title'));
		title.textContent = rejected === 0
			? localize('localAIAppliedChangesCount', "Applied changes to {0} file(s)", accepted)
			: accepted === 0
				? localize('localAIRejectedChangesCount', "Rejected changes to {0} file(s)", rejected)
				: localize('localAIResolvedChangesCount', "Resolved changes: {0} accepted, {1} rejected", accepted, rejected);

		const files = dom.append(container, dom.$('.local-ai-change-files'));
		for (const change of message.agentChanges) {
			const row = dom.append(files, dom.$('.local-ai-change-file'));
			const fileSummary = dom.append(row, dom.$('.local-ai-change-file-summary'));
			const openButton = dom.append(fileSummary, dom.$<HTMLButtonElement>('button.local-ai-change-file-name'));
			openButton.type = 'button';
			openButton.textContent = change.displayPath;
			openButton.title = localize('localAIOpenChangedFile', "Open changed file");
			this._messageRenderStore.add(dom.addDisposableListener(openButton, dom.EventType.CLICK, () => void this._editorService.openEditor({ resource: URI.parse(change.resource) })));
			const stats = dom.append(fileSummary, dom.$('.local-ai-change-file-stats'));
			const added = dom.append(stats, dom.$('span.local-ai-change-added'));
			added.textContent = `+${change.addedLines}`;
			const removed = dom.append(stats, dom.$('span.local-ai-change-removed'));
			removed.textContent = `−${change.removedLines}`;
			const state = dom.append(row, dom.$(`span.local-ai-change-state.${change.state}`));
			state.textContent = change.state === 'accepted'
				? localize('localAIAgentChangeAccepted', "Accepted")
				: localize('localAIAgentChangeRejected', "Rejected");
		}
	}

	private _renderPendingChangeSet(): void {
		const changeSet = this._pendingAgentChangeSet;
		if (!changeSet?.files.length || !this._messagesContainer) {
			return;
		}

		const container = dom.append(this._messagesContainer, dom.$('.local-ai-change-set'));
		const header = dom.append(container, dom.$('.local-ai-change-set-header'));
		const title = dom.append(header, dom.$('span.local-ai-change-set-title'));
		const totalAdded = changeSet.files.reduce((total, change) => total + change.addedLines, 0);
		const totalRemoved = changeSet.files.reduce((total, change) => total + change.removedLines, 0);
		title.textContent = localize('localAIPendingChangesCount', "{0} file(s) changed", changeSet.files.length);
		const totals = dom.append(header, dom.$('.local-ai-change-totals'));
		const addedTotal = dom.append(totals, dom.$('span.local-ai-change-added'));
		addedTotal.textContent = `+${totalAdded}`;
		const removedTotal = dom.append(totals, dom.$('span.local-ai-change-removed'));
		removedTotal.textContent = `−${totalRemoved}`;
		const actions = dom.append(header, dom.$('.local-ai-change-set-actions'));
		const rejectAllButton = dom.append(actions, dom.$<HTMLButtonElement>('button.local-ai-button.secondary'));
		rejectAllButton.type = 'button';
		rejectAllButton.textContent = localize('localAIRejectAll', "Reject All");
		const acceptAllButton = dom.append(actions, dom.$<HTMLButtonElement>('button.local-ai-button'));
		acceptAllButton.type = 'button';
		acceptAllButton.textContent = localize('localAIAcceptAll', "Accept All");
		this._messageRenderStore.add(dom.addDisposableListener(rejectAllButton, dom.EventType.CLICK, () => void this._rejectAllAgentChanges()));
		this._messageRenderStore.add(dom.addDisposableListener(acceptAllButton, dom.EventType.CLICK, () => void this._acceptAllAgentChanges()));

		const files = dom.append(container, dom.$('.local-ai-change-files'));
		for (const change of changeSet.files) {
			const row = dom.append(files, dom.$('.local-ai-change-file'));
			const fileSummary = dom.append(row, dom.$('.local-ai-change-file-summary'));
			const openButton = dom.append(fileSummary, dom.$<HTMLButtonElement>('button.local-ai-change-file-name'));
			openButton.type = 'button';
			openButton.textContent = change.target.displayPath;
			openButton.title = localize('localAIOpenChangedFileDiff', "Open change diff");
			this._messageRenderStore.add(dom.addDisposableListener(openButton, dom.EventType.CLICK, () => void this._openAgentDiff(change)));
			const stats = dom.append(fileSummary, dom.$('.local-ai-change-file-stats'));
			const added = dom.append(stats, dom.$('span.local-ai-change-added'));
			added.textContent = `+${change.addedLines}`;
			const removed = dom.append(stats, dom.$('span.local-ai-change-removed'));
			removed.textContent = `−${change.removedLines}`;
			const fileActions = dom.append(row, dom.$('.local-ai-change-file-actions'));
			const rejectButton = dom.append(fileActions, dom.$<HTMLButtonElement>('button.local-ai-change-action'));
			rejectButton.type = 'button';
			rejectButton.textContent = localize('localAIReject', "Reject");
			const acceptButton = dom.append(fileActions, dom.$<HTMLButtonElement>('button.local-ai-change-action.accept'));
			acceptButton.type = 'button';
			acceptButton.textContent = localize('localAIAccept', "Accept");
			this._messageRenderStore.add(dom.addDisposableListener(rejectButton, dom.EventType.CLICK, () => void this._rejectAgentChange(change)));
			this._messageRenderStore.add(dom.addDisposableListener(acceptButton, dom.EventType.CLICK, () => void this._acceptAgentChange(change)));
		}
	}

	private async _acceptAgentChange(change: IPendingAgentFileChange): Promise<void> {
		const model = change.reference.object.textEditorModel;
		if (model.getVersionId() !== change.appliedVersionId) {
			this._notificationService.warn(localize('localAIChangedAfterProposal', "{0} was edited after Agent prepared it. Review those edits before accepting or rejecting.", change.target.displayPath));
			return;
		}
		if (change.created) {
			this._removeAgentChange(change, 'accepted');
			this._notificationService.info(localize('localAIAcceptedNewFile', "Accepted new file {0}.", change.target.displayPath));
			return;
		}
		const saved = await this._textFileService.save(change.target.resource);
		if (!saved) {
			this._notificationService.error(localize('localAIAcceptSaveFailed', "Unable to save accepted changes to {0}.", change.target.displayPath));
			return;
		}
		this._removeAgentChange(change, 'accepted');
		this._notificationService.info(localize('localAIAcceptedFile', "Accepted changes to {0}.", change.target.displayPath));
	}

	private async _rejectAgentChange(change: IPendingAgentFileChange): Promise<void> {
		const model = change.reference.object.textEditorModel;
		if (model.getVersionId() !== change.appliedVersionId) {
			this._notificationService.warn(localize('localAIChangedAfterProposal', "{0} was edited after Agent prepared it. Review those edits before accepting or rejecting.", change.target.displayPath));
			return;
		}
		if (change.created) {
			await this._fileService.del(change.target.resource);
		} else {
			await model.undo();
		}
		this._removeAgentChange(change, 'rejected');
		this._notificationService.info(localize('localAIRejectedFile', "Rejected changes to {0}.", change.target.displayPath));
	}

	private async _acceptAllAgentChanges(): Promise<void> {
		for (const change of [...(this._pendingAgentChangeSet?.files ?? [])]) {
			await this._acceptAgentChange(change);
		}
	}

	private async _rejectAllAgentChanges(): Promise<void> {
		for (const change of [...(this._pendingAgentChangeSet?.files ?? [])]) {
			await this._rejectAgentChange(change);
		}
	}

	private _removeAgentChange(change: IPendingAgentFileChange, state: IChatAgentChangeSummary['state']): void {
		const changeSet = this._pendingAgentChangeSet;
		if (!changeSet) {
			return;
		}
		changeSet.message.agentChanges ??= [];
		changeSet.message.agentChanges.push({
			resource: change.target.resource.toString(),
			displayPath: change.target.displayPath,
			addedLines: change.addedLines,
			removedLines: change.removedLines,
			state,
		});
		const index = changeSet.files.indexOf(change);
		if (index >= 0) {
			changeSet.files.splice(index, 1);
			change.reference.dispose();
			change.originalReference.dispose();
		}
		if (!changeSet.files.length) {
			this._pendingAgentChangeSet = undefined;
			this._agentChangeReferences.clear();
		}
		this._storeHistory();
		this._renderMessages();
		this._emitActivity();
	}

	private _renderCodeBlock(languageAlias: string | undefined, value: string, mode: LocalAIChatMode): HTMLElement {
		const wrapper = dom.$('.local-ai-code-block');
		const toolbar = dom.append(wrapper, dom.$('.local-ai-code-toolbar'));
		const language = dom.append(toolbar, dom.$('span.local-ai-code-language'));
		language.textContent = languageAlias || localize('localAICode', "Code");
		const actions = mode === 'ask' ? dom.append(toolbar, dom.$('.local-ai-code-actions')) : undefined;
		const previewButton = actions ? dom.append(actions, dom.$<HTMLButtonElement>('button.local-ai-button.secondary')) : undefined;
		if (previewButton) {
			previewButton.type = 'button';
			previewButton.textContent = localize('localAIPreviewChanges', "Preview");
		}
		const pre = dom.append(wrapper, dom.$('pre'));
		const code = dom.append(pre, dom.$('code'));
		code.textContent = value;

		if (previewButton) {
			this._messageRenderStore.add(dom.addDisposableListener(previewButton, dom.EventType.CLICK, () => {
				const controller = this._getInlineEditController();
				controller?.previewEdit(value);
			}));
		}
		return wrapper;
	}

	private _getInlineEditController(): InlineEditController | undefined {
		const editor = getCodeEditor(this._editorService.activeTextEditorControl);
		const controller = editor && InlineEditController.get(editor);
		if (!controller) {
			this._notificationService.warn(localize('localAIApplyNoEditor', "Open a text editor before applying code."));
			return undefined;
		}
		return controller;
	}

	private _setInputEnabled(enabled: boolean): void {
		if (this._input) {
			this._input.disabled = !enabled;
		}
		if (this._sendButton) {
			this._sendButton.disabled = !enabled;
			this._sendButton.hidden = !enabled;
		}
		if (this._stopButton) {
			this._stopButton.hidden = enabled;
		}
		if (enabled && this.isBodyVisible()) {
			this._input?.focus();
		}
		this._emitActivity();
	}

	private _restoreHistory(): void {
		const stored = this._storageService.get(this._historyStorageKey, StorageScope.WORKSPACE);
		if (!stored) {
			return;
		}
		try {
			const messages = JSON.parse(stored) as unknown;
			if (!Array.isArray(messages)) {
				return;
			}
			for (const message of messages.slice(-maximumStoredMessages)) {
				if (typeof message === 'object' && message !== null && ((message as IChatMessage).role === 'user' || (message as IChatMessage).role === 'assistant') && typeof (message as IChatMessage).content === 'string') {
					const candidate = message as IChatMessage;
					const mode = candidate.mode === 'ask' || candidate.mode === 'plan' || candidate.mode === 'agent' ? candidate.mode : undefined;
					const attachmentNames = Array.isArray(candidate.attachmentNames) ? candidate.attachmentNames.filter(name => typeof name === 'string').slice(0, maximumAttachedFiles) : undefined;
					const content = candidate.role === 'assistant' && mode === 'agent'
						? candidate.content.replace(/```[^\r\n]*\r?\n[\s\S]*?\r?\n```/g, '').trim() || localize('localAIPreviousAgentChanges', "Agent prepared changes in an earlier session.")
						: candidate.content;
					const agentChanges = Array.isArray(candidate.agentChanges)
						? candidate.agentChanges.filter((change): change is IChatAgentChangeSummary => {
							return typeof change === 'object' && change !== null
								&& typeof change.resource === 'string'
								&& typeof change.displayPath === 'string'
								&& typeof change.addedLines === 'number'
								&& typeof change.removedLines === 'number'
								&& (change.state === 'accepted' || change.state === 'rejected');
						}).slice(0, maximumAttachedFiles)
						: undefined;
					const agentSteps = Array.isArray(candidate.agentSteps)
						? candidate.agentSteps.filter(step => {
							return typeof step === 'object' && step !== null
								&& (step.stage === 'planner' || step.stage === 'implementer' || step.stage === 'reviewer' || step.stage === 'tester' || step.stage === 'integrationTester')
								&& (step.status === 'queued' || step.status === 'running' || step.status === 'completed' || step.status === 'handedOff' || step.status === 'skipped' || step.status === 'failed')
								&& typeof step.detail === 'string';
						}).slice(0, 40).map((rawStep, index): IChatAgentStep => {
							const step = rawStep as Partial<IChatAgentStep> & Pick<IChatAgentStep, 'stage' | 'status' | 'detail'>;
							const wasNeverRun = step.status === 'failed' && /^Not run because\b/i.test(step.detail);
							return {
								id: typeof step.id === 'string' ? step.id : `${step.stage}-${index}`,
								stage: step.stage,
								name: typeof step.name === 'string' ? step.name : this._agentStageName(step.stage),
								status: wasNeverRun || step.status === 'queued' ? 'skipped' : step.status === 'running' ? 'failed' : step.status,
								detail: step.status === 'running'
									? localize('localAISubagentInterrupted', "Interrupted when Orbyte closed.")
									: step.status === 'queued'
										? localize('localAISubagentNotRunBeforeClose', "Not run before Orbyte closed.")
										: step.detail,
								files: Array.isArray(step.files) ? step.files.filter(file => typeof file === 'string').slice(0, maximumAttachedFiles) : undefined,
							};
						})
						: undefined;
					this._messages.push({ role: candidate.role, content, mode, attachmentNames, agentChanges, agentSteps });
				}
			}
			const firstUserMessage = this._messages.find(message => message.role === 'user');
			if (firstUserMessage) {
				this._chatTitle = firstUserMessage.content.replace(/\s+/g, ' ').slice(0, 42) || this._chatTitle;
			}
		} catch {
			this._storageService.remove(this._historyStorageKey, StorageScope.WORKSPACE);
		}
	}

	private _storeHistory(): void {
		this._storageService.store(
			this._historyStorageKey,
			JSON.stringify(this._messages.slice(-maximumStoredMessages)),
			StorageScope.WORKSPACE,
			StorageTarget.MACHINE
		);
	}

	private _updateServerState(state: LocalLLMServerState): void {
		if (!this._stateElement) {
			return;
		}
		this._stateElement.dataset.state = state;
		switch (state) {
			case 'starting':
				this._stateElement.textContent = localize('localAIStarting', "Starting local model…");
				break;
			case 'ready':
				this._stateElement.textContent = localize('localAIReady', "Local model ready");
				break;
			case 'stopping':
				this._stateElement.textContent = localize('localAIStopping', "Stopping local model…");
				break;
			case 'error':
				this._stateElement.textContent = localize('localAIError', "Local model unavailable");
				break;
			default:
				this._stateElement.textContent = localize('localAIStopped', "Local model stopped");
		}
	}
}
