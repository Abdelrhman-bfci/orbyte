/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/localAI.css';
import './inlineEditController.js';
import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import Severity from '../../../../base/common/severity.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILocalLLMModelInfo, ILocalLLMService } from '../../../../platform/localLLM/common/localLLM.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { orbyteBrandIconSrc } from '../../../browser/orbyteBrand.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewDescriptor, IViewsRegistry, ViewContainerLocation } from '../../../common/views.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { ILocalAIContextService, LocalAIContextService } from './context/localAIContext.js';
import { ILocalAISymbolRetrieverService, LocalAISymbolRetrieverService } from './context/localAISymbolRetriever.js';
import { ILocalAIChatActivity, LocalAIViewPane } from './localAIView.js';

registerSingleton(ILocalAISymbolRetrieverService, LocalAISymbolRetrieverService, InstantiationType.Delayed);
registerSingleton(ILocalAIContextService, LocalAIContextService, InstantiationType.Delayed);

const localAIContainerId = 'workbench.view.localAIContainer';
const localAIModelSetupPromptVersionStorageKey = 'localAI.modelSetupPromptVersion';
const localAIModelSetupPromptVersion = 1;
const localAIFloatingMigrationVersionStorageKey = 'localAI.floatingChatMigrationVersion';
const localAIFloatingMigrationVersion = 1;
const localAIFloatingSessionsStorageKey = 'localAI.floatingChatSessions';
const maximumFloatingChatSessions = 8;
const localAIIcon = registerIcon('local-ai-view-icon', Codicon.chatSparkle, localize('localAIViewIcon', "View icon of the Orbyte AI view."));

const viewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: localAIContainerId,
	title: localize2('localAIContainerTitle', "Orbyte AI"),
	icon: localAIIcon,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [localAIContainerId, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: localAIContainerId,
	hideIfEmpty: true,
	order: 2,
}, ViewContainerLocation.AuxiliaryBar);

const viewDescriptor: IViewDescriptor = {
	id: LocalAIViewPane.ID,
	name: localize2('localAIViewTitle', "Orbyte AI"),
	containerIcon: localAIIcon,
	canToggleVisibility: false,
	canMoveView: false,
	hideByDefault: true,
	when: ContextKeyExpr.false(),
	ctorDescriptor: new SyncDescriptor(LocalAIViewPane),
};

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([viewDescriptor], viewContainer);

interface ILocalAIFloatingChatService {
	readonly _serviceBrand: undefined;
	show(focus?: boolean): void;
	showModels(): void;
	showSettings(): void;
	toggle(): void;
}

const ILocalAIFloatingChatService = createDecorator<ILocalAIFloatingChatService>('localAIFloatingChatService');

interface ILocalAIFloatingChatSession {
	readonly id: string;
	readonly host: HTMLElement;
	readonly view: LocalAIViewPane;
	readonly disposables: DisposableStore;
	activity: ILocalAIChatActivity;
}

interface IStoredLocalAIFloatingChatState {
	readonly activeSessionId?: string;
	readonly sessions?: readonly { readonly id: string }[];
}

class LocalAIFloatingChatService extends Disposable implements ILocalAIFloatingChatService {

	declare readonly _serviceBrand: undefined;

	private readonly panel: HTMLElement;
	private readonly launcher: HTMLButtonElement;
	private readonly launcherProgress: HTMLElement;
	private readonly launcherProgressValue: HTMLElement;
	private readonly tabs: HTMLElement;
	private readonly tabDisposables = this._register(new DisposableStore());
	private readonly content: HTMLElement;
	private readonly sessions: ILocalAIFloatingChatSession[] = [];
	private activeSessionId: string | undefined;
	private visible = false;
	private previousFocus: HTMLElement | undefined;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IStorageService private readonly storageService: IStorageService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();

		const root = dom.append(layoutService.mainContainer, dom.$('.local-ai-floating-root'));
		this.panel = dom.append(root, dom.$('.local-ai-floating-panel'));
		this.panel.hidden = true;
		this.panel.setAttribute('role', 'dialog');
		this.panel.setAttribute('aria-modal', 'false');
		this.panel.setAttribute('aria-label', localize('localAIFloatingPanelAriaLabel', "Orbyte AI chat"));

