/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Orbyte. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { FileAccess } from '../../base/common/network.js';

/**
 * The single bundled brand asset used inside the workbench. Keep this path local:
 * remote URLs make the product identity depend on connectivity and third parties.
 */
export const orbyteBrandIconSrc = FileAccess.asBrowserUri('vs/workbench/browser/media/orbyte-brand.svg').toString(true);
