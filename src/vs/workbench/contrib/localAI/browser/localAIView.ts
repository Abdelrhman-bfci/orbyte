/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { IAction } from '../../../../base/common/actions.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { DisposableStore, IReference } from '../../../../base/common/lifecycle.js';
import { basename, relativePath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { getCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { IResolvedTextEditorModel, ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
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
import { ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewletViewOptions } from '../../../browser/parts/views/viewsViewlet.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ISearchService, QueryType } from '../../../services/search/common/search.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { ILocalAIContextService } from './context/localAIContext.js';
import { formatChatMessages, ILocalAIAttachment, LocalAIChatMode } from './context/promptFormatter.js';
import { InlineEditController } from './inlineEditController.js';

interface IChatMessage {
	readonly role: 'user' | 'assistant';
	content: string;
	readonly mode?: LocalAIChatMode;
	readonly attachmentNames?: readonly string[];
}

interface ILocalAIFilePick extends IQuickPickItem {
	readonly resource: URI;
}

interface IAgentTarget {
	readonly resource: URI;
	readonly displayPath: string;
	readonly originalText: string;
}

interface IPendingAgentRequest {
	readonly requestId: string;
	readonly targets: readonly IAgentTarget[];
}

interface IPendingAgentFileChange {
	readonly target: IAgentTarget;
	readonly proposedText: string;
	readonly reference: IReference<IResolvedTextEditorModel>;
	readonly appliedVersionId: number;
}

interface IPendingAgentChangeSet {
	readonly summary: string;
	readonly files: IPendingAgentFileChange[];
}

interface IParsedAgentResponse {
	readonly summary: string;
	readonly files: readonly { readonly target: string; readonly content: string }[];
}

const localAIChatHistoryStorageKey = 'localAI.chatHistory';
const localAIChatModeStorageKey = 'localAI.chatMode';
const maximumStoredMessages = 40;
const maximumAttachmentBytes = 64 * 1024;
const maximumAttachedFiles = 8;

export class LocalAIViewPane extends ViewPane {

	static readonly ID = 'workbench.view.localAI';

	private readonly _messageRenderStore = this._register(new DisposableStore());
	private readonly _attachmentRenderStore = this._register(new DisposableStore());
	private readonly _agentChangeReferences = this._register(new DisposableStore());
	private readonly _editorContextStore = this._register(new DisposableStore());
	private readonly _renderScheduler = this._register(new RunOnceScheduler(() => this._renderMessages(), 50));
	private readonly _mentionScheduler = this._register(new RunOnceScheduler(() => void this._showMentionPickerFromInput(), 150));
	private readonly _messages: IChatMessage[] = [];
	private readonly _pendingAttachments: ILocalAIAttachment[] = [];
	private readonly _modelDownloads = new Map<string, ILocalLLMModelDownloadEvent>();
	private _modeButton: HTMLButtonElement | undefined;
	private _modelButton: HTMLButtonElement | undefined;
	private _messagesContainer: HTMLElement | undefined;
	private _attachmentsContainer: HTMLElement | undefined;
	private _composerContextRow: HTMLElement | undefined;
	private _input: HTMLTextAreaElement | undefined;
	private _sendButton: HTMLButtonElement | undefined;
	private _stopButton: HTMLButtonElement | undefined;
	private _stateElement: HTMLElement | undefined;
	private _activeContextButton: HTMLButtonElement | undefined;
	private _activeRequestId: string | undefined;
	private _activeAgentResponse = '';
	private _pendingAgentRequest: IPendingAgentRequest | undefined;
	private _pendingAgentChangeSet: IPendingAgentChangeSet | undefined;
	private _mode: LocalAIChatMode;
	private _mentionPickerOpen = false;
	private _modelCatalog: ILocalLLMModelCatalog | undefined;
	private _modelManagerVisible = false;
	private _modelSelectionPending = false;

	constructor(
		options: IViewletViewOptions,
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
		@IFileDialogService private readonly _fileDialogService: IFileDialogService,
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@ISearchService private readonly _searchService: ISearchService,
		@ITextModelService private readonly _textModelService: ITextModelService,
		@ITextFileService private readonly _textFileService: ITextFileService,
	) {
		super(options, keybindingService, _contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
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
			const response = this._messages.at(-1);
			if (response?.role === 'assistant') {
				if (response.mode === 'agent') {
					this._activeAgentResponse += event.token;
				} else {
					response.content += event.token;
					this._renderScheduler.schedule();
				}
			}
		}));
		this._register(this._localLLMService.onDidStreamEnd(event => void this._handleStreamEnd(event.requestId, event.error)));
		this._register(this._editorService.onDidActiveEditorChange(() => this._bindActiveEditorContext()));
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
		this._register(dom.addDisposableListener(newChatButton, dom.EventType.CLICK, () => void this._newChat()));

		this._messagesContainer = dom.append(container, dom.$('.local-ai-messages'));
		const inputArea = dom.append(container, dom.$('.local-ai-input-area'));
		this._composerContextRow = dom.append(inputArea, dom.$('.local-ai-composer-context'));
		this._composerContextRow.hidden = true;
		this._activeContextButton = dom.append(this._composerContextRow, dom.$<HTMLButtonElement>('button.local-ai-active-context'));
		this._activeContextButton.type = 'button';
		this._activeContextButton.hidden = true;
		this._activeContextButton.title = localize('localAIActiveContextTitle', "Open active editor context");
		this._activeContextButton.setAttribute('aria-label', localize('localAIActiveContextAriaLabel', "Open active editor context"));
		this._register(dom.addDisposableListener(this._activeContextButton, dom.EventType.CLICK, () => {
			const resource = getCodeEditor(this._editorService.activeTextEditorControl)?.getModel()?.uri;
			if (resource) {
				void this._editorService.openEditor({ resource });
			}
		}));

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
		mentionButton.title = localize('localAIMentionFileTitle', "Mention Workspace File");
		mentionButton.setAttribute('aria-label', localize('localAIMentionFileAriaLabel', "Mention Workspace File"));
		this._register(dom.addDisposableListener(mentionButton, dom.EventType.CLICK, () => void this._showMentionPicker()));
		this._register(dom.addDisposableListener(attachButton, dom.EventType.CLICK, () => void this._attachFiles()));

		this._modelButton = dom.append(toolbarStart, dom.$<HTMLButtonElement>('button.local-ai-model-picker'));
		this._modelButton.type = 'button';
		this._modelButton.setAttribute('aria-haspopup', 'dialog');
		this._modelButton.setAttribute('aria-label', localize('localAIModelAriaLabel', "Choose local AI model"));
		this._register(dom.addDisposableListener(this._modelButton, dom.EventType.CLICK, () => {
			if (this._modelCatalog?.setupRequired) {
				return;
			}
			this._modelManagerVisible = !this._modelManagerVisible;
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
		this._bindActiveEditorContext();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
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
		this._storageService.store(localAIChatModeStorageKey, mode, StorageScope.WORKSPACE, StorageTarget.MACHINE);
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
		const stored = this._storageService.get(localAIChatModeStorageKey, StorageScope.WORKSPACE);
		return stored === 'ask' || stored === 'plan' || stored === 'agent' ? stored : 'ask';
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

	private _bindActiveEditorContext(): void {
		this._editorContextStore.clear();
		const editor = getCodeEditor(this._editorService.activeTextEditorControl);
		if (editor) {
			this._editorContextStore.add(editor.onDidChangeCursorSelection(() => this._updateActiveEditorContext()));
			this._editorContextStore.add(editor.onDidChangeModel(() => this._updateActiveEditorContext()));
		}
		this._updateActiveEditorContext();
	}

	private _updateActiveEditorContext(): void {
		if (!this._activeContextButton) {
			return;
		}
		const editor = getCodeEditor(this._editorService.activeTextEditorControl);
		const model = editor?.getModel();
		const selection = editor?.getSelection();
		if (!model || !selection) {
			this._activeContextButton.hidden = true;
			if (this._composerContextRow) {
				this._composerContextRow.hidden = true;
			}
			return;
		}

		const startLine = selection.startLineNumber;
		const endLine = selection.endLineNumber;
		const lineLabel = startLine === endLine ? String(startLine) : `${startLine}-${endLine}`;
		this._activeContextButton.textContent = `📌  ${basename(model.uri)}:${lineLabel}`;
		this._activeContextButton.title = localize('localAIActiveContextResource', "Active context: {0}, lines {1}", this._workspaceRelativePath(model.uri), lineLabel);
		this._activeContextButton.hidden = false;
		if (this._composerContextRow) {
			this._composerContextRow.hidden = false;
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
				this._notificationService.warn(localize('localAINoWorkspaceFiles', "Open a workspace folder to mention files."));
				return;
			}

			const picker = disposables.add(this._quickInputService.createQuickPick<ILocalAIFilePick>());
			picker.placeholder = localize('localAIMentionFilePlaceholder', "Select a File to Add as Context");
			picker.matchOnDescription = true;
			let searchSequence = 0;
			const updateItems = async (pattern: string): Promise<void> => {
				const sequence = ++searchSequence;
				picker.busy = true;
				try {
					const items = await this._workspaceFilePicks(pattern, 100);
					if (sequence === searchSequence) {
						picker.items = items;
					}
				} finally {
					if (sequence === searchSequence) {
						picker.busy = false;
					}
				}
			};
			const picked = await new Promise<ILocalAIFilePick | undefined>(resolve => {
				let settled = false;
				const settle = (item: ILocalAIFilePick | undefined): void => {
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
			await this._addAttachment(picked.resource);
			this._insertMention(picked.description ?? picked.label, replaceTrigger);
			this._renderAttachments();
		} finally {
			disposables.dispose();
			this._mentionPickerOpen = false;
			this._input?.focus();
		}
	}

	private async _workspaceFilePicks(pattern = '', maxResults = 300): Promise<ILocalAIFilePick[]> {
		const folders = this._workspaceContextService.getWorkspace().folders;
		if (!folders.length) {
			return [];
		}
		const result = await this._searchService.fileSearch({
			type: QueryType.File,
			folderQueries: folders.map(folder => ({ folder: folder.uri })),
			filePattern: pattern,
			sortByScore: true,
			maxResults,
			excludePattern: {
				'**/.build/**': true,
				'**/.git/**': true,
				'**/node_modules/**': true,
				'**/out/**': true,
				'**/resources/local-llm/**': true,
			},
		});
		return result.results.map(result => {
			const path = this._workspaceRelativePath(result.resource);
			return {
				label: basename(result.resource),
				description: path,
				resource: result.resource,
			};
		});
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
			const picks = await this._workspaceFilePicks(path, 50);
			const exact = picks.find(pick => pick.description === path) ?? picks.find(pick => pick.label === path);
			if (exact) {
				await this._addAttachment(exact.resource);
			}
		}
		this._renderAttachments();
	}

	private async _send(): Promise<void> {
		const value = this._input?.value.trim();
		if (!value || this._activeRequestId) {
			return;
		}

		const mode = this._mode;
		if (mode === 'agent' && this._pendingAgentChangeSet?.files.length) {
			this._notificationService.warn(localize('localAIResolveChanges', "Accept or reject the current Agent changes before starting another Agent request."));
			return;
		}
		const context = await this._contextService.collect();
		await this._resolveTypedMentions(value);
		const attachments = [...this._pendingAttachments];
		const agentTargets = mode === 'agent' ? await this._collectAgentTargets(attachments) : [];
		if (mode === 'agent' && !agentTargets.length) {
			this._notificationService.warn(localize('localAIAgentNoEditor', "Open a text file before asking Agent to make changes."));
			return;
		}
		const history: ILocalLLMChatMessage[] = this._messages.map(message => ({
			role: message.role,
			content: message.attachmentNames?.length ? `${message.content}\n\nAttached files: ${message.attachmentNames.join(', ')}` : message.content,
		}));
		this._input!.value = '';
		this._messages.push({ role: 'user', content: value, mode, attachmentNames: attachments.map(attachment => attachment.name) });
		this._messages.push({ role: 'assistant', content: '', mode });
		this._pendingAttachments.length = 0;
		this._renderAttachments();
		this._storeHistory();
		this._renderMessages();
		this._setInputEnabled(false);
		const requestId = generateUuid();
		this._activeRequestId = requestId;
		if (mode === 'agent') {
			this._activeAgentResponse = '';
			this._pendingAgentRequest = {
				requestId,
				targets: agentTargets,
			};
		}

		try {
			await this._localLLMService.streamChat({
				requestId,
				messages: formatChatMessages(context, value, history, mode, attachments),
				maxTokens: mode === 'agent' ? 3072 : 2048,
				temperature: mode === 'plan' ? 0.15 : 0.2,
			});
		} catch (error) {
			this._activeRequestId = undefined;
			this._activeAgentResponse = '';
			this._pendingAgentRequest = undefined;
			this._setInputEnabled(true);
			this._messages.at(-1)!.content = localize('localAIStartError', "Unable to start the local model: {0}", error instanceof Error ? error.message : String(error));
			this._storeHistory();
			this._renderMessages();
		}
	}

	private async _stopGeneration(): Promise<void> {
		const requestId = this._activeRequestId;
		this._activeRequestId = undefined;
		this._activeAgentResponse = '';
		this._pendingAgentRequest = undefined;
		if (requestId) {
			await this._localLLMService.cancelRequest(requestId);
		}
		this._setInputEnabled(true);
		this._storeHistory();
		this._renderMessages();
	}

	private async _newChat(): Promise<void> {
		if (this._pendingAgentChangeSet?.files.length) {
			this._notificationService.warn(localize('localAIResolveBeforeNewChat', "Accept or reject the pending Agent changes before starting a new chat."));
			return;
		}
		await this._stopGeneration();
		this._messages.length = 0;
		this._pendingAttachments.length = 0;
		this._storageService.remove(localAIChatHistoryStorageKey, StorageScope.WORKSPACE);
		this._renderAttachments();
		this._renderMessages();
		this._input?.focus();
	}

	private async _handleStreamEnd(requestId: string, error: string | undefined): Promise<void> {
		if (requestId !== this._activeRequestId) {
			return;
		}

		const response = this._messages.at(-1);
		const agentResponse = this._activeAgentResponse;
		this._activeRequestId = undefined;
		this._activeAgentResponse = '';
		this._setInputEnabled(true);
		this._renderScheduler.cancel();
		if (error) {
			if (response?.role === 'assistant') {
				response.content = localize('localAIResponseError', "Local model error: {0}", error);
			}
			this._pendingAgentRequest = undefined;
		} else if (response?.role === 'assistant' && response.mode === 'agent') {
			await this._stageAgentResponse(requestId, agentResponse, response);
		}
		this._storeHistory();
		this._renderMessages();
	}

	private async _collectAgentTargets(attachments: readonly ILocalAIAttachment[]): Promise<IAgentTarget[]> {
		const editor = getCodeEditor(this._editorService.activeTextEditorControl);
		const model = editor?.getModel();
		if (!model) {
			return [];
		}

		const targets: IAgentTarget[] = [{
			resource: model.uri,
			displayPath: this._workspaceRelativePath(model.uri),
			originalText: model.getValue(),
		}];
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

		const parsed = this._parseAgentResponse(rawResponse, request.targets);
		response.content = parsed.summary || localize('localAIAgentPreparedChanges', "Agent prepared changes for review.");
		const changes: IPendingAgentFileChange[] = [];
		const stagedResources = new Set<string>();
		for (const file of parsed.files) {
			const target = this._resolveAgentTarget(file.target, request.targets);
			if (!target || stagedResources.has(target.resource.toString())) {
				continue;
			}
			try {
				const reference = await this._textModelService.createModelReference(target.resource);
				const model = reference.object.textEditorModel;
				if (model.getValue() !== target.originalText) {
					reference.dispose();
					this._notificationService.warn(localize('localAIAgentFileChanged', "{0} changed while Agent was working and was skipped.", target.displayPath));
					continue;
				}
				model.pushStackElement();
				model.pushEditOperations(null, [{ range: model.getFullModelRange(), text: file.content }], () => null);
				model.pushStackElement();
				this._agentChangeReferences.add(reference);
				changes.push({ target, proposedText: file.content, reference, appliedVersionId: model.getVersionId() });
				stagedResources.add(target.resource.toString());
			} catch (error) {
				this._notificationService.error(localize('localAIAgentApplyError', "Unable to prepare changes for {0}: {1}", target.displayPath, error instanceof Error ? error.message : String(error)));
			}
		}

		if (!changes.length) {
			this._notificationService.warn(localize('localAIAgentNoEdit', "Agent returned no valid file changes."));
			return;
		}
		this._pendingAgentChangeSet = { summary: response.content, files: changes };
		await this._editorService.openEditor({ resource: changes[0].target.resource });
	}

	private _parseAgentResponse(response: string, targets: readonly IAgentTarget[]): IParsedAgentResponse {
		const summaryMatch = /<summary>([\s\S]*?)<\/summary>/i.exec(response);
		const files: { target: string; content: string }[] = [];
		const filePattern = /<file\s+[^>]*(?:path|uri)="([^"]+)"[^>]*>([\s\S]*?)<\/file>/gi;
		for (const match of response.matchAll(filePattern)) {
			const body = match[2].trim();
			const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(body);
			const fence = /^```[^\r\n]*\r?\n([\s\S]*?)\r?\n```$/.exec(body);
			files.push({ target: this._decodeXml(match[1]), content: cdata?.[1] ?? fence?.[1] ?? body });
		}
		if (!files.length) {
			const fence = /```[^\r\n]*\r?\n([\s\S]*?)\r?\n```/.exec(response);
			if (fence && targets[0]) {
				files.push({ target: targets[0].resource.toString(), content: fence[1] });
			}
		}
		return {
			summary: summaryMatch ? this._decodeXml(summaryMatch[1].trim()) : localize('localAIAgentPreparedChanges', "Agent prepared changes for review."),
			files,
		};
	}

	private _resolveAgentTarget(value: string, targets: readonly IAgentTarget[]): IAgentTarget | undefined {
		const exact = targets.find(target => target.resource.toString() === value || target.displayPath === value);
		if (exact) {
			return exact;
		}
		const basenameMatches = targets.filter(target => basename(target.resource) === value);
		return basenameMatches.length === 1 ? basenameMatches[0] : undefined;
	}

	private _decodeXml(value: string): string {
		return value.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&amp;', '&');
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
		}
		this._renderPendingChangeSet();

		this._messagesContainer.scrollTop = this._messagesContainer.scrollHeight;
	}

	private _renderPendingChangeSet(): void {
		const changeSet = this._pendingAgentChangeSet;
		if (!changeSet?.files.length || !this._messagesContainer) {
			return;
		}

		const container = dom.append(this._messagesContainer, dom.$('.local-ai-change-set'));
		const header = dom.append(container, dom.$('.local-ai-change-set-header'));
		const title = dom.append(header, dom.$('span.local-ai-change-set-title'));
		title.textContent = localize('localAIPendingChangesCount', "Review changes in {0} file(s)", changeSet.files.length);
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
			const openButton = dom.append(row, dom.$<HTMLButtonElement>('button.local-ai-change-file-name'));
			openButton.type = 'button';
			openButton.textContent = change.target.displayPath;
			openButton.title = localize('localAIOpenChangedFile', "Open changed file");
			this._messageRenderStore.add(dom.addDisposableListener(openButton, dom.EventType.CLICK, () => void this._editorService.openEditor({ resource: change.target.resource })));
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
		const saved = await this._textFileService.save(change.target.resource);
		if (!saved) {
			this._notificationService.error(localize('localAIAcceptSaveFailed', "Unable to save accepted changes to {0}.", change.target.displayPath));
			return;
		}
		this._removeAgentChange(change);
		this._notificationService.info(localize('localAIAcceptedFile', "Accepted changes to {0}.", change.target.displayPath));
	}

	private async _rejectAgentChange(change: IPendingAgentFileChange): Promise<void> {
		const model = change.reference.object.textEditorModel;
		if (model.getVersionId() !== change.appliedVersionId) {
			this._notificationService.warn(localize('localAIChangedAfterProposal', "{0} was edited after Agent prepared it. Review those edits before accepting or rejecting.", change.target.displayPath));
			return;
		}
		model.pushStackElement();
		model.pushEditOperations(null, [{ range: model.getFullModelRange(), text: change.target.originalText }], () => null);
		model.pushStackElement();
		this._removeAgentChange(change);
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

	private _removeAgentChange(change: IPendingAgentFileChange): void {
		const changeSet = this._pendingAgentChangeSet;
		if (!changeSet) {
			return;
		}
		const index = changeSet.files.indexOf(change);
		if (index >= 0) {
			changeSet.files.splice(index, 1);
			change.reference.dispose();
		}
		if (!changeSet.files.length) {
			this._pendingAgentChangeSet = undefined;
			this._agentChangeReferences.clear();
		}
		this._renderMessages();
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
		if (enabled) {
			this._input?.focus();
		}
	}

	private _restoreHistory(): void {
		const stored = this._storageService.get(localAIChatHistoryStorageKey, StorageScope.WORKSPACE);
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
					this._messages.push({ role: candidate.role, content, mode, attachmentNames });
				}
			}
		} catch {
			this._storageService.remove(localAIChatHistoryStorageKey, StorageScope.WORKSPACE);
		}
	}

	private _storeHistory(): void {
		this._storageService.store(
			localAIChatHistoryStorageKey,
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
