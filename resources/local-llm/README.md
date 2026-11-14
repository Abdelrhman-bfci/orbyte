# Bundled Local LLM Runtime

Product builds place the platform-specific `llama-server` executable and the Qwen2.5-Coder GGUF model in this directory before running the VS Code packaging task.

Expected layout:

```text
resources/local-llm/
├── darwin-arm64/llama-server
├── darwin-x64/llama-server
├── linux-arm64/llama-server
├── linux-x64/llama-server
├── win32-arm64/llama-server.exe
├── win32-x64/llama-server.exe
└── models/qwen2.5-coder.gguf
```

Only the directory matching the target `platform-arch` and the shared model directory are copied into a packaged application. The executable must retain its executable bit on macOS and Linux.

The development bundle currently contains the official Apple Silicon llama.cpp
`b12387` runtime and Qwen2.5-Coder 3B Instruct `Q4_K_M` model. The model SHA-256
is `724fb256bec1ff062b2f65e4569e871ad2e95ab2a3989723d1769c54294730b7`.
The upstream llama.cpp and Qwen licenses are shipped alongside their respective
artifacts.