		const floatingHeader = dom.append(this.panel, dom.$('.local-ai-floating-header'));
		const brand = dom.append(floatingHeader, dom.$('.local-ai-floating-brand'));
		brand.append(this.createBrandImage('local-ai-floating-brand-icon'));
		const title = dom.append(brand, dom.$('span.local-ai-floating-title'));
		title.textContent = localize('localAIFloatingTitle', "Orbyte AI");
		const privacy = dom.append(brand, dom.$('span.local-ai-floating-privacy'));
		privacy.textContent = localize('localAIFloatingPrivacy', "Local / Cloud");

		const headerActions = dom.append(floatingHeader, dom.$('.local-ai-floating-header-actions'));
		const settingsButton = dom.append(headerActions, dom.$<HTMLButtonElement>('button.local-ai-floating-settings.codicon.codicon-settings-gear'));
		settingsButton.type = 'button';
		settingsButton.title = localize('localAIFloatingSettings', "AI provider settings");
		settingsButton.setAttribute('aria-label', localize('localAIFloatingSettings', "AI provider settings"));
		const closeButton = dom.append(headerActions, dom.$<HTMLButtonElement>('button.local-ai-floating-close'));
		closeButton.type = 'button';
		closeButton.textContent = '×';
		closeButton.title = localize('localAIFloatingClose', "Close Orbyte AI");
		closeButton.setAttribute('aria-label', localize('localAIFloatingClose', "Close Orbyte AI"));

		this.tabs = dom.append(this.panel, dom.$('.local-ai-floating-tabs'));
		this.tabs.setAttribute('role', 'tablist');
		this.tabs.setAttribute('aria-label', localize('localAIFloatingChats', "Orbyte AI chats"));

		// ViewPane normally lives below a PaneView. Keep that host class here so its
		// hidden header and flex body rules also apply in the detached chat window.
		this.content = dom.append(this.panel, dom.$('.local-ai-floating-content.monaco-pane-view'));

		this.launcher = dom.append(root, dom.$<HTMLButtonElement>('button.local-ai-floating-launcher'));
		this.launcher.type = 'button';
		this.launcher.title = localize('openLocalAI', "Open Orbyte AI");
		this.launcher.setAttribute('aria-label', localize('openLocalAI', "Open Orbyte AI"));
		this.launcher.setAttribute('aria-expanded', 'false');
		this.launcher.append(this.createBrandImage('local-ai-floating-launcher-icon'));
		this.launcherProgress = dom.append(this.launcher, dom.$('span.local-ai-floating-progress'));
		this.launcherProgress.setAttribute('aria-hidden', 'true');
		this.launcherProgressValue = dom.append(this.launcherProgress, dom.$('span.local-ai-floating-progress-value'));
		const launcherLabel = dom.append(this.launcher, dom.$('span.local-ai-floating-launcher-label'));
		launcherLabel.textContent = localize('localAIFloatingLauncherLabel', "Ask Orbyte");

		this._register(dom.addDisposableListener(this.launcher, dom.EventType.CLICK, () => this.toggle()));
		this._register(dom.addDisposableListener(settingsButton, dom.EventType.CLICK, () => this.showSettings()));
		this._register(dom.addDisposableListener(closeButton, dom.EventType.CLICK, () => this.hide()));
		const document = dom.getWindow(root).document;
		this._register(dom.addDisposableListener(document, dom.EventType.KEY_DOWN, event => {
			if (event.key === 'Escape' && this.visible) {
				event.stopPropagation();
				this.hide();
			}
		}));
		this._register(dom.addDisposableListener(document, dom.EventType.POINTER_DOWN, event => {
			if (!this.visible) {
				return;
			}
			const target = event.target;
			if (!(target instanceof Node) || this.panel.contains(target) || this.launcher.contains(target)) {
				return;
			}
			// Context menus, quick picks, and dialogs are actions opened by this panel.
			// Treat them as part of the chat interaction even though VS Code renders
			// them in a shared overlay outside the floating panel DOM subtree.
			if (target instanceof Element && target.closest('.context-view, .quick-input-widget, .monaco-dialog-box')) {
				return;
			}
			this.hide(false);
		}, true));

