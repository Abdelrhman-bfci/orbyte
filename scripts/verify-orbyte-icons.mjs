/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Orbyte. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const requiredLocalAssets = [
	'resources/branding/orbyte-icon-source.png',
	'resources/branding/orbyte-icon-1024.png',
	'resources/darwin/code.icns',
	'resources/linux/code.png',
	'resources/win32/code.ico',
	'resources/win32/code_70x70.png',
	'resources/win32/code_150x150.png',
	'resources/server/favicon.ico',
	'resources/server/code-192.png',
	'resources/server/code-512.png',
	'src/vs/workbench/browser/media/orbyte-brand.svg',
	'extensions/orbyte-spring/media/orbyte-brand.svg',
];

const brandSurfaces = [
	'src/vs/workbench/browser/orbyteBrand.ts',
	'src/vs/workbench/contrib/localAI/browser/localAI.contribution.ts',
	'src/vs/workbench/contrib/welcomeGettingStarted/browser/orbyteTaskDashboard.ts',
	'extensions/orbyte-spring/src/environmentSetup.ts',
];

const errors = [];
for (const relativePath of requiredLocalAssets) {
	const absolutePath = path.join(repositoryRoot, relativePath);
	if (!existsSync(absolutePath) || statSync(absolutePath).size === 0) {
		errors.push(`Missing local Orbyte icon asset: ${relativePath}`);
	}
}

const windowsIconPath = path.join(repositoryRoot, 'resources/win32/code.ico');
if (existsSync(windowsIconPath)) {
	const icon = readFileSync(windowsIconPath);
	const sizes = new Set();
	if (icon.length >= 6 && icon.readUInt32LE(0) === 0x00010000) {
		const count = icon.readUInt16LE(4);
		for (let offset = 6; offset < 6 + count * 16 && offset + 16 <= icon.length; offset += 16) {
			const width = icon[offset] || 256;
			const height = icon[offset + 1] || 256;
			const length = icon.readUInt32LE(offset + 8);
			const start = icon.readUInt32LE(offset + 12);
			if (width === height && length > 0 && start >= 6 + count * 16 && start + length <= icon.length) {
				sizes.add(width);
			}
		}
	}
	for (const size of [16, 24, 32, 48, 256]) {
		if (!sizes.has(size)) {
			errors.push('The Windows app icon is missing a valid ' + size + '×' + size + ' frame.');
		}
	}
}

for (const relativePath of brandSurfaces) {
	const source = readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
	if (/(?:src|icon|logo)\s*[:=]\s*['"`]https?:\/\//iu.test(source)) {
		errors.push(`Remote icon URL found in Orbyte brand surface: ${relativePath}`);
	}
}

const brandModule = readFileSync(path.join(repositoryRoot, brandSurfaces[0]), 'utf8');
if (!brandModule.includes("FileAccess.asBrowserUri('vs/workbench/browser/media/orbyte-brand.svg')")) {
	errors.push('The workbench brand icon must resolve from the bundled orbyte-brand.svg asset.');
}

const product = JSON.parse(readFileSync(path.join(repositoryRoot, 'product.json'), 'utf8'));
if (product.linuxIconName !== 'orbyte') {
	errors.push('product.json must keep linuxIconName set to the bundled Orbyte icon name.');
}

if (errors.length) {
	for (const error of errors) {
		console.error(`[Orbyte icons] ${error}`);
	}
	process.exit(1);
}

console.log(`[Orbyte icons] Verified ${requiredLocalAssets.length} bundled icon assets and ${brandSurfaces.length} offline brand surfaces.`);
