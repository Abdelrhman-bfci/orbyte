# Local LLM Runtime

Product builds place the platform-specific `llama-server` executable in this directory before running the VS Code packaging task. GGUF models are deliberately excluded from every package. On first launch, Orbyte recommends a model for the machine and downloads it only after the user approves the download.

Expected layout:

```text
resources/local-llm/
├── darwin-arm64/llama-server
├── darwin-x64/llama-server
├── linux-arm64/llama-server
├── linux-x64/llama-server
├── win32-arm64/llama-server.exe
└── win32-x64/llama-server.exe
```

Only the directory matching the target `platform-arch` is copied into a packaged application. The executable must retain its executable bit on macOS and Linux.

The development resources can contain local model files for testing, but the packaging task never copies them. Runtime and downloaded-model licenses must be presented with their respective artifacts.