		const resizeObserver = new ResizeObserver(() => this.layout());
		resizeObserver.observe(this.content);
		this._register(toDisposable(() => resizeObserver.disconnect()));
		this._register(toDisposable(() => {
			for (const session of this.sessions) {
				session.disposables.dispose();
			}
		}));
		this._register(toDisposable(() => root.remove()));
		this.restoreSessions();
	}

	show(focus = true): void {
		if (!this.visible) {
			this.previousFocus = dom.getActiveElement() instanceof HTMLElement ? dom.getActiveElement() as HTMLElement : undefined;
			this.visible = true;
			this.panel.hidden = false;
			this.launcher.classList.add('active');
			this.launcher.setAttribute('aria-expanded', 'true');
			this.activeSession?.view.setVisible(true);
			this.layout();
		}
		if (focus) {
			this.activeSession?.view.focusInput();
		}
	}

	showModels(): void {
		this.show(false);
		this.activeSession?.view.showModelManager();
	}

	showSettings(): void {
		this.show(false);
		this.activeSession?.view.showProviderSettings();
	}

	toggle(): void {
		if (this.visible) {
			this.hide();
		} else {
			this.show();
		}
	}

	private hide(restoreFocus = true): void {
		if (!this.visible) {
			return;
		}
		this.visible = false;
		this.activeSession?.view.setVisible(false);
		this.panel.hidden = true;
		this.launcher.classList.remove('active');
		this.launcher.setAttribute('aria-expanded', 'false');
		if (restoreFocus) {
			this.previousFocus?.focus();
		}
		this.previousFocus = undefined;
	}

	private layout(): void {
		const session = this.activeSession;
		if (!this.visible || !session || this.content.clientHeight <= 0 || this.content.clientWidth <= 0) {
			return;
		}
		session.view.orthogonalSize = this.content.clientWidth;
		session.view.layout(this.content.clientHeight);
	}

	private get activeSession(): ILocalAIFloatingChatSession | undefined {
		return this.sessions.find(session => session.id === this.activeSessionId);
	}

	private restoreSessions(): void {
		let stored: IStoredLocalAIFloatingChatState | undefined;
		try {
			const raw = this.storageService.get(localAIFloatingSessionsStorageKey, StorageScope.WORKSPACE);
			stored = raw ? JSON.parse(raw) as IStoredLocalAIFloatingChatState : undefined;
		} catch {
			this.storageService.remove(localAIFloatingSessionsStorageKey, StorageScope.WORKSPACE);
		}

		const ids = Array.isArray(stored?.sessions)
			? stored.sessions
				.map(session => session?.id)
				.filter((id): id is string => typeof id === 'string' && id.length > 0)
				.filter((id, index, all) => all.indexOf(id) === index)
				.slice(0, maximumFloatingChatSessions)
			: [];
		for (const id of ids) {
			this.createSession(id, false);
		}
		if (!this.sessions.length) {
			// Preserve the original single-chat history on the first upgrade.
			this.createSession('default', false);
		}
		const activeId = stored?.activeSessionId && this.sessions.some(session => session.id === stored.activeSessionId)
			? stored.activeSessionId
			: this.sessions[0].id;
		this.activateSession(activeId, false);
	}

	private createSession(id = generateUuid(), activate = true): void {
		const existing = this.sessions.find(session => session.id === id);
		if (existing) {
			if (activate) {
				this.activateSession(existing.id);
			}
			return;
		}
		if (this.sessions.length >= maximumFloatingChatSessions) {
			this.notificationService.warn(localize('localAIMaximumChats', "Orbyte supports up to {0} open chats. Close an idle chat before opening another.", maximumFloatingChatSessions));
			return;
		}

		const host = dom.append(this.content, dom.$('.local-ai-floating-session-host'));
		host.hidden = true;
		const disposables = new DisposableStore();
		const view = this.instantiationService.createInstance(LocalAIViewPane, {
			// ViewPane resolves its registered container and location from this ID.
			// The chat session ID is intentionally separate so several isolated
			// instances can share the registered view descriptor safely.
			id: LocalAIViewPane.ID,
			title: localize('localAIFloatingTitle', "Orbyte AI"),
			minimumBodySize: 0,
			maximumBodySize: Number.POSITIVE_INFINITY,
			localAIChatSessionId: id,
			onDidRequestNewChat: () => this.createSession(),
		});
		view.headerVisible = false;
		view.render();
		host.append(view.element);
		view.setVisible(false);
		disposables.add(view);

		const session: ILocalAIFloatingChatSession = {
			id,
			host,
			view,
			disposables,
			activity: view.getActivity(),
		};
		disposables.add(view.onDidChangeActivity(activity => {
			session.activity = activity;
			this.renderTabs();
			this.updateLauncher();
			this.persistSessions();
		}));
		this.sessions.push(session);
		this.renderTabs();
		this.updateLauncher();
		if (activate) {
			this.activateSession(id);
		} else {
			this.persistSessions();
		}
	}

	private activateSession(id: string, focus = true): void {
		const next = this.sessions.find(session => session.id === id);
		if (!next) {
			return;
		}
		const current = this.activeSession;
		if (current && current !== next) {
			current.view.setVisible(false);
			current.host.hidden = true;
		}
		this.activeSessionId = id;
		next.host.hidden = false;
		next.view.setVisible(this.visible);
		this.renderTabs();
		this.persistSessions();
		this.layout();
		if (focus && this.visible) {
			next.view.focusInput();
		}
	}

	private closeSession(id: string): void {
		const index = this.sessions.findIndex(session => session.id === id);
		if (index < 0) {
			return;
		}
		const session = this.sessions[index];
		if (!session.view.canClose()) {
			this.activateSession(id);
			this.notificationService.warn(session.activity.running
				? localize('localAIChatStillRunning', "This chat is still working in the background. Stop it before closing the tab.")
				: localize('localAIChatHasPendingChanges', "Accept or reject this chat's pending changes before closing the tab."));
			return;
		}

		session.view.clearSessionStorage();
		this.sessions.splice(index, 1);
		session.disposables.dispose();
		session.host.remove();
		if (!this.sessions.length) {
			this.activeSessionId = undefined;
			this.createSession(generateUuid());
			return;
		}
		if (this.activeSessionId === id) {
			this.activeSessionId = undefined;
			this.activateSession(this.sessions[Math.min(index, this.sessions.length - 1)].id);
		} else {
			this.renderTabs();
			this.updateLauncher();
			this.persistSessions();
		}
	}

	private renderTabs(): void {
		this.tabDisposables.clear();
		dom.clearNode(this.tabs);
		for (const session of this.sessions) {
			const item = dom.append(this.tabs, dom.$('.local-ai-floating-tab'));
			item.classList.toggle('active', session.id === this.activeSessionId);
			item.classList.toggle('running', session.activity.running);
			item.classList.toggle('pending', session.activity.pendingChanges > 0);
			const button = dom.append(item, dom.$<HTMLButtonElement>('button.local-ai-floating-tab-button'));
			button.type = 'button';
			button.setAttribute('role', 'tab');
			button.setAttribute('aria-selected', String(session.id === this.activeSessionId));
			button.title = session.activity.title;
			const state = dom.append(button, dom.$('span.local-ai-floating-tab-state'));
			state.setAttribute('aria-hidden', 'true');
			const label = dom.append(button, dom.$('span.local-ai-floating-tab-label'));
			label.textContent = session.activity.title;
			this.tabDisposables.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => this.activateSession(session.id)));

			const close = dom.append(item, dom.$<HTMLButtonElement>('button.local-ai-floating-tab-close'));
			close.type = 'button';
			close.textContent = '×';
			close.title = localize('localAICloseChatTab', "Close chat");
			close.setAttribute('aria-label', localize('localAICloseNamedChatTab', "Close chat: {0}", session.activity.title));
			this.tabDisposables.add(dom.addDisposableListener(close, dom.EventType.CLICK, event => {
				event.stopPropagation();
				this.closeSession(session.id);
			}));
		}
		const add = dom.append(this.tabs, dom.$<HTMLButtonElement>('button.local-ai-floating-tab-add'));
		add.type = 'button';
		add.textContent = '+';
		add.title = localize('localAINewChatTab', "New chat tab");
		add.setAttribute('aria-label', localize('localAINewChatTab', "New chat tab"));
		add.disabled = this.sessions.length >= maximumFloatingChatSessions;
		this.tabDisposables.add(dom.addDisposableListener(add, dom.EventType.CLICK, () => this.createSession()));
	}

	private updateLauncher(): void {
		const running = this.sessions.filter(session => session.activity.running);
		this.launcher.classList.toggle('working', running.length > 0);
		if (!running.length) {
			this.launcherProgress.style.removeProperty('background');
			this.launcherProgressValue.textContent = '';
			this.launcher.title = localize('openLocalAI', "Open Orbyte AI");
			this.launcher.setAttribute('aria-label', localize('openLocalAI', "Open Orbyte AI"));
			return;
		}

		const knownProgress = running
			.map(session => session.activity.progress)
			.filter((progress): progress is number => typeof progress === 'number');
		const progress = knownProgress.length
			? knownProgress.reduce((total, value) => total + value, 0) / knownProgress.length
			: undefined;
		const progressDegrees = Math.max(0.04, progress ?? 0.18) * 360;
		this.launcherProgress.style.background = `conic-gradient(#30e5ff ${progressDegrees}deg, color-mix(in srgb, #30e5ff 16%, #0c1d54) 0)`;
		this.launcherProgressValue.textContent = running.length > 1
			? String(running.length)
			: progress === undefined ? '…' : `${Math.round(progress * 100)}`;
		const description = running.length === 1
			? localize('localAIChatWorking', "1 Orbyte chat is working in the background")
			: localize('localAIChatsWorking', "{0} Orbyte chats are working in the background", running.length);
		this.launcher.title = description;
		this.launcher.setAttribute('aria-label', description);
	}

	private persistSessions(): void {
		this.storageService.store(localAIFloatingSessionsStorageKey, JSON.stringify({
			activeSessionId: this.activeSessionId,
			sessions: this.sessions.map(session => ({ id: session.id })),
		}), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private createBrandImage(className: string): HTMLImageElement {
		const image = dom.$<HTMLImageElement>(`img.${className}`);
		image.alt = '';
		image.draggable = false;
		image.src = orbyteBrandIconSrc;
		return image;
	}
}

registerSingleton(ILocalAIFloatingChatService, LocalAIFloatingChatService, InstantiationType.Delayed);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.openLocalAI',
			title: localize2('openLocalAI', "Open Orbyte AI"),
			f1: true,
		});
	}

	run(accessor: ServicesAccessor): void {
		accessor.get(ILocalAIFloatingChatService).toggle();
	}
});

