# Visual Studio Code - Open Source ("Code - OSS")
[![Feature Requests](https://img.shields.io/github/issues/microsoft/vscode/feature-request.svg)](https://github.com/microsoft/vscode/issues?q=is%3Aopen+is%3Aissue+label%3Afeature-request+sort%3Areactions-%2B1-desc)
[![Bugs](https://img.shields.io/github/issues/microsoft/vscode/bug.svg)](https://github.com/microsoft/vscode/issues?utf8=✓&q=is%3Aissue+is%3Aopen+label%3Abug)

## The Repository

This repository ("`Code - OSS`") is where we (Microsoft) develop the [Visual Studio Code](https://code.visualstudio.com) product together with the community. Not only do we work on code and issues here, but we also publish our [roadmap](https://github.com/microsoft/vscode/wiki/Roadmap), [monthly iteration plans](https://github.com/microsoft/vscode/wiki/Iteration-Plans), and our [endgame plans](https://github.com/microsoft/vscode/wiki/Running-the-Endgame). This source code is available to everyone under the standard [MIT license](https://github.com/microsoft/vscode/blob/main/LICENSE.txt).

## Run Orbyte From Source

Use the Node.js version pinned in [`.nvmrc`](.nvmrc) and the pnpm version pinned in [`package.json`](package.json). The following setup works with `fnm`; `nvm use` is also supported.

### Linux development

Install and compile the repository once:

```bash
fnm install
fnm use
corepack enable
pnpm install
pnpm run compile
```

Launch the IDE:

```bash
pnpm run orbyte:run:linux
```

For active development, keep the compiler running in one terminal and launch Orbyte from another:

```bash
# Terminal 1
pnpm run watch

# Terminal 2, after the first watch build finishes
pnpm run orbyte:run:linux
```

For a fresh compile followed by launch, use the single command:

```bash
pnpm run orbyte:dev:linux
```

### Windows development

Use 64-bit Windows with Git, `fnm`, Python 3, and Visual Studio 2022 Build Tools
with **Desktop development with C++** and a Windows SDK installed. Keep at least
30 GB free for dependencies, compilation output, and the packaged application.

Clone, compile, and launch from Command Prompt (`cmd.exe`):

```bat
git clone https://github.com/Abdelrhman-bfci/orbyte.git
cd orbyte
call scripts\setup-windows.cmd
pnpm run compile
pnpm run orbyte:run:windows
```

The setup script installs `fnm` with WinGet when necessary, activates Node.js
24.22.1, installs pnpm 12.16.0, and installs the repository dependencies. It
stops with a clear message if the active versions do not match the versions
pinned by the repository. If WinGet has just installed `fnm` but Windows has
not refreshed `PATH`, close Command Prompt, open a new one, and run the setup
script again.

For an existing clone, update it before running the setup:

```bat
cd /d D:\docker\orbyte
git pull origin main
call scripts\setup-windows.cmd
pnpm run compile
pnpm run orbyte:run:windows
```

The equivalent commands in PowerShell are:

```powershell
fnm env --use-on-cd --shell powershell | Out-String | Invoke-Expression
fnm install 24.22.1
fnm use 24.22.1
npm install --global pnpm@12.16.0
$env:NODE_OPTIONS = '--max-old-space-size=8192'
pnpm install --frozen-lockfile
pnpm run compile
pnpm run orbyte:run:windows
```

For active development, run `pnpm run watch` in one PowerShell window. After its first build finishes, run `pnpm run orbyte:run:windows` in a second window. A fresh compile followed by launch is also available as one command:

```powershell
pnpm run orbyte:dev:windows
```

The run commands start the development IDE from `.build/electron`; they do not create a distributable application. Use the production commands below to create a portable build or installer.

## Java and Spring Boot

Orbyte bundles Java language support, the Java debugger, Maven, Gradle, and Spring Boot tooling. Open a project folder and Orbyte automatically detects:

- Spring Boot applications from `@SpringBootApplication`, `SpringApplication.run`, and Spring Boot build dependencies.
- Maven projects and the project-local `mvnw`/`mvnw.cmd` wrapper.
- Gradle Groovy or Kotlin projects and the project-local `gradlew`/`gradlew.bat` wrapper.
- Ant projects from `build.xml`, including common run, build, and test targets.
- Nested projects in multi-root workspaces.

Install a JDK supported by the project, then open its folder. The Spring Boot main class shows **Run Spring Boot** and **Debug Spring Boot** actions above the class. The editor title and Explorer context menu also provide Run, Debug, Build, and Test. Debug launches the Java debugger with breakpoints, stepping, variables, watches, and the debug console; it does not require a hand-written `launch.json`.

Use **Orbyte: Show Java Project Actions** from the Command Palette or click the `Spring Boot · Maven/Gradle/Ant` status item to choose an action. Use **Orbyte: Refresh Java Project Detection** after changing the project layout if automatic refresh has not completed yet.

### EJB and application servers

Orbyte detects deployable Jakarta EE and Java EE projects from Maven, Gradle, or Ant configuration, including EJB JAR, WAR, and EAR packaging. EJB classes annotated with `@Stateless`, `@Stateful`, `@Singleton`, or `@MessageDriven` show a **Build & Deploy EJB** action in the editor.

Open the **Application Servers** section in Explorer and choose **Add Application Server…**. Supported local server installations are:

- JBoss EAP and WildFly: select the installation directory containing `bin/standalone` and `bin/jboss-cli`. Orbyte also bundles Red Hat's JBoss Toolkit and RSP server UI.
- IBM WebSphere Application Server traditional: select a profile directory containing `bin/startServer`, `bin/stopServer`, and `bin/wsadmin`. If the WebSphere installation directory is selected, Orbyte offers its available profiles.

The server view provides start, stop, build-and-deploy, and Java debugger actions. WildFly can be started directly in JDWP debug mode. For traditional WebSphere, enable debug mode for the JVM in the WebSphere administrative console and use **Attach Java Debugger** with the configured port. Deployment builds the detected project with its Maven or Gradle wrapper (or Ant), selects the newest EAR/WAR/EJB JAR, and deploys it through `jboss-cli` or `wsadmin`.

## Build Orbyte Distributions

Orbyte is this repository's privacy-first AI editor distribution. Production builds bundle the local AI integration and the platform-specific `llama-server`, but they do not bundle a multi-gigabyte GGUF model. On first launch, Orbyte detects the machine's memory, CPU, GPU mode, and free disk space, asks for download approval, and recommends a suitable Qwen2.5-Coder model. Downloaded models are SHA-256 verified and stored in the user's application-data directory instead of the installation directory. Build on the target operating system because Electron and several dependencies contain platform-native binaries. The `orbyte:build:*` scripts stop with a clear error when the current operating system does not match the requested package.

### Prerequisites

- Node.js and the pnpm version pinned by the `packageManager` field in [`package.json`](package.json).
- At least 6 GB of available memory for the production bundler.
- A matching `llama-server` distribution for every target platform. Keep its companion dynamic libraries in the same platform directory.

The expected resource layout is:

```text
resources/local-llm/
├── darwin-arm64/
│   ├── llama-server
│   └── *.dylib
├── darwin-x64/
│   ├── llama-server
│   └── *.dylib
├── win32-x64/
│   ├── llama-server.exe
│   └── *.dll
├── win32-arm64/
│   ├── llama-server.exe
│   └── *.dll
├── linux-x64/
│   ├── llama-server
│   └── *.so*
└── linux-arm64/
    ├── llama-server
    └── *.so*
```

On macOS and Linux, make the server executable before packaging:

```bash
chmod +x resources/local-llm/<platform-arch>/llama-server
```

Install repository dependencies once before running a production build:

```bash
fnm install
fnm use
corepack enable
pnpm install
```

### macOS

Build Apple Silicon (`arm64`):

```bash
NODE_OPTIONS=--max-old-space-size=6144 pnpm run gulp vscode-darwin-arm64
```

Build an Intel Mac (`x64`):

```bash
NODE_OPTIONS=--max-old-space-size=6144 pnpm run gulp vscode-darwin-x64
```

The application is generated at `../VSCode-darwin-arm64/Orbyte.app` or `../VSCode-darwin-x64/Orbyte.app`. For a local unsigned build, apply an ad-hoc signature and create a distributable ZIP:

```bash
codesign --force --deep --sign - "../VSCode-darwin-arm64/Orbyte.app"
ditto -c -k --sequesterRsrc --keepParent \
  "../VSCode-darwin-arm64/Orbyte.app" \
  "../Orbyte-macOS-arm64.zip"
```

Run the packaged application:

```bash
open "../VSCode-darwin-arm64/Orbyte.app"
```

An ad-hoc signature is suitable for local testing only. Public distribution requires an Apple Developer ID Application signature, hardened runtime, notarization, and stapling before recreating the ZIP.

### Windows

Run the Windows build from PowerShell on a Windows machine.

Build the x64 application and per-user installer:

```powershell
$env:NODE_OPTIONS = "--max-old-space-size=6144"
pnpm run orbyte:build:windows:x64
pnpm run orbyte:installer:windows:x64
```

From Command Prompt (`cmd.exe`), use:

```bat
set NODE_OPTIONS=--max-old-space-size=8192
pnpm run orbyte:build:windows:x64
pnpm run orbyte:installer:windows:x64
```

Build Windows ARM64:

```powershell
$env:NODE_OPTIONS = "--max-old-space-size=6144"
pnpm run orbyte:build:windows:arm64
pnpm run orbyte:installer:windows:arm64
```

The portable application is generated at `..\VSCode-win32-x64\` or `..\VSCode-win32-arm64\`. Per-user installers are generated under `.build\win32-x64\user-setup\` or `.build\win32-arm64\user-setup\`. Replace `user-setup` with `system-setup` to create a machine-wide installer.

Official distribution should sign the application binaries and installer with a trusted Windows code-signing certificate. The setup tasks can receive the repository's `--sign` option when the signing environment is configured.

To build and smoke-test the Windows x64 installer without a local Windows machine, run the **Build and test Windows x64 installer** workflow in GitHub Actions. It builds on a native Windows x64 runner, silently installs Orbyte into a temporary directory, verifies both executables are x64 PE files, launches the installed application with `--version`, rejects bundled `.gguf` and `.safetensors` model files, and uploads `OrbyteUserSetup-x64.exe` as the `Orbyte-Windows-x64-tested-installer` artifact.

### Linux

Build the x64 application folder and archive:

```bash
export NODE_OPTIONS=--max-old-space-size=6144
pnpm run orbyte:build:linux:x64
tar -czf Orbyte-linux-x64.tar.gz -C .. VSCode-linux-x64
```

Build Linux ARM64 by replacing `x64` with `arm64`:

```bash
export NODE_OPTIONS=--max-old-space-size=6144
pnpm run orbyte:build:linux:arm64
tar -czf Orbyte-linux-arm64.tar.gz -C .. VSCode-linux-arm64
```

Create a Debian package after building the matching application folder:

```bash
pnpm run gulp vscode-linux-x64-prepare-deb
pnpm run gulp vscode-linux-x64-build-deb
find .build/linux/deb -name '*.deb'
```

Create an RPM package:

```bash
pnpm run gulp vscode-linux-x64-prepare-rpm
pnpm run gulp vscode-linux-x64-build-rpm
find .build/linux/rpm -name '*.rpm'
```

Use the equivalent `arm64` task names for ARM64 packages.

#### Build Linux on macOS with Docker

The Docker build uses an isolated Linux source tree, so it never replaces the macOS `node_modules`. Docker Desktop must be running, and at least 25 GB of free disk space is recommended. Install the checksum-verified `llama.cpp b12387` CPU runtime matching the target architecture:

```bash
pnpm run orbyte:runtime:linux:x64
# Or, for Linux ARM64:
pnpm run orbyte:runtime:linux:arm64
```

Build the common Linux x64 distribution on either an Intel or Apple Silicon Mac:

```bash
pnpm run orbyte:build:linux:x64:docker
```

On Apple Silicon, build Linux ARM64 without x64 emulation:

```bash
pnpm run orbyte:build:linux:arm64:docker
```

The completed archive is written to `dist/Orbyte-linux-x64.tar.gz` or `dist/Orbyte-linux-arm64.tar.gz`. The x64 build uses Docker's `linux/amd64` emulation on Apple Silicon and is therefore slower than the ARM64 build.

No GGUF model is copied into the archive. The installed application presents the hardware-matched model picker on first launch and downloads a model only after the user approves it.

## Visual Studio Code

<p align="center">
  <img alt="VS Code in action" src="https://github.com/user-attachments/assets/56af271c-949d-454c-a3ea-16188c063414">
</p>

[Visual Studio Code](https://code.visualstudio.com) is a distribution of the `Code - OSS` repository with Microsoft-specific customizations released under a traditional [Microsoft product license](https://code.visualstudio.com/License/).

[Visual Studio Code](https://code.visualstudio.com) combines the simplicity of a code editor with what developers need for their core edit-build-debug cycle. It provides comprehensive code editing, navigation, and understanding support along with lightweight debugging, a rich extensibility model, and lightweight integration with existing tools.

Visual Studio Code is updated monthly with new features and bug fixes. You can download it for Windows, macOS, and Linux on the [Visual Studio Code website](https://code.visualstudio.com/Download). To get the latest releases every day, install the [Insiders build](https://code.visualstudio.com/insiders).

## Contributing

There are many ways in which you can participate in this project, for example:

* [Submit bugs and feature requests](https://github.com/microsoft/vscode/issues), and help us verify them as they are checked in
* Review [source code changes](https://github.com/microsoft/vscode/pulls)
* Review the [documentation](https://github.com/microsoft/vscode-docs) and make pull requests for anything from typos to new content.

If you are interested in fixing issues and contributing directly to the codebase, please see the document [How to Contribute](https://github.com/microsoft/vscode/wiki/How-to-Contribute), which covers the following:

* [How to build and run from source](https://github.com/microsoft/vscode/wiki/How-to-Contribute)
* [The development workflow, including debugging and running tests](https://github.com/microsoft/vscode/wiki/How-to-Contribute#debugging)
* [Coding guidelines](https://github.com/microsoft/vscode/wiki/Coding-Guidelines)
* [Submitting pull requests](https://github.com/microsoft/vscode/wiki/How-to-Contribute#pull-requests)
* [Finding an issue to work on](https://github.com/microsoft/vscode/wiki/How-to-Contribute#where-to-contribute)
* [Contributing to translations](https://aka.ms/vscodeloc)

## Feedback

* Ask a question on [Stack Overflow](https://stackoverflow.com/questions/tagged/vscode)
* [Request a new feature](CONTRIBUTING.md)
* Upvote [popular feature requests](https://github.com/microsoft/vscode/issues?q=is%3Aopen+is%3Aissue+label%3Afeature-request+sort%3Areactions-%2B1-desc)
* [File an issue](https://github.com/microsoft/vscode/issues)
* Connect with the extension author community on [GitHub Discussions](https://github.com/microsoft/vscode-discussions/discussions) or [Slack](https://aka.ms/vscode-dev-community)
* Follow [@code](https://x.com/code) and let us know what you think!

See our [wiki](https://github.com/microsoft/vscode/wiki/Feedback-Channels) for a description of each of these channels and information on some other available community-driven channels.

## Related Projects

Many of the core components and extensions to VS Code live in their own repositories on GitHub. For example, the [node debug adapter](https://github.com/microsoft/vscode-node-debug) and the [mono debug adapter](https://github.com/microsoft/vscode-mono-debug) repositories are separate from each other. For a complete list, please visit the [Related Projects](https://github.com/microsoft/vscode/wiki/Related-Projects) page on our [wiki](https://github.com/microsoft/vscode/wiki).

## Bundled Extensions

VS Code includes a set of built-in extensions located in the [extensions](extensions) folder, including grammars and snippets for many languages. Extensions that provide rich language support (inline suggestions, Go to Definition) for a language have the suffix `language-features`. For example, the `json` extension provides coloring for `JSON` and the `json-language-features` extension provides rich language support for `JSON`.

## Development Container

This repository includes a Visual Studio Code Dev Containers / GitHub Codespaces development container.

* For [Dev Containers](https://aka.ms/vscode-remote/download/containers), use the **Dev Containers: Clone Repository in Container Volume...** command, which creates a Docker volume for better disk I/O on macOS and Windows.
  * If you already have VS Code and Docker installed, you can also click [here](https://vscode.dev/redirect?url=vscode://ms-vscode-remote.remote-containers/cloneInVolume?url=https://github.com/microsoft/vscode) to get started. This will cause VS Code to automatically install the Dev Containers extension if needed, clone the source code into a container volume, and spin up a dev container for use.

* For Codespaces, install the [GitHub Codespaces](https://marketplace.visualstudio.com/items?itemName=GitHub.codespaces) extension in VS Code, and use the **Codespaces: Create New Codespace** command.

Docker / the Codespace should have at least **4 cores and 6 GB of RAM (8 GB recommended)** to run a full build. See the [development container README](.devcontainer/README.md) for more information.

## Code of Conduct

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/). For more information, see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## License

Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the [MIT](LICENSE.txt) license.
