# Orbyte IntelliJ Compatibility

Orbyte uses a clean-room compatibility approach on top of the VS Code workbench. It does not copy JetBrains source code, branding, or proprietary assets. The goal is compatible workflows and keyboard habits, with a private local-LLM agent built into the editor.

## Implemented baseline

| IntelliJ workflow | Orbyte implementation |
| --- | --- |
| Project tool window | Explorer with automatic active-file reveal, hierarchy guides, Outline, and Timeline |
| Structure and navigation | Breadcrumbs, sticky scopes, Outline symbols, semantic highlighting, CodeLens, and inlay hints |
| Inspections and intentions | Problems view, inline diagnostics, quick fixes, refactoring actions, and lightbulb actions supplied by language services |
| Local Changes and Log | SCM tree, repository actions, side-by-side diff, history graph, branches, tags, stashes, and worktrees |
| Run, Debug, and Tests | Run and Debug view, launch configurations, breakpoints, variables, call stack, debug console, and Testing view |
| Java projects | Microsoft Java Extension Pack recommendation for language intelligence, refactoring, debugging, tests, Maven, and project management |
| Spring Boot | Spring Boot Extension Pack recommendation for Spring-aware editing and the Spring Boot Dashboard |
| New Spring project | Built-in Orbyte Spring wizard with Maven/Gradle, Java/Kotlin/Groovy, Spring Boot/JDK versions, packaging, metadata, and dependency selection |
| IntelliJ keyboard habits | IntelliJ IDEA keymap recommendation for Java, Maven, and Gradle projects |
| IntelliJ visual language | Orbyte IntelliJ Dark theme, compact density, modern Java/Spring file icons, and VCS/diff colors |
| AI assistance | Offline local model with Ask, Plan, Agent, context attachments, deterministic edits, review diffs, and accept/reject controls |

## Safety contract for local-LLM edits

1. Existing code is changed only through an exact, unique search anchor.
2. New Python top-level definitions use a dedicated `before_main` insertion operation.
3. Orbyte calculates the insertion boundary; the model cannot choose an arbitrary function body.
4. Existing Python definitions must remain structurally intact for additive requests.
5. `if __name__ == "__main__":` remains the final executable section.
6. Every proposal is displayed in a diff and can be accepted or rejected per file.

## Remaining parity work

Exact IntelliJ parity is not a single theme change. The remaining areas are separate subsystems:

- A first-party JVM semantic/indexing service bundled with Orbyte instead of installed extension packs.
- Spring bean graphs, dependency injection navigation, runtime actuator views, and Spring-aware debugger data.
- Maven and Gradle tool windows with task favorites, dependency analysis, and build profiles.
- Database browser, SQL console, profiler, coverage, HTTP client, Docker/Kubernetes, and remote targets.
- IntelliJ-style named changelists and shelving on top of Git.
- A unified Services tool window for applications, containers, processes, and endpoints.

These should be implemented as interoperable services and extensions rather than by copying IntelliJ internals. The local Agent can then call the same project model, diagnostics, refactoring, run, test, and VCS services used by the UI.

## Reference behavior

- [IntelliJ IDEA tool windows](https://www.jetbrains.com/help/idea/tool-windows.html)
- [IntelliJ IDEA project analysis](https://www.jetbrains.com/help/idea/project-analysis.html)
- [IntelliJ IDEA version control window](https://www.jetbrains.com/help/idea/version-control-tool-window.html)
- [IntelliJ IDEA Spring Boot support](https://www.jetbrains.com/help/idea/spring-boot.html)
- [VS Code Java and Spring Boot tooling](https://code.visualstudio.com/learn/java-spring-boot/1-build-and-run)