class LocalAIStartupContribution implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.localAIStartup';

	constructor(
		@ILocalAIFloatingChatService private readonly floatingChatService: ILocalAIFloatingChatService,
		@ILocalLLMService private readonly localLLMService: ILocalLLMService,
		@INotificationService private readonly notificationService: INotificationService,
		@IStorageService private readonly storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
	) {
		if (storageService.getNumber(localAIFloatingMigrationVersionStorageKey, StorageScope.APPLICATION, 0) < localAIFloatingMigrationVersion) {
			layoutService.setPartHidden(true, Parts.AUXILIARYBAR_PART);
			storageService.store(localAIFloatingMigrationVersionStorageKey, localAIFloatingMigrationVersion, StorageScope.APPLICATION, StorageTarget.MACHINE);
		}
		void this.offerFirstRunModelSetup();
	}

	private async offerFirstRunModelSetup(): Promise<void> {
		if (this.storageService.getNumber(localAIModelSetupPromptVersionStorageKey, StorageScope.APPLICATION, 0) >= localAIModelSetupPromptVersion) {
			return;
		}

		try {
			const catalog = await this.localLLMService.getModelCatalog();
			if (!catalog.setupRequired) {
				return;
			}

			const recommended = catalog.models.find(model => model.recommendation === 'recommended');
			if (!recommended) {
				return;
			}

			this.storageService.store(localAIModelSetupPromptVersionStorageKey, localAIModelSetupPromptVersion, StorageScope.APPLICATION, StorageTarget.MACHINE);
			const memory = this.formatBytes(catalog.hardware.memoryBytes);
			const modelSize = this.formatBytes(recommended.sizeBytes);
			const action = recommended.installed
				? localize('localAIUseRecommendedModelPrompt', "Use {0}", recommended.name)
				: localize('localAIDownloadRecommendedModelPrompt', "Download {0}", recommended.name);
			this.notificationService.prompt(
				Severity.Info,
				localize(
					'localAIFirstRunModelPrompt',
					"Orbyte detected {0} memory and {1} CPU cores. {2} ({3}) is recommended for this computer. Downloading requires your approval.",
					memory,
					catalog.hardware.cpuCount,
					recommended.name,
					modelSize,
				),
				[
					{
						label: action,
						run: () => this.installRecommendedModel(recommended),
					},
					{
						label: localize('localAIReviewModelsPrompt', "Review Models"),
						run: () => this.floatingChatService.showModels(),
					},
				],
			);
		} catch (error) {
			this.notificationService.error(localize('localAIModelSetupPromptError', "Unable to prepare local AI setup: {0}", error instanceof Error ? error.message : String(error)));
		}
	}

	private async installRecommendedModel(model: ILocalLLMModelInfo): Promise<void> {
		this.floatingChatService.showModels();
		try {
			if (model.installed) {
				await this.localLLMService.selectModel(model.id);
			} else {
				await this.localLLMService.downloadModel(model.id);
			}
		} catch (error) {
			this.notificationService.error(localize('localAIModelDownloadError', "Model download failed: {0}", error instanceof Error ? error.message : String(error)));
		}
	}

	private formatBytes(bytes: number): string {
		return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
	}
}

registerWorkbenchContribution2(LocalAIStartupContribution.ID, LocalAIStartupContribution, WorkbenchPhase.AfterRestored);
