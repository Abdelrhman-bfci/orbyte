import { spawnSync } from 'node:child_process';

const [targetPlatform, arch, packageKind = 'app'] = process.argv.slice(2);
const supportedPlatforms = new Set(['linux', 'win32']);
const supportedArchitectures = new Set(['x64', 'arm64']);
const supportedKinds = new Set(['app', 'user-setup']);

if (!supportedPlatforms.has(targetPlatform) || !supportedArchitectures.has(arch) || !supportedKinds.has(packageKind)) {
	console.error('Usage: node scripts/orbyte-build.mjs <linux|win32> <x64|arm64> [app|user-setup]');
	process.exit(2);
}

if (packageKind === 'user-setup' && targetPlatform !== 'win32') {
	console.error('[Orbyte] The user-setup package is available only for Windows.');
	process.exit(2);
}

if (process.platform !== targetPlatform) {
	const targetName = targetPlatform === 'win32' ? 'Windows' : 'Linux';
	const hostName = process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : process.platform;
	console.error(`[Orbyte] ${targetName} packages must be built on ${targetName}. Current host: ${hostName}.`);
	console.error(`[Orbyte] Run this command on a ${targetName} ${arch} machine or CI runner.`);
	process.exit(1);
}

if (process.arch !== arch) {
	console.warn(`[Orbyte] Building ${arch} on a ${process.arch} host. Native dependencies may require a matching ${arch} runner.`);
}

const task = `vscode-${targetPlatform}-${arch}${packageKind === 'user-setup' ? '-user-setup' : ''}`;
const command = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'pnpm';
const tasks = packageKind === 'user-setup'
	? [`vscode-win32-${arch}-inno-updater`, task]
	: [task];

for (const buildTask of tasks) {
	const args = process.platform === 'win32'
		? ['/d', '/s', '/c', `pnpm.cmd run gulp ${buildTask}`]
		: ['run', 'gulp', buildTask];
	const result = spawnSync(command, args, { stdio: 'inherit' });

	if (result.error) {
		console.error(`[Orbyte] Failed to start ${buildTask}: ${result.error.message}`);
		process.exit(1);
	}

	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
}

process.exit(0);
