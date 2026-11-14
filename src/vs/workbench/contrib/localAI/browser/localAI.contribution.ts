/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/localAI.css';
import './inlineEditController.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewDescriptor, IViewsRegistry, ViewContainerLocation } from '../../../common/views.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { ILocalAIContextService, LocalAIContextService } from './context/localAIContext.js';
import { ILocalAISymbolRetrieverService, LocalAISymbolRetrieverService } from './context/localAISymbolRetriever.js';
import { LocalAIViewPane } from './localAIView.js';

registerSingleton(ILocalAISymbolRetrieverService, LocalAISymbolRetrieverService, InstantiationType.Delayed);
registerSingleton(ILocalAIContextService, LocalAIContextService, InstantiationType.Delayed);

const localAIContainerId = 'workbench.view.localAIContainer';
const localAIIcon = registerIcon('local-ai-view-icon', Codicon.chatSparkle, localize('localAIViewIcon', "View icon of the Orbyte AI view."));

const viewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: localAIContainerId,
	title: localize2('localAIContainerTitle', "Orbyte AI"),
	icon: localAIIcon,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [localAIContainerId, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: localAIContainerId,
	hideIfEmpty: false,
	order: 2,
}, ViewContainerLocation.AuxiliaryBar);

const viewDescriptor: IViewDescriptor = {
	id: LocalAIViewPane.ID,
	name: localize2('localAIViewTitle', "Orbyte AI"),
	containerIcon: localAIIcon,
	canToggleVisibility: false,
	canMoveView: false,
	hideByDefault: false,
	ctorDescriptor: new SyncDescriptor(LocalAIViewPane),
	openCommandActionDescriptor: {
		id: 'workbench.action.openLocalAI',
		title: localize2('openLocalAI', "Open Orbyte AI"),
		order: 2,
	},
};

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([viewDescriptor], viewContainer);

class LocalAIStartupContribution implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.localAIStartup';

	constructor(@IViewsService viewsService: IViewsService) {
		void viewsService.openViewContainer(localAIContainerId, false);
	}
}

registerWorkbenchContribution2(LocalAIStartupContribution.ID, LocalAIStartupContribution, WorkbenchPhase.AfterRestored);
